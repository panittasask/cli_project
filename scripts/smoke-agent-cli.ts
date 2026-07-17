import childProcess = require("node:child_process");
import path = require("node:path");

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    return value?.trim() || undefined;
}

function terminateTree(pid: number): void {
    if (process.platform === "win32") {
        childProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true
        });
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        process.kill(pid, "SIGKILL");
    }
}

async function main(): Promise<void> {
    const session = argument("--session");
    const workspace = argument("--workspace");
    const prompt = argument("--prompt");
    const timeoutMinutes = Number(argument("--timeout-minutes") ?? "20");
    if (!session || !workspace || !prompt) {
        throw new Error("Usage: npm run smoke:agent:cli -- --session <id> --workspace <path> --prompt <text> [--timeout-minutes 20]");
    }

    const root = path.resolve(__dirname, "..");
    const tsx = path.resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
    const child = childProcess.spawn(process.execPath, [tsx, "cli/terminal.ts", "--session", session, "--workspace", workspace], {
        cwd: root,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
    });
    let promptSent = false;
    let exitSent = false;
    let outputAfterPrompt = "";
    const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

    const timer = setTimeout(() => {
        if (child.pid) terminateTree(child.pid);
    }, Math.max(1, timeoutMinutes) * 60_000);

    child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        process.stdout.write(text);
        const clean = stripAnsi(text);
        if (!promptSent && clean.includes("You:")) {
            promptSent = true;
            child.stdin.write(`${prompt}\n`);
            return;
        }
        if (!promptSent || exitSent) return;
        outputAfterPrompt = `${outputAfterPrompt}${clean}`.slice(-40_000);
        const completed = outputAfterPrompt.includes("AI:") || outputAfterPrompt.includes("API Error:") || outputAfterPrompt.includes("Request wall-clock budget reached");
        if (completed && /You:\s*$/.test(outputAfterPrompt)) {
            exitSent = true;
            child.stdin.write("/exit\n");
        }
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

    const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
    });
    clearTimeout(timer);
    if (!promptSent) throw new Error("CLI exited before presenting its prompt.");
    if (!exitSent) throw new Error(`CLI exited before completing the smoke prompt (exit ${exitCode}).`);
    if (exitCode !== 0) throw new Error(`CLI smoke process exited with code ${exitCode}.`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
