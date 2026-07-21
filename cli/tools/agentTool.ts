import childProcess = require("node:child_process");
import fs = require("node:fs");
import path = require("node:path");
const { normalizeClarificationRequest } = require("../clarification") as {
    normalizeClarificationRequest: (
        question: unknown,
        options: unknown,
        decision: unknown,
        reason?: string
    ) => import("../clarificationTypes").ClarificationRequest | undefined;
};
const { commandFailureGuidance, commandInteractiveRisk, commandTimeoutMs, packageContentAddsBrowserAutoOpen, resolveCommandWorkdir, unwrapWindowsPowerShellCommand } = require("../commandNormalizer") as {
    commandFailureGuidance: (workspace: string, command: string, errorOutput: string) => string;
    commandInteractiveRisk: (command: string, workspace: string, workdir?: string) => string | undefined;
    commandTimeoutMs: (command: string) => number;
    packageContentAddsBrowserAutoOpen: (filePath: string, content: string) => boolean;
    resolveCommandWorkdir: (workspace: string, command: string, requestedWorkdir?: string) => { workdir: string; autoSelected: boolean };
    unwrapWindowsPowerShellCommand: (command: string) => string;
};
const { McpTool } = require("./mcpTool") as { McpTool: new (configRoot?: string) => {
    buildPromptSection: () => Promise<string>;
    listTools: (serverName?: string) => Promise<string>;
    callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>;
    resolveDirectCall: (toolName: string, payload: Record<string, unknown>) => {
        server: string;
        tool: string;
        arguments: Record<string, unknown>;
    } | undefined;
    close: () => Promise<void>;
} };

type AgentAction = (
    | {
        action: "final";
        answer: string;
    }
    | {
        action: "list_files";
        path?: string;
    }
    | {
        action: "search_files";
        query: string;
        path?: string;
    }
    | {
        action: "read_file";
        path: string;
    }
    | {
        action: "write_file";
        path: string;
        content: string;
    }
    | {
        action: "edit_file";
        path: string;
        old_text: string;
        new_text: string;
    }
    | {
        action: "delete_file";
        path: string;
    }
    | {
        action: "run_command";
        command: string;
        workdir?: string;
    }
    | ({ action: "ask_user" } & import("../clarificationTypes").ClarificationRequest)
    | {
        action: "mcp_list_tools";
        server?: string;
    }
    | {
        action: "mcp_call_tool";
        server: string;
        tool: string;
        arguments: Record<string, unknown>;
    }) & {
        reason?: string | undefined;
    };

type AgentToolResult = {
    ok: boolean;
    output: string;
    changed?: boolean;
};

class AgentTool {
    private readonly maxFileChars = 6000;
    private readonly maxObservationChars = 12000;
    private readonly maxListedFiles = 180;
    private readonly ignoredDirectories = new Set([
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
        "coverage",
        "$recycle.bin",
        "system volume information",
        "recovery"
    ]);
    private readonly mcpTool: InstanceType<typeof McpTool>;

    constructor(configRoot = process.cwd(), private readonly commandTimeoutOverrideMs?: number) {
        this.mcpTool = new McpTool(configRoot);
    }

    async inspectCapabilities(): Promise<{ servers: Array<Record<string, unknown>> }> {
        try {
            const parsed = JSON.parse(await this.mcpTool.listTools()) as { servers?: unknown };
            return { servers: Array.isArray(parsed.servers) ? parsed.servers as Array<Record<string, unknown>> : [] };
        } catch (error) {
            return { servers: [{ name: "MCP discovery", error: error instanceof Error ? error.message : String(error) }] };
        }
    }

    async buildSystemPrompt(workflowInstructions = ""): Promise<string> {
        const mcpSection = await this.mcpTool.buildPromptSection();
        const runtimeSection = process.platform === "win32"
            ? `Runtime platform: Windows. run_command executes Windows PowerShell.
Use PowerShell commands such as Get-ChildItem, Get-Content, and Select-String. Do not use Unix-only commands such as grep, sed, or awk.
Set run_command.workdir to a relative workspace directory instead of using Set-Location or cd.
If workdir is omitted and exactly one nested package manifest matches the requested executable or package script, the runner selects that directory automatically.
Dependency installation and project scaffolding may run for up to three minutes. After a real timeout, inspect files before retrying because the command may have created partial output.
Never add automatic browser-opening flags such as --open to package scripts. Do not run dev servers, watch commands, or browser-based interactive tests; use finite build and non-watch test commands.
Do not wrap commands in another powershell.exe invocation. Do not use Bash separators such as && or a bare & to background a process.`
            : `Runtime platform: ${process.platform}. run_command executes the platform shell.`;
        // The model is controlled through a small JSON protocol so the CLI can
        // safely decide which local capability to execute on each agent turn.
        return `You are a helpful local CLI assistant and coding agent running inside a user's project workspace.
You may have a natural conversation, inspect files, search code, edit files, run safe verification commands, and call only the MCP tools listed below.
Work in small steps. Use tools until you have enough evidence, then return final.

${runtimeSection}

${workflowInstructions}

Return ONLY valid JSON. No markdown. No code fences. No text outside JSON.
For every tool action, include "reason" with one short user-visible sentence explaining why that action is the useful next step. Use the user's language when practical. This is a decision summary, not private chain-of-thought.

Available actions:
{"action":"list_files","path":"optional relative path","reason":"brief rationale"}
{"action":"search_files","query":"text or regex","path":"optional relative path","reason":"brief rationale"}
{"action":"read_file","path":"relative path","reason":"brief rationale"}
{"action":"write_file","path":"relative path","content":"full updated file content","reason":"brief rationale"}
{"action":"edit_file","path":"relative path","old_text":"exact existing text","new_text":"replacement text","reason":"brief rationale"}
{"action":"delete_file","path":"relative file path","reason":"brief rationale"}
{"action":"run_command","command":"safe read-only or verification command","workdir":"optional relative directory","reason":"brief rationale"}
{"action":"ask_user","decision":"target|scope|compatibility|destructive|cost|external|preference","question":"one concrete decision needed","options":[{"id":"stable_id","label":"short choice","description":"impact of choosing it"},{"id":"second_id","label":"another choice","description":"impact of choosing it"}],"reason":"why this ambiguity blocks a correct action"}
{"action":"mcp_list_tools","server":"optional configured server name","reason":"brief rationale"}
{"action":"mcp_call_tool","server":"configured server name","tool":"tool name","arguments":{},"reason":"brief rationale"}
Call discovered MCP tools through mcp_call_tool using the exact configured server and tool names.
{"action":"final","answer":"final answer to the user"}

Rules:
- Be precise about your own capabilities. Never claim to have a tool, internet access, search results, or an executed action unless it appears in Available actions or Discovered MCP tools and you successfully used it.
- When asked whether you can search or use a tool, answer about this CLI's actual discovered capabilities, not generic websites the user could visit.
- For current, niche, or external information, call a relevant MCP search tool before answering. Base the answer on its observation and include the returned source URLs.
- If a required tool is unavailable or its call fails, say so plainly. Do not fabricate results and do not pretend that telling the user to search is equivalent to searching.
- Prefer reading relevant files before editing.
- Resolve uncertainty from accessible conversation, files, manifests, configuration, and tool observations first. Uncertainty by itself is not a blocker. Use ask_user only when required information is absent after inspection and choosing incorrectly would materially change scope, compatibility, cost, data, or an irreversible effect.
- Use ask_user instead of final for a blocking clarification. Offer 2-6 concrete, mutually distinct choices grounded in observed facts. Do not add an "Other" option; the CLI always accepts free-text answers outside the choices.
- Classify every clarification by its actual decision type. Use preference only for naming, styling, layout, or minor implementation details; preference questions are rejected because they are safely inferable and reversible. Never mislabel a preference as scope or target.
- For workspace mutations, inspect before asking. Ask only when inspection reveals at least two genuinely plausible targets or a required value is still missing. Never ask whether to create a new project or use an existing one before inspecting manifests; use the single existing matching project, and create a new one only when requested or when none exists.
- Normally ask at most once per task. A second clarification is allowed only after a new command, validation, or missing-target blocker appears. Ask one decision at a time and continue the same task after the answer.
- A tool, validation, build, or dependency error is diagnostic evidence, not a new product decision. Inspect the referenced files and manifests, correct or revert the incompatible approach, and retry safely. Do not ask the user to choose troubleshooting commands, retry flags, or dependency-conflict workarounds.
- For package operations, establish the exact package name, target project root, package manager, and production versus development role from the request and manifests. Inspect first, then use ask_user if any material choice remains or multiple project roots are plausible.
- If the user names an exact file path, act on that path directly instead of listing the workspace to look for it.
- Preserve existing style and dependencies unless the user asks otherwise.
- Before importing a package that is not already declared, inspect the project manifest. Prefer an implementation using the existing stack; do not make a new dependency a prerequisite unless the request requires it and its compatible version is established from project evidence.
- Treat each directory containing a manifest as a separate project root. If an obsolete project is being removed and its replacement already exists in another root, delete the obsolete files after reading them instead of repurposing that manifest with guessed dependencies.
- Prefer edit_file for an existing file: old_text must match exactly once, and new_text contains only its replacement.
- Use delete_file when the user asks to remove an obsolete file. Read it first. Never simulate deletion by replacing a manifest or source file with empty content.
- Use write_file for new files or when a complete replacement is genuinely necessary. For write_file, provide the full final file content.
- Use write_file to create files and parent directories. Use run_command for read-only inspection, finite verification, or package/scaffold operations explicitly requested by the user; never use mkdir, New-Item, redirection, or generic shell commands to create files.
- Verify file contents with read_file or search_files instead of shell pipelines whenever possible.
- Never assume a localhost server is running or that a workspace file is available over HTTP. Call a local URL only after a successful observation confirms that exact server and port are running.
- If a verification command fails, recover with an OS-compatible command or a relevant read_file/search_files action before reporting verified success.
- If a project manifest is missing or damaged but a lockfile exists, inspect the lockfile and existing project configuration to recover compatible versions. Do not invent or downgrade dependency versions.
- Preserve a lockfile that is co-located with its project manifest unless the user explicitly asks to remove that lockfile. An orphan lockfile without a same-directory manifest may be removed when it belongs to an obsolete project.
- Treat phrases such as "until it works", "จนกว่าจะผ่าน", and "ให้ใช้งานได้" as completion criteria, not requests for advice. Keep using actions until the requested observable result is verified.
- A successful build proves compilation only. For runtime behavior such as a URL, endpoint, server, or Swagger UI, probe the actual local behavior before returning final.
- Do not run destructive commands.
- Answer the final user in Thai unless the user asks for another language.

${mcpSection}`;
    }

    parseAction(content: string | undefined | null): AgentAction | undefined {
        if (!content) {
            return undefined;
        }

        const raw = content.trim();
        // Local models sometimes wrap an action in prose or emit more than one
        // object. Parse balanced objects independently so one extra object does
        // not make the whole response invalid.
        const parsed = this.extractJsonObjects(raw).find((candidate) => {
            const action = typeof candidate.action === "string" ? candidate.action : "";
            return this.isSupportedAction(action, candidate);
        });

        if (!parsed) {
            return undefined;
        }

        const data = parsed;
        const action = typeof data.action === "string" ? data.action : "";
        const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 300) : undefined;

        if (action === "final") {
            return {
                action,
                answer: typeof data.answer === "string" ? data.answer : "",
                reason
            };
        }

        if (action === "ask_user") {
            const request = normalizeClarificationRequest(data.question, data.options, data.decision, reason);
            return request ? { action, ...request } : undefined;
        }

        if (action === "list_files") {
            const pathValue = typeof data.path === "string" ? data.path : undefined;
            return pathValue ? { action, path: pathValue, reason } : { action, reason };
        }

        if (action === "search_files") {
            const query = typeof data.query === "string" ? data.query : "";
            const pathValue = typeof data.path === "string" ? data.path : undefined;
            return pathValue ? { action, query, path: pathValue, reason } : { action, query, reason };
        }

        if (action === "read_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                reason
            };
        }

        if (action === "write_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                content: typeof data.content === "string" ? data.content : "",
                reason
            };
        }

        if (action === "edit_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                old_text: typeof data.old_text === "string" ? data.old_text : "",
                new_text: typeof data.new_text === "string" ? data.new_text : "",
                reason
            };
        }

        if (action === "delete_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                reason
            };
        }

        if (action === "run_command") {
            const workdir = typeof data.workdir === "string" ? data.workdir : undefined;
            return {
                action,
                command: typeof data.command === "string" ? data.command : "",
                ...(workdir ? { workdir } : {}),
                reason
            };
        }

        if (action === "mcp_list_tools") {
            const server = typeof data.server === "string" ? data.server : undefined;
            return server ? { action, server, reason } : { action, reason };
        }

        if (action === "mcp_call_tool") {
            return {
                action,
                server: typeof data.server === "string" ? data.server : "",
                tool: typeof data.tool === "string" ? data.tool : "",
                arguments: data.arguments && typeof data.arguments === "object" && !Array.isArray(data.arguments)
                    ? data.arguments as Record<string, unknown>
                    : {},
                reason
            };
        }

        const directMcpCall = this.mcpTool.resolveDirectCall(action, data);
        if (directMcpCall) {
            return {
                action: "mcp_call_tool",
                server: directMcpCall.server,
                tool: directMcpCall.tool,
                arguments: directMcpCall.arguments,
                reason
            };
        }

        return undefined;
    }

    explainParseFailure(content: string | undefined | null): string {
        if (!content?.trim()) {
            return "empty model content";
        }

        const objects = this.extractJsonObjects(content.trim());
        if (objects.length === 0) {
            return "no valid JSON object found in model content";
        }

        const actions = objects
            .map((candidate) => typeof candidate.action === "string" ? candidate.action : "")
            .filter(Boolean);
        if (actions.length === 0) {
            return "valid JSON object is missing a string action field";
        }

        const unsupportedActions = actions.filter((action, index) => (
            actions.indexOf(action) === index
            && !objects.some((candidate) => candidate.action === action && this.isSupportedAction(action, candidate))
        ));

        return unsupportedActions.length > 0
            ? `unsupported action: ${unsupportedActions.join(", ")}`
            : "model content did not produce one supported action";
    }

    private extractJsonObjects(raw: string): Array<Record<string, unknown>> {
        const objects: Array<Record<string, unknown>> = [];

        for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
            let depth = 0;
            let inString = false;
            let escaped = false;

            for (let index = start; index < raw.length; index += 1) {
                const character = raw[index];

                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (character === "\\") {
                        escaped = true;
                    } else if (character === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (character === '"') {
                    inString = true;
                } else if (character === "{") {
                    depth += 1;
                } else if (character === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        try {
                            const parsed = JSON.parse(raw.slice(start, index + 1)) as unknown;
                            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                                objects.push(parsed as Record<string, unknown>);
                            }
                        } catch {
                            // Try the next opening brace; a later object may be valid.
                        }
                        break;
                    }
                }
            }
        }

        return objects;
    }

    private isSupportedAction(action: string, data: Record<string, unknown>): boolean {
        if (action === "ask_user") {
            const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 300) : undefined;
            return Boolean(normalizeClarificationRequest(data.question, data.options, data.decision, reason));
        }
        const builtInActions = new Set([
            "final",
            "list_files",
            "search_files",
            "read_file",
            "write_file",
            "edit_file",
            "delete_file",
            "run_command",
            "mcp_list_tools",
            "mcp_call_tool"
        ]);

        return builtInActions.has(action) || Boolean(this.mcpTool.resolveDirectCall(action, data));
    }

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
                return { ok: true, output: this.listFiles(action.path) };
            }

            if (action.action === "search_files") {
                if (!action.query.trim()) {
                    return { ok: false, output: "Missing search query." };
                }

                return { ok: true, output: this.searchFiles(action.query, action.path) };
            }

            if (action.action === "read_file") {
                if (!action.path.trim()) {
                    return { ok: false, output: "Missing file path." };
                }

                return { ok: true, output: this.readFile(action.path) };
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
                const mcpConfigError = this.mcpConfigWriteError(action.path, action.content);
                if (mcpConfigError) return { ok: false, output: mcpConfigError };

                const writeTarget = this.resolveInsideWorkspace(action.path);
                if (fs.existsSync(writeTarget) && fs.statSync(writeTarget).isFile()
                    && fs.readFileSync(writeTarget, "utf8") === action.content) {
                    return { ok: true, changed: false, output: `No change needed: ${action.path} already has the requested content.` };
                }

                this.writeFile(action.path, action.content);
                return { ok: true, changed: true, output: `Wrote ${action.path}` };
            }

            if (action.action === "edit_file") {
                const prepared = this.prepareEdit(action.path, action.old_text, action.new_text);
                if (!prepared.ok || prepared.content === undefined) {
                    return { ok: false, output: prepared.output };
                }
                if (packageContentAddsBrowserAutoOpen(action.path, prepared.content)) {
                    return { ok: false, output: "Blocked package script: automatic browser-opening flags such as --open are not allowed. Use a normal start script without auto-open." };
                }
                const mcpConfigError = this.mcpConfigWriteError(action.path, prepared.content);
                if (mcpConfigError) return { ok: false, output: mcpConfigError };
                const editTarget = this.resolveInsideWorkspace(action.path);
                if (fs.readFileSync(editTarget, "utf8") === prepared.content) {
                    return { ok: true, changed: false, output: `No change needed: ${action.path} already contains the requested replacement.` };
                }
                this.writeFile(action.path, prepared.content);
                return { ok: true, changed: true, output: `Edited ${action.path} with one exact replacement` };
            }

            if (action.action === "delete_file") {
                if (!action.path.trim()) return { ok: false, output: "Missing file path." };
                const resolved = this.resolveInsideWorkspace(action.path);
                if (!fs.existsSync(resolved)) return { ok: false, output: this.missingFileMessage(action.path) };
                if (!fs.statSync(resolved).isFile()) return { ok: false, output: `delete_file only removes files: ${action.path}` };
                fs.rmSync(resolved);
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

            if (!action.command.trim()) {
                return { ok: false, output: "Missing command." };
            }

            return { ok: true, output: await this.runCommand(action.command, action.workdir) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (action.action === "run_command") {
                const guidance = commandFailureGuidance(process.cwd(), action.command, message);
                const sourceContext = this.diagnosticSourceContext(message, action.command, action.workdir);
                return {
                    ok: false,
                    output: `Recovery guidance: ${guidance}${sourceContext ? `\n${sourceContext}` : ""}\nOriginal command error:\n${message}`
                };
            }
            return { ok: false, output: message };
        }
    }

    async close(): Promise<void> {
        await this.mcpTool.close();
    }

    prepareEdit(inputPath: string, oldText: string, newText: string): { ok: boolean; output: string; content?: string; changed?: boolean } {
        if (!inputPath.trim()) return { ok: false, output: "Missing file path." };
        if (!oldText) return { ok: false, output: "edit_file old_text must not be empty." };

        const resolved = this.resolveInsideWorkspace(inputPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            return { ok: false, output: this.missingFileMessage(inputPath) };
        }
        const current = fs.readFileSync(resolved, "utf8");
        const matchCount = current.split(oldText).length - 1;
        if (matchCount === 0 && newText) {
            const replacementCount = current.split(newText).length - 1;
            if (replacementCount === 1) {
                return {
                    ok: true,
                    changed: false,
                    output: `Replacement is already present in ${inputPath}.`,
                    content: current
                };
            }
        }
        if (matchCount !== 1) {
            return {
                ok: false,
                output: matchCount === 0
                    ? `edit_file old_text was not found in ${inputPath}. Read the file again and use an exact match. If line endings or whitespace still prevent an exact replacement after reading, use write_file with the complete corrected file content.`
                    : `edit_file old_text matched ${matchCount} locations in ${inputPath}; provide more surrounding text so it matches exactly once.`
            };
        }
        const content = current.replace(oldText, newText);
        return {
            ok: true,
            changed: content !== current,
            output: content === current ? `Replacement is already present in ${inputPath}.` : "Exact replacement prepared.",
            content
        };
    }

    formatActionStatus(action: AgentAction, turn: number, maxTurns: number): string {
        const clean = (value: string | undefined, maxChars = 100): string => {
            const redacted = (value ?? "")
                .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
                .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
                .replace(/\s+/g, " ")
                .trim();
            return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 3)}...` : redacted;
        };
        const target = (() => {
            if (action.action === "list_files") return `Listing files: ${clean(action.path || ".")}`;
            if (action.action === "search_files") return `Searching files: ${clean(action.query)}`;
            if (action.action === "read_file") return `Reading file: ${clean(action.path)}`;
            if (action.action === "write_file") return `Writing file: ${clean(action.path)}`;
            if (action.action === "edit_file") return `Editing file: ${clean(action.path)}`;
            if (action.action === "delete_file") return `Deleting file: ${clean(action.path)}`;
            if (action.action === "run_command") {
                const location = action.workdir ? ` in ${clean(action.workdir)}` : "";
                return `Running check${location}: ${clean(action.command)}`;
            }
            if (action.action === "ask_user") return `Waiting for clarification: ${clean(action.question)}`;
            if (action.action === "mcp_list_tools") return `Discovering MCP tools${action.server ? `: ${clean(action.server)}` : ""}`;
            if (action.action === "mcp_call_tool") return `Calling tool: ${clean(`${action.server}.${action.tool}`)}`;
            return "Preparing final answer";
        })();
        const reason = clean(action.reason, 120);

        return `[${turn}/${maxTurns}] ${target}${reason ? ` - ${reason}` : ""}`;
    }

    formatObservation(action: AgentAction, result: AgentToolResult): string {
        const actionName = action.action;
        const status = result.ok ? "ok" : "error";
        const output = this.truncate(result.output, this.maxObservationChars);

        const observation: Record<string, unknown> = {
            action: actionName,
            status,
            output
        };
        if (result.changed !== undefined) observation.changed = result.changed;

        if (action.action === "mcp_call_tool" && action.tool.toLowerCase().includes("search")) {
            observation.requiredFollowup = result.ok
                ? "Answer the user's question from these results and include exact source URLs. Do not merely list websites or suggest that the user search."
                : "Tell the user the search failed. Do not invent external facts or sources.";
        }

        return JSON.stringify(observation);
    }

    private listFiles(inputPath?: string): string {
        const root = this.resolveInsideWorkspace(inputPath || ".");
        const files: string[] = [];

        this.walk(root, files);

        const limited = files.slice(0, this.maxListedFiles);
        const suffix = files.length > limited.length ? `\n[Truncated: ${files.length - limited.length} more files]` : "";
        return limited.length > 0 ? `${limited.join("\n")}${suffix}` : "[Workspace is empty]";
    }

    private searchFiles(query: string, inputPath?: string): string {
        const root = this.resolveInsideWorkspace(inputPath || ".");
        const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const files: string[] = [];
        const matches: string[] = [];

        this.walk(root, files);

        for (const relativeFile of files) {
            const absoluteFile = path.resolve(process.cwd(), relativeFile);
            let buffer: Buffer;
            try {
                buffer = fs.readFileSync(absoluteFile);
            } catch {
                continue;
            }
            if (buffer.includes(0)) {
                continue;
            }

            const lines = buffer.toString("utf8").split(/\r?\n/);
            lines.forEach((line, index) => {
                if (regex.test(line)) {
                    matches.push(`${relativeFile}:${index + 1}: ${line.trim()}`);
                }
            });

            if (matches.length >= 120) {
                break;
            }
        }

        return matches.length > 0 ? matches.join("\n") : "No matches.";
    }

    private readFile(inputPath: string): string {
        const resolved = this.resolveInsideWorkspace(inputPath);

        if (!fs.existsSync(resolved)) {
            throw new Error(this.missingFileMessage(inputPath));
        }

        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            throw new Error(`Not a file: ${inputPath}`);
        }

        const buffer = fs.readFileSync(resolved);
        if (buffer.includes(0)) {
            throw new Error("Binary file is not supported.");
        }

        const content = buffer.toString("utf8");
        return this.truncate(`${content}${this.relatedManifestRecoveryContext(resolved, content)}`, this.maxFileChars);
    }

    private relatedManifestRecoveryContext(resolved: string, content: string): string {
        if (path.basename(resolved).toLowerCase() !== "package.json") return "";

        try {
            const manifest = JSON.parse(content) as Record<string, unknown>;
            const lockPath = path.join(path.dirname(resolved), "package-lock.json");
            if (!fs.existsSync(lockPath)) return "";
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
                packages?: Record<string, Record<string, unknown>>;
            };
            const root = lock.packages?.[""];
            if (!root) return "";

            const evidenceKeys = ["name", "version", "dependencies", "devDependencies"];
            const evidence = Object.fromEntries(evidenceKeys.filter((key) => root[key] !== undefined).map((key) => [key, root[key]]));
            const comparableManifest = Object.fromEntries(evidenceKeys.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]));
            if (JSON.stringify(evidence) === JSON.stringify(comparableManifest)) return "";

            return `\n\n[Recovery context: this manifest disagrees with same-directory package-lock.json root metadata. For every displayed field, copy the lockfile value exactly: remove dependency keys absent from the evidence, add keys that are present, and preserve unrelated manifest-only fields such as scripts/private. Do not guess or downgrade versions.]\n${JSON.stringify(evidence, null, 2)}`;
        } catch {
            return "";
        }
    }

    diagnosticSourceContext(errorOutput: string, command = "", requestedWorkdir?: string): string | undefined {
        const missing = errorOutput.match(/Cannot find name ['"]([^'"]+)['"]/i);
        const symbol = missing?.[1];
        if (!symbol || missing?.index === undefined) return undefined;

        const afterDiagnostic = errorOutput.slice(missing.index);
        const beforeDiagnostic = errorOutput.slice(0, missing.index);
        const location = afterDiagnostic.match(/(?:^|\r?\n)\s*([^\r\n]+?\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py)):(\d+)(?::\d+)?:/i)?.[1]
            ?? beforeDiagnostic.match(/(?:^|\r?\n)\s*([^\r\n]+?\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py))\(\d+,\d+\):[^\r\n]*$/i)?.[1]
            ?? beforeDiagnostic.match(/(?:^|\r?\n)\s*([^\r\n]+?\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py)):\d+(?::\d+)?:[^\r\n]*$/i)?.[1];
        if (!location) return undefined;

        let workdir = requestedWorkdir || ".";
        if (command.trim()) {
            try {
                workdir = resolveCommandWorkdir(process.cwd(), command, requestedWorkdir).workdir;
            } catch {
                // Keep the requested/default workdir when project inference fails.
            }
        }
        const files: string[] = [];
        this.walk(process.cwd(), files);
        const initialTarget = path.resolve(process.cwd(), workdir, location);
        const normalizedLocation = location.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
        const matchingTarget = files
            .filter((relativeFile) => relativeFile.replace(/\\/g, "/").toLowerCase().endsWith(normalizedLocation))
            .sort((left, right) => left.length - right.length)[0];
        const target = fs.existsSync(initialTarget) ? initialTarget : matchingTarget
            ? path.resolve(process.cwd(), matchingTarget)
            : initialTarget;
        const targetRelative = path.relative(process.cwd(), target).replace(/\\/g, "/");
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const exportedDefinition = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:abstract\\s+)?(?:class|function|const|let|var|interface|type|enum)\\s+${escaped}\\b`);
        const definition = files.find((relativeFile) => {
            const absolute = path.resolve(process.cwd(), relativeFile);
            if (absolute.toLowerCase() === target.toLowerCase()) return false;
            if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(relativeFile)) return false;
            try {
                return exportedDefinition.test(fs.readFileSync(absolute, "utf8"));
            } catch {
                return false;
            }
        });
        if (!definition) {
            return `Diagnostic source context: '${symbol}' is used in ${targetRelative}, but no exported definition was found in visible workspace source files. Define it or choose an existing exported symbol before retrying.`;
        }

        const definitionPath = definition.replace(/\\/g, "/");
        let moduleSpecifier = path.relative(path.dirname(target), path.resolve(process.cwd(), definition)).replace(/\\/g, "/")
            .replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, "")
            .replace(/\/index$/i, "");
        if (!moduleSpecifier.startsWith(".")) moduleSpecifier = `./${moduleSpecifier}`;
        return `Diagnostic source context: '${symbol}' is used in ${targetRelative}; an existing exported definition was found in ${definitionPath}. The target file has no in-scope declaration for that symbol. A direct source-level correction is to import it there with: import { ${symbol} } from '${moduleSpecifier}'; Keep the existing symbol reference and do not edit an unrelated registry file.`;
    }

    private writeFile(inputPath: string, content: string): void {
        const resolved = this.resolveInsideWorkspace(inputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf8");
    }

    private mcpConfigWriteError(inputPath: string, content: string): string | undefined {
        const normalizedPath = inputPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
        if (normalizedPath !== ".cli/mcp.json") return undefined;

        try {
            const parsed = JSON.parse(content) as { mcpServers?: unknown };
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
                || !parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
                return "Invalid .cli/mcp.json: it must be a JSON object with an object-valued mcpServers field. Use {\"mcpServers\":{...}}.";
            }
        } catch {
            return "Invalid .cli/mcp.json: content must be valid JSON with an object-valued mcpServers field.";
        }
        return undefined;
    }

    private async runCommand(command: string, workdir?: string): Promise<string> {
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
        const interactiveRisk = commandInteractiveRisk(normalizedCommand, process.cwd(), workdirResolution.workdir);
        if (interactiveRisk) {
            throw new Error(`Blocked interactive command: ${interactiveRisk}.`);
        }

        const timeout = this.commandTimeoutOverrideMs ?? commandTimeoutMs(normalizedCommand);
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
        return workdirResolution.autoSelected
            ? `${commandOutput}\n[Auto-selected workdir: ${workdirResolution.workdir}]`
            : commandOutput;
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
                    const error = Object.assign(new Error(`Command timed out after ${Math.ceil(timeoutMs / 1000)} seconds; the spawned process tree was terminated.`), { code: "ETIMEDOUT" });
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

    private walk(root: string, files: string[]): void {
        if (files.length >= this.maxListedFiles * 3) {
            return;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return;
        }

        entries.sort((left, right) => {
            if (left.isFile() !== right.isFile()) return left.isFile() ? -1 : 1;
            return left.name.localeCompare(right.name);
        });

        for (const entry of entries) {
            const absolute = path.join(root, entry.name);
            if (entry.isDirectory() && this.shouldIgnoreDirectory(absolute, entry.name)) {
                continue;
            }

            const relative = path.relative(process.cwd(), absolute) || ".";

            if (entry.isDirectory()) {
                this.walk(absolute, files);
            } else if (entry.isFile()) {
                files.push(relative);
            }
        }
    }

    private shouldIgnoreDirectory(absolutePath: string, name: string): boolean {
        const normalized = name.toLowerCase();
        if (this.ignoredDirectories.has(normalized) || normalized === "cache" || normalized === ".cache") return true;
        if (!normalized.startsWith(".")) return false;
        try {
            return fs.statSync(path.join(absolutePath, "cache")).isDirectory();
        } catch {
            return false;
        }
    }

    private missingFileMessage(inputPath: string): string {
        const files: string[] = [];
        this.walk(process.cwd(), files);
        const normalizedTarget = inputPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
        const targetName = path.posix.basename(normalizedTarget);
        const targetDirectory = path.posix.dirname(normalizedTarget);
        const targetExtension = path.posix.extname(targetName);
        const targetSegments = targetDirectory === "." ? [] : targetDirectory.split("/");
        const commonDirectorySuffix = (candidate: string): number => {
            const candidateSegments = path.posix.dirname(candidate).split("/");
            let shared = 0;
            while (shared < targetSegments.length && shared < candidateSegments.length
                && targetSegments[targetSegments.length - shared - 1] === candidateSegments[candidateSegments.length - shared - 1]) {
                shared += 1;
            }
            return shared;
        };
        const distance = (left: string, right: string): number => {
            const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
            for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
                const current = [leftIndex];
                for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
                    current[rightIndex] = Math.min(
                        (current[rightIndex - 1] ?? 0) + 1,
                        (previous[rightIndex] ?? 0) + 1,
                        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
                    );
                }
                previous.splice(0, previous.length, ...current);
            }
            return previous[right.length] ?? Math.max(left.length, right.length);
        };
        const candidates = files
            .map((file) => file.replace(/\\/g, "/"))
            .map((file) => {
                const name = path.posix.basename(file).toLowerCase();
                const exactNameBonus = name === targetName ? -30 : 0;
                const extensionBonus = targetExtension && path.posix.extname(name) === targetExtension ? -4 : 0;
                const directoryBonus = commonDirectorySuffix(file.toLowerCase()) * -5;
                return { file, score: distance(targetName, name) * 4 + exactNameBonus + extensionBonus + directoryBonus };
            })
            .sort((left, right) => left.score - right.score || left.file.length - right.file.length || left.file.localeCompare(right.file))
            .slice(0, 5)
            .map((candidate) => candidate.file);
        return candidates.length > 0
            ? `File not found: ${inputPath}\nClosest visible files (verify the intended target before editing):\n${candidates.map((file) => `- ${file}`).join("\n")}`
            : `File not found: ${inputPath}`;
    }

    private resolveInsideWorkspace(inputPath: string): string {
        // Keep all file reads/writes inside the current project directory.
        const workspace = process.cwd();
        const resolved = path.resolve(workspace, inputPath);
        const relative = path.relative(workspace, resolved);

        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Path is outside workspace: ${inputPath}`);
        }

        return resolved;
    }

    private truncate(content: string, maxChars: number): string {
        if (content.length <= maxChars) {
            return content;
        }

        const headChars = Math.ceil(maxChars / 2);
        const tailChars = Math.floor(maxChars / 2);
        return `${content.slice(0, headChars)}\n\n[Middle truncated; showing first ${headChars} and last ${tailChars} characters]\n\n${content.slice(-tailChars)}`;
    }
}

module.exports = {
    AgentTool
};
