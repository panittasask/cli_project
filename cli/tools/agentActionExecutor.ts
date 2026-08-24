import fs = require("node:fs");

type AgentAction = import("../agent/agentSchema").AgentAction;
type AgentToolResult = import("../agent/agentSchema").AgentToolResult;
type CommandExpectation = import("../agent/agentSchema").CommandExpectation;
type FileTools = {
    listFiles: (inputPath?: string) => string;
    searchFiles: (query: string, inputPath?: string) => string;
    resolveInsideWorkspace: (inputPath: string) => string;
    readFile: (inputPath: string) => string;
    writeFile: (inputPath: string, content: string) => void;
    mcpConfigWriteError: (inputPath: string, content: string) => string | undefined;
    prepareEdit: (inputPath: string, oldText: string, newText: string) => { ok: boolean; output: string; content?: string; changed?: boolean };
    missingFileMessage: (inputPath: string) => string;
    diagnosticSourceContext: (errorOutput: string, command?: string, requestedWorkdir?: string) => string | undefined;
};
type CommandTool = {
    runCommand: (command: string, workdir?: string, mode?: "normal" | "probe", requestedTimeoutMs?: number, expectation?: CommandExpectation) => Promise<string>;
    assertCommandOutput: (output: string, expectation?: CommandExpectation) => void;
};
type McpTool = {
    listTools: (serverName?: string) => Promise<string>;
    callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>;
};
type ProjectIndex = {
    markDirty: () => void;
    search: (query: string, limit?: number, path?: string) => string;
};

const { commandFailureGuidance, commandFailureKind, packageContentAddsBrowserAutoOpen, packageScriptRecovery } = require("../commandNormalizer") as {
    commandFailureGuidance: (workspace: string, command: string, errorOutput: string, inferenceApiUrl?: string, requestedWorkdir?: string) => string;
    commandFailureKind: (command: string, errorOutput: string, inferenceApiUrl?: string) => "inference_port_collision" | "invocation" | "timeout" | "unsafe" | "runtime";
    packageContentAddsBrowserAutoOpen: (filePath: string, content: string) => boolean;
    packageScriptRecovery: (workspace: string, command: string, errorOutput: string, requestedWorkdir?: string) => {
        command: string;
        workdir: string;
        mode?: "probe";
    } | undefined;
};

class AgentActionExecutor {
    constructor(
        private readonly fileTools: FileTools,
        private readonly commandTool: CommandTool,
        private readonly mcpTool: McpTool,
        private readonly getProjectIndex: () => ProjectIndex,
        private readonly inferenceApiUrl?: string
    ) {}
    async execute(action: AgentAction): Promise<AgentToolResult> {
        try {
            // Every model action is translated into a deterministic local
            // operation. The model never touches the filesystem directly.
            if (action.action === "final") {
                return { ok: true, output: action.answer };
            }

            if (action.action === "ask_user") {
                return { ok: false, output: "ask_user must be handled by the interactive agent loop." };
            }

            if (action.action === "list_files") {
                return { ok: true, output: this.fileTools.listFiles(action.path) };
            }

            if (action.action === "search_files") {
                if (!action.query.trim()) {
                    return { ok: false, output: "Missing search query." };
                }

                return { ok: true, output: this.fileTools.searchFiles(action.query, action.path) };
            }

            if (action.action === "search_project") {
                if (!action.query.trim()) {
                    return { ok: false, output: "Missing project search query." };
                }
                if (action.path) this.fileTools.resolveInsideWorkspace(action.path);
                return { ok: true, output: this.getProjectIndex().search(action.query, action.limit, action.path) };
            }

            if (action.action === "read_file") {
                if (!action.path.trim()) {
                    return { ok: false, output: "Missing file path." };
                }

                return { ok: true, output: this.fileTools.readFile(action.path) };
            }

            if (action.action === "write_file") {
                if (!action.path.trim()) {
                    return { ok: false, output: "Missing file path." };
                }

                if (!action.content) {
                    return { ok: false, output: "Missing file content." };
                }

                if (packageContentAddsBrowserAutoOpen(action.path, action.content)) {
                    return { ok: false, output: "Blocked package script: automatic browser-opening flags such as --open are not allowed. Use a normal start script without auto-open." };
                }
                const mcpConfigError = this.fileTools.mcpConfigWriteError(action.path, action.content);
                if (mcpConfigError) return { ok: false, output: mcpConfigError };

                const writeTarget = this.fileTools.resolveInsideWorkspace(action.path);
                if (fs.existsSync(writeTarget) && fs.statSync(writeTarget).isFile()
                    && fs.readFileSync(writeTarget, "utf8") === action.content) {
                    return { ok: true, changed: false, output: `No change needed: ${action.path} already has the requested content.` };
                }

                this.fileTools.writeFile(action.path, action.content);
                this.getProjectIndex().markDirty();
                return { ok: true, changed: true, output: `Wrote ${action.path}` };
            }

            if (action.action === "edit_file") {
                const prepared = this.fileTools.prepareEdit(action.path, action.old_text, action.new_text);
                if (!prepared.ok || prepared.content === undefined) {
                    return { ok: false, output: prepared.output };
                }
                if (packageContentAddsBrowserAutoOpen(action.path, prepared.content)) {
                    return { ok: false, output: "Blocked package script: automatic browser-opening flags such as --open are not allowed. Use a normal start script without auto-open." };
                }
                const mcpConfigError = this.fileTools.mcpConfigWriteError(action.path, prepared.content);
                if (mcpConfigError) return { ok: false, output: mcpConfigError };
                const editTarget = this.fileTools.resolveInsideWorkspace(action.path);
                if (fs.readFileSync(editTarget, "utf8") === prepared.content) {
                    return { ok: true, changed: false, output: `No change needed: ${action.path} already contains the requested replacement.` };
                }
                this.fileTools.writeFile(action.path, prepared.content);
                this.getProjectIndex().markDirty();
                return { ok: true, changed: true, output: `Edited ${action.path} with one exact replacement` };
            }

            if (action.action === "delete_file") {
                if (!action.path.trim()) return { ok: false, output: "Missing file path." };
                const resolved = this.fileTools.resolveInsideWorkspace(action.path);
                if (!fs.existsSync(resolved)) return { ok: false, output: this.fileTools.missingFileMessage(action.path) };
                if (!fs.statSync(resolved).isFile()) return { ok: false, output: `delete_file only removes files: ${action.path}` };
                fs.rmSync(resolved);
                this.getProjectIndex().markDirty();
                return { ok: true, changed: true, output: `Deleted ${action.path}` };
            }

            if (action.action === "mcp_list_tools") {
                return { ok: true, output: await this.mcpTool.listTools(action.server) };
            }

            if (action.action === "mcp_call_tool") {
                return {
                    ok: true,
                    output: await this.mcpTool.callTool(action.server, action.tool, action.arguments)
                };
            }

            if (action.action === "refine_task") {
                return { ok: false, output: "refine_task must be handled by the interactive agent loop." };
            }

            if (!action.command.trim()) {
                return { ok: false, output: "Missing command." };
            }

            const commandOutput = await this.commandTool.runCommand(
                action.command,
                action.workdir,
                action.mode,
                action.timeout_ms,
                action.expect
            );
            // Finite checks are usually read-only, but package/scaffold commands
            // may create files. Refresh lazily before the next indexed search.
            this.getProjectIndex().markDirty();
            return { ok: true, output: commandOutput };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (action.action === "run_command") {
                const commandError = error as Error & { code?: string; commandOutput?: string };
                if (commandError.code === "EOUTPUTASSERT") {
                    return {
                        ok: true,
                        assertionPassed: false,
                        output: `Command exited with code 0, but its explicit output assertion did not match. Treat the exit code as command/build evidence only; it does not prove the asserted runtime behavior. Do not repeat the same command with invented output text. Run the distinct verification required by the task or use an exact observable string grounded in inspected project evidence.\n${message}`
                    };
                }
                if (commandError.code === "ETIMEDOUT" && action.mode === "probe") {
                    const observedOutput = commandError.commandOutput?.trim() || "[No output was observed before timeout]";
                    if (action.expect) {
                        try {
                            this.commandTool.assertCommandOutput(observedOutput, action.expect);
                            return {
                                ok: true,
                                assertionPassed: true,
                                probeTimedOut: true,
                                output: `Probe observation window ended and the process tree was terminated. The grounded output assertion passed before timeout.\n${observedOutput}`
                            };
                        } catch (assertionError) {
                            const assertionMessage = assertionError instanceof Error ? assertionError.message : String(assertionError);
                            return {
                                ok: true,
                                assertionPassed: false,
                                probeTimedOut: true,
                                output: `Probe observation window ended and the process tree was terminated. The command did not prove the requested behavior.\n${assertionMessage}`
                            };
                        }
                    }
                    return {
                        ok: true,
                        assertionPassed: false,
                        probeTimedOut: true,
                        output: `Probe observation window ended and the process tree was terminated. Startup without a grounded output assertion is inconclusive and is not runtime or interaction verification.\n${observedOutput}`
                    };
                }
                // A timed-out or failed scaffold/install may still leave files.
                this.getProjectIndex().markDirty();
                const scriptRecovery = packageScriptRecovery(process.cwd(), action.command, message, action.workdir);
                const guidance = commandFailureGuidance(process.cwd(), action.command, message, this.inferenceApiUrl, action.workdir);
                const sourceContext = this.fileTools.diagnosticSourceContext(message, action.command, action.workdir);
                return {
                    ok: false,
                    failureKind: commandFailureKind(action.command, message, this.inferenceApiUrl),
                    ...(scriptRecovery ? {
                        recommendedCommand: scriptRecovery.command,
                        recommendedWorkdir: scriptRecovery.workdir,
                        ...(scriptRecovery.mode ? { recommendedMode: scriptRecovery.mode } : {})
                    } : {}),
                    output: `Recovery guidance: ${guidance}${sourceContext ? `\n${sourceContext}` : ""}\nOriginal command error:\n${message}`
                };
            }
            return { ok: false, output: message };
        }
    }

}

module.exports = { AgentActionExecutor };
