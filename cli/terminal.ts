import axios = require("axios");
import readline = require("node:readline");
import fs = require("node:fs");
import path = require("node:path");
const {
    answerLooksLikeBlockingClarification,
    clarificationBlockReason,
    clarificationObservation,
    clarificationTranscriptLine,
    formatClarificationRequest,
    relevantClarificationInspections,
    resolveClarificationAnswer
} = require("./clarification") as {
    answerLooksLikeBlockingClarification: (answer: string) => boolean;
    clarificationBlockReason: (input: {
        workspaceMutationRequired: boolean;
        successfulInspections: number;
        answeredClarifications: number;
        hasNewBlocker: boolean;
        decision: ClarificationRequest["decision"];
        knownProjectRoots: number;
        asksNewVersusExisting: boolean;
        maxClarifications: number;
        requireInspection: boolean;
        secondRequiresBlocker: boolean;
    }) => string | undefined;
    clarificationObservation: (request: ClarificationRequest, answer: ClarificationAnswer) => Record<string, unknown>;
    clarificationTranscriptLine: (request: ClarificationRequest, answer: ClarificationAnswer) => string;
    formatClarificationRequest: (request: ClarificationRequest) => string;
    relevantClarificationInspections: (input: {
        decision: ClarificationRequest["decision"];
        question: string;
        inspections: Array<{ action: "list_files" | "search_files" | "read_file"; path?: string; query?: string }>;
    }) => Array<{ action: "list_files" | "search_files" | "read_file"; path?: string; query?: string }>;
    resolveClarificationAnswer: (request: ClarificationRequest, input: string) => ClarificationAnswer | undefined;
};
type ClarificationRequest = import("./clarificationTypes").ClarificationRequest;
type ClarificationAnswer = import("./clarificationTypes").ClarificationAnswer;
const { LlamaClient } = require("./llamaClient") as { LlamaClient: new (apiUrl: string, timeoutMs?: number) => {
    post: (
        payload: Record<string, unknown>,
        onRetry?: (attempt: number, errorCode: string) => void,
        signal?: AbortSignal
    ) => Promise<{ data: any }>;
    formatError: (error: unknown) => string;
    close: () => void;
} };
const { ModelRouterClient } = require("./modelRouter") as { ModelRouterClient: new (apiUrl: string, loadTimeoutMs?: number) => {
    list: () => Promise<RouterModel[]>;
    switch: (selection: string) => Promise<{ model: RouterModel; unloaded: string[] }>;
    formatError: (error: unknown) => string;
} };
const { loadCliSettings, getSamplingSettings, getAgentGuardSettings, getClarificationSettings, getProjectCheckProviders, initializeCliSettings, validateCliSettingsFile } = require("./config") as {
    loadCliSettings: (appRoot?: string) => CliSettings;
    getSamplingSettings: (settings: CliSettings, kind: "chat" | "planner" | "action") => SamplingSettings;
    getAgentGuardSettings: (settings: CliSettings) => AgentGuardSettings;
    getClarificationSettings: (settings: CliSettings) => ClarificationSettings;
    getProjectCheckProviders: (settings: CliSettings) => ProjectCheckProvider[];
    initializeCliSettings: (appRoot?: string) => { created: boolean; path: string; message: string };
    validateCliSettingsFile: (appRoot?: string) => { ok: boolean; path: string; source: string; errors: string[] };
};
type AgentGuardSettings = { profile: "quick" | "standard" | "deep"; maxTurns: number; maxSegments: number; maxDurationMs: number; maxCompletionTokens: number; repeatLimit: number };
type ClarificationSettings = { maxClarifications: number; requireInspection: boolean; secondRequiresBlocker: boolean };
type ProjectCheckProvider = import("./projectTypes").ProjectCheckProvider;
const { AgentGuard } = require("./agentGuard") as { AgentGuard: new (settings: AgentGuardSettings) => {
    settings: AgentGuardSettings;
    recordCompletionTokens: (tokens: number) => void;
    checkBudget: (turn: number) => string | undefined;
    registerAction: (action: Record<string, unknown>) => { status: "allow" | "replan" | "stop"; message?: string };
    resetActionHistory: () => void;
    recordFileProgress: () => void;
    pause: () => void;
    resume: () => void;
    formatRemaining: () => string;
} };
const { commandAddsTooling, commandCreatesWorkspaceFiles, commandMutatesWorkspaceFiles, commandInvocationError, diagnosticRecoveryGuidance, missingCommandTargetError, normalizeCommandSignature, packageLifecycleRoleChanges, packageMutationRisk } = require("./commandNormalizer") as {
    commandAddsTooling: (command: string) => boolean;
    commandCreatesWorkspaceFiles: (command: string) => boolean;
    commandMutatesWorkspaceFiles: (command: string) => boolean;
    commandInvocationError: (errorOutput: string) => boolean;
    diagnosticRecoveryGuidance: (errorOutput: string) => string | undefined;
    missingCommandTargetError: (errorOutput: string) => boolean;
    normalizeCommandSignature: (command: string) => string;
    packageLifecycleRoleChanges: (beforeContent: string, afterContent: string) => string[];
    packageMutationRisk: (workspace: string, userMessage: string, command: string, requestedWorkdir?: string) => string | undefined;
};
const { FileCheckpointStore } = require("./fileCheckpoints") as { FileCheckpointStore: new (root: string) => {
    checkpoint: (workspace: string, inputPath: string, nextContent: string) => { id: string; preview: string };
    undoLatest: (workspace: string, checkpointId?: string) => { ok: boolean; message: string };
} };
const { SkillLoader } = require("./skillLoader") as { SkillLoader: new () => {
    discover: (workspace: string) => Array<{ name: string; description: string; body: string }>;
    select: (message: string, skills: Array<{ name: string; description: string; body: string }>) => Array<{ name: string; description: string; body: string }>;
    formatPrompt: (skills: Array<{ name: string; description: string; body: string }>) => string;
} };
const { AgentTrace } = require("./agentTrace") as { AgentTrace: new (logTarget?: string | { directory: string; basename: string }, taskId?: string, onEntry?: (entry: Record<string, unknown>) => void) => {
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
const { AgentResponseLog } = require("./agentResponseLog") as { AgentResponseLog: new (logTarget?: string | { directory: string; basename: string }, taskId?: string) => {
    append: (entry: {
        turn: number;
        maxTurns: number;
        requestFormat: unknown;
        rawContent: unknown;
        reasoningContent?: unknown;
        finishReason?: unknown;
        parsedAction?: string | undefined;
        parseError?: string | undefined;
        durationMs?: number | undefined;
        usage?: unknown;
        timings?: unknown;
    }) => void;
} };
const { resolveJsonlLogPath } = require("./dailyLog") as {
    resolveJsonlLogPath: (target: string | { directory: string; basename: string }, date?: Date) => string;
};
const { buildCompactedAgentMessages } = require("./agentCompaction") as {
    buildCompactedAgentMessages: (
        systemContent: string,
        originalRequest: string,
        state: {
            segment: number;
            maxSegments: number;
            writtenPaths: string[];
            satisfiedPaths?: string[];
            validationFailures: string[];
            unresolvedVerificationFailure?: string;
            verificationRequirement?: "none" | "command" | "runtime";
            verificationSatisfied?: boolean;
            sourceUrls: string[];
            recentEvents: string[];
            mcpCallsDisabled?: boolean;
        }
    ) => Array<{ role: "system" | "user"; content: string }>;
};
const { buildInitialAgentMessages, getAgentResponseFormat, getAgentRecoveryResponseFormat, getAgentMutationResponseFormat, getAgentLocalResponseFormat, getAgentReadOnlyResponseFormat, getAgentFinalResponseFormat, getInitialAgentResponseFormat } = require("./agentProtocol") as {
    buildInitialAgentMessages: (systemPrompt: string, contextSummary: string, userMessage: string) => Array<{ role: "system" | "user"; content: string }>;
    getAgentResponseFormat: (workflow: WorkflowKind) => Record<string, unknown>;
    getAgentRecoveryResponseFormat: (workflow: WorkflowKind, blockedAction: string | string[]) => Record<string, unknown>;
    getAgentMutationResponseFormat: (blockedAction?: string) => Record<string, unknown>;
    getAgentLocalResponseFormat: (workflow: WorkflowKind) => Record<string, unknown>;
    getAgentReadOnlyResponseFormat: (workflow: WorkflowKind, allowCommands?: boolean) => Record<string, unknown>;
    getAgentFinalResponseFormat: () => Record<string, unknown>;
    getInitialAgentResponseFormat: (workflow: WorkflowKind, message: string, requiresWrite?: boolean) => Record<string, unknown>;
};
const { StatusBar } = require("./statusBar") as { StatusBar: new (getState: () => {
    model: string;
    contextUsed: number;
    contextLimit: number;
    workspace: string;
}) => {
    start: () => void;
    render: () => void;
    suspend: () => void;
    resume: () => void;
    stop: () => void;
} };
const { formatSessionHistory } = require("./sessionHistory") as {
    formatSessionHistory: (messages: Array<{ role: "user" | "assistant"; content: string }>, maxMessages?: number) => string;
};
type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";
type VerificationRequirement = "none" | "command" | "runtime";
type AcceptanceContract = { evidence: "source" | "command" | "runtime" | "interaction"; verification: VerificationRequirement; reason: string };
type ProjectCheck = import("./projectTypes").ProjectCheck;
type ProjectCompletionRequirement = import("./projectTypes").ProjectCompletionRequirement;
const { forbidsWorkspaceWriteWithHistory, requiresWorkspaceWriteWithHistory, acceptanceContractWithHistory, commandSatisfiesAcceptance, workflowInstructions } = require("./workflowRouter") as {
    forbidsWorkspaceWriteWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => boolean;
    requiresWorkspaceWriteWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => boolean;
    acceptanceContractWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => AcceptanceContract;
    commandSatisfiesAcceptance: (command: string, contract: AcceptanceContract) => boolean;
    workflowInstructions: (kind: WorkflowKind) => string;
};
const { searchReturnedNoResults } = require("./webResearch") as {
    searchReturnedNoResults: (output: string) => boolean;
};
const {
    answerDefersRequiredWork,
    discoverProjectChecks,
    discoverProjectRoots,
    evaluateProjectCompletion,
    formatIncompleteTaskAnswer,
    formatProjectCompletionPrompt,
    formatProjectChecksPrompt,
    inferProjectCompletionRequirementWithHistory,
    projectChecksAffectedByPath,
    projectChecksAffectedByWorkdir,
    projectChecksForCommand,
    unownedProjectMutationReason,
    requiredProjectChecks,
    protectedProjectDeletionReason
} = require("./projectCompletion") as {
    answerDefersRequiredWork: (answer: string) => boolean;
    discoverProjectChecks: (workspace: string, providers?: ProjectCheckProvider[]) => ProjectCheck[];
    discoverProjectRoots: (workspace: string, providers?: ProjectCheckProvider[]) => string[];
    evaluateProjectCompletion: (workspace: string, requirement: ProjectCompletionRequirement) => string[];
    formatIncompleteTaskAnswer: (reasons: string[], writtenPaths: string[]) => string;
    formatProjectCompletionPrompt: (requirement: ProjectCompletionRequirement, checks?: ProjectCheck[]) => string;
    formatProjectChecksPrompt: (checks: ProjectCheck[]) => string;
    inferProjectCompletionRequirementWithHistory: (
        message: string,
        history: Array<{ role: "user" | "assistant"; content: string }>,
        continuation: boolean
    ) => ProjectCompletionRequirement | undefined;
    projectChecksAffectedByPath: (filePath: string, checks: ProjectCheck[]) => string[];
    projectChecksAffectedByWorkdir: (workdir: string | undefined, checks: ProjectCheck[]) => string[];
    projectChecksForCommand: (command: string, checks: ProjectCheck[], workdir?: string) => string[];
    unownedProjectMutationReason: (filePath: string, checks: ProjectCheck[]) => string | undefined;
    requiredProjectChecks: (requirement: ProjectCompletionRequirement, checks: ProjectCheck[]) => ProjectCheck[];
    protectedProjectDeletionReason: (workspace: string, filePath: string, request: string) => string | undefined;
};
const { isContinuationRequest, selectTaskContext, summarizeTaskContext } = require("./taskContext") as {
    isContinuationRequest: (message: string) => boolean;
    selectTaskContext: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, workflow: WorkflowKind, maxMessages?: number) => Array<{ role: "user" | "assistant"; content: string }>;
    summarizeTaskContext: (messages: Array<{ role: "user" | "assistant"; content: string }>) => string;
};
const { missingBehaviorCompanionInspections } = require("./behaviorEvidence") as {
    missingBehaviorCompanionInspections: (workspace: string, inputPath: string, readPaths: Set<string>) => string[];
};
const { WriteValidator } = require("./writeValidator") as { WriteValidator: new (workspace?: string) => {
    exists: (inputPath: string) => boolean;
    validate: (inputPath: string) => { ok: boolean; validator: string; output: string };
    validateProjectFor: (inputPath: string) => { ok: boolean; validator: string; output: string } | undefined;
} };
const { Spinner, formatCompletionLine } = require("./spinner") as { Spinner: new (message?: string) => {
    start: () => void;
    stop: () => number;
    suspend: () => void;
    resume: () => void;
    update: (message: string) => void;
    log: (message: string) => void;
}; formatCompletionLine: (milliseconds: number, completed?: boolean) => string };
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
    buildWorkflowMessages: (message: string, recentContext?: Array<{ role: "user" | "assistant"; content: string }>) => Array<{ role: "system" | "user"; content: string }>;
    parseWorkflowDecision: (content: string | undefined | null) => { kind: WorkflowKind; reason: string } | undefined;
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
const { AgentTool } = require("./tools/agentTool") as { AgentTool: new (configRoot?: string, commandTimeoutOverrideMs?: number) => {
    buildSystemPrompt: (workflowInstructions?: string) => Promise<string>;
    parseAction: (content: string | undefined | null) => unknown;
    explainParseFailure: (content: string | undefined | null) => string;
    execute: (action: unknown) => Promise<{ ok: boolean; output: string; changed?: boolean }>;
    inspectCapabilities: () => Promise<{ servers: Array<Record<string, unknown>> }>;
    prepareEdit: (path: string, oldText: string, newText: string) => { ok: boolean; output: string; content?: string; changed?: boolean };
    diagnosticSourceContext: (errorOutput: string, command?: string, requestedWorkdir?: string) => string | undefined;
    formatActionStatus: (action: unknown, turn: number, maxTurns: number) => string;
    formatObservation: (action: unknown, result: { ok: boolean; output: string }) => string;
    close: () => Promise<void>;
} };
const { SessionTool } = require("./session") as { SessionTool: new (storagePath?: string) => {
    selectSession: (rl: readline.Interface, workspace: string) => Promise<{ id: string; title: string; workspace?: string }>;
    resumeSession: (sessionId: string) => { id: string; title: string; workspace?: string } | undefined;
    setWorkspace: (sessionId: string, workspace: string) => boolean;
    getContextMessages: (sessionId: string, maxMessages?: number, afterTimestamp?: number) => Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
    appendExchange: (sessionId: string, userMessage: string, assistantMessage: string) => void;
    recordUsage: (sessionId: string, usage: ApiUsage) => void;
    getUsage: (sessionId: string) => SessionUsage;
    resetActiveContextUsage: (sessionId: string) => void;
} };

type ChatSession = {
    id: string;
    title: string;
    workspace?: string;
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

type RouterModel = {
    id: string;
    path?: string;
    status: string;
    failed: boolean;
};

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

type ApiUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

type SessionUsage = ApiUsage & {
    requestCount: number;
    activeContextTokens: number;
};

type CliSettings = {
    llamaCppPath?: string;
    modelPath?: string;
    apiUrl?: string;
    routerMode?: boolean;
    modelsMax?: number;
    defaultModel?: string;
    contextLength?: number;
    device?: string;
    hardwareProfile?: "auto" | "intel-arc" | "rtx-4070-super" | "default";
    debug?: boolean;
    historyMessages?: number;
    agent?: { profile?: "quick" | "standard" | "deep"; maxTurns?: number; maxSegments?: number; maxDurationMinutes?: number; maxCompletionTokens?: number; repeatLimit?: number; maxClarifications?: number; requireInspectionBeforeClarification?: boolean; secondClarificationRequiresBlocker?: boolean };
    projectChecks?: ProjectCheckProvider[];
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

function getArgumentValue(...names: string[]): string | undefined {
    const args = process.argv.slice(2);
    const index = args.findIndex((item) => names.includes(item));
    return index >= 0 ? args[index + 1] : undefined;
}

const cliSettings = loadCliSettings();
let activeWorkspace = initializeWorkspaceFromArgs();
const workspaceWasExplicitlyRequested = getArgumentValue("--workspace", "--cwd") !== undefined;
const requestedSessionId = getArgumentValue("--session");
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
    { command: "/model", description: "show or switch server models" },
    { command: "/settings", description: "show effective runtime settings" },
    { command: "/settings init", description: "create settings from the prototype" },
    { command: "/settings validate", description: "validate effective settings" },
    { command: "/capabilities", description: "show tools, checks, and web availability" },
    { command: "/usage", description: "show session token usage" },
    { command: "/clear", description: "start a clean task context" },
    { command: "/undo", description: "restore the latest file checkpoint" },
    { command: "/skills", description: "show project-local skills" },
    { command: "/debug", description: "show or hide agent trace" },
    { command: "/debug on", description: "show agent trace" },
    { command: "/debug off", description: "hide agent trace" },
    { command: "/exit", description: "exit the app" }
];
const slashCommands = slashCommandOptions.map((item) => item.command);

let slashMenuVisible = false;
let slashKeypressListenerAttached = false;
let renderedSlashSuggestionCount = 0;
let clarificationPromptActive = false;

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
rl.on("SIGINT", () => {
    if (activeRequestController) {
        activeRequestController.abort();
        activeRequestSpinner?.log("Cancelling active request... completed file writes remain available through /undo.");
        return;
    }
    process.stdout.write("\nUse /exit to close the CLI.\n");
    rl.setPrompt(promptLabel);
    rl.prompt();
});

const apiUrl = process.env.LLAMA_API_URL?.trim()
    || cliSettings.apiUrl?.trim()
    || "http://127.0.0.1:8080/v1/chat/completions";
const agentGuardSettings = getAgentGuardSettings(cliSettings);
const clarificationSettings = getClarificationSettings(cliSettings);
const projectCheckProviders = getProjectCheckProviders(cliSettings);
// The request-level Axios timeout must not fire before the user-visible Agent
// wall-clock guard. The guard's AbortController remains the single source of
// truth and produces the actionable timeout message.
const llamaClient = new LlamaClient(apiUrl, agentGuardSettings.maxDurationMs + 5000);
const modelRouterClient = new ModelRouterClient(apiUrl);
const modelDirectory = process.env.LLAMA_MODEL_DIR?.trim() || cliSettings.modelPath?.trim() || "D:\\Model";
const defaultModel = process.env.LLAMA_MODEL?.trim()
    || cliSettings.defaultModel?.trim()
    || "Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf";
const configuredContextValue = Number(
    process.env.LLAMA_CONTEXT_LENGTH?.trim() || cliSettings.contextLength || 16384
);
const configuredContextLength = Number.isFinite(configuredContextValue) && configuredContextValue >= 512
    ? Math.floor(configuredContextValue)
    : 16384;
let activeContextLength = configuredContextLength;
let model = defaultModel;
let plannerModel = defaultModel;
let serverModelSynced = false;
const chatSampling = getSamplingSettings(cliSettings, "chat");
const plannerSampling = getSamplingSettings(cliSettings, "planner");
const actionSampling = getSamplingSettings(cliSettings, "action");
const historyMessageLimit = Math.max(0, Math.floor(cliSettings.historyMessages ?? 6));
let contextStartedAt = 0;
let debugEnabled = process.env.CLI_DEBUG
    ? /^(1|true|on|yes)$/i.test(process.env.CLI_DEBUG.trim())
    : cliSettings.debug === true;

const debugSensitiveKey = /(^|_)(api_?key|token|secret|password|authorization|cookie|private_?key)($|_)/i;

function redactDebugValue(value: unknown, key = ""): unknown {
    if (debugSensitiveKey.test(key)) return "[REDACTED]";
    if (typeof value === "string") {
        return value
            .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
            .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
    }
    if (Array.isArray(value)) return value.map((item) => redactDebugValue(item));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
            childKey,
            redactDebugValue(childValue, childKey)
        ]));
    }
    return value;
}

function debugLog(stage: string, detail: unknown): void {
    if (!debugEnabled) return;
    console.log(`\n[debug] ${stage}`);
    console.log(JSON.stringify(redactDebugValue(detail), null, 2));
}

function persistDebugSetting(enabled: boolean): void {
    const settingsPath = path.resolve(appRoot, ".cli", "settings.json");
    if (!fs.existsSync(settingsPath)) initializeCliSettings(appRoot);
    let persisted: Record<string, unknown> = {};
    try {
        persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
        // Keep a valid minimal user settings file rather than losing the
        // selected preference when an existing file is malformed.
    }
    persisted.debug = enabled;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    cliSettings.debug = enabled;
}

// Sessions belong to the CLI installation, not to whichever workspace the
// agent is currently inspecting. This also keeps --workspace startup and the
// interactive /workspace command consistent.
const sessionTool = new SessionTool(path.resolve(appRoot, ".cli-sessions.json"));
const imageTool = new ImageTool();
const readFileTool = new ReadFileTool();
const editFileTool = new EditFileTool();
const toolRouter = new ToolRouter();
const agentTool = new AgentTool(appRoot);
const checkpointStore = new FileCheckpointStore(appRoot);
const skillLoader = new SkillLoader();
let activeRequestController: AbortController | undefined;
let activeRequestSpinner: InstanceType<typeof Spinner> | undefined;
let statusSessionId: string | undefined;
const statusBar = new StatusBar(() => ({
    model: serverModelSynced ? model : "server unavailable",
    contextUsed: statusSessionId ? sessionTool.getUsage(statusSessionId).activeContextTokens : 0,
    contextLimit: activeContextLength,
    workspace: activeWorkspace
}));

function extractApiUsage(data: any): ApiUsage | undefined {
    const promptTokens = Number(data?.usage?.prompt_tokens);
    const completionTokens = Number(data?.usage?.completion_tokens);
    const reportedTotal = Number(data?.usage?.total_tokens);
    const safePrompt = Number.isFinite(promptTokens) && promptTokens >= 0 ? Math.floor(promptTokens) : 0;
    const safeCompletion = Number.isFinite(completionTokens) && completionTokens >= 0 ? Math.floor(completionTokens) : 0;
    const totalTokens = Number.isFinite(reportedTotal) && reportedTotal > 0
        ? Math.floor(reportedTotal)
        : safePrompt + safeCompletion;

    if (totalTokens <= 0) {
        return undefined;
    }

    return { promptTokens: safePrompt, completionTokens: safeCompletion, totalTokens };
}

function recordResponseUsage(sessionId: string, responseData: any): ApiUsage | undefined {
    const usage = extractApiUsage(responseData);
    if (usage) {
        sessionTool.recordUsage(sessionId, usage);
        statusBar.render();
    }
    return usage;
}

function printSessionUsage(sessionId: string): void {
    const usage = sessionTool.getUsage(sessionId);
    const percentage = activeContextLength > 0
        ? Math.min(100, usage.activeContextTokens / activeContextLength * 100)
        : 0;
    console.log(
        `Session usage: ${usage.totalTokens.toLocaleString()} tokens across ${usage.requestCount.toLocaleString()} request${usage.requestCount === 1 ? "" : "s"}`
    );
    console.log(
        `Active context: ${usage.activeContextTokens.toLocaleString()} / ${activeContextLength.toLocaleString()} tokens (${percentage.toFixed(1)}%) | output: ${usage.completionTokens.toLocaleString()} tokens`
    );
}

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
        const routerModels = await modelRouterClient.list();
        return routerModels.filter((entry) => entry.status === "loaded").map((entry) => entry.id);
    } catch {
        // A single-model llama-server does not expose the router /models API.
    }

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

async function getServerContextInfo(modelId?: string): Promise<{ contextLength: number; totalSlots?: number } | undefined> {
    try {
        const propsUrl = new URL("/props", apiUrl).toString();
        const url = new URL(propsUrl);
        if (modelId) url.searchParams.set("model", modelId);
        const response = await axios.get(url.toString(), { timeout: 2000 });
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
    serverModelSynced = true;
    return true;
}

async function printModelInfo(): Promise<void> {
    const [loadedModels, serverContext, routerModels] = await Promise.all([
        getLoadedServerModels(),
        getServerContextInfo(model),
        modelRouterClient.list().catch(() => undefined)
    ]);
    const availableFiles = getAvailableModelFiles();

    if (loadedModels[0]) {
        model = loadedModels[0];
        plannerModel = loadedModels[0];
        serverModelSynced = true;
        statusBar.render();
    }

    console.log(serverModelSynced
        ? `CLI request model: ${model}`
        : `Configured fallback model: ${model} (server model unavailable)`);
    console.log(loadedModels.length > 0
        ? `Loaded by llama.cpp: ${loadedModels.join(", ")}`
        : "Loaded by llama.cpp: unavailable (server is not running or still loading)");
    console.log(`Configured context: ${configuredContextLength.toLocaleString()} tokens`);
    console.log(serverContext
        ? `Active server context: ${serverContext.contextLength.toLocaleString()} tokens per slot${serverContext.totalSlots ? ` (${serverContext.totalSlots} slot${serverContext.totalSlots === 1 ? "" : "s"})` : ""}`
        : "Active server context: unavailable (use /model while llama.cpp is running)");
    console.log(`Model directory: ${modelDirectory}`);

    if (routerModels) {
        console.log("Available server models:");
        routerModels.forEach((entry, index) => {
            const state = entry.failed ? "failed" : entry.status;
            console.log(`  [${index + 1}] ${entry.id} (${state})`);
        });
        console.log("Switch with /model <number-or-name>.");
    } else if (availableFiles.length === 0) {
        console.log("Available GGUF models: none found");
    } else {
        console.log("Available GGUF models:");
        availableFiles.forEach((fileName, index) => {
            console.log(`  [${index + 1}] ${fileName}`);
        });
    }

    if (!routerModels) {
        console.log("Runtime switching requires llama.cpp router mode. Restart the server with routerMode enabled.");
    }
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
    console.log("/model                    Show loaded and available server models");
    console.log("/model <number-or-name>   Switch the router server to another GGUF model");
    console.log("/settings                 Show effective settings and their source");
    console.log("/settings init            Create settings.json from the tracked prototype without overwriting");
    console.log("/settings validate        Validate the effective settings file");
    console.log("/capabilities             Show local tools, project checks, MCP, and web search");
    console.log("/usage                    Show session and active context token usage");
    console.log("/clear                    Start a new task context; keep session history");
    console.log("/undo                     Restore the latest model file checkpoint");
    console.log("/skills                   Show project-local skills");
    console.log("/debug [on|off]           Show status or toggle concise agent trace");
    console.log("/exit                     Exit the app");
    console.log();
    printModeHelp(currentMode);
}

function settingsFileSource(): string {
    return fs.existsSync(path.resolve(appRoot, ".cli", "settings.json")) ? "settings.json" : "settings.example.json";
}

function settingSource(envName: string, configured: boolean): string {
    if (process.env[envName]?.trim()) return `environment (${envName})`;
    if (!configured) return "built-in default";
    return settingsFileSource();
}

function printEffectiveSettings(): void {
    const agent = cliSettings.agent ?? {};
    const rows: Array<[string, string | number | boolean, string]> = [
        ["agent.profile", agentGuardSettings.profile, settingSource("CLI_AGENT_PROFILE", agent.profile !== undefined)],
        ["agent.maxTurns", agentGuardSettings.maxTurns, settingSource("CLI_AGENT_MAX_TURNS", agent.maxTurns !== undefined)],
        ["agent.maxSegments", agentGuardSettings.maxSegments, settingSource("CLI_AGENT_MAX_SEGMENTS", agent.maxSegments !== undefined)],
        ["agent.maxDurationMinutes", Math.round(agentGuardSettings.maxDurationMs / 60_000), settingSource("CLI_AGENT_MAX_MINUTES", agent.maxDurationMinutes !== undefined)],
        ["agent.maxCompletionTokens", agentGuardSettings.maxCompletionTokens, settingSource("CLI_AGENT_MAX_COMPLETION_TOKENS", agent.maxCompletionTokens !== undefined)],
        ["agent.repeatLimit", agentGuardSettings.repeatLimit, settingSource("CLI_AGENT_REPEAT_LIMIT", agent.repeatLimit !== undefined)],
        ["agent.maxClarifications", clarificationSettings.maxClarifications, settingSource("CLI_AGENT_MAX_CLARIFICATIONS", agent.maxClarifications !== undefined)],
        ["agent.requireInspectionBeforeClarification", clarificationSettings.requireInspection, settingSource("CLI_AGENT_REQUIRE_INSPECTION_BEFORE_CLARIFICATION", agent.requireInspectionBeforeClarification !== undefined)],
        ["agent.secondClarificationRequiresBlocker", clarificationSettings.secondRequiresBlocker, settingSource("CLI_AGENT_SECOND_CLARIFICATION_REQUIRES_BLOCKER", agent.secondClarificationRequiresBlocker !== undefined)],
        ["contextLength", configuredContextLength, settingSource("LLAMA_CONTEXT_LENGTH", cliSettings.contextLength !== undefined)],
        ["hardwareProfile", process.env.LLAMA_HARDWARE_PROFILE?.trim() || cliSettings.hardwareProfile || "auto", settingSource("LLAMA_HARDWARE_PROFILE", cliSettings.hardwareProfile !== undefined)]
    ];
    console.log("Effective settings:");
    rows.forEach(([name, value, source]) => console.log(`  ${name}: ${value} [${source}]`));
    console.log(`  projectChecks providers: ${projectCheckProviders.length} [${cliSettings.projectChecks ? settingsFileSource() : "built-in default"}]`);
}

async function printCapabilities(currentMode: RunMode): Promise<void> {
    const checks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
    const mcp = await agentTool.inspectCapabilities();
    const tools = mcp.servers.flatMap((server) => Array.isArray(server.tools) ? server.tools as Array<Record<string, unknown>> : []);
    const webTools = tools.filter((tool) => /(?:web|search|browser)/i.test(`${tool.name ?? ""} ${tool.description ?? ""}`));
    console.log(`Mode: ${currentMode}`);
    console.log(`Local workspace actions: ${currentMode === "agent" ? "read, search, list, edit, write, delete, safe commands" : "not available to the model in this mode"}`);
    console.log(`Project checks: ${checks.length === 0 ? "none discovered" : ""}`);
    checks.forEach((check) => console.log(`  ${check.label}: ${check.command} (workdir ${check.workdir})`));
    console.log(`Configured project-check providers: ${projectCheckProviders.length}`);
    console.log(`MCP servers: ${mcp.servers.length === 0 ? "none configured" : ""}`);
    mcp.servers.forEach((server) => {
        const serverTools = Array.isArray(server.tools) ? server.tools as Array<Record<string, unknown>> : [];
        console.log(`  ${String(server.name ?? "unknown")}: ${server.error ? `error — ${String(server.error)}` : `${serverTools.length} tool(s)`}`);
    });
    console.log(`Web search: ${currentMode !== "agent" ? "unavailable in this mode" : webTools.length > 0 ? `available via ${webTools.map((tool) => String(tool.name)).join(", ")}` : "unavailable (no discovered MCP search tool)"}`);
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
    if (!process.stdout.isTTY || clarificationPromptActive) {
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
        statusBar.render();
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

function promptText(question: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            callback();
        };
        const onAbort = (): void => finish(() => reject(signal?.reason ?? new Error("Request cancelled.")));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        if (signal) {
            rl.question(question, { signal }, (answer) => finish(() => resolve(answer.trim())));
        } else {
            rl.question(question, (answer) => finish(() => resolve(answer.trim())));
        }
    });
}

async function promptForClarification(request: ClarificationRequest, signal: AbortSignal): Promise<ClarificationAnswer> {
    clarificationPromptActive = true;
    try {
        console.log(formatClarificationRequest(request));
        while (true) {
            const input = await promptText("Your choice: ", signal);
            const answer = resolveClarificationAnswer(request, input);
            if (answer) return answer;
            console.log(`Please choose 1-${request.options.length}, enter an option id, or type a custom answer.`);
        }
    } finally {
        clarificationPromptActive = false;
    }
}

type RequestBudgetControl = { pause: () => void; resume: () => void; clear: () => void };

function createRequestBudget(controller: AbortController, durationMs: number): RequestBudgetControl {
    // Zero is explicitly unbounded. Do not arm a zero-delay timer.
    if (durationMs <= 0) {
        return { pause: () => undefined, resume: () => undefined, clear: () => undefined };
    }
    let remainingMs = durationMs;
    let armedAt = 0;
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
        if (timer || controller.signal.aborted) return;
        if (remainingMs <= 0) {
            controller.abort(new Error(`Request wall-clock budget reached (${Math.round(durationMs / 60000)} minutes).`));
            return;
        }
        armedAt = Date.now();
        timer = setTimeout(() => {
            timer = undefined;
            remainingMs = 0;
            controller.abort(new Error(`Request wall-clock budget reached (${Math.round(durationMs / 60000)} minutes).`));
        }, remainingMs);
    };
    arm();
    return {
        pause: () => {
            if (!timer) return;
            clearTimeout(timer);
            timer = undefined;
            remainingMs = Math.max(0, remainingMs - (Date.now() - armedAt));
        },
        resume: arm,
        clear: () => {
            if (timer) clearTimeout(timer);
            timer = undefined;
        }
    };
}

async function restoreSessionWorkspace(activeSession: ChatSession): Promise<void> {
    if (workspaceWasExplicitlyRequested) {
        sessionTool.setWorkspace(activeSession.id, activeWorkspace);
        activeSession.workspace = activeWorkspace;
        console.log(`Session workspace overridden and saved: ${activeWorkspace}`);
        return;
    }

    if (activeSession.workspace) {
        try {
            const restored = changeWorkspace(activeSession.workspace);
            console.log(`Restored session workspace: ${restored}`);
            return;
        } catch {
            console.log(`Saved session workspace is unavailable: ${activeSession.workspace}`);
        }
    } else {
        console.log("This legacy session has no saved workspace.");
    }

    while (true) {
        const rawWorkspace = await promptText(`Workspace path (Enter to use ${activeWorkspace}, or /exit): `);
        if (/^\/?exit$/i.test(rawWorkspace)) {
            throw new Error("Workspace selection cancelled.");
        }

        try {
            const restored = changeWorkspace(rawWorkspace || activeWorkspace);
            sessionTool.setWorkspace(activeSession.id, restored);
            activeSession.workspace = restored;
            console.log(`Session workspace saved: ${restored}`);
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`Workspace error: ${message}`);
        }
    }
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

    if (lower === "/help" || lower === "/exit" || lower === "/planner" || lower === "/fast" || lower === "/agent" || lower === "/undo" || lower === "/skills") {
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

function countCompilerDiagnostics(output: string): number {
    const diagnostics = output.match(/\berror\s+TS\d+:/gi);
    return diagnostics?.length ?? (output.trim() ? 1 : 0);
}

function compilerDiagnosticFingerprint(output: string): string[] {
    return output.split(/\r?\n/)
        .filter((line) => /\berror\s+TS\d+:/i.test(line))
        .map((line) => line.trim().replace(/\s+/g, " "))
        .sort();
}

async function routeTool(message: string, sessionId: string, signal?: AbortSignal): Promise<ToolDecision> {
    try {
        const routerMessages = toolRouter.buildRouterMessages(message);
        debugLog("Tool-router LLM request", { model, messages: routerMessages, sampling: actionSampling });
        const response = await llamaClient.post({
            model,
            messages: routerMessages,
            ...actionSampling
        }, undefined, signal);
        recordResponseUsage(sessionId, response.data);

        const rawContent = response.data.choices[0].message.content;
        const decision = toolRouter.parseDecision(rawContent);
        debugLog("Tool-router LLM response", { rawContent, decision, usage: response.data.usage, timings: response.data.timings });

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

async function decideWorkflowWithLlm(message: string, history: Array<{ role: "user" | "assistant"; content: string }>, sessionId: string, signal?: AbortSignal): Promise<{ kind: WorkflowKind; reason: string }> {
    try {
        const messages = toolRouter.buildWorkflowMessages(message, history);
        debugLog("Workflow-router LLM request", { model, messages, sampling: actionSampling });
        const response = await llamaClient.post({ model, messages, ...actionSampling }, undefined, signal);
        recordResponseUsage(sessionId, response.data);
        const rawContent = response.data.choices[0].message.content;
        const decision = toolRouter.parseWorkflowDecision(rawContent);
        debugLog("Workflow-router LLM response", { rawContent, decision, usage: response.data.usage, timings: response.data.timings });
        if (decision) return decision;
    } catch (error) {
        debugLog("Workflow-router fallback", { error: llamaClient.formatError(error) });
    }
    return { kind: "general", reason: "Workflow router unavailable; retain all safe capabilities and let the agent select its tools." };
}

async function runAgentLoop(
    userMessage: string,
    historyForModel: Array<{ role: "user" | "assistant"; content: string }>,
    historyForTask: Array<{ role: "user" | "assistant"; content: string }>,
    spinner: {
        update: (message: string) => void;
        log: (message: string) => void;
        suspend: () => void;
        resume: () => void;
    },
    sessionId: string,
    signal: AbortSignal,
    requestBudget: RequestBudgetControl
): Promise<{ answer: string; trace: InstanceType<typeof AgentTrace>; clarifications: string[] }> {
    const guard = new AgentGuard(agentGuardSettings);
    const maxTurnsPerSegment = guard.settings.maxTurns;
    const hasStepCadence = maxTurnsPerSegment > 0;
    const maxSegments = agentGuardSettings.maxSegments;
    const unboundedSegments = maxSegments === 0;
    const maxSegmentsLabel = unboundedSegments ? "unbounded" : String(maxSegments);
    const maxTurns = unboundedSegments || !hasStepCadence ? Number.POSITIVE_INFINITY : maxTurnsPerSegment * maxSegments;
    const maxTurnsForLog = unboundedSegments || !hasStepCadence ? 0 : maxTurns;
    let effectiveUserMessage = userMessage;
    let workflow = await decideWorkflowWithLlm(effectiveUserMessage, historyForTask, sessionId, signal);
    const continuation = isContinuationRequest(userMessage);
    const readOnlyRequest = forbidsWorkspaceWriteWithHistory(effectiveUserMessage, historyForTask, continuation);
    let mustWrite = !readOnlyRequest && requiresWorkspaceWriteWithHistory(effectiveUserMessage, historyForTask, continuation);
    let acceptance = acceptanceContractWithHistory(effectiveUserMessage, historyForTask, continuation);
    let verificationRequirement = acceptance.verification;
    let readOnlyAllowsCommands = verificationRequirement !== "none";
    let projectRequirement = inferProjectCompletionRequirementWithHistory(effectiveUserMessage, historyForTask, continuation);
    let projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
    let agentResponseFormat = readOnlyRequest ? getAgentReadOnlyResponseFormat(workflow.kind, readOnlyAllowsCommands) : getAgentResponseFormat(workflow.kind);
    let initialAgentResponseFormat = readOnlyRequest ? agentResponseFormat : getInitialAgentResponseFormat(workflow.kind, effectiveUserMessage, mustWrite);
    const relevantHistory = selectTaskContext(userMessage, historyForModel, workflow.kind, historyMessageLimit);
    const contextSummary = summarizeTaskContext(relevantHistory);
    const writeValidator = new WriteValidator(activeWorkspace);
    const availableSkills = skillLoader.discover(activeWorkspace);
    const selectedSkills = skillLoader.select(userMessage, availableSkills);
    const skillPrompt = skillLoader.formatPrompt(selectedSkills);
    const readPaths = new Set<string>();
    const explicitlyRequestedFiles = Array.from(effectiveUserMessage.matchAll(/(?:^|[\s"'`])((?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|ps1|yml|yaml|go))(?=$|[\s"'`,)])/gi))
        .map((match) => path.resolve(activeWorkspace, match[1] ?? "").toLowerCase());
    const writeRetriesAwaitingRead = new Set<string>();
    const noOpMutationPaths = new Set<string>();
    const validationFailures = new Set<string>();
    let unresolvedVerificationFailure: string | undefined;
    let unresolvedToolFailure: { action: string; output: string } | undefined;
    let unresolvedMissingCommandTarget = false;
    let lastFailedCommand: string | undefined;
    let verificationSatisfied = verificationRequirement === "none";
    const successfulProjectChecks = new Set<string>();
    const pendingProjectChecks = new Set<string>();
    const clarificationTranscript: string[] = [];
    const answeredClarifications = new Map<string, Record<string, unknown>>();
    const contextInspections: Array<{ action: "list_files" | "search_files" | "read_file"; path?: string; query?: string }> = [];
    const writtenPaths = new Set<string>();
    const satisfiedPaths = new Set<string>();
    let successfulMcpDiscovery = false;
    let successfulMcpCall = false;
    let mcpCallsDisabled = false;
    const sourceUrls = new Set<string>();
    let consecutiveEmptyWebSearches = 0;
    let webResearchExhausted = false;
    const logDirectory = path.resolve(appRoot, ".cli", "logs");
    const traceTarget = { directory: logDirectory, basename: "agent-trace" };
    const responseTarget = { directory: logDirectory, basename: "agent-model-responses" };
    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const trace = new AgentTrace(traceTarget, taskId, (entry) => debugLog("Agent trace", entry));
    const responseLog = new AgentResponseLog(responseTarget, taskId);
    trace.add({
        turn: 0,
        status: "action",
        action: "task_start",
        observation: JSON.stringify({
            workflow: workflow.kind,
            verificationRequirement,
            evidence: acceptance.evidence,
            model,
            contextLength: activeContextLength,
            agentProfile: agentGuardSettings.profile,
            maxSteps: unboundedSegments || !hasStepCadence ? "unbounded" : maxTurns,
            maxDurationMs: agentGuardSettings.maxDurationMs
        })
    });
    trace.save();
    const responseLogDisplayPath = path.relative(appRoot, resolveJsonlLogPath(responseTarget));
    const buildCurrentSystemPrompt = (): Promise<string> => agentTool.buildSystemPrompt([
        workflowInstructions(workflow.kind),
        `Router decision: ${workflow.reason}`,
        verificationRequirement === "none"
            ? "No explicit command-level acceptance check was inferred."
            : `Completion requirement: ${verificationRequirement} verification must succeed after the latest file change before final.`,
        `Acceptance evidence contract: ${acceptance.evidence}. ${acceptance.reason} Final claims must not exceed successful tool evidence.`,
        acceptance.evidence === "interaction"
            ? "Trace the rendered declaration through its owning implementation, imports/providers, event handler, state transition, and output before editing. Inspect co-located implementation companions referenced by the target. Then use a finite automated interaction test that performs the user-visible action and asserts its observable outcome. A build, typecheck, source read, response-body text search, or unrelated HTTP probe is not sufficient. Prefer an existing project test runner over starting a development server."
            : "",
        readOnlyRequest ? "Read-only contract: the user explicitly prohibited workspace changes. Do not edit, write, delete, install, scaffold, or run any command that mutates files." : "",
        formatProjectChecksPrompt(projectChecks),
        projectRequirement ? formatProjectCompletionPrompt(projectRequirement, projectChecks) : "",
        skillPrompt
    ].filter(Boolean).join("\n\n"));
    let systemPrompt = await buildCurrentSystemPrompt();
    let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = buildInitialAgentMessages(systemPrompt, contextSummary, userMessage);
    let recoveryResponseFormat: Record<string, unknown> | undefined;
    const recoveryFormat = (extra: string | string[] = []) => getAgentRecoveryResponseFormat(
        workflow.kind,
        Array.from(new Set(Array.isArray(extra) ? extra : [extra])).filter(Boolean)
    );
    let segmentEvents: string[] = [];
    let contextCompactionCount = 0;
    const stepStatus = (step: number): string => hasStepCadence
        ? `step ${step}/${maxTurns}`
        : `step ${step}`;

    if (selectedSkills.length > 0) spinner.log(`Skills: ${selectedSkills.map((skill) => skill.name).join(", ")}`);

    for (let turn = 1; turn <= maxTurns; turn += 1) {
        const segmentTurn = hasStepCadence ? (turn - 1) % maxTurnsPerSegment + 1 : turn;
        const segment = hasStepCadence ? Math.floor((turn - 1) / maxTurnsPerSegment) + 1 : 1;
        const contextTokenThreshold = Math.floor(activeContextLength * 0.7);
        const compactForTokens = turn > 1
            && contextTokenThreshold > 0
            && sessionTool.getUsage(sessionId).activeContextTokens >= contextTokenThreshold;
        if ((hasStepCadence && segmentTurn === 1 && segment > 1) || compactForTokens) {
            contextCompactionCount += 1;
            const compactedSegment = Math.max(segment, contextCompactionCount + 1);
            messages = buildCompactedAgentMessages(systemPrompt, userMessage, {
                segment: compactedSegment,
                maxSegments,
                writtenPaths: Array.from(writtenPaths),
                satisfiedPaths: Array.from(satisfiedPaths),
                validationFailures: Array.from(validationFailures),
                ...(unresolvedVerificationFailure ? { unresolvedVerificationFailure } : {}),
                verificationRequirement,
                verificationSatisfied,
                sourceUrls: Array.from(sourceUrls),
                recentEvents: segmentEvents,
                mcpCallsDisabled
            });
            segmentEvents = [];
            readPaths.clear();
            writeRetriesAwaitingRead.clear();
            sessionTool.resetActiveContextUsage(sessionId);
            recoveryResponseFormat = undefined;
            const trigger = compactForTokens ? `at 70% context usage (${contextTokenThreshold.toLocaleString()} tokens)` : "at the turn boundary";
            spinner.log(`Compacted agent context ${trigger}; continuing segment ${compactedSegment}/${maxSegmentsLabel}.`);
            trace.add({ turn, status: "action", action: "context_compaction", observation: `Continuing segment ${compactedSegment}/${maxSegmentsLabel} ${trigger}` });
            trace.save();
        }
        const budgetError = guard.checkBudget(segmentTurn);
        if (budgetError) {
            const answer = `Agent stopped safely because its ${budgetError}. Review the trace or continue with a narrower request.`;
            trace.add({ turn, status: "error", action: "budget_stop", observation: answer });
            trace.save();
            return { answer, trace, clarifications: clarificationTranscript };
        }
        const requestFormat = recoveryResponseFormat
            ?? (mcpCallsDisabled
                ? getAgentLocalResponseFormat(workflow.kind)
                : (turn === 1 ? initialAgentResponseFormat : agentResponseFormat));
        recoveryResponseFormat = undefined;
        spinner.update(turn === 1
            ? `Planning next step (step ${turn}, ${guard.formatRemaining()})...`
            : `Reviewing results (step ${turn}, ${guard.formatRemaining()})...`);

        const modelStartedAt = Date.now();
        debugLog("LLM request", { turn, model, messages, responseFormat: requestFormat, sampling: actionSampling });
        const response = await llamaClient.post({
            model,
            messages,
            response_format: requestFormat,
            ...actionSampling
        }, (_attempt, errorCode) => {
            spinner.update(`llama.cpp connection ${errorCode}; retrying...`);
        }, signal);
        const responseUsage = recordResponseUsage(sessionId, response.data);
        guard.recordCompletionTokens(responseUsage?.completionTokens ?? 0);

        const choice = response.data.choices[0];
        const rawAssistantContent = choice.message.content;
        const assistantContent = typeof rawAssistantContent === "string" ? rawAssistantContent.trim() : "";
        const action = agentTool.parseAction(assistantContent) as {
            action?: string;
            answer?: string;
            tool?: string;
            reason?: string;
            path?: string;
            query?: string;
            content?: string;
            old_text?: string;
            new_text?: string;
            command?: string;
            workdir?: string;
            question?: string;
            decision?: ClarificationRequest["decision"];
            options?: Array<{ id: string; label: string; description?: string }>;
            server?: string;
            arguments?: Record<string, unknown>;
        } | undefined;
        const parseError = action ? undefined : agentTool.explainParseFailure(assistantContent);
        debugLog("LLM response", {
            turn,
            rawContent: rawAssistantContent,
            reasoningContent: choice.message.reasoning_content,
            finishReason: choice.finish_reason,
            usage: response.data.usage,
            timings: response.data.timings,
            parsedAction: action,
            parseError
        });
        responseLog.append({
            turn,
            maxTurns: maxTurnsForLog,
            requestFormat,
            rawContent: rawAssistantContent,
            reasoningContent: choice.message.reasoning_content,
            finishReason: choice.finish_reason,
            parsedAction: action?.action,
            parseError,
            durationMs: Date.now() - modelStartedAt,
            usage: response.data.usage,
            timings: response.data.timings
        });

        messages.push({
            role: "assistant",
            content: !action && choice.finish_reason === "length"
                ? "[Truncated model response omitted; use a smaller action.]"
                : assistantContent
        });

        if (!action) {
            segmentEvents.push(`Step ${segmentTurn}: invalid model action (${parseError ?? "unknown parse error"})`);
            spinner.log(`[${stepStatus(turn)}] Invalid model action (${parseError}); logged to ${responseLogDisplayPath}`);
            trace.add({
                turn,
                status: "parse_error",
                action: "invalid_action",
                observation: assistantContent.slice(0, 1000)
            });
            trace.save();
            if (choice.finish_reason === "length") {
                recoveryResponseFormat = recoveryFormat("write_file");
                messages.push({
                    role: "user",
                    content: "Your response reached the completion limit and was cut off. Do not resend the full file. For an existing file, use edit_file with a small exact old_text/new_text replacement. Read the file again first if needed."
                });
            } else {
                messages.push({
                    role: "user",
                    content: "Your last response was not one supported action object. Return exactly one valid JSON object using an action from Available actions."
                });
            }
            continue;
        }

        // The loop ends only when the model explicitly returns final. Until
        // then each action becomes an observation for the next reasoning step.
        if (action.action === "ask_user") {
            if (unresolvedToolFailure) {
                const failure = unresolvedToolFailure.output.slice(0, 1400);
                const output = `Blocked recovery clarification: ${unresolvedToolFailure.action} is still failing. Tool failures must be diagnosed and corrected autonomously; do not ask the user to choose retry flags, troubleshooting commands, or implementation workarounds.`;
                recoveryResponseFormat = recoveryFormat(["ask_user", "final"]);
                trace.add({
                    turn,
                    status: "error",
                    action: "ask_user_recovery_blocked",
                    reason: action.reason,
                    observation: output
                });
                trace.save();
                messages.push({
                    role: "user",
                    content: `${output}\nReview the failure evidence below, inspect referenced files or manifests if needed, then make a compatible correction or revert the failed approach. A successful read alone does not resolve the failure.\n${failure}`
                });
                continue;
            }
            const request: ClarificationRequest = {
                question: action.question ?? "",
                options: action.options ?? [],
                decision: action.decision ?? "scope",
                ...(action.reason ? { reason: action.reason } : {})
            };
            const clarificationKey = JSON.stringify([
                request.question.trim().toLowerCase(),
                request.options.map((option) => option.id.trim().toLowerCase())
            ]);
            const previousObservation = answeredClarifications.get(clarificationKey);
            if (previousObservation) {
                trace.add({
                    turn,
                    status: "error",
                    action: "ask_user_repeated",
                    reason: action.reason,
                    observation: JSON.stringify(previousObservation)
                });
                trace.save();
                messages.push({
                    role: "user",
                    content: `This clarification was already answered: ${JSON.stringify(previousObservation)}\nUse the existing answer and continue; do not ask it again.`
                });
                continue;
            }
            const clarificationBlocked = clarificationBlockReason({
                workspaceMutationRequired: mustWrite,
                successfulInspections: relevantClarificationInspections({
                    decision: request.decision,
                    question: request.question,
                    inspections: contextInspections
                }).length,
                answeredClarifications: answeredClarifications.size,
                hasNewBlocker: Boolean(
                    unresolvedVerificationFailure
                    || unresolvedMissingCommandTarget
                    || validationFailures.size > 0
                ),
                decision: request.decision,
                knownProjectRoots: discoverProjectRoots(activeWorkspace, projectCheckProviders).length,
                asksNewVersusExisting: /(?:new|create|สร้าง)[\s\S]*(?:existing|current|ใช้โปรเจกต์|ใช้โปรเจค|ที่มีอยู่)/i.test(`${request.question} ${request.options.map((option) => `${option.id} ${option.label}`).join(" ")}`)
                    || /(?:existing|current|ใช้โปรเจกต์|ใช้โปรเจค|ที่มีอยู่)[\s\S]*(?:new|create|สร้าง)/i.test(`${request.question} ${request.options.map((option) => `${option.id} ${option.label}`).join(" ")}`),
                ...clarificationSettings
            });
            if (clarificationBlocked) {
                recoveryResponseFormat = recoveryFormat("ask_user");
                spinner.log(`[${stepStatus(turn)}] Clarification blocked: ${clarificationBlocked}`);
                trace.add({
                    turn,
                    status: "error",
                    action: "ask_user_blocked",
                    reason: action.reason,
                    observation: clarificationBlocked
                });
                trace.save();
                messages.push({
                    role: "user",
                    content: `Clarification rejected: ${clarificationBlocked} Do not guess blindly; use the available evidence-producing action and continue.`
                });
                continue;
            }
            spinner.suspend();
            requestBudget.pause();
            guard.pause();
            let answer: ClarificationAnswer;
            try {
                answer = await promptForClarification(request, signal);
            } finally {
                guard.resume();
                requestBudget.resume();
                spinner.resume();
            }
            const observation = clarificationObservation(request, answer);
            clarificationTranscript.push(clarificationTranscriptLine(request, answer));
            trace.add({
                turn,
                status: answer.kind === "cancel" ? "error" : "action",
                action: "ask_user",
                reason: action.reason,
                observation: JSON.stringify(observation)
            });
            trace.save();
            if (answer.kind === "cancel") {
                const completedWrites = writtenPaths.size > 0
                    ? ` การเปลี่ยนแปลงที่ทำสำเร็จก่อนยกเลิกยังอยู่ใน workspace: ${Array.from(writtenPaths).join(", ")}`
                    : "";
                return {
                    answer: `ยกเลิกงานตามคำขอแล้ว${completedWrites}`,
                    trace,
                    clarifications: clarificationTranscript
                };
            }
            answeredClarifications.set(clarificationKey, observation);
            const previousWorkflowKind = workflow.kind;
            const previousVerificationRequirement = verificationRequirement;
            effectiveUserMessage = `${userMessage}\n\nUser clarifications:\n${clarificationTranscript.map((line) => `- ${line}`).join("\n")}`;
            workflow = await decideWorkflowWithLlm(effectiveUserMessage, historyForTask, sessionId, signal);
            mustWrite = !readOnlyRequest && requiresWorkspaceWriteWithHistory(effectiveUserMessage, historyForTask, continuation);
            acceptance = acceptanceContractWithHistory(effectiveUserMessage, historyForTask, continuation);
            verificationRequirement = acceptance.verification;
            readOnlyAllowsCommands = verificationRequirement !== "none";
            projectRequirement = inferProjectCompletionRequirementWithHistory(effectiveUserMessage, historyForTask, continuation);
            agentResponseFormat = readOnlyRequest ? getAgentReadOnlyResponseFormat(workflow.kind, readOnlyAllowsCommands) : getAgentResponseFormat(workflow.kind);
            initialAgentResponseFormat = readOnlyRequest ? agentResponseFormat : getInitialAgentResponseFormat(workflow.kind, effectiveUserMessage, mustWrite);
            if (verificationRequirement !== previousVerificationRequirement) {
                verificationSatisfied = verificationRequirement === "none";
            }
            systemPrompt = await buildCurrentSystemPrompt();
            const refreshedSystemMessage = buildInitialAgentMessages(systemPrompt, contextSummary, effectiveUserMessage)[0];
            if (refreshedSystemMessage) messages[0] = refreshedSystemMessage;
            guard.resetActionHistory();
            segmentEvents.push(`Step ${segmentTurn}: user clarification answered`);
            if (workflow.kind !== previousWorkflowKind) {
                segmentEvents.push(`Workflow reclassified: ${previousWorkflowKind} -> ${workflow.kind}`);
                spinner.log(`Workflow reclassified after clarification: ${previousWorkflowKind} -> ${workflow.kind}`);
            }
            messages.push({
                role: "user",
                content: `User clarification observation: ${JSON.stringify(observation)}\nContinue the same task using this answer. Do not ask the same question again.`
            });
            continue;
        }

        if (action.action === "final") {
            const rejectFinal = (summary: string, feedback: string): void => {
                recoveryResponseFormat = recoveryFormat("final");
                spinner.log(`[${stepStatus(turn)}] Final blocked: ${summary}`);
                trace.add({
                    turn,
                    status: "error",
                    action: "final_blocked",
                    reason: action.reason,
                    observation: summary
                });
                trace.save();
                segmentEvents.push(`final_blocked [error]: ${summary}`);
                messages.push({ role: "user", content: feedback });
            };
            const proposedAnswer = action.answer?.trim() || "Done.";
            if (answerLooksLikeBlockingClarification(proposedAnswer)) {
                rejectFinal(
                    "blocking clarification must use the interactive choice action",
                    "Do not return a blocking question as final. Use ask_user with 2-6 concrete choices grounded in the context you already inspected; the CLI automatically accepts a free-text answer outside those choices."
                );
                continue;
            }
            if (unresolvedToolFailure) {
                rejectFinal(
                    `latest ${unresolvedToolFailure.action} action is still failing`,
                    `You cannot return final while the latest tool failure is unresolved. Inspect the error and make a concrete correction or run a successful corrective command. A read-only inspection does not clear this failure. Failure evidence: ${unresolvedToolFailure.output.slice(0, 1400)}`
                );
                continue;
            }
            if (mustWrite && writtenPaths.size === 0 && satisfiedPaths.size === 0) {
                rejectFinal(
                    "this request requires a successful file write",
                    "You cannot return final yet. The user requested a file change, but no file has been changed. Use edit_file for an existing file or write_file for a new file, then verify the result before returning final."
                );
                continue;
            }
            if (validationFailures.size > 0) {
                const failed = Array.from(validationFailures).join(", ");
                rejectFinal(
                    `validation still failing for ${failed}`,
                    `You cannot return final yet. Validation is failing for: ${failed}. Inspect the error, fix the file, and validate again.`
                );
                continue;
            }
            projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
            if (projectRequirement) {
                const missingArtifacts = evaluateProjectCompletion(activeWorkspace, projectRequirement);
                if (missingArtifacts.length > 0) {
                    const missing = missingArtifacts.join(", ");
                    rejectFinal(
                        `project completion profile is missing: ${missing}`,
                        `You cannot return final yet. The requested ${projectRequirement.label} is incomplete. Missing: ${missing}. Implement these items, then run the required checks. Do not return a starter scaffold or tell the user to expand it later.`
                    );
                    continue;
                }
                const missingChecks = requiredProjectChecks(projectRequirement, projectChecks)
                    .filter((check) => !successfulProjectChecks.has(check.id));
                if (missingChecks.length > 0) {
                    const descriptions = missingChecks.map((check) => `${check.command} (workdir ${check.workdir})`);
                    rejectFinal(
                        `required project checks have not succeeded: ${descriptions.join(", ")}`,
                        `You cannot return final yet. Run successful verification for: ${descriptions.join(", ")}. Use run_command.workdir exactly as discovered from each project manifest.`
                    );
                    continue;
                }
            }
            const pendingChecks = projectChecks.filter((check) => (
                pendingProjectChecks.has(check.id) && !successfulProjectChecks.has(check.id)
            ));
            if (pendingChecks.length > 0) {
                const descriptions = pendingChecks.map((check) => `${check.command} (workdir ${check.workdir})`);
                rejectFinal(
                    `checks affected by the latest changes have not succeeded: ${descriptions.join(", ")}`,
                    `You cannot return final yet. The latest file changes invalidated these manifest-discovered checks: ${descriptions.join(", ")}. Run each command in its discovered workdir; do not substitute an unrelated verification command.`
                );
                continue;
            }
            if (unresolvedVerificationFailure) {
                recoveryResponseFormat = recoveryFormat(["run_command", "final"]);
                rejectFinal(
                    "the latest verification command failed",
                    `You cannot report verified success yet because the latest verification command failed: ${unresolvedVerificationFailure}. Inspect the error and run an OS-compatible verification command successfully. A read_file or search_files action can diagnose the problem but does not clear the failed verification. Do not assume a localhost server exists.`
                );
                continue;
            }
            if (projectRequirement && answerDefersRequiredWork(proposedAnswer)) {
                rejectFinal(
                    "the answer describes a starter scaffold or defers required work",
                    "Do not return a partial scaffold or ask the user to expand it later. Finish the requested implementation and checks, then summarize concrete completed behavior."
                );
                continue;
            }
            // Intent is refined semantically by the model's selected action.
            // Only require a previously inferred verification after the task
            // has actually entered a workspace-verification path; a final
            // response chosen as the first action remains valid conversation.
            const verificationWasActivated = writtenPaths.size > 0
                || pendingProjectChecks.size > 0
                || Boolean(unresolvedVerificationFailure);
            if (!verificationSatisfied && verificationWasActivated) {
                const requiredCheck = verificationRequirement === "runtime"
                    ? acceptance.evidence === "interaction"
                        ? "run a finite automated interaction test that performs the action and asserts the resulting state"
                        : "run an OS-compatible runtime probe of the requested URL, endpoint, server, or UI"
                    : "run the relevant test, build, lint, or verification command";
                rejectFinal(
                    `required ${verificationRequirement} verification has not succeeded after the latest write`,
                    `You cannot return final yet. The user gave an observable completion criterion. ${requiredCheck}, inspect and fix any failure, and return final only after that command succeeds. A file read or successful build alone does not prove runtime behavior.`
                );
                continue;
            }
            if (workflow.kind === "web_research" && !mcpCallsDisabled && !webResearchExhausted && sourceUrls.size < 2) {
                rejectFinal(
                    "web research needs at least two relevant source URLs",
                    "You cannot return final yet. Web research requires at least two relevant source URLs from successful MCP observations. Refine the web query; do not use search_files."
                );
                continue;
            }
            if (workflow.kind === "mcp_creation" && writtenPaths.size > 0 && (!successfulMcpDiscovery || !successfulMcpCall)) {
                rejectFinal(
                    "MCP discovery and a successful tool call are required",
                    "You cannot claim MCP completion yet. Run mcp_list_tools and one relevant mcp_call_tool successfully after implementation."
                );
                continue;
            }
            spinner.update("Preparing final answer...");
            const answer = proposedAnswer;
            const missingSources = Array.from(sourceUrls).filter((sourceUrl) => !answer.includes(sourceUrl));
            const finalAnswer = missingSources.length === 0
                ? answer
                : `${answer}\n\nSources:\n${missingSources.slice(0, 5).map((sourceUrl) => `- ${sourceUrl}`).join("\n")}`;
            trace.add({ turn, status: "final", action: "final", reason: action.reason });
            trace.save();
            return { answer: finalAnswer, trace, clarifications: clarificationTranscript };
        }

        if (action.action === "run_command" && action.command && lastFailedCommand
            && unresolvedVerificationFailure && commandInvocationError(unresolvedVerificationFailure)
            && normalizeCommandSignature(action.command) !== normalizeCommandSignature(lastFailedCommand)) {
            guard.resetActionHistory();
        }
        const guardDecision = guard.registerAction(action as Record<string, unknown>);
        if (guardDecision.status === "replan") {
            const invocationCorrection = action.action === "run_command"
                && Boolean(unresolvedVerificationFailure && commandInvocationError(unresolvedVerificationFailure));
            const failureReview = action.action === "run_command" && unresolvedVerificationFailure
                ? ` Review the previous failure before choosing another action:\n${unresolvedVerificationFailure}`
                : "";
            const repeatObservation = `${guardDecision.message}${failureReview}`;
            spinner.log(`[${stepStatus(turn)}] ${guardDecision.message}`);
            trace.add({ turn, status: "error", action: "repeat_guard", arguments: action, observation: repeatObservation });
            trace.save();
            const repeatedMutation = ["edit_file", "write_file", "delete_file"].includes(action.action ?? "");
            recoveryResponseFormat = invocationCorrection
                ? recoveryFormat("final")
                : repeatedMutation
                    ? recoveryFormat(["edit_file", "write_file", "delete_file"])
                    : getAgentMutationResponseFormat();
            const completedWrites = writtenPaths.size > 0
                ? ` Successful writes so far: ${Array.from(writtenPaths).join(", ")}.`
                : "";
            messages.push({
                role: "user",
                content: invocationCorrection
                    ? `Observation: ${repeatObservation} Correct the rejected command or option and run a finite verification command with a different invocation. Do not edit source/configuration just to preserve the invalid command.`
                    : repeatedMutation
                        ? `Observation: ${repeatObservation} Further file mutations are unavailable for your next response.${completedWrites} Read the current file, run a finite verification command, or return final. Do not delete a file as recovery from a repeated mutation.`
                        : `Observation: ${repeatObservation} The repeated ${action.action} action is unavailable for your next response.${completedWrites} Use the files and errors already observed to make a concrete correction now.`
            });
            continue;
        }
        if (guardDecision.status === "stop") {
            const failureSummary = unresolvedVerificationFailure
                ? ` Last unresolved command failure: ${unresolvedVerificationFailure}`
                : "";
            const observation = `${guardDecision.message}${failureSummary} The task stopped because repeated work produced no new evidence.`;
            trace.add({ turn, status: "error", action: "repeat_stop", arguments: action, observation });
            trace.save();
            const writes = writtenPaths.size > 0 ? ` Successful writes before stopping: ${Array.from(writtenPaths).join(", ")}.` : "";
            return {
                answer: `Agent stopped early after detecting repeated work without progress. ${observation}${writes}`,
                trace,
                clarifications: clarificationTranscript
            };
        }

        if (action.action === "run_command" && action.command
            && unresolvedMissingCommandTarget
            && commandAddsTooling(action.command)
            && !/(?:\blint(?:er|ing)?\b|\btooling\b|\bplugin\b|ติดตั้ง|เพิ่ม.*(?:เครื่องมือ|ปลั๊กอิน))/i.test(userMessage)) {
            const output = "Blocked scope expansion: a missing optional command target does not authorize installing new tooling. Use a finite verification command already declared by the project, or inspect the manifest to find one.";
            spinner.log(`[${stepStatus(turn)}] ${output}`);
            trace.add({ turn, status: "error", action: action.action, reason: action.reason, arguments: action, observation: output });
            trace.save();
            messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
            continue;
        }
        const attemptsReadOnlyMutation = readOnlyRequest && (
            ["write_file", "edit_file", "delete_file"].includes(action.action ?? "")
            || (action.action === "run_command" && commandMutatesWorkspaceFiles(action.command ?? ""))
        );
        if (attemptsReadOnlyMutation) {
            const output = "Blocked by read-only contract: the user explicitly prohibited workspace changes. Inspect with read/list/search or return a factual final answer without mutating files.";
            recoveryResponseFormat = getAgentReadOnlyResponseFormat(workflow.kind, readOnlyAllowsCommands);
            spinner.log(`[${stepStatus(turn)}] ${output}`);
            trace.add({ turn, status: "error", action: "read_only_mutation_blocked", reason: action.reason, arguments: action, observation: output });
            trace.save();
            messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
            continue;
        }

        if (["write_file", "edit_file", "delete_file"].includes(action.action ?? "") && action.path) {
            const mutationPathKey = path.resolve(activeWorkspace, action.path).toLowerCase();
            if (noOpMutationPaths.has(mutationPathKey)) {
                const output = `Blocked mutation: ${action.path} already has the requested state. Read its current contents before any further mutation, or verify/finalize the task. Deletion is not a recovery for a no-op change.`;
                recoveryResponseFormat = recoveryFormat(["write_file", "edit_file", "delete_file"]);
                spinner.log(`[${stepStatus(turn)}] ${output}`);
                trace.add({ turn, status: "error", action: "no_op_mutation_blocked", reason: action.reason, arguments: action, observation: output });
                trace.save();
                messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                continue;
            }
            const normalizedMutationPath = action.path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
            if (normalizedMutationPath === ".cli/mcp.json" && workflow.kind !== "mcp_creation") {
                const output = "Blocked MCP config mutation: .cli/mcp.json is only changed for an explicit MCP-server creation task. Keep the existing configuration while working on this project.";
                recoveryResponseFormat = recoveryFormat(["read_file", "final"]);
                spinner.log(`[${stepStatus(turn)}] ${output}`);
                trace.add({ turn, status: "error", action: "mcp_config_mutation_blocked", reason: action.reason, arguments: action, observation: output });
                trace.save();
                messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                continue;
            }
            projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
            const scopeFailure = unownedProjectMutationReason(action.path, projectChecks);
            if (scopeFailure) {
                const output = `Blocked unscoped project mutation: ${scopeFailure}`;
                recoveryResponseFormat = recoveryFormat([action.action ?? "write_file", "final"]);
                spinner.log(`[${stepStatus(turn)}] ${output}`);
                trace.add({ turn, status: "error", action: "project_scope_blocked", reason: action.reason, arguments: action, observation: output });
                trace.save();
                messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                continue;
            }
        }

        if (acceptance.evidence === "interaction"
            && ["write_file", "edit_file", "delete_file"].includes(action.action ?? "")
            && action.path) {
            const missingCompanions = missingBehaviorCompanionInspections(activeWorkspace, action.path, readPaths);
            if (missingCompanions.length > 0) {
                const output = `Blocked behavior mutation: inspect the target's owning implementation companion before editing: ${missingCompanions.join(", ")}. Trace bindings, imports/providers, handlers, and state changes from source evidence instead of changing presentation markup speculatively.`;
                recoveryResponseFormat = recoveryFormat([action.action ?? "edit_file", "final"]);
                spinner.log(`[${stepStatus(turn)}] ${output}`);
                trace.add({ turn, status: "error", action: "behavior_inspection_blocked", reason: action.reason, arguments: action, observation: output });
                trace.save();
                messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                continue;
            }
        }

        if (action.action === "run_command" && action.command) {
            const packageRisk = packageMutationRisk(activeWorkspace, userMessage, action.command, action.workdir);
            if (packageRisk) {
                const output = `Blocked package mutation: ${packageRisk}. Inspect the selected manifest and lockfile, then use an exact user-authorized package and compatible package manager.`;
                recoveryResponseFormat = recoveryFormat("final");
                spinner.log(`[${stepStatus(turn)}] ${output}`);
                trace.add({ turn, status: "error", action: "package_preflight_blocked", reason: action.reason, arguments: action, observation: output });
                trace.save();
                messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                continue;
            }
        }

        if (action.action === "delete_file" && action.path) {
            const protectedDeletion = protectedProjectDeletionReason(activeWorkspace, action.path, userMessage);
            if (protectedDeletion) {
                const output = `Blocked deletion: ${protectedDeletion}. Inspect the co-located project files and make a different correction.`;
                recoveryResponseFormat = recoveryFormat(["delete_file", "final"]);
                spinner.log(`[${stepStatus(turn)}] ${output}`);
                trace.add({ turn, status: "error", action: action.action, reason: action.reason, arguments: action, observation: output });
                trace.save();
                messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                continue;
            }
        }

        if ((action.action === "write_file" || action.action === "edit_file" || action.action === "delete_file") && action.path
            && writeValidator.exists(action.path) && !readPaths.has(path.resolve(activeWorkspace, action.path).toLowerCase())) {
            writeRetriesAwaitingRead.add(path.resolve(activeWorkspace, action.path).toLowerCase());
            const output = `Blocked write: read the existing file first (${action.path}).`;
            spinner.log(`[${stepStatus(turn)}] ${output}`);
            trace.add({ turn, status: "error", action: action.action, reason: action.reason, arguments: action, observation: output });
            trace.save();
            messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
            continue;
        }

        const validationBeforeMutation = (action.action === "write_file" || action.action === "edit_file") && action.path
            ? writeValidator.validateProjectFor(action.path)
            : undefined;
        const packageManifestBeforeMutation = (action.action === "write_file" || action.action === "edit_file") && action.path
            && path.basename(action.path).toLowerCase() === "package.json"
            && writeValidator.exists(action.path)
            ? fs.readFileSync(path.resolve(activeWorkspace, action.path), "utf8")
            : undefined;
        const completionBeforeDelete = action.action === "delete_file" && projectRequirement
            ? evaluateProjectCompletion(activeWorkspace, projectRequirement)
            : undefined;
        let mutationCheckpointId: string | undefined;
        if (action.action === "write_file" && action.path && typeof action.content === "string") {
            const absolute = path.resolve(activeWorkspace, action.path);
            const alreadyMatches = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
                && fs.readFileSync(absolute, "utf8") === action.content;
            if (!alreadyMatches) {
                const checkpoint = checkpointStore.checkpoint(activeWorkspace, action.path, action.content);
                mutationCheckpointId = checkpoint.id;
                spinner.log(checkpoint.preview);
                spinner.log(`Checkpoint: ${checkpoint.id} (use /undo to restore)`);
            }
        }
        if (action.action === "edit_file" && action.path && typeof action.old_text === "string" && typeof action.new_text === "string") {
            const prepared = agentTool.prepareEdit(action.path, action.old_text, action.new_text);
            if (prepared.ok && prepared.content !== undefined && prepared.changed !== false) {
                const checkpoint = checkpointStore.checkpoint(activeWorkspace, action.path, prepared.content);
                mutationCheckpointId = checkpoint.id;
                spinner.log(checkpoint.preview);
                spinner.log(`Checkpoint: ${checkpoint.id} (use /undo to restore)`);
            }
        }
        if (action.action === "delete_file" && action.path && writeValidator.exists(action.path)) {
            const checkpoint = checkpointStore.checkpoint(activeWorkspace, action.path, "");
            mutationCheckpointId = checkpoint.id;
            spinner.log(checkpoint.preview);
            spinner.log(`Checkpoint: ${checkpoint.id} (use /undo to restore)`);
        }
        spinner.log(agentTool.formatActionStatus(action, segmentTurn, maxTurnsPerSegment));
        spinner.update(`Executing ${action.action}...`);
        debugLog("Tool request", { turn, action });
        let result = await agentTool.execute(action);
        if (workflow.kind !== "mcp_creation" && action.action === "mcp_list_tools" && result.ok
            && (/"servers"\s*:\s*\[\s*\]/i.test(result.output) || /Unknown MCP server/i.test(result.output))) {
            mcpCallsDisabled = true;
            result = {
                ok: false,
                output: `${result.output}\nMCP disabled for this request because no configured server is available. Use local file tools and do not invent server names.`
            };
        }
        if (workflow.kind !== "mcp_creation" && action.action === "mcp_call_tool" && !result.ok
            && /Unknown MCP server|No MCP servers configured/i.test(result.output)) {
            mcpCallsDisabled = true;
            result = {
                ...result,
                output: `${result.output}\nMCP disabled for this request. Use local file tools and do not invent server names.`
            };
        }
        if (result.ok && ["list_files", "search_files", "read_file"].includes(action.action ?? "")) {
            contextInspections.push({
                action: action.action as "list_files" | "search_files" | "read_file",
                ...(action.path ? { path: action.path } : {}),
                ...(action.query ? { query: action.query } : {})
            });
        }
        if (action.action === "read_file" && result.ok && action.path) {
            const resolvedReadPath = path.resolve(activeWorkspace, action.path).toLowerCase();
            readPaths.add(resolvedReadPath);
            noOpMutationPaths.delete(resolvedReadPath);
            if (readOnlyRequest && verificationRequirement === "none" && explicitlyRequestedFiles.length > 0
                && explicitlyRequestedFiles.every((requestedPath) => readPaths.has(requestedPath))) {
                recoveryResponseFormat = getAgentFinalResponseFormat();
            }
            if (writeRetriesAwaitingRead.delete(resolvedReadPath)) {
                guard.resetActionHistory();
            }
        }
        if (action.action === "run_command" && result.ok && commandMutatesWorkspaceFiles(action.command ?? "")) {
            guard.recordFileProgress();
            writtenPaths.add(commandCreatesWorkspaceFiles(action.command ?? "")
                ? "[project scaffold generated by command]"
                : "[dependency metadata updated by command]");
            projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
            const effectiveWorkdir = action.workdir
                ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
            projectChecksAffectedByWorkdir(effectiveWorkdir, projectChecks).forEach((checkId) => {
                successfulProjectChecks.delete(checkId);
                pendingProjectChecks.add(checkId);
            });
            result.output += `\n${formatProjectChecksPrompt(projectChecks)}`;
            if (verificationRequirement !== "none") verificationSatisfied = false;
        }
        if ((action.action === "write_file" || action.action === "edit_file") && result.ok && action.path) {
            let validation = writeValidator.validate(action.path);
            if (validation.ok && packageManifestBeforeMutation
                && !/(?:\bscript\b|\bcommand\b|\bnpm run\b|คำสั่ง|สคริปต์)/i.test(userMessage)) {
                const afterContent = fs.readFileSync(path.resolve(activeWorkspace, action.path), "utf8");
                const changedRoles = packageLifecycleRoleChanges(packageManifestBeforeMutation, afterContent);
                if (changedRoles.length > 0) {
                    validation = {
                        ok: false,
                        validator: "manifest lifecycle semantics",
                        output: `Lifecycle script role changed without an explicit request: ${changedRoles.join(", ")}. Preserve existing runtime/build/test behavior and choose a compatible finite verification command instead.`
                    };
                }
            }
            const beforeDiagnostics = validationBeforeMutation ? countCompilerDiagnostics(validationBeforeMutation.output) : 0;
            const afterDiagnostics = countCompilerDiagnostics(validation.output);
            const beforeFingerprint = validationBeforeMutation ? compilerDiagnosticFingerprint(validationBeforeMutation.output) : [];
            const afterFingerprint = compilerDiagnosticFingerprint(validation.output);
            const replacedDiagnostics = afterDiagnostics >= beforeDiagnostics
                && JSON.stringify(afterFingerprint) !== JSON.stringify(beforeFingerprint);
            const worsenedProject = validation.validator === "TypeScript" && !validation.ok
                && (validationBeforeMutation?.ok !== false || afterDiagnostics > beforeDiagnostics || replacedDiagnostics);
            const shouldRollback = !validation.ok && (validation.validator !== "TypeScript" || worsenedProject);
            const rollback = shouldRollback && mutationCheckpointId
                ? checkpointStore.undoLatest(activeWorkspace, mutationCheckpointId)
                : undefined;
            const diagnosticGuidance = validation.ok ? undefined : diagnosticRecoveryGuidance(validation.output);
            const diagnosticSourceContext = validation.ok ? undefined : agentTool.diagnosticSourceContext(validation.output);
            if (rollback?.ok) {
                recoveryResponseFormat = getAgentMutationResponseFormat();
            }
            result = {
                ok: validation.ok,
                ...(result.changed !== undefined ? { changed: result.changed } : {}),
                output: `${result.output}\nValidator: ${validation.validator}\n${validation.output}${diagnosticGuidance ? `\nRecovery guidance: ${diagnosticGuidance}` : ""}${diagnosticSourceContext ? `\n${diagnosticSourceContext}` : ""}${rollback?.ok ? `\nMutation rolled back because it introduced additional validation failures. ${rollback.message} The failed ${action.action} action is quarantined until a different mutation persists.` : ""}`
            };
            if (validation.ok || rollback?.ok) validationFailures.delete(action.path);
            else validationFailures.add(action.path);
            if (!rollback?.ok && result.changed !== false) {
                // A write changes the file version. Do not let an earlier read
                // authorize a later mutation against stale contents.
                readPaths.delete(path.resolve(activeWorkspace, action.path).toLowerCase());
                guard.recordFileProgress();
                writtenPaths.add(action.path);
                projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                projectChecksAffectedByPath(action.path, projectChecks).forEach((checkId) => {
                    successfulProjectChecks.delete(checkId);
                    pendingProjectChecks.add(checkId);
                });
                result.output += `\n${formatProjectChecksPrompt(projectChecks)}`;
                if (verificationRequirement !== "none") verificationSatisfied = false;
                if (workflow.kind === "mcp_creation") {
                    successfulMcpDiscovery = false;
                    successfulMcpCall = false;
                }
            } else if (validation.ok && result.changed === false) {
                noOpMutationPaths.add(path.resolve(activeWorkspace, action.path).toLowerCase());
                satisfiedPaths.add(action.path);
                if (verificationRequirement === "none" && !projectRequirement) {
                    recoveryResponseFormat = getAgentFinalResponseFormat();
                }
            }
        }
        if (action.action === "delete_file" && result.ok && action.path) {
            const completionAfterDelete = projectRequirement
                ? evaluateProjectCompletion(activeWorkspace, projectRequirement)
                : [];
            const introducedBlockers = completionBeforeDelete
                ? completionAfterDelete.filter((reason) => !completionBeforeDelete.includes(reason))
                : [];
            const protectedDeletion = protectedProjectDeletionReason(activeWorkspace, action.path, userMessage);
            if (protectedDeletion) introducedBlockers.push(protectedDeletion);
            const rollback = introducedBlockers.length > 0 && mutationCheckpointId
                ? checkpointStore.undoLatest(activeWorkspace, mutationCheckpointId)
                : undefined;
            if (rollback?.ok) {
                recoveryResponseFormat = recoveryFormat(["delete_file", "final"]);
                result = {
                    ok: false,
                    output: `${result.output}\nDeletion rolled back because it introduced unmet task requirements: ${introducedBlockers.join("; ")}. ${rollback.message} The delete_file action is quarantined until a different mutation persists.`
                };
            } else {
                // A deleted file likewise invalidates any prior read evidence.
                readPaths.delete(path.resolve(activeWorkspace, action.path).toLowerCase());
                guard.recordFileProgress();
                validationFailures.delete(action.path);
                writtenPaths.add(action.path);
                projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                projectChecksAffectedByPath(action.path, projectChecks).forEach((checkId) => {
                    successfulProjectChecks.delete(checkId);
                    pendingProjectChecks.add(checkId);
                });
                result.output += `\n${formatProjectChecksPrompt(projectChecks)}`;
                if (verificationRequirement !== "none") verificationSatisfied = false;
                if (workflow.kind === "mcp_creation") {
                    successfulMcpDiscovery = false;
                    successfulMcpCall = false;
                }
            }
        }
        if (action.action === "mcp_list_tools" && result.ok) successfulMcpDiscovery = true;
        if (action.action === "mcp_call_tool" && result.ok) successfulMcpCall = true;
        if (action.action === "run_command" && !result.ok) {
            lastFailedCommand = action.command;
            unresolvedMissingCommandTarget = missingCommandTargetError(result.output);
            const effectiveWorkdir = action.workdir
                ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
            const failedKnownCheck = projectChecksForCommand(action.command ?? "", projectChecks, effectiveWorkdir).length > 0;
            const failedRequiredVerification = commandSatisfiesAcceptance(action.command ?? "", acceptance);
            if (failedKnownCheck || failedRequiredVerification) {
                unresolvedVerificationFailure = result.output.slice(0, 2000);
            }
            if (commandInvocationError(result.output)) {
                recoveryResponseFormat = recoveryFormat(["edit_file", "write_file", "delete_file", "final"]);
            }
            if (verificationRequirement !== "none") verificationSatisfied = false;
        } else if (action.action === "run_command" && result.ok) {
            lastFailedCommand = undefined;
            projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
            const effectiveWorkdir = action.workdir
                ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
            const completedProjectChecks = projectChecksForCommand(action.command ?? "", projectChecks, effectiveWorkdir);
            completedProjectChecks.forEach((checkId) => successfulProjectChecks.add(checkId));
            const wroteInteractionTest = acceptance.evidence === "interaction"
                && Array.from(writtenPaths).some((file) => /(?:^|[\\/])[^\\/]*(?:e2e|spec|test)\.[^\\/]+$/i.test(file));
            const satisfiesRequiredCheck = commandSatisfiesAcceptance(action.command ?? "", acceptance)
                || (wroteInteractionTest && completedProjectChecks.length > 0 && /\btest\b/i.test(action.command ?? ""));
            if (completedProjectChecks.length > 0) {
                unresolvedVerificationFailure = undefined;
                unresolvedMissingCommandTarget = false;
            }
            if (satisfiesRequiredCheck) {
                verificationSatisfied = true;
                unresolvedVerificationFailure = undefined;
                unresolvedMissingCommandTarget = false;
            }
        }
        if (!result.ok) {
            unresolvedToolFailure = {
                action: action.action ?? "unknown_action",
                output: result.output
            };
        } else if (["write_file", "edit_file", "delete_file", "run_command"].includes(action.action ?? "")) {
            unresolvedToolFailure = undefined;
        }
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
        trace.save();
        debugLog("Tool result", { turn, action: action.action, ok: result.ok, changed: result.changed, output: result.output });
        const eventTarget = action.path || action.command || action.tool || "";
        segmentEvents.push(`${action.action} [${result.ok ? "ok" : "error"}]${eventTarget ? ` ${eventTarget}` : ""}: ${result.output.replace(/\s+/g, " ").slice(0, 240)}`);
        if (action.action === "mcp_call_tool" && action.tool?.toLowerCase().includes("search") && result.ok) {
            const urls = result.output.match(/https?:\/\/[^"\\\s]+/g) || [];
            urls.forEach((sourceUrl) => sourceUrls.add(sourceUrl));
            if (workflow.kind === "web_research" && urls.length === 0 && searchReturnedNoResults(result.output)) {
                consecutiveEmptyWebSearches += 1;
                if (consecutiveEmptyWebSearches >= 2) {
                    webResearchExhausted = true;
                    recoveryResponseFormat = getAgentFinalResponseFormat();
                    const observation = "Web search returned no usable results for two distinct attempts. Stop searching and return a concise final answer that clearly states the information could not be found through the configured search provider.";
                    trace.add({ turn, status: "error", action: "web_search_exhausted", observation });
                    trace.save();
                    messages.push({ role: "user", content: `Observation: ${observation}` });
                    continue;
                }
            } else if (urls.length > 0) {
                consecutiveEmptyWebSearches = 0;
            }
        }
        const observation = agentTool.formatObservation(action, result);
        debugLog("Tool observation -> LLM", { turn, action: action.action, observation });
        messages.push({
            role: "user",
            content: `Observation: ${observation}`
        });
    }

    const toolLimitBlockers: string[] = [];
    if (mustWrite && writtenPaths.size === 0 && satisfiedPaths.size === 0) toolLimitBlockers.push("no successful workspace change or already-satisfied target was recorded");
    if (validationFailures.size > 0) toolLimitBlockers.push(`validation failing for ${Array.from(validationFailures).join(", ")}`);
    if (unresolvedVerificationFailure) toolLimitBlockers.push(`latest verification failed: ${unresolvedVerificationFailure}`);
    projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
    if (projectRequirement) {
        const missingArtifacts = evaluateProjectCompletion(activeWorkspace, projectRequirement);
        if (missingArtifacts.length > 0) toolLimitBlockers.push(`missing project artifacts: ${missingArtifacts.join(", ")}`);
        const missingChecks = requiredProjectChecks(projectRequirement, projectChecks)
            .filter((check) => !successfulProjectChecks.has(check.id));
        if (missingChecks.length > 0) {
            toolLimitBlockers.push(`project checks not passed: ${missingChecks.map((check) => `${check.command} in ${check.workdir}`).join(", ")}`);
        }
    }
    const pendingChecks = projectChecks.filter((check) => (
        pendingProjectChecks.has(check.id) && !successfulProjectChecks.has(check.id)
    ));
    if (pendingChecks.length > 0) {
        toolLimitBlockers.push(`checks invalidated by file changes: ${pendingChecks.map((check) => `${check.command} in ${check.workdir}`).join(", ")}`);
    }
    if (!verificationSatisfied) toolLimitBlockers.push(`${verificationRequirement} verification not satisfied`);
    if (workflow.kind === "web_research" && !mcpCallsDisabled && !webResearchExhausted && sourceUrls.size < 2) {
        toolLimitBlockers.push("fewer than two web source URLs were collected");
    }
    if (workflow.kind === "mcp_creation" && writtenPaths.size > 0 && (!successfulMcpDiscovery || !successfulMcpCall)) {
        toolLimitBlockers.push("MCP discovery and a successful tool call were not completed");
    }
    if (toolLimitBlockers.length > 0) {
        const answer = formatIncompleteTaskAnswer(toolLimitBlockers, Array.from(writtenPaths));
        spinner.log(`[${maxTurns}/${maxTurns}] Tool limit reached; task remains incomplete`);
        trace.add({
            turn: maxTurns + 1,
            status: "error",
            action: "incomplete_after_tool_limit",
            observation: toolLimitBlockers.join("; ")
        });
        trace.save();
        return { answer, trace, clarifications: clarificationTranscript };
    }

    spinner.log(`[${maxTurns}/${maxTurns}] Tool limit reached after all completion gates passed; preparing a final summary`);
    spinner.update("Summarizing completed work...");
    messages.push({
        role: "user",
        content: `No more tool actions are available for this task. Return one final JSON object now:
{"action":"final","answer":"Summarize what was completed, validations that actually ran, any failures, and concrete remaining work."}
Do not call another tool. Do not claim unverified success.`
    });

    try {
        const modelStartedAt = Date.now();
        debugLog("LLM final-summary request", { model, messages, responseFormat: agentResponseFormat, sampling: actionSampling });
        const response = await llamaClient.post({
            model,
            messages,
            response_format: agentResponseFormat,
            ...actionSampling
        }, (_attempt, errorCode) => {
            spinner.update(`llama.cpp connection ${errorCode}; retrying final summary...`);
        }, signal);
        const responseUsage = recordResponseUsage(sessionId, response.data);
        guard.recordCompletionTokens(responseUsage?.completionTokens ?? 0);
        const choice = response.data.choices[0];
        const rawAssistantContent = choice.message.content;
        const assistantContent = typeof rawAssistantContent === "string" ? rawAssistantContent.trim() : "";
        const finalAction = agentTool.parseAction(assistantContent) as {
            action?: string;
            answer?: string;
            reason?: string;
        } | undefined;
        debugLog("LLM final-summary response", {
            rawContent: rawAssistantContent,
            reasoningContent: choice.message.reasoning_content,
            finishReason: choice.finish_reason,
            parsedAction: finalAction,
            usage: response.data.usage,
            timings: response.data.timings
        });
        responseLog.append({
            turn: maxTurns + 1,
            maxTurns: maxTurnsForLog,
            requestFormat: agentResponseFormat,
            rawContent: rawAssistantContent,
            reasoningContent: choice.message.reasoning_content,
            finishReason: choice.finish_reason,
            parsedAction: finalAction?.action,
            parseError: finalAction ? undefined : agentTool.explainParseFailure(assistantContent),
            durationMs: Date.now() - modelStartedAt,
            usage: response.data.usage,
            timings: response.data.timings
        });

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
            return { answer: finalAnswer, trace, clarifications: clarificationTranscript };
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
    return { answer, trace, clarifications: clarificationTranscript };
}

function ask(activeSession: ChatSession, runMode: RunMode): void {
    statusBar.resume();
    const spinner = new Spinner("Thinking...");

    if (!slashKeypressListenerAttached) {
        slashKeypressListenerAttached = true;
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }

        process.stdin.on("keypress", (_str: string, key: readline.Key) => {
            if (key?.ctrl && key.name === "c" && activeRequestController) {
                activeRequestController.abort();
                activeRequestSpinner?.log("Cancelling active request... completed file writes remain available through /undo.");
                return;
            }
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
            statusBar.stop();
            await agentTool.close();
            llamaClient.close();
            rl.close();
            process.exit(0);
        }

        if (trimmed.toLowerCase() === "/help") {
            printCommandHelp(runMode);
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/settings") {
            printEffectiveSettings();
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/settings init") {
            const result = initializeCliSettings(appRoot);
            console.log(`${result.message} (${result.path})`);
            if (result.created) console.log("Restart the CLI to load the new settings.");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/settings validate") {
            const validation = validateCliSettingsFile(appRoot);
            console.log(validation.ok
                ? `Settings valid: ${validation.path} [${validation.source}]`
                : `Settings invalid: ${validation.path} [${validation.source}]`);
            validation.errors.forEach((error) => console.log(`  - ${error}`));
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/capabilities") {
            await printCapabilities(runMode);
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/clear") {
            contextStartedAt = Date.now();
            sessionTool.resetActiveContextUsage(activeSession.id);
            statusBar.render();
            console.log("Task context cleared. Saved session history was kept.");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/undo") {
            const result = checkpointStore.undoLatest(activeWorkspace);
            console.log(result.ok ? `Undo: ${result.message}` : result.message);
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/skills") {
            const skills = skillLoader.discover(activeWorkspace);
            console.log("Project-local skills:");
            if (skills.length === 0) console.log("  None. Add .cli/skills/<name>/SKILL.md");
            else skills.forEach((skill) => console.log(`  $${skill.name} — ${skill.description}`));
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/usage") {
            printSessionUsage(activeSession.id);
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
            try {
                persistDebugSetting(debugEnabled);
                console.log(`Agent trace: ${debugEnabled ? "on" : "off"} (saved to .cli/settings.json)`);
            } catch (error) {
                console.log(`Agent trace: ${debugEnabled ? "on" : "off"} (could not save setting: ${error instanceof Error ? error.message : String(error)})`);
            }
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
            try {
                console.log(`Switching server model to: ${modelCommand.model}`);
                const result = await modelRouterClient.switch(modelCommand.model);
                model = result.model.id;
                plannerModel = result.model.id;
                serverModelSynced = true;
                const serverContext = await getServerContextInfo(model);
                activeContextLength = serverContext?.contextLength ?? configuredContextLength;
                contextStartedAt = Date.now();
                sessionTool.resetActiveContextUsage(activeSession.id);
                statusBar.render();
                if (result.unloaded.length > 0) console.log(`Unloaded: ${result.unloaded.join(", ")}`);
                console.log(`Current model: ${model}`);
                console.log("Task context cleared for the new model. Saved session history was kept.");
            } catch (error) {
                console.log(`Model switch failed: ${modelRouterClient.formatError(error)}`);
            }
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
                sessionTool.setWorkspace(activeSession.id, nextWorkspace);
                activeSession.workspace = nextWorkspace;
                statusBar.render();
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

        const requestController = new AbortController();
        const requestBudget = createRequestBudget(requestController, agentGuardSettings.maxDurationMs);
        activeRequestController = requestController;
        activeRequestSpinner = spinner;
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
            // Task inference is cheap and does not enter the model prompt. Keep a
            // much longer window than conversational context so repeated
            // continuation requests cannot erase the original acceptance scope.
            const taskHistory = sessionTool.getContextMessages(activeSession.id, 160, contextStartedAt);
            const historyForModel = toModelMessages(sessionHistory);
            const historyForTask = [
                ...(activeSession.title ? [{ role: "user" as const, content: `Build task: ${activeSession.title}` }] : []),
                ...toModelMessages(taskHistory)
            ];

            if (runMode === "agent" && !imagePrompt && !explicitReadPrompt && !explicitEditPrompt && !trimmed.startsWith("/")) {
                const result = await runAgentLoop(
                    trimmed,
                    historyForModel,
                    historyForTask,
                    spinner,
                    activeSession.id,
                    requestController.signal,
                    requestBudget
                );
                const elapsedMs = spinner.stop();
                if (debugEnabled) {
                    result.trace.print();
                }
                console.log("AI:", result.answer);
                console.log(formatCompletionLine(elapsedMs));
                printSessionUsage(activeSession.id);
                console.log();

                const recordedRequest = result.clarifications.length > 0
                    ? `${trimmed}\n\nClarifications provided during this task:\n${result.clarifications.map((line) => `- ${line}`).join("\n")}`
                    : trimmed;
                sessionTool.appendExchange(activeSession.id, recordedRequest, result.answer);
                ask(activeSession, runMode);
                return;
            }

            if (!imagePrompt && !explicitReadPrompt && !explicitEditPrompt && !trimmed.startsWith("/")) {
                const decision = await routeTool(trimmed, activeSession.id, requestController.signal);
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

                const planner = await llamaClient.post({
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
                }, undefined, requestController.signal);
                recordResponseUsage(activeSession.id, planner.data);

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

                const editResponse = await llamaClient.post({
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
                }, undefined, requestController.signal);
                recordResponseUsage(activeSession.id, editResponse.data);

                const editedRaw = editResponse.data.choices[0].message.content?.trim() ?? "";
                const editedContent = stripCodeFence(editedRaw);

                if (!editedContent) {
                    throw new Error("Model returned empty edited content.");
                }

                const checkpoint = checkpointStore.checkpoint(activeWorkspace, editFilePrompt.filePath, editedContent);
                spinner.log(checkpoint.preview);
                spinner.log(`Checkpoint: ${checkpoint.id} (use /undo to restore)`);
                editFileTool.writeEditedFile(editFilePrompt.filePath, editedContent);

                const validation = new WriteValidator(activeWorkspace).validate(editFilePrompt.filePath);
                if (!validation.ok) {
                    checkpointStore.undoLatest(activeWorkspace);
                    throw new Error(`Updated file but ${validation.validator} validation failed:\n${validation.output}`);
                }

                const elapsedMs = spinner.stop();
                const editMessage = implicitEditPrompt
                    ? `Updated and validated file (auto edit intent): ${editFilePrompt.filePath} (${validation.validator})`
                    : `Updated and validated file: ${editFilePrompt.filePath} (${validation.validator})`;
                console.log("AI:", editMessage);
                console.log(formatCompletionLine(elapsedMs));
                printSessionUsage(activeSession.id);
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
            const selectedSkills = skillLoader.select(trimmed, skillLoader.discover(activeWorkspace));
            const skillGuidance = skillLoader.formatPrompt(selectedSkills);
            if (selectedSkills.length > 0) spinner.log(`Skills: ${selectedSkills.map((skill) => skill.name).join(", ")}`);

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

            const chatMessages = [
                {
                    role: "system" as const,
                    content: [assistantSystemInstruction, skillGuidance].filter(Boolean).join("\n\n")
                },
                ...historyForModel,
                {
                    role: "user" as const,
                    content: userContent
                }
            ];
            debugLog("Chat LLM request", { model, messages: chatMessages, sampling: chatSampling });
            const response = await llamaClient.post({
                model,
                messages: chatMessages,
                ...chatSampling
            }, undefined, requestController.signal);
            recordResponseUsage(activeSession.id, response.data);

            const answer = response.data.choices[0].message.content?.trim() ?? "";
            debugLog("Chat LLM response", {
                rawContent: response.data.choices[0].message.content,
                reasoningContent: response.data.choices[0].message.reasoning_content,
                finishReason: response.data.choices[0].finish_reason,
                usage: response.data.usage,
                timings: response.data.timings
            });
            const elapsedMs = spinner.stop();
            console.log("AI:", answer);
            console.log(formatCompletionLine(elapsedMs));
            printSessionUsage(activeSession.id);
            console.log();

            sessionTool.appendExchange(activeSession.id, trimmed, answer);
        } catch (error) {
            const elapsedMs = spinner.stop();
            if (requestController.signal.aborted) {
                const reason = requestController.signal.reason instanceof Error && requestController.signal.reason.message.includes("budget")
                    ? requestController.signal.reason.message
                    : "Request cancelled.";
                console.log(`${reason} The CLI is ready for the next prompt; use /undo if a completed write should be reverted.`);
            }
            else console.error(`API Error: ${llamaClient.formatError(error)}`);
            console.log(formatCompletionLine(elapsedMs, false));
        } finally {
            requestBudget.clear();
            if (activeRequestController === requestController) activeRequestController = undefined;
            if (activeRequestSpinner === spinner) activeRequestSpinner = undefined;
        }

        ask(activeSession, runMode);
    });
}

async function start(): Promise<void> {
    const [modelSynced, serverContext] = await Promise.all([
        syncModelFromServer(),
        getServerContextInfo()
    ]);
    activeContextLength = serverContext?.contextLength ?? configuredContextLength;
    console.log("Chat Started");
    console.log("Type \"exit\" to quit");
    console.log("Image mode: /img <path-to-image> | <prompt>");
    console.log("Read file mode: /readfile <path-to-file> | <prompt>");
    console.log("Edit file mode: /editfile <path-to-file> | <instruction>");
    console.log("Mode: /mode planner, /mode fast, or /mode agent");
    console.log("Model status: /model");
    console.log(`Agent trace: ${debugEnabled ? "on" : "off"} (/debug on|off)`);
    console.log("New task context: /clear");
    console.log("Cancel active request: Ctrl+C | restore latest file change: /undo");
    console.log("Project-local skills: /skills");
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

    const activeSession = requestedSessionId
        ? sessionTool.resumeSession(requestedSessionId)
        : await sessionTool.selectSession(rl, activeWorkspace);
    if (!activeSession) {
        throw new Error(`Session not found: ${requestedSessionId}`);
    }
    await restoreSessionWorkspace(activeSession);
    console.log(`Session: ${activeSession.title}`);
    console.log(formatSessionHistory(
        sessionTool.getContextMessages(activeSession.id, historyMessageLimit),
        historyMessageLimit
    ));
    console.log();
    printSessionUsage(activeSession.id);
    console.log();

    const initialMode: RunMode = "agent";
    console.log(`Current mode: ${initialMode}`);
    console.log(modelSynced
        ? `Current model: ${model}`
        : `Current model: unavailable (configured fallback: ${model})`);
    console.log();

    statusSessionId = activeSession.id;
    statusBar.start();
    ask(activeSession, initialMode);
}

start().catch((error) => {
    statusBar.stop();
    console.error(`Failed to start chat: ${llamaClient.formatError(error)}`);
    llamaClient.close();
    rl.close();
    process.exit(1);
});

process.once("exit", () => statusBar.stop());
