import childProcess = require("node:child_process");
import fs = require("node:fs");
import path = require("node:path");

type HarnessOptions = {
    appRoot: string;
    workspace: string;
    apiUrl: string;
    prompt: string;
    clarificationAnswers?: string[];
    timeoutMs?: number;
    environment?: Record<string, string>;
};

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function terminateTree(pid: number): void {
    if (process.platform === "win32") {
        childProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return;
    }
    try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
}

async function runAgentCliHarness(options: HarnessOptions): Promise<{ output: string; stderr: string; exitCode: number }> {
    const sessionId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(path.join(options.appRoot, ".cli-sessions.json"), JSON.stringify({
        version: 1,
        sessions: [{
            id: sessionId,
            title: "E2E scenario",
            workspace: options.workspace,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: []
        }]
    }), "utf8");
    const repositoryRoot = path.resolve(__dirname, "..");
    const tsx = path.resolve(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const terminal = path.resolve(repositoryRoot, "cli", "terminal.ts");
    const child = childProcess.spawn(process.execPath, [tsx, terminal, "--session", sessionId, "--workspace", options.workspace], {
        cwd: options.appRoot,
        detached: process.platform !== "win32",
        env: {
            ...process.env,
            LLAMA_API_URL: options.apiUrl,
            CLI_AGENT_MAX_MINUTES: "2",
            CLI_AGENT_MAX_TURNS: "12",
            CLI_AGENT_MAX_SEGMENTS: "1",
            CLI_DEBUG: "1",
            ...options.environment
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
    });
    let output = "";
    let stderr = "";
    let promptSent = false;
    let exitSent = false;
    let clarificationIndex = 0;
    let scannedLength = 0;
    const timeout = setTimeout(() => { if (child.pid) terminateTree(child.pid); }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
        output += stripAnsi(chunk.toString("utf8"));
        const fresh = output.slice(scannedLength);
        if (!promptSent && output.includes("You:")) {
            promptSent = true;
            child.stdin.write(`${options.prompt}\n`);
        }
        const answer = options.clarificationAnswers?.[clarificationIndex];
        if (promptSent && answer && /(?:Your choice|Choice):/i.test(fresh)) {
            clarificationIndex += 1;
            child.stdin.write(`${answer}\n`);
        }
        const latestAnswer = output.lastIndexOf("AI:");
        const latestPrompt = output.lastIndexOf("You:");
        if (promptSent && !exitSent && latestAnswer >= 0 && latestPrompt > latestAnswer) {
            exitSent = true;
            child.stdin.write("/exit\n");
        }
        scannedLength = Math.max(0, output.length - 20);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += stripAnsi(chunk.toString("utf8")); });
    const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
    });
    clearTimeout(timeout);
    if (!promptSent) throw new Error(`CLI did not present a prompt.\n${output}\n${stderr}`);
    if (!exitSent) throw new Error(`CLI did not complete the scenario (exit ${exitCode}).\n${output}\n${stderr}`);
    return { output, stderr, exitCode };
}

module.exports = { runAgentCliHarness };
