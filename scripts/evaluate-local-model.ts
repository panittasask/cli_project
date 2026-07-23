import axios = require("axios");
import childProcess = require("node:child_process");
import fs = require("node:fs");
import net = require("node:net");
import path = require("node:path");
const { loadCliSettings } = require("../cli/config") as {
    loadCliSettings: (root?: string) => { defaultModel?: string; modelPath?: string };
};

type ProbeStatus = "passed" | "failed" | "timed_out" | "skipped";
type EvaluationMode = "practical" | "quality";
type ProbeResult = {
    name: string;
    script: string;
    status: ProbeStatus;
    durationMs: number;
    exitCode: number | null;
    outputTail: string;
    errorTail: string;
};

const appRoot = path.resolve(__dirname, "..");
const logDirectory = path.join(appRoot, ".cli", "logs", "evaluation");
const settings = loadCliSettings(appRoot);

function readPositiveInteger(name: string, fallback: number, minimum: number, maximum: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

function selectedModel(): string {
    const index = process.argv.findIndex((argument) => argument === "--model");
    const inline = process.argv.find((argument) => argument.startsWith("--model="));
    const requested = index >= 0 ? process.argv[index + 1] : inline?.slice("--model=".length);
    const model = requested?.trim() || process.env.LLAMA_MODEL?.trim() || settings.defaultModel?.trim();
    if (!model) throw new Error("No model selected. Use --model <file.gguf> or configure defaultModel.");
    return model;
}

function selectedProbeNames(): Set<string> {
    const index = process.argv.findIndex((argument) => argument === "--probes");
    const inline = process.argv.find((argument) => argument.startsWith("--probes="));
    const raw = index >= 0 ? process.argv[index + 1] : inline?.slice("--probes=".length);
    const selected = new Set((raw || "protocol,read,coding").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
    const unsupported = [...selected].filter((value) => !["protocol", "read", "coding", "invoice"].includes(value));
    if (unsupported.length > 0) throw new Error(`Unsupported probe name(s): ${unsupported.join(", ")}`);
    if (selected.size === 0) throw new Error("At least one probe must be selected.");
    return selected;
}

function selectedMode(): EvaluationMode {
    const index = process.argv.findIndex((argument) => argument === "--mode");
    const inline = process.argv.find((argument) => argument.startsWith("--mode="));
    const requested = (index >= 0 ? process.argv[index + 1] : inline?.slice("--mode=".length))?.trim().toLowerCase() || "practical";
    if (requested !== "practical" && requested !== "quality") {
        throw new Error(`Unsupported evaluation mode: ${requested}`);
    }
    return requested;
}

function safeName(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "model";
}

function tail(value: string, maximum = 12_000): string {
    return value.length <= maximum ? value : value.slice(-maximum);
}

function tailFile(filePath: string): string {
    try { return tail(fs.readFileSync(filePath, "utf8"), 8_000); } catch { return ""; }
}

function terminateTree(pid: number | undefined): void {
    if (!pid) return;
    if (process.platform === "win32") {
        childProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return;
    }
    try { process.kill(-pid, "SIGKILL"); } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
}

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() => reject(new Error("Could not allocate a local evaluation port.")));
                return;
            }
            server.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
}

async function waitForModel(apiUrl: string, server: childProcess.ChildProcess, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastReason = "server has not responded";
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`llama-server exited during startup with code ${server.exitCode}`);
        try {
            await axios.get(new URL("/health", apiUrl).toString(), { timeout: 2_000 });
            const response = await axios.get(new URL("/v1/models", apiUrl).toString(), { timeout: 2_000 });
            const model = Array.isArray(response.data?.data)
                ? response.data.data.find((entry: { id?: unknown }) => typeof entry?.id === "string")?.id
                : undefined;
            if (typeof model === "string" && model) return model;
            lastReason = "/v1/models did not contain a model id";
        } catch (error) {
            lastReason = axios.isAxiosError(error) ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`llama-server was not model-ready within ${(timeoutMs / 1000).toFixed(0)} seconds: ${lastReason}`);
}

async function waitForIdleSlot(apiUrl: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastReason = "slot state is unavailable";
    while (Date.now() < deadline) {
        try {
            const response = await axios.get(new URL("/slots", apiUrl).toString(), { timeout: 2_000 });
            const slots = Array.isArray(response.data) ? response.data : [];
            if (slots.length > 0 && slots.every((slot: { is_processing?: unknown }) => slot.is_processing !== true)) return;
            lastReason = "all llama.cpp slots are still processing";
        } catch (error) {
            lastReason = axios.isAxiosError(error) ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`llama-server did not expose an idle slot within ${(timeoutMs / 1000).toFixed(0)} seconds: ${lastReason}`);
}

async function runProbe(name: string, script: string, apiUrl: string, timeoutMs: number, mode: EvaluationMode): Promise<ProbeResult> {
    const startedAt = Date.now();
    const tsx = path.join(appRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = path.join(appRoot, "scripts", script);
    const child = childProcess.spawn(process.execPath, [tsx, scriptPath], {
        cwd: appRoot,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: {
            ...process.env,
            LLAMA_API_URL: apiUrl,
            LLAMA_ACTION_MAX_TOKENS: process.env.LOCAL_EVAL_ACTION_MAX_TOKENS || "512",
            LOCAL_EVAL_MODE: mode,
            BASELINE_AGENT_ATTEMPTS: process.env.BASELINE_AGENT_ATTEMPTS || "3",
            BASELINE_REQUEST_TIMEOUT_MS: process.env.BASELINE_REQUEST_TIMEOUT_MS || "120000"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let errorOutput = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { output = tail(output + chunk.toString("utf8")); });
    child.stderr.on("data", (chunk: Buffer) => { errorOutput = tail(errorOutput + chunk.toString("utf8")); });
    const timer = setTimeout(() => {
        timedOut = true;
        terminateTree(child.pid);
    }, timeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    const skipped = /\bskipped\b/i.test(output);
    return {
        name,
        script,
        status: timedOut ? "timed_out" : skipped ? "skipped" : exitCode === 0 ? "passed" : "failed",
        durationMs: Date.now() - startedAt,
        exitCode,
        outputTail: output.trim(),
        errorTail: errorOutput.trim()
    };
}

async function main(): Promise<void> {
    fs.mkdirSync(logDirectory, { recursive: true });
    const model = selectedModel();
    const requestedProbes = selectedProbeNames();
    const mode = selectedMode();
    const modelDirectory = process.env.LLAMA_MODEL_DIR?.trim() || settings.modelPath?.trim() || "D:\\Model";
    const modelPath = path.join(modelDirectory, model);
    if (!fs.existsSync(modelPath)) throw new Error(`Model not found: ${modelPath}`);
    const port = await getFreePort();
    const apiUrl = `http://127.0.0.1:${port}/v1/chat/completions`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = `local-eval-${safeName(model)}-${stamp}`;
    const stdoutPath = path.join(logDirectory, `${prefix}.server.out.log`);
    const stderrPath = path.join(logDirectory, `${prefix}.server.err.log`);
    const reportPath = path.join(logDirectory, `${prefix}.json`);
    const stdout = fs.openSync(stdoutPath, "w");
    const stderr = fs.openSync(stderrPath, "w");
    const launcher = path.join(appRoot, "scripts", "start-llama-eval.ps1");
    const server = childProcess.spawn("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher,
        "-ModelName", model, "-Port", String(port)
    ], {
        cwd: appRoot,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: { ...process.env, LLAMA_MODEL: model },
        stdio: ["ignore", stdout, stderr]
    });
    const startedAt = Date.now();
    let loadedModel: string | undefined;
    let infrastructureError: string | undefined;
    const probes: ProbeResult[] = [];
    try {
        console.log(`Starting local ${mode} evaluation: ${model}`);
        loadedModel = await waitForModel(apiUrl, server, readPositiveInteger("LOCAL_EVAL_STARTUP_TIMEOUT_MS", 300_000, 30_000, 900_000));
        console.log(`Model ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${loadedModel}`);
        const qualityMode = mode === "quality";
        const definitions = [
            { id: "protocol", name: "agent protocol", script: "baseline-agent.ts", timeoutMs: qualityMode ? 600_000 : 360_000 },
            { id: "read", name: "read-only E2E", script: "test-live-agent.ts", timeoutMs: qualityMode ? 16 * 60_000 : 240_000 },
            { id: "coding", name: "focused coding E2E", script: "test-live-behavior.ts", timeoutMs: qualityMode ? 16 * 60_000 : 360_000 },
            { id: "invoice", name: "invoice repair E2E", script: "test-live-invoice-repair.ts", timeoutMs: qualityMode ? 16 * 60_000 : 360_000 }
        ].filter((definition) => requestedProbes.has(definition.id));
        for (const definition of definitions) {
            await waitForIdleSlot(apiUrl);
            console.log(`Running ${definition.name}...`);
            const result = await runProbe(definition.name, definition.script, apiUrl, definition.timeoutMs, mode);
            probes.push(result);
            console.log(`${definition.name}: ${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`);
        }
    } catch (error) {
        infrastructureError = error instanceof Error ? error.message : String(error);
        console.error(`Infrastructure failure: ${infrastructureError}`);
    } finally {
        terminateTree(server.pid);
        fs.closeSync(stdout);
        fs.closeSync(stderr);
    }
    const report = {
        generatedAt: new Date().toISOString(),
        requestedModel: model,
        modelPath,
        loadedModel,
        mode,
        requestedProbes: [...requestedProbes],
        apiUrl,
        durationMs: Date.now() - startedAt,
        infrastructureError,
        serverLogs: { stdoutPath, stderrPath },
        serverOutputTail: tailFile(stdoutPath),
        serverErrorTail: tailFile(stderrPath),
        probes,
        passed: !infrastructureError && probes.length === requestedProbes.size && probes.every((probe) => probe.status === "passed")
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`Evaluation report: ${reportPath}`);
    if (!report.passed) process.exitCode = 2;
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
