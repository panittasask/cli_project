import axios = require("axios");
import childProcess = require("node:child_process");
import crypto = require("node:crypto");
import fs = require("node:fs");
import path = require("node:path");
import streamPromises = require("node:stream/promises");

const { pipeline } = streamPromises;
const { loadApiEndpointSettings } = require("../cli/config") as {
    loadApiEndpointSettings: (appRoot?: string) => {
        provider?: "llama.cpp" | "openrouter";
        apiUrl?: string;
        bearerToken?: string;
        apiKeyEnv?: string;
        httpReferer?: string;
        xTitle?: string;
        model?: string;
    } | undefined;
};

type Backend = "cuda" | "sycl" | "vulkan" | "metal" | "cpu";
type LaunchMode = { kind: "external"; apiUrl: string } | { kind: "local"; apiUrl: string };

type LauncherSettings = {
    llamaCppPath?: string;
    modelPath?: string;
    provider?: "llama.cpp" | "openrouter";
    apiUrl?: string;
    apiEndpoint?: {
        provider?: "llama.cpp" | "openrouter";
        apiUrl?: string;
        bearerToken?: string;
        apiKeyEnv?: string;
        httpReferer?: string;
        xTitle?: string;
        model?: string;
    };
    defaultModel?: string;
    contextLength?: number;
    serverHost?: string;
    serverPort?: number;
    device?: string;
    hardwareProfile?: string;
};

const DEFAULT_OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

type ReleaseAsset = {
    name: string;
    browser_download_url: string;
    digest?: string | null;
};

type Release = {
    tag_name: string;
    assets: ReleaseAsset[];
};

const appRoot = path.resolve(__dirname, "..");

function boolEnv(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    throw new Error(`${name} must be true or false.`);
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
    const parsed = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
    }
    return parsed;
}

function loadSettings(root = appRoot): LauncherSettings {
    const personal = path.join(root, ".cli", "settings.json");
    const example = path.join(root, ".cli", "settings.example.json");
    const selected = fs.existsSync(personal) ? personal : example;
    if (!fs.existsSync(selected)) return {};
    const parsed = JSON.parse(fs.readFileSync(selected, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const apiEndpoint = loadApiEndpointSettings(root);
    return apiEndpoint ? { ...(parsed as LauncherSettings), apiEndpoint } : parsed as LauncherSettings;
}

function localApiUrl(settings: LauncherSettings): string {
    const port = integer(process.env.LLAMA_ARG_PORT ?? settings.serverPort, 8080, 1, 65535, "llama.cpp port");
    return `http://127.0.0.1:${port}/v1/chat/completions`;
}

function isOpenRouter(settings: LauncherSettings, environment: NodeJS.ProcessEnv = process.env): boolean {
    return (environment.LLM_PROVIDER?.trim().toLowerCase() || settings.apiEndpoint?.provider || settings.provider) === "openrouter";
}

function resolveLaunchMode(settings: LauncherSettings, environment: NodeJS.ProcessEnv = process.env): LaunchMode {
    const explicit = environment.LLM_API_URL?.trim() || environment.LLAMA_API_URL?.trim();
    if (explicit) {
        const parsed = new URL(explicit);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("LLAMA_API_URL must use http or https.");
        return { kind: "external", apiUrl: parsed.toString() };
    }
    const configured = settings.apiEndpoint?.apiUrl?.trim()
        || settings.apiUrl?.trim()
        || (isOpenRouter(settings, environment) ? DEFAULT_OPENROUTER_API_URL : undefined);
    if (configured) {
        const parsed = new URL(configured);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("apiUrl must use http or https.");
        const host = parsed.hostname.toLowerCase();
        if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
            return { kind: "external", apiUrl: parsed.toString() };
        }
    }
    return { kind: "local", apiUrl: localApiUrl(settings) };
}

function runCapture(command: string, args: string[]): string {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000
    });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function detectGraphicsHardware(platform = process.platform): string {
    const override = process.env.LLAMA_GPU_NAME?.trim();
    if (override) return override;
    if (platform === "win32") {
        return runCapture("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }"
        ]);
    }
    if (platform === "darwin") {
        return runCapture("system_profiler", ["SPDisplaysDataType"]);
    }
    const nvidia = runCapture("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
    if (nvidia) return nvidia;
    return runCapture("sh", ["-lc", "command -v lspci >/dev/null 2>&1 && lspci | grep -Ei 'vga|3d|display' || true"]);
}

function selectBackend(hardware: string, platform = process.platform, architecture = process.arch): Backend {
    const requested = process.env.LLAMA_RUNTIME_BACKEND?.trim().toLowerCase();
    if (requested) {
        if (!["cuda", "sycl", "vulkan", "metal", "cpu"].includes(requested)) {
            throw new Error("LLAMA_RUNTIME_BACKEND must be cuda, sycl, vulkan, metal, or cpu.");
        }
        return requested as Backend;
    }
    if (platform === "darwin" && architecture === "arm64") return "metal";
    if (/nvidia|geforce|quadro|tesla/i.test(hardware)) return platform === "win32" ? "cuda" : "vulkan";
    if (/intel.*(?:arc|iris|uhd)|(?:arc|iris).*intel/i.test(hardware)) return architecture === "x64" ? "sycl" : "cpu";
    if (/amd|radeon/i.test(hardware)) return "vulkan";
    return "cpu";
}

function assetPatterns(backend: Backend, platform = process.platform, architecture = process.arch): RegExp[] {
    const arch = architecture === "arm64" ? "arm64" : "x64";
    if (platform === "win32") {
        if (backend === "cuda") return [
            new RegExp(`^llama-.+-bin-win-cuda-12\\.[0-9]+-${arch}\\.zip$`, "i"),
            new RegExp(`^cudart-llama-bin-win-cuda-12\\.[0-9]+-${arch}\\.zip$`, "i")
        ];
        if (backend === "sycl") return [new RegExp(`^llama-.+-bin-win-sycl-${arch}\\.zip$`, "i")];
        if (backend === "vulkan") return [new RegExp(`^llama-.+-bin-win-vulkan-${arch}\\.zip$`, "i")];
        return [new RegExp(`^llama-.+-bin-win-cpu-${arch}\\.zip$`, "i")];
    }
    if (platform === "darwin") return [new RegExp(`^llama-.+-bin-macos-${arch}\\.tar\\.gz$`, "i")];
    if (backend === "sycl") return [
        new RegExp(`^llama-.+-bin-ubuntu-sycl-fp16-${arch}\\.tar\\.gz$`, "i"),
        new RegExp(`^llama-.+-bin-ubuntu-sycl-${arch}\\.tar\\.gz$`, "i")
    ];
    if (backend === "vulkan") return [
        new RegExp(`^llama-.+-bin-ubuntu-vulkan-${arch}\\.tar\\.gz$`, "i"),
        new RegExp(`^llama-.+-bin-ubuntu-${arch}\\.tar\\.gz$`, "i")
    ];
    return [new RegExp(`^llama-.+-bin-ubuntu-${arch}\\.tar\\.gz$`, "i")];
}

function selectReleaseAssets(release: Release, backend: Backend, platform = process.platform, architecture = process.arch): ReleaseAsset[] {
    const selected: ReleaseAsset[] = [];
    for (const pattern of assetPatterns(backend, platform, architecture)) {
        const match = release.assets.find((asset) => pattern.test(asset.name));
        if (match && !selected.some((asset) => asset.name === match.name)) selected.push(match);
    }
    if (selected.length === 0) {
        throw new Error(`llama.cpp release ${release.tag_name} has no ${platform}/${architecture}/${backend} binary.`);
    }
    if (platform === "win32" && backend === "cuda" && selected.length < 2) {
        throw new Error(`llama.cpp release ${release.tag_name} is missing its CUDA runtime archive.`);
    }
    return selected;
}

async function fetchLatestRelease(): Promise<Release> {
    const response = await axios.get<Release>("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
        timeout: 30_000,
        headers: { "User-Agent": "local-cli-launcher", Accept: "application/vnd.github+json" }
    });
    if (!response.data?.tag_name || !Array.isArray(response.data.assets)) throw new Error("GitHub returned invalid llama.cpp release metadata.");
    return response.data;
}

async function sha256(file: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest("hex");
}

async function downloadAsset(asset: ReleaseAsset, destination: string): Promise<void> {
    const expected = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
    if (!expected) throw new Error(`Release asset ${asset.name} has no verifiable SHA-256 digest.`);
    const temporary = `${destination}.part`;
    fs.rmSync(temporary, { force: true });
    console.log(`Downloading ${asset.name}...`);
    const response = await axios.get(asset.browser_download_url, {
        responseType: "stream",
        timeout: 300_000,
        maxRedirects: 10,
        headers: { "User-Agent": "local-cli-launcher" }
    });
    await pipeline(response.data, fs.createWriteStream(temporary));
    const actual = await sha256(temporary);
    if (actual !== expected) {
        fs.rmSync(temporary, { force: true });
        throw new Error(`SHA-256 verification failed for ${asset.name}.`);
    }
    fs.renameSync(temporary, destination);
}

function extractArchive(archive: string, destination: string): void {
    const result = archive.toLowerCase().endsWith(".zip")
        ? childProcess.spawnSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
            archive, destination
        ], { stdio: "inherit", windowsHide: true })
        : childProcess.spawnSync("tar", ["-xf", archive, "-C", destination], { stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Could not extract ${path.basename(archive)} (exit ${result.status}).`);
}

function findServerExecutable(root: string): string | undefined {
    if (!fs.existsSync(root)) return undefined;
    const expected = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.shift() as string;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isFile() && entry.name === expected) return fullPath;
            if (entry.isDirectory()) pending.push(fullPath);
        }
    }
    return undefined;
}

async function provisionRuntime(settings: LauncherSettings, backend: Backend): Promise<string> {
    const configured = process.env.LLAMA_CPP_DIR?.trim() || settings.llamaCppPath?.trim();
    if (configured) {
        const existing = findServerExecutable(path.resolve(configured));
        if (existing) return existing;
        console.warn(`Configured llama.cpp runtime was not found at ${configured}; automatic provisioning will be used.`);
    }
    if (!boolEnv("LLAMA_AUTO_DOWNLOAD", true)) {
        throw new Error("No llama-server runtime was found and LLAMA_AUTO_DOWNLOAD is disabled.");
    }
    const release = await fetchLatestRelease();
    const runtimeRoot = path.join(appRoot, ".cli", "runtime", "llama.cpp", release.tag_name, `${process.platform}-${process.arch}-${backend}`);
    const cached = findServerExecutable(runtimeRoot);
    if (cached) return cached;
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const assets = selectReleaseAssets(release, backend);
    for (const asset of assets) {
        const archive = path.join(runtimeRoot, asset.name);
        if (!fs.existsSync(archive)) await downloadAsset(asset, archive);
        extractArchive(archive, runtimeRoot);
        fs.rmSync(archive, { force: true });
    }
    const executable = findServerExecutable(runtimeRoot);
    if (!executable) throw new Error(`Downloaded llama.cpp ${release.tag_name}, but llama-server was not found after extraction.`);
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
    return executable;
}

function listModels(settings: LauncherSettings): string[] {
    const explicit = process.env.LLAMA_MODEL?.trim();
    if (explicit && fs.existsSync(path.resolve(explicit)) && fs.statSync(path.resolve(explicit)).isFile()) return [path.resolve(explicit)];
    const modelDirectory = process.env.LLAMA_MODEL_DIR?.trim() || settings.modelPath?.trim() || path.join(appRoot, ".cli", "models");
    if (!fs.existsSync(modelDirectory)) throw new Error(`Model directory not found: ${modelDirectory}. Set LLAMA_MODEL_DIR or LLAMA_MODEL.`);
    const models = fs.readdirSync(modelDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gguf"))
        .map((entry) => path.resolve(modelDirectory, entry.name))
        .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
    if (models.length === 0) throw new Error(`No .gguf model was found in ${modelDirectory}.`);
    if (explicit) {
        const matched = models.find((model) => path.basename(model).toLowerCase() === explicit.toLowerCase());
        if (!matched) throw new Error(`LLAMA_MODEL '${explicit}' was not found in ${modelDirectory}.`);
        return [matched];
    }
    const preferred = settings.defaultModel?.trim();
    const selected = preferred && models.find((model) => path.basename(model).toLowerCase() === preferred.toLowerCase());
    return [selected ?? models[0] as string];
}

async function endpointReady(apiUrl: string, timeout = 3_000): Promise<boolean> {
    try {
        const response = await axios.get(new URL("/health", apiUrl).toString(), { timeout, validateStatus: () => true });
        return response.status >= 200 && response.status < 300;
    } catch {
        return false;
    }
}

async function requireExternalEndpoint(apiUrl: string): Promise<void> {
    if (await endpointReady(apiUrl, 10_000)) return;
    throw new Error(`LLAMA_API_URL is set, but its health endpoint is unavailable: ${new URL("/health", apiUrl)}`);
}

async function waitForServer(apiUrl: string, server: childProcess.ChildProcess, timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("Loading model");
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`llama-server exited during startup with code ${server.exitCode}.`);
        if (await endpointReady(apiUrl, 2_000)) {
            process.stdout.write("\n");
            return;
        }
        process.stdout.write(".");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    process.stdout.write("\n");
    throw new Error("llama-server did not become ready within 5 minutes.");
}

function deviceArguments(executable: string, requested: string | undefined): string[] {
    const output = runCapture(executable, ["--list-devices"]);
    const devices = [...output.matchAll(/^\s*([A-Za-z][A-Za-z0-9_-]*\d+):/gm)].map((match) => match[1] as string);
    const wanted = requested?.trim();
    if (wanted && wanted.toLowerCase() !== "auto") {
        const match = devices.find((device) => device.toLowerCase() === wanted.toLowerCase());
        if (!match) throw new Error(`Requested llama.cpp device '${wanted}' is unavailable. Available: ${devices.join(", ") || "CPU only"}.`);
        return ["--device", match];
    }
    return devices[0] ? ["--device", devices[0]] : [];
}

function runtimeBatch(backend: Backend, settings: LauncherSettings): { batch: number; ubatch: number } {
    const defaults = backend === "cuda" ? { batch: 1024, ubatch: 512 }
        : backend === "sycl" ? { batch: 512, ubatch: 256 }
            : backend === "vulkan" ? { batch: 512, ubatch: 256 }
                : { batch: 256, ubatch: 128 };
    const batch = integer(process.env.LLAMA_BATCH_SIZE, defaults.batch, 1, 65_536, "LLAMA_BATCH_SIZE");
    const ubatch = integer(process.env.LLAMA_UBATCH_SIZE, defaults.ubatch, 1, batch, "LLAMA_UBATCH_SIZE");
    void settings;
    return { batch, ubatch };
}

function startLocalServer(executable: string, model: string, backend: Backend, settings: LauncherSettings): childProcess.ChildProcess {
    const port = integer(process.env.LLAMA_ARG_PORT ?? settings.serverPort, 8080, 1, 65535, "llama.cpp port");
    const context = integer(process.env.LLAMA_CONTEXT_LENGTH ?? settings.contextLength, 16_384, 512, 10_000_000, "context length");
    const host = process.env.LLAMA_ARG_HOST?.trim() || settings.serverHost?.trim() || "127.0.0.1";
    const { batch, ubatch } = runtimeBatch(backend, settings);
    const args = ["-m", model, "-c", String(context), "-b", String(batch), "-ub", String(ubatch), "-np", "1", "-fa", "auto", "--host", host, "--port", String(port), ...deviceArguments(executable, process.env.LLAMA_DEVICE ?? settings.device)];
    const logDirectory = path.join(appRoot, ".cli", "logs", "server");
    fs.mkdirSync(logDirectory, { recursive: true });
    const stdout = fs.openSync(path.join(logDirectory, "llama-server.log"), "w");
    const stderr = fs.openSync(path.join(logDirectory, "llama-server-error.log"), "w");
    console.log(`Starting llama.cpp (${backend}) with ${path.basename(model)}...`);
    try {
        return childProcess.spawn(executable, args, {
            cwd: path.dirname(executable),
            stdio: ["ignore", stdout, stderr],
            windowsHide: true
        });
    } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
    }
}

function startCli(apiUrl: string): Promise<number> {
    const tsx = path.join(appRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const terminal = path.join(appRoot, "cli", "terminal.ts");
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, [tsx, terminal, ...process.argv.slice(2)], {
            cwd: appRoot,
            stdio: "inherit",
            env: { ...process.env, LLM_API_URL: apiUrl, LLAMA_API_URL: apiUrl },
            windowsHide: true
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
    });
}

async function main(): Promise<void> {
    const settings = loadSettings();
    const mode = resolveLaunchMode(settings);
    let localServer: childProcess.ChildProcess | undefined;
    const stopLocalServer = (): void => {
        if (localServer && localServer.exitCode === null && !localServer.killed) localServer.kill();
    };
    const interrupt = (): never => {
        stopLocalServer();
        process.exit(130);
    };
    const terminate = (): never => {
        stopLocalServer();
        process.exit(143);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
        if (mode.kind === "external") {
            console.log(`Using configured ${isOpenRouter(settings) ? "OpenRouter" : "llama.cpp"} API: ${mode.apiUrl}`);
            if (!isOpenRouter(settings)) await requireExternalEndpoint(mode.apiUrl);
        } else if (await endpointReady(mode.apiUrl)) {
            console.log(`Reusing llama.cpp API: ${mode.apiUrl}`);
        } else {
            const hardware = detectGraphicsHardware();
            const backend = selectBackend(hardware);
            console.log(`Detected accelerator: ${hardware.split(/\r?\n/).filter(Boolean)[0] || "none"}`);
            console.log(`Selected llama.cpp backend: ${backend}`);
            const [model] = listModels(settings);
            const executable = await provisionRuntime(settings, backend);
            localServer = startLocalServer(executable, model as string, backend, settings);
            await waitForServer(mode.apiUrl, localServer);
        }
        const exitCode = await startCli(mode.apiUrl);
        if (exitCode !== 0) process.exitCode = exitCode;
    } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
        stopLocalServer();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

module.exports = {
    assetPatterns,
    detectGraphicsHardware,
    findServerExecutable,
    resolveLaunchMode,
    selectBackend,
    selectReleaseAssets
};
