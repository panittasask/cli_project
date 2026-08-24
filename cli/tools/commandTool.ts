import childProcess = require("node:child_process");
import fs = require("node:fs");

type CommandExpectation = import("../agent/agentSchema").CommandExpectation;
type ResolveWorkspacePath = (inputPath: string) => string;

const { commandInteractiveRisk, commandTimeoutMs, resolveCommandWorkdir, unwrapWindowsPowerShellCommand } = require("../commandNormalizer") as {
    commandInteractiveRisk: (command: string, workspace: string, workdir?: string, options?: { probe?: boolean }) => string | undefined;
    commandTimeoutMs: (command: string) => number;
    resolveCommandWorkdir: (workspace: string, command: string, requestedWorkdir?: string) => { workdir: string; autoSelected: boolean };
    unwrapWindowsPowerShellCommand: (command: string) => string;
};

class CommandTool {
    constructor(
        private readonly resolveInsideWorkspace: ResolveWorkspacePath,
        private readonly commandTimeoutOverrideMs?: number,
        private readonly inferenceApiUrl?: string
    ) {}
    async runCommand(
        command: string,
        workdir?: string,
        mode: "normal" | "probe" = "normal",
        requestedTimeoutMs?: number,
        expectation?: CommandExpectation
    ): Promise<string> {
        const normalizedCommand = process.platform === "win32"
            ? unwrapWindowsPowerShellCommand(command)
            : command.trim();
        if (process.platform === "win32" && /^(?:powershell|pwsh)(?:\.exe)?\b/i.test(normalizedCommand)) {
            throw new Error("Unsupported nested PowerShell command. Pass the command body directly.");
        }
        if (!this.isSafeCommand(normalizedCommand)) {
            throw new Error(`Blocked unsafe command: ${normalizedCommand}`);
        }

        if (process.platform === "win32" && /\b(grep|sed|awk)\b/i.test(normalizedCommand)) {
            throw new Error("Unsupported Unix command on Windows PowerShell. Use Select-String or a built-in file action instead.");
        }

        const workdirResolution = resolveCommandWorkdir(process.cwd(), normalizedCommand, workdir);
        const commandCwd = this.resolveInsideWorkspace(workdirResolution.workdir);
        if (!fs.existsSync(commandCwd) || !fs.statSync(commandCwd).isDirectory()) {
            throw new Error(`Command workdir is not a directory: ${workdirResolution.workdir}`);
        }
        const interactiveRisk = commandInteractiveRisk(
            normalizedCommand,
            process.cwd(),
            workdirResolution.workdir,
            { probe: mode === "probe" }
        );
        if (interactiveRisk) {
            throw new Error(`Blocked interactive command: ${interactiveRisk}.`);
        }

        const timeout = this.commandTimeoutOverrideMs
            ?? (mode === "probe"
                ? Math.max(1000, Math.min(30000, requestedTimeoutMs ?? 10000))
                : commandTimeoutMs(normalizedCommand));
        let output = "";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                output = await this.runFiniteProcess(normalizedCommand, commandCwd, timeout);
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (attempt < 2 && (code === "EPERM" || code === "EBUSY")) continue;
                throw error;
            }
        }

        const commandOutput = output.trim() || "[Command completed with no output]";
        this.assertCommandOutput(commandOutput, expectation);
        return workdirResolution.autoSelected
            ? `${commandOutput}\n[Auto-selected workdir: ${workdirResolution.workdir}]`
            : commandOutput;
    }

    assertCommandOutput(output: string, expectation?: CommandExpectation): void {
        if (!expectation) return;
        const missing = (expectation.output_includes ?? []).filter((text) => !output.includes(text));
        const forbidden = (expectation.output_excludes ?? []).filter((text) => output.includes(text));
        if (missing.length === 0 && forbidden.length === 0) return;
        const details = [
            missing.length > 0 ? `missing required output: ${missing.map((text) => JSON.stringify(text)).join(", ")}` : "",
            forbidden.length > 0 ? `found forbidden output: ${forbidden.map((text) => JSON.stringify(text)).join(", ")}` : ""
        ].filter(Boolean).join("; ");
        const error = Object.assign(
            new Error(`Command output assertion failed: ${details}\nObserved output:\n${output}`),
            { code: "EOUTPUTASSERT", commandOutput: output }
        );
        throw error;
    }

    private runFiniteProcess(command: string, cwd: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const environment = {
                ...process.env,
                BROWSER: "none",
                CI: "true",
                NO_OPEN: "1"
            };
            const child = process.platform === "win32"
                ? childProcess.spawn("powershell.exe", [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    command
                ], {
                    cwd,
                    env: environment,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true
                })
                : childProcess.spawn(command, {
                    cwd,
                    detached: true,
                    env: environment,
                    shell: true,
                    stdio: ["ignore", "pipe", "pipe"]
                });
            let stdout = "";
            let stderr = "";
            let settled = false;
            let timedOut = false;
            const append = (current: string, chunk: Buffer): string => (
                current.length >= 1_000_000 ? current : `${current}${chunk.toString("utf8")}`.slice(0, 1_000_000)
            );
            child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
            child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

            const timer = setTimeout(() => {
                timedOut = true;
                if (child.pid) this.terminateProcessTree(child.pid);
            }, timeoutMs);

            const finish = (callback: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };

            child.once("error", (error) => finish(() => reject(error)));
            child.once("close", (code, signal) => finish(() => {
                if (timedOut) {
                    const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
                    const error = Object.assign(
                        new Error(`Command timed out after ${Math.ceil(timeoutMs / 1000)} seconds; the spawned process tree was terminated.${combinedOutput ? `\n${combinedOutput}` : ""}`),
                        { code: "ETIMEDOUT", commandOutput: combinedOutput }
                    );
                    reject(error);
                    return;
                }
                const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
                if (code === 0) {
                    resolve(combinedOutput);
                    return;
                }
                const error = Object.assign(new Error(`Command failed with exit code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${command}${combinedOutput ? `\n${combinedOutput}` : ""}`), { code: `EXIT_${code ?? "UNKNOWN"}` });
                reject(error);
            }));
        });
    }

    private terminateProcessTree(pid: number): void {
        try {
            if (process.platform === "win32") {
                childProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true
                });
            } else {
                process.kill(-pid, "SIGKILL");
            }
        } catch {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // The process may already have exited between timeout and cleanup.
            }
        }
    }

    private isSafeCommand(command: string): boolean {
        // This is intentionally conservative: agent mode should verify builds
        // and inspect state, not perform destructive shell operations.
        const lower = command.toLowerCase();
        const blockedPatterns = [
            /\brm\b/,
            /\brmdir\b/,
            /\bdel\b/,
            /\berase\b/,
            /\bformat\b/,
            /\bshutdown\b/,
            /\bstop-process\b/,
            /\btaskkill\b/,
            /\bpkill\b/,
            /\bkillall\b/,
            /(?:^|[;&|]\s*)kill\s+(?:-\S+\s+)*(?:\d+|%?\w+)/,
            /\bmove\b/,
            /\bmv\b/,
            /\bcopy\b/,
            /\bcp\b/,
            /\bren\b/,
            /\brename\b/,
            /\bmkdir\b/,
            /\bmd\s+/,
            /\bnew-item\b/,
            /\bremove-item\b/,
            /\bclear-content\b/,
            /\bset-content\b/,
            /\badd-content\b/,
            /\bout-file\b/,
            /(^|[^<])>(?!>)/,
            /\bsetx\b/,
            /\bgit\s+reset\b/,
            /\bgit\s+checkout\b/,
            /\bgit\s+clean\b/,
            /\bnpm\s+publish\b/,
            /\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+audit\s+fix\b/,
            /\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:install|i|add)\b[^\r\n]*(?:--legacy-peer-deps|--force)\b/
        ];

        return !blockedPatterns.some((pattern) => pattern.test(lower));
    }


}

module.exports = { CommandTool };
