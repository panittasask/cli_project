import axios = require("axios");
import readline = require("node:readline");
import fs = require("node:fs");
import path = require("node:path");
const { loadCliSettings, getSamplingSettings } = require("./config") as {
    loadCliSettings: (appRoot?: string) => CliSettings;
    getSamplingSettings: (settings: CliSettings, kind: "chat" | "planner" | "action") => SamplingSettings;
};
const { AgentTrace } = require("./agentTrace") as { AgentTrace: new (logPath?: string) => {
    add: (entry: {
        turn: number;
        status: "action" | "ok" | "error" | "parse_error" | "final";
        action?: string | undefined;
        reason?: string | undefined;
        arguments?: unknown;
        observation?: string | undefined;
    }) => void;
    save: () => void;
    print: () => void;
} };
const { Spinner } = require("./spinner") as { Spinner: new (message?: string) => {
    start: () => void;
    stop: () => void;
    update: (message: string) => void;
    log: (message: string) => void;
} };
const { ImageTool } = require("./tools/imageTool") as { ImageTool: new () => {
    parseImagePrompt: (input: string) => { filePath: string; prompt: string } | undefined;
    toDataUrl: (inputPath: string) => string;
} };
const { ReadFileTool } = require("./tools/readFileTool") as { ReadFileTool: new () => {
    parseReadFilePrompt: (input: string) => { filePath: string; prompt: string } | undefined;
    readFileForPrompt: (inputPath: string) => string;
} };
const { EditFileTool } = require("./tools/editFileTool") as { EditFileTool: new () => {
    parseEditFilePrompt: (input: string) => { filePath: string; instruction: string } | undefined;
    readTargetFile: (inputPath: string) => string;
    writeEditedFile: (inputPath: string, content: string) => void;
} };
const { ToolRouter } = require("./tools/toolRouter") as { ToolRouter: new () => {
    buildRouterMessages: (message: string) => Array<{ role: "system" | "user"; content: string }>;
    parseDecision: (content: string | undefined | null) => {
        needsTool: boolean;
        tool: "readfile" | "editfile" | "none";
        filePath: string;
        needsMoreContext: boolean;
        contextFiles: string[];
        contextReason: string;
    } | undefined;
} };
const { AgentTool } = require("./tools/agentTool") as { AgentTool: new () => {
    buildSystemPrompt: () => Promise<string>;
    parseAction: (content: string | undefined | null) => unknown;
    execute: (action: unknown) => Promise<{ ok: boolean; output: string }>;
    formatActionStatus: (action: unknown, turn: number, maxTurns: number) => string;
    formatObservation: (action: unknown, result: { ok: boolean; output: string }) => string;
    close: () => Promise<void>;
} };
const { SessionTool } = require("./session") as { SessionTool: new () => {
    selectSession: (rl: readline.Interface) => Promise<{ id: string; title: string }>;
    getContextMessages: (sessionId: string, maxMessages?: number, afterTimestamp?: number) => Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
    appendExchange: (sessionId: string, userMessage: string, assistantMessage: string) => void;
} };

type ChatSession = {
    id: string;
    title: string;
};

type SessionMessage = {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
};

type RunMode = "planner" | "fast" | "agent";

type ModelCommandResult = {
    type: "show" | "set";
    model?: string;
} | undefined;

type WorkspaceCommandResult = {
    type: "show" | "set";
    workspace?: string;
} | undefined;

type EditRequest = {
    filePath: string;
    instruction: string;
};

type SlashCommandOption = {
    command: string;
    description: string;
};

type CliSettings = {
    llamaCppPath?: string;
    modelPath?: string;
    defaultModel?: string;
    contextLength?: number;
    device?: string;
    debug?: boolean;
    historyMessages?: number;
    sampling?: Partial<Record<"chat" | "planner" | "action", Partial<SamplingSettings>>>;
};

type SamplingSettings = {
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
    max_tokens: number;
};

const appRoot = process.cwd();

function initializeWorkspaceFromArgs(): string {
    const args = process.argv.slice(2);
    const workspaceFlagIndex = args.findIndex((item) => item === "--workspace" || item === "--cwd");
    const workspaceValue = workspaceFlagIndex >= 0 ? args[workspaceFlagIndex + 1] : undefined;

    if (!workspaceValue) {
        return process.cwd();
    }

    const resolvedWorkspace = path.resolve(process.cwd(), workspaceValue);

    if (!fs.existsSync(resolvedWorkspace)) {
        throw new Error(`Workspace not found: ${resolvedWorkspace}`);
    }

    if (!fs.statSync(resolvedWorkspace).isDirectory()) {
        throw new Error(`Workspace is not a directory: ${resolvedWorkspace}`);
    }

    // Agent tools use process.cwd() as their safety boundary, so switching cwd
    // here makes every read/write/search operate inside the selected project.
    process.chdir(resolvedWorkspace);
    return resolvedWorkspace;
}

const cliSettings = loadCliSettings();
let activeWorkspace = initializeWorkspaceFromArgs();
const promptLabel = "You: ";
const maxVisibleSlashSuggestions = 5;
const slashCommandOptions: SlashCommandOption[] = [
    { command: "/help", description: "show help" },
    { command: "/mode", description: "show or switch mode" },
    { command: "/mode planner", description: "plan first, then answer" },
    { command: "/mode fast", description: "answer immediately" },
    { command: "/mode agent", description: "use agentic tool loop" },
    { command: "/planner", description: "switch to planner mode" },
    { command: "/fast", description: "switch to fast mode" },
    { command: "/agent", description: "switch to agent mode" },
    { command: "/img", description: "analyze an image file" },
    { command: "/readfile", description: "read a text/code file" },
    { command: "/editfile", description: "edit a file with AI" },
    { command: "/workspace", description: "show or change workspace" },
    { command: "/model", description: "show loaded and available models" },
    { command: "/clear", description: "start a clean task context" },
    { command: "/debug", description: "show or hide agent trace" },
    { command: "/debug on", description: "show agent trace" },
    { command: "/debug off", description: "hide agent trace" },
    { command: "/exit", description: "exit the app" }
];
const slashCommands = slashCommandOptions.map((item) => item.command);

let slashMenuVisible = false;
let slashKeypressListenerAttached = false;
let renderedSlashSuggestionCount = 0;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
        const trimmed = line.trim();

        if (!trimmed.startsWith("/")) {
            return [[], line];
        }

        const hits = slashCommands.filter((cmd) => cmd.startsWith(trimmed));
        return [hits.length > 0 ? hits : slashCommands, trimmed];
    }
});

const apiUrl = process.env.LLAMA_API_URL?.trim()
    || "http://127.0.0.1:8080/v1/chat/completions";
const modelDirectory = process.env.LLAMA_MODEL_DIR?.trim() || cliSettings.modelPath?.trim() || "D:\\Model";
const defaultModel = process.env.LLAMA_MODEL?.trim()
    || cliSettings.defaultModel?.trim()
    || "qwen2.5-coder-7b-instruct-q4_k_m.gguf";
const configuredContextValue = Number(
    process.env.LLAMA_CONTEXT_LENGTH?.trim() || cliSettings.contextLength || 65536
);
const configuredContextLength = Number.isFinite(configuredContextValue) && configuredContextValue >= 512
    ? Math.floor(configuredContextValue)
    : 65536;
let model = defaultModel;
let plannerModel = defaultModel;
const chatSampling = getSamplingSettings(cliSettings, "chat");
const plannerSampling = getSamplingSettings(cliSettings, "planner");
const actionSampling = getSamplingSettings(cliSettings, "action");
const historyMessageLimit = Math.max(0, Math.floor(cliSettings.historyMessages ?? 6));
let contextStartedAt = 0;
let debugEnabled = process.env.CLI_DEBUG
    ? /^(1|true|on|yes)$/i.test(process.env.CLI_DEBUG.trim())
    : cliSettings.debug === true;

const sessionTool = new SessionTool();
const imageTool = new ImageTool();
const readFileTool = new ReadFileTool();
const editFileTool = new EditFileTool();
const toolRouter = new ToolRouter();
const agentTool = new AgentTool();

function getAvailableModelFiles(): string[] {
    try {
        return fs.readdirSync(modelDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gguf"))
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right));
    } catch {
        return [];
    }
}

async function getLoadedServerModels(): Promise<string[]> {
    try {
        const modelsUrl = new URL("/v1/models", apiUrl).toString();
        const response = await axios.get(modelsUrl, { timeout: 2000 });
        const entries = Array.isArray(response.data?.data) ? response.data.data : [];

        return entries
            .map((entry: { id?: unknown }) => entry?.id)
            .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
    } catch {
        return [];
    }
}

async function getServerContextInfo(): Promise<{ contextLength: number; totalSlots?: number } | undefined> {
    try {
        const propsUrl = new URL("/props", apiUrl).toString();
        const response = await axios.get(propsUrl, { timeout: 2000 });
        const contextLength = Number(response.data?.default_generation_settings?.n_ctx);
        const totalSlots = Number(response.data?.total_slots);

        if (!Number.isFinite(contextLength) || contextLength <= 0) {
            return undefined;
        }

        return {
            contextLength: Math.floor(contextLength),
            ...(Number.isFinite(totalSlots) && totalSlots > 0 ? { totalSlots: Math.floor(totalSlots) } : {})
        };
    } catch {
        return undefined;
    }
}

async function syncModelFromServer(): Promise<boolean> {
    const [loadedModel] = await getLoadedServerModels();
    if (!loadedModel) {
        return false;
    }

    model = loadedModel;
    plannerModel = loadedModel;
    return true;
}

async function printModelInfo(): Promise<void> {
    const [loadedModels, serverContext] = await Promise.all([
        getLoadedServerModels(),
        getServerContextInfo()
    ]);
    const availableFiles = getAvailableModelFiles();

    console.log(`CLI request model: ${model}`);
    console.log(loadedModels.length > 0
        ? `Loaded by llama.cpp: ${loadedModels.join(", ")}`
        : "Loaded by llama.cpp: unavailable (server is not running or still loading)");
    console.log(`Configured context: ${configuredContextLength.toLocaleString()} tokens`);
    console.log(serverContext
        ? `Active server context: ${serverContext.contextLength.toLocaleString()} tokens per slot${serverContext.totalSlots ? ` (${serverContext.totalSlots} slot${serverContext.totalSlots === 1 ? "" : "s"})` : ""}`
        : "Active server context: unavailable (use /model while llama.cpp is running)");
    console.log(`Model directory: ${modelDirectory}`);

    if (availableFiles.length === 0) {
        console.log("Available GGUF models: none found");
    } else {
        console.log("Available GGUF models:");
        availableFiles.forEach((fileName, index) => {
            console.log(`  [${index + 1}] ${fileName}`);
        });
    }

    console.log("To load another model: stop the llama.cpp server, run npm run llama, then select its number.");
    console.log();
}

function toModelMessages(history: SessionMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
    return history.map((item) => ({
        role: item.role,
        content: item.content
    }));
}

function printModeHelp(currentMode: RunMode): void {
    console.log(`Current mode: ${currentMode}`);
    console.log("Available modes:");
    console.log("- planner: run planning before answer");
    console.log("- fast: answer immediately");
    console.log("- agent: let the model inspect files, edit, and run checks in a loop");
    console.log("Use /mode planner to run planning before answer");
    console.log("Use /mode fast to answer immediately");
    console.log("Use /mode agent to run the agentic tool loop");
    console.log();
}

function printCommandHelp(currentMode: RunMode): void {
    console.log("Available commands:");
    console.log("/help                     Show command help");
    console.log("/mode                     Show current mode");
    console.log("/mode planner             Enable planner mode");
    console.log("/mode fast                Enable fast mode");
    console.log("/mode agent               Enable agentic mode");
    console.log("/planner                  Shortcut for /mode planner");
    console.log("/fast                     Shortcut for /mode fast");
    console.log("/agent                    Shortcut for /mode agent");
    console.log("/img <path> | <prompt>    Ask using image input");
    console.log("/readfile <path> | <prompt>   Ask using file input");
    console.log("/editfile <path> | <instruction>   Edit file with AI instruction");
    console.log("/workspace                Show current workspace");
    console.log("/workspace <path>         Change workspace for agent/files");
    console.log("/model                    Show loaded and available GGUF models");
    console.log("                            Switch GGUF by restarting npm run llama");
    console.log("/clear                    Start a new task context; keep session history");
    console.log("/debug [on|off]           Show status or toggle concise agent trace");
    console.log("/exit                     Exit the app");
    console.log();
    printModeHelp(currentMode);
}

function getSlashSuggestions(line: string): SlashCommandOption[] {
    const trimmedStart = line.trimStart();
    const firstToken = trimmedStart.split(/\s+/, 1)[0] ?? "";

    if (!firstToken.startsWith("/")) {
        return [];
    }

    if (trimmedStart === "/") {
        return slashCommandOptions;
    }

    const hits = slashCommandOptions.filter((item) => item.command.startsWith(trimmedStart));
    const suggestions = hits.length > 0 ? hits : slashCommandOptions;
    return suggestions.slice(0, maxVisibleSlashSuggestions);
}

function getInputCursorColumn(): number {
    // 0-based column where the user's cursor sits on the prompt line
    return promptLabel.length + rl.cursor;
}

function restoreCursorToInput(linesAbove: number): void {
    if (linesAbove > 0) {
        process.stdout.write(`\x1b[${linesAbove}A`);
    }
    // absolute horizontal move is scroll-safe (1-based column)
    process.stdout.write(`\x1b[${getInputCursorColumn() + 1}G`);
}

function clearSlashSuggestions(): void {
    if (renderedSlashSuggestionCount === 0 || !process.stdout.isTTY) {
        return;
    }

    const count = renderedSlashSuggestionCount;

    for (let index = 0; index < count; index += 1) {
        process.stdout.write("\n");
        readline.clearLine(process.stdout, 0);
    }

    restoreCursorToInput(count);
    slashMenuVisible = false;
    renderedSlashSuggestionCount = 0;
}

function renderSlashSuggestions(line: string): void {
    if (!process.stdout.isTTY) {
        return;
    }

    const suggestions = getSlashSuggestions(line);
    if (suggestions.length === 0) {
        return;
    }

    const lines = suggestions.map((item, index) => {
        const prefix = index === 0 ? ">" : " ";
        return `${prefix} ${item.command.padEnd(10, " ")} ${item.description}`;
    });

    lines.forEach((lineContent) => {
        process.stdout.write("\n");
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`\x1b[2m${lineContent}\x1b[0m`);
    });

    restoreCursorToInput(lines.length);
    slashMenuVisible = true;
    renderedSlashSuggestionCount = lines.length;
}

function updateSlashSuggestions(): void {
    if (!process.stdout.isTTY) {
        return;
    }

    clearSlashSuggestions();
    renderSlashSuggestions(rl.line);
}

function clearSlashSuggestionsBelow(): void {
    // Called right after Enter: readline has already moved the cursor down to
    // the first panel line, so clearing from cursor to end of screen removes it.
    if (renderedSlashSuggestionCount > 0 && process.stdout.isTTY) {
        readline.clearScreenDown(process.stdout);
    }

    slashMenuVisible = false;
    renderedSlashSuggestionCount = 0;
}

function parseModelCommand(input: string): ModelCommandResult {
    const trimmed = input.trim();

    if (trimmed === "/model") {
        return { type: "show" };
    }

    if (!trimmed.toLowerCase().startsWith("/model ")) {
        return undefined;
    }

    const nextModel = trimmed.slice(7).trim();
    if (!nextModel) {
        return { type: "show" };
    }

    return {
        type: "set",
        model: nextModel
    };
}

function parseWorkspaceCommand(input: string): WorkspaceCommandResult {
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "/workspace" || lower === "/cwd") {
        return { type: "show" };
    }

    if (!lower.startsWith("/workspace ") && !lower.startsWith("/cwd ")) {
        return undefined;
    }

    const rawWorkspace = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
    if (!rawWorkspace) {
        return { type: "show" };
    }

    const workspace = ((rawWorkspace.startsWith('"') && rawWorkspace.endsWith('"'))
        || (rawWorkspace.startsWith("'") && rawWorkspace.endsWith("'")))
        ? rawWorkspace.slice(1, -1).trim()
        : rawWorkspace;

    return {
        type: "set",
        workspace
    };
}

function changeWorkspace(workspace: string): string {
    const resolvedWorkspace = path.resolve(process.cwd(), workspace);

    if (!fs.existsSync(resolvedWorkspace)) {
        throw new Error(`Workspace not found: ${resolvedWorkspace}`);
    }

    if (!fs.statSync(resolvedWorkspace).isDirectory()) {
        throw new Error(`Workspace is not a directory: ${resolvedWorkspace}`);
    }

    // Agent/file tools use process.cwd() as their active project boundary.
    // Changing cwd here moves the read/write/search sandbox for later prompts.
    process.chdir(resolvedWorkspace);
    activeWorkspace = resolvedWorkspace;
    return activeWorkspace;
}

function parseModeCommand(input: string): RunMode | "show" | undefined {
    const normalized = input.trim().toLowerCase();

    if (normalized === "/mode" || normalized === "mode") {
        return "show";
    }

    if (normalized === "/planner") {
        return "planner";
    }

    if (normalized === "/fast") {
        return "fast";
    }

    if (normalized === "/agent") {
        return "agent";
    }

    if (!normalized.startsWith("/mode ")) {
        return undefined;
    }

    const value = normalized.slice(6).trim();
    if (value === "planner" || value === "fast" || value === "agent") {
        return value;
    }

    return undefined;
}

function findUnknownSlashCommand(input: string): string | undefined {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
        return undefined;
    }

    const lower = trimmed.toLowerCase();

    if (lower === "/help" || lower === "/exit" || lower === "/planner" || lower === "/fast" || lower === "/agent") {
        return undefined;
    }

    if (lower === "/workspace" || lower.startsWith("/workspace ") || lower === "/cwd" || lower.startsWith("/cwd ")) {
        return undefined;
    }

    if (lower === "/mode" || lower.startsWith("/mode ")) {
        const parsedMode = parseModeCommand(trimmed);
        return parsedMode ? undefined : trimmed.split(/\s+/, 2)[0];
    }

    if (lower === "/model" || lower.startsWith("/model ")) {
        const parsedModel = parseModelCommand(trimmed);
        return parsedModel ? undefined : trimmed.split(/\s+/, 2)[0];
    }

    if (lower.startsWith("/img ") || lower.startsWith("/readfile ") || lower.startsWith("/editfile ")) {
        return undefined;
    }

    return trimmed.split(/\s+/, 2)[0];
}

function stripCodeFence(content: string): string {
    const trimmed = content.trim();

    if (!trimmed.startsWith("```")) {
        return trimmed;
    }

    const lines = trimmed.split("\n");
    if (lines.length < 3) {
        return trimmed;
    }

    if (!lines[0]?.startsWith("```")) {
        return trimmed;
    }

    if (lines[lines.length - 1]?.trim() !== "```") {
        return trimmed;
    }

    return lines.slice(1, -1).join("\n");
}

function detectEditIntent(input: string): boolean {
    const lower = input.toLowerCase();
    const keywords = [
        "แก้",
        "แก้ไข",
        "แก้ให้",
        "เพิ่มเติม",
        "เพิ่ม",
        "ปรับ",
        "ปรับปรุง",
        "เขียน",
        "รีแฟคเตอร์",
        "refactor",
        "fix",
        "edit",
        "modify",
        "update"
    ];

    return keywords.some((word) => lower.includes(word));
}

function findExistingPathByShrinking(segment: string): string | undefined {
    const tokens = segment.trim().split(/\s+/);

    for (let count = tokens.length; count >= 1; count -= 1) {
        const candidate = tokens.slice(0, count).join(" ").replace(/[|"']+$/, "").trim();
        if (resolveExistingFile(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function extractPathFromMessage(input: string): string | undefined {
    const quotedMatch = input.match(/"([^"\n]+)"|'([^'\n]+)'/);
    if (quotedMatch) {
        const pathFromQuote = (quotedMatch[1] || quotedMatch[2] || "").trim();
        if (pathFromQuote.includes("/") || pathFromQuote.includes("\\") || pathFromQuote.includes(".")) {
            return pathFromQuote;
        }
    }

    // Windows drive path that may contain spaces (e.g. D:\Work Space\app.ts question...)
    const driveMatch = input.match(/[A-Za-z]:\\/);
    if (driveMatch && driveMatch.index !== undefined) {
        const found = findExistingPathByShrinking(input.slice(driveMatch.index));
        if (found) {
            return found;
        }
    }

    // Relative or unix-like path that may contain spaces
    const relMatch = input.match(/(\.{0,2}[\\/][^\s|]*|[A-Za-z0-9_.-]+[\\/])/);
    if (relMatch && relMatch.index !== undefined) {
        const found = findExistingPathByShrinking(input.slice(relMatch.index));
        if (found) {
            return found;
        }
    }

    const pathPattern = /([A-Za-z]:\\[^\s|]+|(?:\.\.?[\\/]|[A-Za-z0-9_.-]+[\\/])[^\s|]+)/;
    const pathMatch = input.match(pathPattern);

    return pathMatch?.[1]?.trim();
}

function resolveExistingFile(candidate: string | undefined): string | undefined {
    if (!candidate) {
        return undefined;
    }

    try {
        const resolved = path.resolve(process.cwd(), candidate);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return candidate;
        }
    } catch {
        return undefined;
    }

    return undefined;
}

type ToolDecision = {
    tool: "readfile" | "editfile" | "none";
    filePath: string;
    contextFiles: string[];
    contextReason: string;
};

function keywordFallbackDecision(message: string): ToolDecision {
    const filePath = resolveExistingFile(extractPathFromMessage(message));
    if (!filePath) {
        return { tool: "none", filePath: "", contextFiles: [], contextReason: "" };
    }

    return {
        tool: detectEditIntent(message) ? "editfile" : "readfile",
        filePath,
        contextFiles: [],
        contextReason: ""
    };
}

function resolveContextFiles(candidates: string[]): string[] {
    const defaults = ["package.json", "tsconfig.json", "README.md"];
    const picked = candidates.length > 0 ? candidates : defaults;
    const unique = Array.from(new Set(picked));

    return unique.filter((item) => resolveExistingFile(item));
}

function buildProjectContextBlock(filePaths: string[], reason?: string): string {
    if (filePaths.length === 0) {
        return "";
    }

    const sections = filePaths.map((filePath) => {
        const content = readFileTool.readFileForPrompt(filePath);
        return `File: ${filePath}\n${content}`;
    });

    const header = reason?.trim().length
        ? `Additional project context (${reason.trim()}):`
        : "Additional project context:";

    return `${header}\n\n${sections.join("\n\n---\n\n")}`;
}

async function routeTool(message: string): Promise<ToolDecision> {
    try {
        const response = await axios.post(apiUrl, {
            model,
            messages: toolRouter.buildRouterMessages(message),
            ...actionSampling
        });

        const decision = toolRouter.parseDecision(response.data.choices[0].message.content);

        if (decision) {
            if (!decision.needsTool || decision.tool === "none") {
                return {
                    tool: "none",
                    filePath: "",
                    contextFiles: decision.needsMoreContext ? resolveContextFiles(decision.contextFiles) : [],
                    contextReason: decision.contextReason
                };
            }

            const filePath = resolveExistingFile(decision.filePath)
                ?? resolveExistingFile(extractPathFromMessage(message));

            if (filePath) {
                return {
                    tool: decision.tool,
                    filePath,
                    contextFiles: decision.needsMoreContext ? resolveContextFiles(decision.contextFiles) : [],
                    contextReason: decision.contextReason
                };
            }
        }
    } catch {
        // Ignore and fall back to keyword detection below.
    }

    return keywordFallbackDecision(message);
}

async function runAgentLoop(
    userMessage: string,
    historyForModel: Array<{ role: "user" | "assistant"; content: string }>,
    spinner: { update: (message: string) => void; log: (message: string) => void }
): Promise<{ answer: string; trace: InstanceType<typeof AgentTrace> }> {
    const maxTurns = 12;
    const sourceUrls = new Set<string>();
    const trace = new AgentTrace(path.resolve(appRoot, ".cli", "logs", "agent-trace.jsonl"));
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        {
            role: "system",
            content: await agentTool.buildSystemPrompt()
        },
        ...historyForModel,
        {
            role: "user",
            content: userMessage
        }
    ];

    for (let turn = 1; turn <= maxTurns; turn += 1) {
        spinner.update(turn === 1
            ? `Planning next action (${turn}/${maxTurns})...`
            : `Reviewing results and planning (${turn}/${maxTurns})...`);

        const response = await axios.post(apiUrl, {
            model,
            messages,
            ...actionSampling
        });

        const assistantContent = response.data.choices[0].message.content?.trim() ?? "";
        const action = agentTool.parseAction(assistantContent) as {
            action?: string;
            answer?: string;
            tool?: string;
            reason?: string;
            path?: string;
            query?: string;
            command?: string;
            server?: string;
            arguments?: Record<string, unknown>;
        } | undefined;

        messages.push({
            role: "assistant",
            content: assistantContent
        });

        if (!action) {
            spinner.log(`[${turn}/${maxTurns}] Invalid model action; retrying with strict JSON`);
            trace.add({
                turn,
                status: "parse_error",
                action: "invalid_json",
                observation: assistantContent.slice(0, 1000)
            });
            messages.push({
                role: "user",
                content: "Your last response was not valid JSON. Return one valid action object only."
            });
            continue;
        }

        // The loop ends only when the model explicitly returns final. Until
        // then each action becomes an observation for the next reasoning step.
        if (action.action === "final") {
            spinner.update("Preparing final answer...");
            const answer = action.answer?.trim() || "Done.";
            const missingSources = Array.from(sourceUrls).filter((sourceUrl) => !answer.includes(sourceUrl));
            const finalAnswer = missingSources.length === 0
                ? answer
                : `${answer}\n\nSources:\n${missingSources.slice(0, 5).map((sourceUrl) => `- ${sourceUrl}`).join("\n")}`;
            trace.add({ turn, status: "final", action: "final", reason: action.reason });
            trace.save();
            return { answer: finalAnswer, trace };
        }

        spinner.log(agentTool.formatActionStatus(action, turn, maxTurns));
        spinner.update(`Executing ${action.action}...`);
        const result = await agentTool.execute(action);
        spinner.update(result.ok
            ? `Completed ${action.action}; reviewing result...`
            : `${action.action} failed; planning recovery...`);
        trace.add({
            turn,
            status: result.ok ? "ok" : "error",
            action: action.action,
            reason: action.reason,
            arguments: action,
            observation: result.output
        });
        if (action.action === "mcp_call_tool" && action.tool?.toLowerCase().includes("search") && result.ok) {
            const urls = result.output.match(/https?:\/\/[^"\\\s]+/g) || [];
            urls.forEach((sourceUrl) => sourceUrls.add(sourceUrl));
        }
        messages.push({
            role: "user",
            content: `Observation: ${agentTool.formatObservation(action, result)}`
        });
    }

    spinner.log(`[${maxTurns}/${maxTurns}] Tool limit reached; preparing a final summary`);
    spinner.update("Summarizing completed work...");
    messages.push({
        role: "user",
        content: `No more tool actions are available for this task. Return one final JSON object now:
{"action":"final","answer":"Summarize what was completed, validations that actually ran, any failures, and concrete remaining work."}
Do not call another tool. Do not claim unverified success.`
    });

    try {
        const response = await axios.post(apiUrl, {
            model,
            messages,
            ...actionSampling
        });
        const assistantContent = response.data.choices[0].message.content?.trim() ?? "";
        const finalAction = agentTool.parseAction(assistantContent) as {
            action?: string;
            answer?: string;
            reason?: string;
        } | undefined;

        if (finalAction?.action === "final" && finalAction.answer?.trim()) {
            const answer = finalAction.answer.trim();
            const missingSources = Array.from(sourceUrls).filter((sourceUrl) => !answer.includes(sourceUrl));
            const finalAnswer = missingSources.length === 0
                ? answer
                : `${answer}\n\nSources:\n${missingSources.slice(0, 5).map((sourceUrl) => `- ${sourceUrl}`).join("\n")}`;
            trace.add({
                turn: maxTurns + 1,
                status: "final",
                action: "final_after_tool_limit",
                reason: finalAction.reason
            });
            trace.save();
            return { answer: finalAnswer, trace };
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace.add({
            turn: maxTurns + 1,
            status: "error",
            action: "final_after_tool_limit",
            observation: message
        });
    }

    const answer = "Agent completed the maximum number of tool actions but could not produce a final summary. Review the trace and ask it to inspect the existing files before continuing.";
    trace.add({ turn: maxTurns + 1, status: "error", action: "final_summary_failed", observation: answer });
    trace.save();
    return { answer, trace };
}

function ask(activeSession: ChatSession, runMode: RunMode): void {
    const spinner = new Spinner("Thinking...");

    if (!slashKeypressListenerAttached) {
        slashKeypressListenerAttached = true;
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }

        process.stdin.on("keypress", (_str: string, key: readline.Key) => {
            if (key && (key.name === "return" || key.name === "enter")) {
                // Let the rl.question callback erase the panel via clearScreenDown
                // once readline has emitted its newline.
                return;
            }

            // defer so rl.line and rl.cursor reflect the just-typed key
            setImmediate(updateSlashSuggestions);
        });
    }

    rl.question("You: ", async (message: string) => {
        const trimmed = message.trim();
        clearSlashSuggestionsBelow();
        const modeCommand = parseModeCommand(trimmed);
        const modelCommand = parseModelCommand(trimmed);
        const workspaceCommand = parseWorkspaceCommand(trimmed);
        const unknownSlashCommand = findUnknownSlashCommand(trimmed);

        if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "/exit") {
            await agentTool.close();
            rl.close();
            process.exit(0);
        }

        if (trimmed.toLowerCase() === "/help") {
            printCommandHelp(runMode);
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/clear") {
            contextStartedAt = Date.now();
            console.log("Task context cleared. Saved session history was kept.");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/debug") {
            console.log(`Agent trace: ${debugEnabled ? "on" : "off"}`);
            console.log("Use /debug on or /debug off.");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (/^\/debug\s+(on|off)$/i.test(trimmed)) {
            debugEnabled = /\bon$/i.test(trimmed);
            console.log(`Agent trace: ${debugEnabled ? "on" : "off"}`);
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase().startsWith("/debug ")) {
            console.log("Invalid debug command. Use /debug, /debug on, or /debug off");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (modelCommand?.type === "show") {
            await printModelInfo();
            ask(activeSession, runMode);
            return;
        }

        if (modelCommand?.type === "set" && modelCommand.model) {
            console.log("Models can only be selected when llama.cpp starts.");
            console.log("Stop the server with Ctrl+C, run npm run llama, and select a model number.");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (workspaceCommand?.type === "show") {
            console.log(`Current workspace: ${activeWorkspace}`);
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (workspaceCommand?.type === "set" && workspaceCommand.workspace) {
            try {
                await agentTool.close();
                const nextWorkspace = changeWorkspace(workspaceCommand.workspace);
                console.log(`Workspace switched to: ${nextWorkspace}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.log(`Workspace error: ${message}`);
            }

            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (modeCommand === "show") {
            printModeHelp(runMode);
            ask(activeSession, runMode);
            return;
        }

        if (modeCommand === "planner" || modeCommand === "fast" || modeCommand === "agent") {
            console.log(`Mode switched to: ${modeCommand}`);
            console.log();
            ask(activeSession, modeCommand);
            return;
        }

        if (trimmed.toLowerCase().startsWith("/mode ")) {
            console.log("Invalid mode. Use /mode planner, /mode fast, or /mode agent");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase().startsWith("/model ") && !modelCommand) {
            console.log("Invalid model command. Use /model or /model <name>");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase().startsWith("/file ")) {
            console.log("Command renamed. Use /readfile <path> | <prompt>");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (unknownSlashCommand) {
            console.log(`Unknown command: ${unknownSlashCommand}`);
            console.log("Use /help to see available commands.");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.length === 0) {
            ask(activeSession, runMode);
            return;
        }

        try {
            const imagePrompt = imageTool.parseImagePrompt(trimmed);
            const explicitReadPrompt = readFileTool.parseReadFilePrompt(trimmed);
            const explicitEditPrompt = editFileTool.parseEditFilePrompt(trimmed);

            spinner.start();

            let implicitEditPrompt: EditRequest | undefined;
            let implicitReadPrompt: { filePath: string; prompt: string } | undefined;
            let requestedContextFiles: string[] = [];
            let contextReason = "";
            const sessionHistory = sessionTool.getContextMessages(activeSession.id, historyMessageLimit, contextStartedAt);
            const historyForModel = toModelMessages(sessionHistory);

            if (runMode === "agent" && !imagePrompt && !explicitReadPrompt && !explicitEditPrompt && !trimmed.startsWith("/")) {
                const result = await runAgentLoop(trimmed, historyForModel, spinner);
                spinner.stop();
                if (debugEnabled) {
                    result.trace.print();
                }
                console.log("AI:", result.answer);
                console.log();

                sessionTool.appendExchange(activeSession.id, trimmed, result.answer);
                ask(activeSession, runMode);
                return;
            }

            if (!imagePrompt && !explicitReadPrompt && !explicitEditPrompt && !trimmed.startsWith("/")) {
                const decision = await routeTool(trimmed);
                requestedContextFiles = decision.contextFiles;
                contextReason = decision.contextReason;

                if (decision.tool === "editfile" && decision.filePath) {
                    implicitEditPrompt = { filePath: decision.filePath, instruction: trimmed };
                } else if (decision.tool === "readfile" && decision.filePath) {
                    implicitReadPrompt = { filePath: decision.filePath, prompt: trimmed };
                }
            }

            const projectContextBlock = buildProjectContextBlock(requestedContextFiles, contextReason);

            const editFilePrompt = explicitEditPrompt ?? implicitEditPrompt;
            const readFilePrompt = explicitReadPrompt ?? implicitReadPrompt;
            let plannerPayload = "";

            if (runMode === "planner") {
                const plannerInput = imagePrompt
                    ? `${imagePrompt.prompt} (Image path: ${imagePrompt.filePath})`
                    : readFilePrompt
                        ? `${readFilePrompt.prompt} (File path: ${readFilePrompt.filePath})`
                        : editFilePrompt
                            ? `${editFilePrompt.instruction} (Edit file path: ${editFilePrompt.filePath})`
                    : trimmed;

                const planner = await axios.post(apiUrl, {
                    model: plannerModel,
                    messages: [
                        {
                            role: "user",
                            content: `You are a planning agent.
Your job is NOT to solve the task.
Your job is to:
Understand the user's objective.
Break the objective into small executable tasks.
Identify required tools.
Produce a concise execution plan.
Rules:
Do not explain your reasoning.
Do not solve the task.
Do not generate code.
Keep plans short and actionable.
Prefer 3-10 steps.

Return ONLY valid JSON.

Do not wrap the response in markdown.

Do not use code fences.

Do not include explanations before or after the JSON.

Create the smallest valid plan.

Do not split tasks unnecessarily.

A task should only be split when the next step depends on the previous one.

Answer in Thai Language.

JSON Schema:
{
"goal": "string",
"summary": "string",
"requires_tools": boolean,
"tasks": [
{
"id": 1,
"description": "string"
}
]
}
User Prompt: ${plannerInput}`
                        }
                    ],
                    ...plannerSampling
                });

                const plannerMessage = planner.data.choices[0].message.content?.trim() ?? "{}";
                plannerPayload = plannerMessage;

                try {
                    plannerPayload = JSON.stringify(JSON.parse(plannerMessage));
                } catch {
                    plannerPayload = plannerMessage;
                }
            }

            if (editFilePrompt) {
                const originalContent = editFileTool.readTargetFile(editFilePrompt.filePath);
                const editSystemInstruction = runMode === "planner"
                    ? `You are an expert code editor.
Apply the user's instruction to the provided file content.
Stay consistent with the existing project setup visible in the file (dependencies, scripts, tooling, code style).
Do not introduce tools, frameworks, or dependencies that are not already present unless the user explicitly asks for them.
Return ONLY the final updated full file content.
Do not include markdown fences.
Do not add explanations.
Internal planner output: ${plannerPayload}`
                    : `You are an expert code editor.
Apply the user's instruction to the provided file content.
Stay consistent with the existing project setup visible in the file (dependencies, scripts, tooling, code style).
Do not introduce tools, frameworks, or dependencies that are not already present unless the user explicitly asks for them.
Return ONLY the final updated full file content.
Do not include markdown fences.
Do not add explanations.`;

                const editResponse = await axios.post(apiUrl, {
                    model,
                    messages: [
                        {
                            role: "system",
                            content: editSystemInstruction
                        },
                        {
                            role: "user",
                            content: `File path: ${editFilePrompt.filePath}
Instruction: ${editFilePrompt.instruction}

Current file content:
${originalContent}

${projectContextBlock}`
                        }
                    ],
                    ...actionSampling
                });

                const editedRaw = editResponse.data.choices[0].message.content?.trim() ?? "";
                const editedContent = stripCodeFence(editedRaw);

                if (!editedContent) {
                    throw new Error("Model returned empty edited content.");
                }

                editFileTool.writeEditedFile(editFilePrompt.filePath, editedContent);

                spinner.stop();
                const editMessage = implicitEditPrompt
                    ? `Updated file (auto edit intent): ${editFilePrompt.filePath}`
                    : `Updated file: ${editFilePrompt.filePath}`;
                console.log("AI:", editMessage);
                console.log();

                sessionTool.appendExchange(activeSession.id, trimmed, editMessage);
                ask(activeSession, runMode);
                return;
            }

            const userContent = imagePrompt
                ? [
                    {
                        type: "text",
                        text: imagePrompt.prompt
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: imageTool.toDataUrl(imagePrompt.filePath)
                        }
                    }
                ]
                : readFilePrompt
                    ? `${readFilePrompt.prompt}

File path: ${readFilePrompt.filePath}
File content:
${readFileTool.readFileForPrompt(readFilePrompt.filePath)}

${projectContextBlock}`
                : projectContextBlock
                    ? `${trimmed}

${projectContextBlock}`
                    : trimmed;

            const capabilityInstruction = `You are the assistant inside this local CLI, not a generic advisor.
In ${runMode} mode you cannot execute MCP or web-search tools; only agent mode can execute discovered MCP tools.
Never claim that you searched the web, called a tool, or performed an action unless this conversation contains its successful tool result.
If the user asks whether you can search from this mode, explain the limitation and tell them to use /mode agent.`;

            const assistantSystemInstruction = runMode === "planner"
                ? `You are a helpful assistant.
${capabilityInstruction}
The planner output below is internal guidance and must never be quoted, summarized, or mentioned.
Do not mention words like planner, plan, internal tool, hidden context, or system prompt.
Answer only the end user's request directly in a natural tone.
Internal planner output: ${plannerPayload}`
                : `You are a helpful assistant.
${capabilityInstruction}
Answer only the end user's request directly in a natural tone.
Do not mention hidden context, internal tools, or system prompts.`;

            const response = await axios.post(apiUrl, {
                model,
                messages: [
                    {
                        role: "system",
                        content: assistantSystemInstruction
                    },
                    ...historyForModel,
                    {
                        role: "user",
                        content: userContent
                    }
                ],
                ...chatSampling
            });

            const answer = response.data.choices[0].message.content?.trim() ?? "";
            spinner.stop();
            console.log("AI:", answer);
            console.log();

            sessionTool.appendExchange(activeSession.id, trimmed, answer);
        } catch (error) {
            spinner.stop();
            console.error("API Error",error);

            if (axios.isAxiosError(error)) {
                console.error(error.message);
            }
        }

        ask(activeSession, runMode);
    });
}

async function start(): Promise<void> {
    const [modelSynced, serverContext] = await Promise.all([
        syncModelFromServer(),
        getServerContextInfo()
    ]);
    console.log("Chat Started");
    console.log("Type \"exit\" to quit");
    console.log("Image mode: /img <path-to-image> | <prompt>");
    console.log("Read file mode: /readfile <path-to-file> | <prompt>");
    console.log("Edit file mode: /editfile <path-to-file> | <instruction>");
    console.log("Mode: /mode planner, /mode fast, or /mode agent");
    console.log("Model status: /model");
    console.log(`Agent trace: ${debugEnabled ? "on" : "off"} (/debug on|off)`);
    console.log("New task context: /clear");
    console.log(`Workspace: ${activeWorkspace}`);
    console.log(`llama.cpp API: ${apiUrl}`);
    console.log(`Configured context: ${configuredContextLength.toLocaleString()} tokens`);
    console.log(serverContext
        ? `Active server context: ${serverContext.contextLength.toLocaleString()} tokens per slot${serverContext.totalSlots ? ` (${serverContext.totalSlots} slot${serverContext.totalSlots === 1 ? "" : "s"})` : ""}`
        : "Active server context: unavailable");
    console.log(modelSynced
        ? `llama.cpp loaded model: ${model}`
        : "llama.cpp status: server is not running or still loading");
    console.log("Workspace option: --workspace <project-path>");
    console.log("Tip: type / to see inline command suggestions");
    console.log();

    const activeSession = await sessionTool.selectSession(rl);
    console.log(`Session: ${activeSession.title}`);
    console.log();

    const initialMode: RunMode = "agent";
    console.log(`Current mode: ${initialMode}`);
    console.log(`Current model: ${model}`);
    console.log();

    ask(activeSession, initialMode);
}

start().catch((error) => {
    console.error("Failed to start chat", error);
    rl.close();
    process.exit(1);
});
