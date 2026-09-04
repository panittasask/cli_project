import fs = require("node:fs");
import path = require("node:path");
const { resolveCommandWorkdir } = require("../commandNormalizer") as {
    resolveCommandWorkdir: (workspace: string, command: string, requestedWorkdir?: string) => { workdir: string; autoSelected: boolean };
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
const { ProjectIndex } = require("../projectIndex") as { ProjectIndex: new (workspace: string) => {
    markDirty: () => void;
    refresh: (force?: boolean) => void;
    summary: () => string;
    search: (query: string, limit?: number, path?: string) => string;
} };
const { ToolRegistry } = require("./toolRegistry") as { ToolRegistry: new () => {
    register: (tool: { name: string; execute: (input: unknown, context: { workspacePath: string; sessionId?: string }) => Promise<{ success: boolean; data?: unknown; error?: string }> }) => void;
    execute: (name: string, input: unknown, context: { workspacePath: string; sessionId?: string }) => Promise<{ success: boolean; data?: unknown; error?: string }>;
} };
const { WorkspaceGuard } = require("./workspaceGuard") as { WorkspaceGuard: new () => {
    resolveSafePath: (workspacePath: string, requestedPath: string) => string;
} };
const { WorkspaceFileTools } = require("./workspaceFileTools") as { WorkspaceFileTools: new (
    workspaceGuard: InstanceType<typeof WorkspaceGuard>,
    resolveCommandWorkdir: (workspace: string, command: string, requestedWorkdir?: string) => { workdir: string; autoSelected: boolean }
) => {
    prepareEdit: (inputPath: string, oldText: string, newText: string) => { ok: boolean; output: string; content?: string; changed?: boolean };
    diagnosticSourceContext: (errorOutput: string, command?: string, requestedWorkdir?: string) => string | undefined;
    listFiles: (inputPath?: string) => string;
    searchFiles: (query: string, inputPath?: string) => string;
    readFile: (inputPath: string) => string;
    writeFile: (inputPath: string, content: string) => void;
    mcpConfigWriteError: (inputPath: string, content: string) => string | undefined;
    missingFileMessage: (inputPath: string) => string;
    resolveInsideWorkspace: (inputPath: string) => string;
    truncate: (content: string, maxChars: number) => string;
} };
const { CommandTool } = require("./commandTool") as { CommandTool: new (
    resolveInsideWorkspace: (inputPath: string) => string,
    commandTimeoutOverrideMs?: number,
    inferenceApiUrl?: string
) => {
    runCommand: (command: string, workdir?: string, mode?: "normal" | "probe", requestedTimeoutMs?: number, expectation?: CommandExpectation) => Promise<string>;
    assertCommandOutput: (output: string, expectation?: CommandExpectation) => void;
} };
const { AgentActionExecutor } = require("./agentActionExecutor") as { AgentActionExecutor: new (
    fileTools: InstanceType<typeof WorkspaceFileTools>,
    commandTool: InstanceType<typeof CommandTool>,
    mcpTool: InstanceType<typeof McpTool>,
    getProjectIndex: () => InstanceType<typeof ProjectIndex>,
    inferenceApiUrl?: string
) => {
    execute: (action: AgentAction) => Promise<AgentToolResult>;
} };
type CommandExpectation = import("../agent/agentSchema").CommandExpectation;
type AgentAction = import("../agent/agentSchema").AgentAction;
type AgentToolResult = import("../agent/agentSchema").AgentToolResult;
type ActionAdmissionInput = import("../agent/action/actionAdmissionGate").ActionAdmissionInput;
type ActionAdmissionResult = import("../agent/action/actionAdmissionGate").ActionAdmissionResult;
type AgentToolOptions = {
    tolerateUnescapedControlCharacters?: boolean;
    repairMalformedJson?: boolean;
};
const { AgentActionParser } = require("../agent/agentActionParser") as { AgentActionParser: new (
    mcpTool: InstanceType<typeof McpTool>,
    options?: AgentToolOptions
) => {
    parseAction: (content: string | undefined | null) => AgentAction | undefined;
    admitContent: (content: string | undefined | null) => import("../agent/agentActionParser").AgentActionParserResult;
    explainParseFailure: (content: string | undefined | null) => string;
} };
const { ActionAdmissionGate } = require("../agent/action/actionAdmissionGate") as {
    ActionAdmissionGate: new (parser: InstanceType<typeof AgentActionParser>) => {
        admit: (input: ActionAdmissionInput) => ActionAdmissionResult;
    };
};

class AgentTool {
    private readonly maxObservationChars = 12000;
    private readonly mcpTool: InstanceType<typeof McpTool>;
    private readonly actionParser: InstanceType<typeof AgentActionParser>;
    private readonly actionAdmissionGate: InstanceType<typeof ActionAdmissionGate>;
    private readonly toolRegistry: InstanceType<typeof ToolRegistry>;
    private readonly fileTools: InstanceType<typeof WorkspaceFileTools>;
    private readonly commandTool: InstanceType<typeof CommandTool>;
    private readonly actionExecutor: InstanceType<typeof AgentActionExecutor>;
    private projectIndex: InstanceType<typeof ProjectIndex> | undefined;
    private indexedWorkspace: string | undefined;

    constructor(
        configRoot = process.cwd(),
        private readonly commandTimeoutOverrideMs?: number,
        private readonly inferenceApiUrl?: string,
        options: AgentToolOptions = {}
    ) {
        this.mcpTool = new McpTool(configRoot);
        this.actionParser = new AgentActionParser(this.mcpTool, options);
        this.actionAdmissionGate = new ActionAdmissionGate(this.actionParser);
        this.toolRegistry = new ToolRegistry();
        const workspaceGuard = new WorkspaceGuard();
        this.fileTools = new WorkspaceFileTools(workspaceGuard, resolveCommandWorkdir);
        this.commandTool = new CommandTool(
            (inputPath) => this.fileTools.resolveInsideWorkspace(inputPath),
            commandTimeoutOverrideMs,
            inferenceApiUrl
        );
        this.actionExecutor = new AgentActionExecutor(
            this.fileTools,
            this.commandTool,
            this.mcpTool,
            () => this.currentProjectIndex(),
            inferenceApiUrl
        );
        this.registerActionTools();
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
        const projectSummary = this.currentProjectIndex().summary();
        const runtimeSection = process.platform === "win32"
            ? `Runtime platform: Windows. run_command executes Windows PowerShell.
Use PowerShell commands such as Get-ChildItem, Get-Content, and Select-String. Do not use Unix-only commands such as grep, sed, or awk.
In Windows PowerShell, a bare curl command may resolve to Invoke-WebRequest; use curl.exe when curl flags are required. Do not use && as a command separator.
Set run_command.workdir to a relative workspace directory instead of using Set-Location or cd.
If workdir is omitted and exactly one nested package manifest matches the requested executable or package script, the runner selects that directory automatically.
Dependency installation and project scaffolding may run for up to three minutes. After a real timeout, inspect files before retrying because the command may have created partial output.
Never add automatic browser-opening flags such as --open to package scripts. Do not run unbounded dev servers, watch commands, or headed/manual browser sessions. A package lifecycle may be observed only through a bounded probe, and finite headless automated interaction tests are allowed.
Do not wrap commands in another powershell.exe invocation. Do not use Bash separators such as && or a bare & to background a process.`
            : `Runtime platform: ${process.platform}. run_command executes the platform shell.`;
        const inferenceBoundary = (() => {
            if (!this.inferenceApiUrl) return "";
            try {
                const origin = new URL(this.inferenceApiUrl).origin;
                return `CLI inference endpoint reserved by llama.cpp: ${origin}. If workspace server/client code uses this same loopback port, treat it as a port collision. Move the workspace runtime to a different unused port consistently before probing the real entrypoint; never substitute an auxiliary server to make verification pass.`;
            } catch {
                return "";
            }
        })();
        // The model is controlled through a small JSON protocol so the CLI can
        // safely decide which local capability to execute on each agent turn.
        return `You are a helpful local CLI assistant and coding agent running inside a user's project workspace.
You may have a natural conversation, inspect files, search code, edit files, run safe verification commands, and call only the MCP tools listed below.
Work in small steps. Use tools until you have enough evidence, then return final.

${runtimeSection}

${inferenceBoundary}

${workflowInstructions}

Return ONLY valid JSON. No markdown. No code fences. No text outside JSON.
For every tool action, include "reason" with one short user-visible sentence explaining why that action is the useful next step. Use the user's language when practical. This is a decision summary, not private chain-of-thought.
Follow the mandatory first-response contract supplied for the current protocol state. It defines the exact nested task shape and required action fields.
Classify the task semantically from the complete request and context. Choose the first evidence-producing action in that same response; there is no separate routing phase. For repository work, use the project index summary and request only relevant search results or file contents rather than asking for every file.
Set continuation true only when the current request semantically asks to resume unfinished work from the session context. A continuation may already be satisfied by the current workspace state: inspect it, run every required verification, then return final citing both workspace and verification Evidence IDs without making a cosmetic file change.
Choose every applicable evidence requirement from the requested outcome, not merely the cheapest check. Use interaction whenever success depends on a user action and its observable result. Use visual whenever success depends on rendered appearance, layout, or styling; visual work also requires interaction evidence. A build proves compilation only and must not be used as evidence that navigation, clicks, state transitions, or appearance work.
Keep verification consistent with evidence_requirements: source-only evidence uses none, command evidence uses command, runtime evidence uses runtime, and interaction evidence uses interaction. Do not declare a stronger verification mode than the evidence requirements describe.

Available actions:
{"action":"list_files","path":"optional relative path","reason":"brief rationale"}
{"action":"search_project","query":"semantic or lexical project query","path":"optional relative path","limit":12,"reason":"brief rationale"}
{"action":"search_files","query":"exact text","path":"optional relative path","reason":"brief rationale"}
{"action":"read_file","path":"relative path","reason":"brief rationale"}
{"action":"write_file","path":"relative path","content":"full updated file content","reason":"brief rationale"}
{"action":"edit_file","path":"relative path","old_text":"exact existing text","new_text":"replacement text","reason":"brief rationale"}
{"action":"delete_file","path":"relative file path","reason":"brief rationale"}
{"action":"run_command","command":"safe read-only or verification command","workdir":"optional relative directory","reason":"brief rationale"}
{"action":"run_command","command":"bounded runtime command","workdir":".","mode":"probe","timeout_ms":10000,"expect":{"exit_code":0,"output_includes":["observable success"],"output_excludes":["observable failure"]},"reason":"brief rationale"}
{"action":"refine_task","task":{"intent":"refined intent","task_type":"coding","continuation":false,"requires_workspace_changes":true,"verification":"runtime","evidence_requirements":["source","runtime"],"success_criteria":["observable result"]},"evidence":["evidence_N_read_file"],"reason":"why inspected workspace evidence changes the initial contract"}
{"action":"ask_user","decision":"target|scope|compatibility|destructive|cost|external|preference","question":"one concrete decision needed","options":[{"id":"stable_id","label":"short choice","description":"impact of choosing it"},{"id":"second_id","label":"another choice","description":"impact of choosing it"}],"reason":"why this ambiguity blocks a correct action"}
{"action":"mcp_list_tools","server":"optional configured server name","reason":"brief rationale"}
{"action":"mcp_call_tool","server":"configured server name","tool":"tool name","arguments":{},"reason":"brief rationale"}
Call discovered MCP tools through mcp_call_tool using the exact configured server and tool names.
{"action":"final","answer":"final answer to the user","completion_status":"completed|already_satisfied|no_change_needed|incomplete","evidence":["brief reference to successful tool evidence, or empty for a conversational answer"]}

Rules:
- Be precise about your own capabilities. Never claim to have a tool, internet access, search results, or an executed action unless it appears in Available actions or Discovered MCP tools and you successfully used it.
- When asked whether you can search or use a tool, answer about this CLI's actual discovered capabilities, not generic websites the user could visit.
- For current, niche, or external information, call a relevant MCP search tool before answering. Base the answer on its observation and include the returned source URLs.
- If a required tool is unavailable or its call fails, say so plainly. Do not fabricate results and do not pretend that telling the user to search is equivalent to searching.
- Prefer reading relevant files before editing.
- Treat the current project index and successful tool observations as authoritative over prior assistant claims or an interrupted journal. Session history may mention files that were later moved or deleted. If a path is absent from the current index or read_file reports it missing, do not retry or assume it is still required solely from history; use the visible manifest/source evidence to continue.
- If inspection proves the requested state already exists, return final with completion_status "already_satisfied". If evidence proves that changing files would be unnecessary or incorrect, use "no_change_needed". Copy the exact host-issued Evidence ID values from successful observations into evidence; do not invent IDs or perform a cosmetic mutation merely to create file progress. Required command/runtime/interaction verification still applies to no-change outcomes.
- If implementation progress is preserved but a required verifier is unavailable or an environment/tool blocker remains after a grounded attempt, return final with completion_status "incomplete" and describe the exact unverified criterion. Do not claim completion, change unrelated runtime configuration, create a substitute service, or call an unrelated tool merely to manufacture evidence.
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
- Use search_project first when the relevant path, symbol, import, manifest, or configuration is unknown. Use search_files for an exact text search and read_file for authoritative contents before editing.
- If workspace inspection disproves an initial evidence requirement, use refine_task with successful workspace Evidence IDs. Do not keep an impossible visual or interaction gate after evidence shows the task has no such outcome. Refinement cannot change read-only/write scope or task type.
- For runtime verification, prefer one finite command with expect.output_includes/output_excludes. Use mode probe only when a normally long-running package lifecycle must be exercised under a hard timeout. A zero exit code does not satisfy an explicit output assertion that failed.
- A long-running server probe without a grounded output assertion is an inconclusive startup observation, not proof of runtime behavior or interaction. Do not retry it with arbitrary ports or replace the project runtime with an auxiliary server. Use a finite automated verifier when available; otherwise report the remaining verification as incomplete.
- Add output_includes/output_excludes only for exact observable text grounded in inspected source, tests, or documentation. Omit output text assertions for silent build/typecheck/test scripts; their zero exit code is the command evidence. Never invent generic success text.
- When package.json exposes the lifecycle needed for a project-local executable, invoke that package script. Do not bypass it by calling the executable directly, constructing node_modules/.bin paths, or passing a binary path to npx. Run start/dev/serve/watch lifecycle scripts with mode "probe" and a finite timeout.
- Verify file contents with read_file or search_files instead of shell pipelines whenever possible.
- Never assume a localhost server is running or that a workspace file is available over HTTP. Call a local URL only after a successful observation confirms that exact server and port are running.
- If a verification command fails, recover with an OS-compatible command or a relevant read_file/search_files action before reporting verified success.
- If a project manifest is missing or damaged but a lockfile exists, inspect the lockfile and existing project configuration to recover compatible versions. Do not invent or downgrade dependency versions.
- Preserve a lockfile that is co-located with its project manifest unless the user explicitly asks to remove that lockfile. An orphan lockfile without a same-directory manifest may be removed when it belongs to an obsolete project.
- Treat phrases such as "until it works", "จนกว่าจะผ่าน", and "ให้ใช้งานได้" as completion criteria, not requests for advice. Keep using actions until the requested observable result is verified.
- A successful build proves compilation only. For runtime behavior such as a URL, endpoint, server, or Swagger UI, probe the actual local behavior before returning final.
- Do not run destructive commands.
- Answer the final user in Thai unless the user asks for another language.

Project index summary (metadata and searchable excerpts only; request authoritative contents with read_file):
${projectSummary}

${mcpSection}`;
    }

    parseAction(content: string | undefined | null): AgentAction | undefined {
        const result = this.admitAction({ content });
        return result.ok ? result.action : undefined;
    }

    admitAction(input: ActionAdmissionInput): ActionAdmissionResult {
        return this.actionAdmissionGate.admit(input);
    }

    explainParseFailure(content: string | undefined | null): string {
        return this.actionParser.explainParseFailure(content);
    }

    async execute(action: AgentAction): Promise<AgentToolResult> {
        const result = await this.toolRegistry.execute(action.action, action, { workspacePath: process.cwd() });
        if (result.success) {
            return result.data as AgentToolResult;
        }
        return { ok: false, output: result.error ?? `Tool failed: ${action.action}` };
    }

    private registerActionTools(): void {
        const actionNames = [
            "final",
            "ask_user",
            "refine_task",
            "list_files",
            "search_files",
            "search_project",
            "read_file",
            "write_file",
            "edit_file",
            "delete_file",
            "run_command",
            "mcp_list_tools",
            "mcp_call_tool"
        ];

        for (const name of actionNames) {
            this.toolRegistry.register({
                name,
                execute: async (input) => ({
                    success: true,
                    data: await this.actionExecutor.execute(input as AgentAction)
                })
            });
        }
    }

    async close(): Promise<void> {
        await this.mcpTool.close();
    }

    private currentProjectIndex(): InstanceType<typeof ProjectIndex> {
        const workspace = path.resolve(process.cwd());
        if (!this.projectIndex || this.indexedWorkspace !== workspace) {
            this.projectIndex = new ProjectIndex(workspace);
            this.indexedWorkspace = workspace;
        }
        return this.projectIndex;
    }

    prepareEdit(inputPath: string, oldText: string, newText: string): { ok: boolean; output: string; content?: string; changed?: boolean } {
        return this.fileTools.prepareEdit(inputPath, oldText, newText);
    }

    diagnosticSourceContext(errorOutput: string, command = "", requestedWorkdir?: string): string | undefined {
        return this.fileTools.diagnosticSourceContext(errorOutput, command, requestedWorkdir);
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
            if (action.action === "search_project") return `Searching project index: ${clean(action.query)}`;
            if (action.action === "search_files") return `Searching files: ${clean(action.query)}`;
            if (action.action === "read_file") return `Reading file: ${clean(action.path)}`;
            if (action.action === "write_file") return `Writing file: ${clean(action.path)}`;
            if (action.action === "edit_file") return `Editing file: ${clean(action.path)}`;
            if (action.action === "delete_file") return `Deleting file: ${clean(action.path)}`;
            if (action.action === "run_command") {
                const location = action.workdir ? ` in ${clean(action.workdir)}` : "";
                return `Running ${action.mode === "probe" ? "bounded probe" : "check"}${location}: ${clean(action.command)}`;
            }
            if (action.action === "refine_task") return `Refining task contract: ${clean(action.task.intent)}`;
            if (action.action === "ask_user") return `Waiting for clarification: ${clean(action.question)}`;
            if (action.action === "mcp_list_tools") return `Discovering MCP tools${action.server ? `: ${clean(action.server)}` : ""}`;
            if (action.action === "mcp_call_tool") return `Calling tool: ${clean(`${action.server}.${action.tool}`)}`;
            return "Preparing final answer";
        })();
        const reason = clean(action.reason, 120);

        const progress = maxTurns > 0 ? `step ${turn}/${maxTurns}` : `step ${turn}`;
        return `[${progress}] ${target}${reason ? ` - ${reason}` : ""}`;
    }

    formatObservation(action: AgentAction, result: AgentToolResult): string {
        const actionName = action.action;
        const status = result.ok ? "ok" : "error";
        const output = this.fileTools.truncate(result.output, this.maxObservationChars);

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

}

module.exports = {
    AgentTool
};
