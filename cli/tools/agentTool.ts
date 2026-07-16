import childProcess = require("node:child_process");
import fs = require("node:fs");
import path = require("node:path");
const { McpTool } = require("./mcpTool") as { McpTool: new () => {
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
        action: "run_command";
        command: string;
    }
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
};

class AgentTool {
    private readonly maxFileChars = 20000;
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
    private readonly mcpTool = new McpTool();

    async buildSystemPrompt(workflowInstructions = ""): Promise<string> {
        const mcpSection = await this.mcpTool.buildPromptSection();
        const runtimeSection = process.platform === "win32"
            ? `Runtime platform: Windows. run_command executes Windows PowerShell.
Use PowerShell commands such as Get-ChildItem, Get-Content, and Select-String. Do not use Unix-only commands such as grep, sed, or awk.`
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
{"action":"run_command","command":"safe read-only or verification command","reason":"brief rationale"}
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
- If the user names an exact file path, act on that path directly instead of listing the workspace to look for it.
- Preserve existing style and dependencies unless the user asks otherwise.
- Prefer edit_file for an existing file: old_text must match exactly once, and new_text contains only its replacement.
- Use write_file for new files or when a complete replacement is genuinely necessary. For write_file, provide the full final file content.
- Use write_file to create files and parent directories. run_command is only for read-only inspection or verification; never use mkdir, New-Item, redirection, or shell commands to create files.
- Verify file contents with read_file or search_files instead of shell pipelines whenever possible.
- Never assume a localhost server is running or that a workspace file is available over HTTP. Call a local URL only after a successful observation confirms that exact server and port are running.
- If a verification command fails, recover with an OS-compatible command or a relevant read_file/search_files action before reporting verified success.
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

        if (action === "run_command") {
            return {
                action,
                command: typeof data.command === "string" ? data.command : "",
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
        const builtInActions = new Set([
            "final",
            "list_files",
            "search_files",
            "read_file",
            "write_file",
            "edit_file",
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

                this.writeFile(action.path, action.content);
                return { ok: true, output: `Wrote ${action.path}` };
            }

            if (action.action === "edit_file") {
                const prepared = this.prepareEdit(action.path, action.old_text, action.new_text);
                if (!prepared.ok || prepared.content === undefined) {
                    return { ok: false, output: prepared.output };
                }
                this.writeFile(action.path, prepared.content);
                return { ok: true, output: `Edited ${action.path} with one exact replacement` };
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

            return { ok: true, output: this.runCommand(action.command) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, output: message };
        }
    }

    async close(): Promise<void> {
        await this.mcpTool.close();
    }

    prepareEdit(inputPath: string, oldText: string, newText: string): { ok: boolean; output: string; content?: string } {
        if (!inputPath.trim()) return { ok: false, output: "Missing file path." };
        if (!oldText) return { ok: false, output: "edit_file old_text must not be empty." };

        const resolved = this.resolveInsideWorkspace(inputPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            return { ok: false, output: `File not found: ${inputPath}` };
        }
        const current = fs.readFileSync(resolved, "utf8");
        const matchCount = current.split(oldText).length - 1;
        if (matchCount !== 1) {
            return {
                ok: false,
                output: matchCount === 0
                    ? `edit_file old_text was not found in ${inputPath}. Read the file again and use an exact match.`
                    : `edit_file old_text matched ${matchCount} locations in ${inputPath}; provide more surrounding text so it matches exactly once.`
            };
        }
        return { ok: true, output: "Exact replacement prepared.", content: current.replace(oldText, newText) };
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
            if (action.action === "run_command") return `Running check: ${clean(action.command)}`;
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
        return `${limited.join("\n")}${suffix}`;
    }

    private searchFiles(query: string, inputPath?: string): string {
        const root = this.resolveInsideWorkspace(inputPath || ".");
        const regex = new RegExp(query, "i");
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
            throw new Error(`File not found: ${inputPath}`);
        }

        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            throw new Error(`Not a file: ${inputPath}`);
        }

        const buffer = fs.readFileSync(resolved);
        if (buffer.includes(0)) {
            throw new Error("Binary file is not supported.");
        }

        return this.truncate(buffer.toString("utf8"), this.maxFileChars);
    }

    private writeFile(inputPath: string, content: string): void {
        const resolved = this.resolveInsideWorkspace(inputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf8");
    }

    private runCommand(command: string): string {
        if (!this.isSafeCommand(command)) {
            throw new Error(`Blocked unsafe command: ${command}`);
        }

        if (process.platform === "win32" && /\b(grep|sed|awk)\b/i.test(command)) {
            throw new Error("Unsupported Unix command on Windows PowerShell. Use Select-String or a built-in file action instead.");
        }

        const output = process.platform === "win32"
            ? childProcess.execFileSync("powershell.exe", [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command
            ], {
                cwd: process.cwd(),
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 30000,
                windowsHide: true
            })
            : childProcess.execSync(command, {
            cwd: process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30000,
            windowsHide: true
        });

        return output.trim() || "[Command completed with no output]";
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
            /(^|[^<])>(?!>)/,
            /\bsetx\b/,
            /\bgit\s+reset\b/,
            /\bgit\s+checkout\b/,
            /\bgit\s+clean\b/,
            /\bnpm\s+publish\b/
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

        for (const entry of entries) {
            if (entry.isDirectory() && this.ignoredDirectories.has(entry.name.toLowerCase())) {
                continue;
            }

            const absolute = path.join(root, entry.name);
            const relative = path.relative(process.cwd(), absolute) || ".";

            if (entry.isDirectory()) {
                this.walk(absolute, files);
            } else if (entry.isFile()) {
                files.push(relative);
            }
        }
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

        return `${content.slice(0, maxChars)}\n\n[Truncated to first ${maxChars} characters]`;
    }
}

module.exports = {
    AgentTool
};
