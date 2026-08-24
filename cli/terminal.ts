import axios = require("axios");
import readline = require("node:readline");
import fs = require("node:fs");
import path = require("node:path");
const { generateLogViewer } = require("../scripts/generate-log-viewer") as {
    generateLogViewer: (root?: string) => string;
};
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
        inspections: Array<{ action: "list_files" | "search_project" | "search_files" | "read_file"; path?: string; query?: string }>;
    }) => Array<{ action: "list_files" | "search_project" | "search_files" | "read_file"; path?: string; query?: string }>;
    resolveClarificationAnswer: (request: ClarificationRequest, input: string) => ClarificationAnswer | undefined;
};
type ClarificationRequest = import("./clarificationTypes").ClarificationRequest;
type ClarificationAnswer = import("./clarificationTypes").ClarificationAnswer;
const { LlamaCppProvider } = require("./model/llamaCppProvider") as { LlamaCppProvider: new (apiUrl: string, timeoutMs?: number) => {
    chat: (request: {
        model: string;
        messages: Array<{ role: "system" | "user" | "assistant"; content: unknown }>;
        responseFormat?: Record<string, unknown>;
        sampling?: Record<string, unknown>;
        signal?: AbortSignal | undefined;
        onRetry?: (attempt: number, errorCode: string) => void;
    }) => Promise<{ data: any; content: string; reasoningContent?: unknown; finishReason?: unknown; usage?: unknown; timings?: unknown }>;
    formatError: (error: unknown) => string;
    close: () => void;
} };
const { DefaultAgentRunner } = require("./agent/agentRunner") as { DefaultAgentRunner: new (services: Record<string, unknown>) => {
    run: (request: {
        userMessage: string;
        historyForModel: Array<{ role: "user" | "assistant"; content: string }>;
        historyForTask: Array<{ role: "user" | "assistant"; content: string }>;
        spinner: { update: (message: string) => void; log: (message: string) => void; suspend: () => void; resume: () => void };
        sessionId: string;
        taskId: string;
        signal: AbortSignal;
        requestBudget: { pause: () => void; resume: () => void; clear: () => void };
    }) => Promise<{ answer: string; trace: InstanceType<typeof AgentTrace>; clarifications: string[] }>;
} };
const { ModelRouterClient } = require("./modelRouter") as { ModelRouterClient: new (apiUrl: string, loadTimeoutMs?: number) => {
    list: () => Promise<RouterModel[]>;
    switch: (selection: string) => Promise<{ model: RouterModel; unloaded: string[] }>;
    formatError: (error: unknown) => string;
} };
const { loadCliSettings, getSamplingSettings, getAgentGuardSettings, getClarificationSettings, getProjectCheckProviders, getTerminalSettings, initializeCliSettings, validateCliSettingsFile } = require("./config") as {
    loadCliSettings: (appRoot?: string) => CliSettings;
    getSamplingSettings: (settings: CliSettings, kind: "chat" | "planner" | "action") => SamplingSettings;
    getAgentGuardSettings: (settings: CliSettings) => AgentGuardSettings;
    getClarificationSettings: (settings: CliSettings) => ClarificationSettings;
    getProjectCheckProviders: (settings: CliSettings) => ProjectCheckProvider[];
    getTerminalSettings: (settings: CliSettings) => { llmMessageColor: string };
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
    recordObservation: (action: Record<string, unknown>, observation: { ok: boolean; output: string; changed?: boolean }) => { status: "allow" | "replan" | "stop"; message?: string };
    resetActionHistory: () => void;
    recordFileProgress: () => void;
    pause: () => void;
    resume: () => void;
    formatRemaining: () => string;
} };
const { continuationNoWriteCompletionAllowed, effectiveCompletionStatus, noChangeCompletionBlockReason } = require("./completionPolicy") as {
    continuationNoWriteCompletionAllowed: (input: {
        continuation: boolean;
        evidence: string[];
        successfulEvidenceRefs: Set<string>;
        successfulWorkspaceEvidenceRefs: Set<string>;
        verificationRequired: boolean;
        verificationSatisfied: boolean;
        hasUnresolvedFailures: boolean;
    }) => boolean;
    effectiveCompletionStatus: (
        status: "completed" | "already_satisfied" | "no_change_needed" | "incomplete",
        successfulWorkspaceChanges: number
    ) => "completed" | "already_satisfied" | "no_change_needed" | "incomplete";
    noChangeCompletionBlockReason: (input: {
        status: "completed" | "already_satisfied" | "no_change_needed" | "incomplete";
        evidence: string[];
        successfulEvidenceRefs: Set<string>;
        successfulWorkspaceEvidenceRefs: Set<string>;
        workspaceChangeRequired: boolean;
        verificationRequired: boolean;
        verificationSatisfied: boolean;
        hasUnresolvedFailures: boolean;
    }) => string | undefined;
};
const { FailedCommandRegistry } = require("./failedCommandRegistry") as {
    FailedCommandRegistry: new (workspace: string) => {
        has: (command: string, workdir?: string) => boolean;
        record: (command: string, workdir?: string, errorOutput?: string) => void;
        failureFor: (command: string, workdir?: string) => string | undefined;
        recordBlockedAttempt: (command: string, workdir?: string) => number;
        clear: () => void;
    };
};
const { shouldActivateVerificationRecovery, verificationRecoveryTurnAllowance } = require("./verificationRecovery") as {
    shouldActivateVerificationRecovery: (input: {
        boundedRun: boolean;
        baseLimitReached: boolean;
        unresolvedVerificationFailure?: string;
        verificationRequiredAndUnsatisfied?: boolean;
        pendingProjectChecks?: boolean;
    }) => boolean;
    verificationRecoveryTurnAllowance: (maxTurnsPerSegment: number) => number;
};
const { commandAddsTooling, commandCreatesWorkspaceFiles, commandMutatesWorkspaceFiles, commandInvocationError, commandInvokesAgentTool, diagnosticRecoveryGuidance, missingCommandTargetError, normalizeCommandSignature, packageLifecycleRoleChanges, packageMutationRisk, packageScriptCommandsEquivalent } = require("./commandNormalizer") as {
    commandAddsTooling: (command: string) => boolean;
    commandCreatesWorkspaceFiles: (command: string) => boolean;
    commandMutatesWorkspaceFiles: (command: string) => boolean;
    commandInvocationError: (errorOutput: string) => boolean;
    commandInvokesAgentTool: (command: string) => boolean;
    diagnosticRecoveryGuidance: (errorOutput: string) => string | undefined;
    missingCommandTargetError: (errorOutput: string) => boolean;
    normalizeCommandSignature: (command: string) => string;
    packageLifecycleRoleChanges: (beforeContent: string, afterContent: string) => string[];
    packageMutationRisk: (workspace: string, userMessage: string, command: string, requestedWorkdir?: string) => string | undefined;
    packageScriptCommandsEquivalent: (left: string, right: string) => boolean;
};
const { FileCheckpointStore } = require("./fileCheckpoints") as { FileCheckpointStore: new (root: string) => {
    checkpoint: (workspace: string, inputPath: string, nextContent: string) => { id: string; preview: string };
    undoLatest: (workspace: string, checkpointId?: string) => { ok: boolean; message: string };
} };
const { SkillLoader } = require("./skillLoader") as { SkillLoader: new (userSkillsRoot?: string) => {
    discover: (workspace: string) => Array<{ name: string; description: string; body: string }>;
    select: (message: string, skills: Array<{ name: string; description: string; body: string }>) => Array<{ name: string; description: string; body: string }>;
    formatPrompt: (skills: Array<{ name: string; description: string; body: string }>) => string;
} };
type InputSuggestion = {
    kind: "slash" | "skill" | "model";
    value: string;
    description: string;
    replaceStart: number;
    replaceEnd: number;
    appendSpace: boolean;
};
const {
    acceptInputSuggestion,
    applyInputSuggestion,
    buildInputSuggestions,
    moveSuggestionSelection,
    suggestionStateKey
} = require("./inputSuggestions") as {
    acceptInputSuggestion: (
        line: string,
        cursor: number,
        suggestion: InputSuggestion,
        keyName: "enter" | "return" | "tab"
    ) => { line: string; cursor: number; submit: boolean };
    applyInputSuggestion: (line: string, suggestion: InputSuggestion) => { line: string; cursor: number };
    buildInputSuggestions: (input: {
        line: string;
        cursor: number;
        slashCommands: Array<{ value: string; description: string }>;
        skills: Array<{ value: string; description: string }>;
        models: Array<{ value: string; description: string }>;
        limit?: number;
    }) => InputSuggestion[];
    moveSuggestionSelection: (current: number, count: number, direction: -1 | 1) => number;
    suggestionStateKey: (suggestions: InputSuggestion[]) => string;
};
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
const {
    MAX_REASONING_ONLY_RETRIES,
    REASONING_ONLY_PARSE_ERROR,
    formatReasoningOnlyRecoveryPrompt,
    isReasoningOnlyTruncation,
    reasoningOnlyRetryMaxTokens
} = require("./modelResponseRecovery") as {
    MAX_REASONING_ONLY_RETRIES: number;
    REASONING_ONLY_PARSE_ERROR: string;
    formatReasoningOnlyRecoveryPrompt: (attempt: number) => string;
    isReasoningOnlyTruncation: (response: { content: unknown; reasoningContent: unknown; finishReason: unknown }) => boolean;
    reasoningOnlyRetryMaxTokens: (configuredMaxTokens: number) => number;
};
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
            successfulEvidenceRefs?: string[];
            successfulWorkspaceEvidenceRefs?: string[];
            sourceUrls: string[];
            recentEvents: string[];
            mcpCallsDisabled?: boolean;
        }
    ) => Array<{ role: "system" | "user"; content: string }>;
};
const { buildInitialAgentMessages, getAgentResponseFormat, getAgentRecoveryResponseFormat, getAgentMutationResponseFormat, getAgentReadOnlyResponseFormat, getAgentFinalResponseFormat, getInitialAgentResponseFormat, withoutMcpActions } = require("./agentProtocol") as {
    buildInitialAgentMessages: (systemPrompt: string, contextSummary: string, userMessage: string) => Array<{ role: "system" | "user"; content: string }>;
    getAgentResponseFormat: (workflow: WorkflowKind) => Record<string, unknown>;
    getAgentRecoveryResponseFormat: (workflow: WorkflowKind, blockedAction: string | string[]) => Record<string, unknown>;
    getAgentMutationResponseFormat: (blockedAction?: string) => Record<string, unknown>;
    getAgentReadOnlyResponseFormat: (workflow: WorkflowKind, allowCommands?: boolean) => Record<string, unknown>;
    getAgentFinalResponseFormat: () => Record<string, unknown>;
    getInitialAgentResponseFormat: () => Record<string, unknown>;
    withoutMcpActions: (responseFormat: Record<string, unknown>) => Record<string, unknown>;
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
const { commandSatisfiesAcceptance } = require("./workflowRouter") as {
    commandSatisfiesAcceptance: (command: string, contract: AcceptanceContract, options?: { probe?: boolean }) => boolean;
};
const { deriveTaskEvidencePolicy, isVisualPresentationMutation, taskContractsEquivalent } = require("./taskEvidence") as {
    deriveTaskEvidencePolicy: (
        requirements: Array<"source" | "command" | "runtime" | "interaction" | "visual">,
        verification: "none" | "command" | "runtime" | "interaction"
    ) => { evidence: AcceptanceContract["evidence"]; verification: VerificationRequirement; visualPresentation: boolean };
    isVisualPresentationMutation: (filePath: string, replacementText?: string) => boolean;
    taskContractsEquivalent: (
        left: {
            intent: string;
            task_type: string;
            continuation: boolean;
            requires_workspace_changes: boolean;
            verification: string;
            evidence_requirements: string[];
            success_criteria: string[];
        },
        right: {
            intent: string;
            task_type: string;
            continuation: boolean;
            requires_workspace_changes: boolean;
            verification: string;
            evidence_requirements: string[];
            success_criteria: string[];
        }
    ) => boolean;
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
const { formatAiResponse, normalizeTerminalColor } = require("./terminalStyle") as {
    formatAiResponse: (answer: string, colors?: boolean, messageColor?: string | number) => string;
    normalizeTerminalColor: (value: unknown) => string | undefined;
};
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
const { AgentTool } = require("./tools/agentTool") as { AgentTool: new (configRoot?: string, commandTimeoutOverrideMs?: number, inferenceApiUrl?: string) => {
    buildSystemPrompt: (workflowInstructions?: string) => Promise<string>;
    parseAction: (content: string | undefined | null) => unknown;
    explainParseFailure: (content: string | undefined | null) => string;
    execute: (action: unknown) => Promise<{
        ok: boolean;
        output: string;
        changed?: boolean;
        assertionPassed?: boolean;
        probeTimedOut?: boolean;
        failureKind?: "inference_port_collision" | "invocation" | "timeout" | "unsafe" | "runtime";
        recommendedCommand?: string;
        recommendedWorkdir?: string;
        recommendedMode?: "probe";
    }>;
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
    beginTask: (sessionId: string, userRequest: string) => string | undefined;
    recordTaskEvent: (sessionId: string, taskId: string, entry: {
        turn: number;
        status: "action" | "ok" | "error" | "parse_error" | "final";
        action?: string;
        reason?: string;
        arguments?: unknown;
        observation?: string;
    }) => void;
    finishTask: (sessionId: string, taskId: string, answer: string) => void;
    interruptTask: (sessionId: string, taskId: string, reason: string) => void;
    recoverInterruptedTask: (sessionId: string) => boolean;
    getUnfinishedTaskContext: (sessionId: string) => string;
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
    terminal?: { llmMessageColor?: string | number };
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
    { command: "/log", description: "refresh the HTML log viewer" },
    { command: "/color", description: "show or change the LLM message color" },
    { command: "/clear", description: "start a clean task context" },
    { command: "/undo", description: "restore the latest file checkpoint" },
    { command: "/skills", description: "show project-local skills" },
    { command: "/debug", description: "show or hide agent trace" },
    { command: "/debug on", description: "show agent trace" },
    { command: "/debug off", description: "hide agent trace" },
    { command: "/exit", description: "exit the app" }
];
let inputSuggestionKeypressListenerAttached = false;
let renderedInputSuggestionCount = 0;
let inputSuggestions: InputSuggestion[] = [];
let selectedInputSuggestion = 0;
let activeInputSuggestionKey = "";
let routerModelSuggestionCache: RouterModel[] = [];
let routerModelSuggestionsLoading = false;
let routerModelSuggestionError: string | undefined;
let clarificationPromptActive = false;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
        const suggestions = getInputSuggestions(line, line.length);
        return [
            suggestions.map((suggestion) => applyInputSuggestion(line, suggestion).line),
            line
        ];
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
const terminalSettings = getTerminalSettings(cliSettings);
// The request-level Axios timeout must not fire before the user-visible Agent
// wall-clock guard. A zero guard is deliberately unbounded, so Axios must also
// receive zero (its no-timeout value) rather than a five-second fallback.
const llamaClient = new LlamaCppProvider(
    apiUrl,
    agentGuardSettings.maxDurationMs > 0 ? agentGuardSettings.maxDurationMs + 5000 : 0
);
const modelRouterClient = new ModelRouterClient(apiUrl);
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

function persistTerminalColor(color: string): void {
    const settingsPath = path.resolve(appRoot, ".cli", "settings.json");
    if (!fs.existsSync(settingsPath)) initializeCliSettings(appRoot);
    let persisted: Record<string, unknown> = {};
    try {
        persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
        // Preserve the selected color in a valid settings object if the
        // existing personal settings file cannot be parsed.
    }
    const persistedTerminal = persisted.terminal && typeof persisted.terminal === "object" && !Array.isArray(persisted.terminal)
        ? persisted.terminal as Record<string, unknown>
        : {};
    persisted.terminal = {
        ...persistedTerminal,
        llmMessageColor: color
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    cliSettings.terminal = {
        ...cliSettings.terminal,
        llmMessageColor: color
    };
    terminalSettings.llmMessageColor = color;
}

// Sessions belong to the CLI installation, not to whichever workspace the
// agent is currently inspecting. This also keeps --workspace startup and the
// interactive /workspace command consistent.
const sessionTool = new SessionTool(path.resolve(appRoot, ".cli-sessions.json"));
const imageTool = new ImageTool();
const readFileTool = new ReadFileTool();
const editFileTool = new EditFileTool();
const toolRouter = new ToolRouter();
const agentTool = new AgentTool(appRoot, undefined, apiUrl);
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

const agentRunner = new DefaultAgentRunner({
    AgentGuard,
    agentGuardSettings,
    verificationRecoveryTurnAllowance,
    shouldActivateVerificationRecovery,
    discoverProjectChecks,
    get activeWorkspace() { return activeWorkspace; },
    projectCheckProviders,
    getAgentReadOnlyResponseFormat,
    getAgentResponseFormat,
    getInitialAgentResponseFormat,
    selectTaskContext,
    historyMessageLimit,
    summarizeTaskContext,
    WriteValidator,
    skillLoader,
    FailedCommandRegistry,
    appRoot,
    AgentTrace,
    debugLog,
    sessionTool,
    AgentResponseLog,
    resolveJsonlLogPath,
    agentTool,
    formatProjectChecksPrompt,
    formatProjectCompletionPrompt,
    buildInitialAgentMessages,
    getAgentRecoveryResponseFormat,
    buildCompactedAgentMessages,
    withoutMcpActions,
    actionSampling,
    get model() { return model; },
    get activeContextLength() { return activeContextLength; },
    llmProvider: llamaClient,
    recordResponseUsage,
    isReasoningOnlyTruncation,
    reasoningOnlyRetryMaxTokens,
    MAX_REASONING_ONLY_RETRIES,
    REASONING_ONLY_PARSE_ERROR,
    formatReasoningOnlyRecoveryPrompt,
    answerLooksLikeBlockingClarification,
    clarificationBlockReason,
    clarificationObservation,
    clarificationTranscriptLine,
    relevantClarificationInspections,
    promptForClarification,
    discoverProjectRoots,
    deriveTaskEvidencePolicy,
    taskContractsEquivalent,
    getAgentMutationResponseFormat,
    getAgentFinalResponseFormat,
    continuationNoWriteCompletionAllowed,
    effectiveCompletionStatus,
    noChangeCompletionBlockReason,
    formatIncompleteTaskAnswer,
    evaluateProjectCompletion,
    requiredProjectChecks,
    answerDefersRequiredWork,
    protectedProjectDeletionReason,
    commandInvocationError,
    normalizeCommandSignature,
    packageScriptCommandsEquivalent,
    packageMutationRisk,
    commandMutatesWorkspaceFiles,
    commandCreatesWorkspaceFiles,
    projectChecksAffectedByWorkdir,
    projectChecksAffectedByPath,
    projectChecksForCommand,
    commandSatisfiesAcceptance,
    commandAddsTooling,
    packageLifecycleRoleChanges,
    diagnosticRecoveryGuidance,
    missingCommandTargetError,
    commandInvokesAgentTool,
    unownedProjectMutationReason,
    isVisualPresentationMutation,
    searchReturnedNoResults,
    countCompilerDiagnostics,
    compilerDiagnosticFingerprint,
    checkpointStore,
    clarificationSettings
});

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
    console.log(`llama.cpp API: ${apiUrl}`);

    if (routerModels) {
        routerModelSuggestionCache = routerModels;
        routerModelSuggestionError = undefined;
        console.log("Available server models:");
        routerModels.forEach((entry, index) => {
            const state = entry.failed ? "failed" : entry.status;
            console.log(`  [${index + 1}] ${entry.id} (${state})`);
        });
        console.log("Switch with /model <number-or-name>.");
    } else {
        console.log("Available server models: unavailable (the server is offline or llama.cpp router mode is disabled)");
        console.log("Runtime switching and the full model list require router mode on the server.");
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
    console.log("/log                      Refresh .cli/log-viewer.html from the latest logs");
    console.log("/color                    Show the current LLM message color and supported values");
    console.log("/color <name-or-code>     Change and save the LLM message color");
    console.log("/clear                    Start a new task context; keep session history");
    console.log("/undo                     Restore the latest model file checkpoint");
    console.log("/skills                   Show user-level and project-local skills");
    console.log("/debug [on|off]           Show status or toggle concise agent trace");
    console.log("/exit                     Exit the app");
    console.log("Autocomplete: type /, $skill, or /model; use ↑↓, Enter to run/select, Tab to insert, and Esc");
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
        ["hardwareProfile", process.env.LLAMA_HARDWARE_PROFILE?.trim() || cliSettings.hardwareProfile || "auto", settingSource("LLAMA_HARDWARE_PROFILE", cliSettings.hardwareProfile !== undefined)],
        ["terminal.llmMessageColor", terminalSettings.llmMessageColor, cliSettings.terminal?.llmMessageColor !== undefined ? settingsFileSource() : "built-in default"]
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

function getInputSuggestions(line: string, cursor: number): InputSuggestion[] {
    const skills = skillLoader.discover(activeWorkspace).map((skill) => ({
        value: skill.name,
        description: skill.description
    }));
    const models = routerModelSuggestionCache.map((entry) => ({
        value: entry.id,
        description: entry.failed ? "failed" : entry.status
    }));
    return buildInputSuggestions({
        line,
        cursor,
        slashCommands: slashCommandOptions.map((item) => ({
            value: item.command,
            description: item.description
        })),
        skills,
        models,
        limit: maxVisibleSlashSuggestions
    });
}

function isModelSuggestionInput(line: string, cursor: number): boolean {
    return /^\s*\/model(?:\s+[^\s]*)?$/i.test(line.slice(0, cursor));
}

async function loadRouterModelSuggestions(force = false): Promise<void> {
    if (routerModelSuggestionsLoading || (!force && routerModelSuggestionCache.length > 0)) return;
    routerModelSuggestionsLoading = true;
    routerModelSuggestionError = undefined;
    updateInputSuggestions();
    try {
        routerModelSuggestionCache = await modelRouterClient.list();
    } catch (error) {
        routerModelSuggestionError = modelRouterClient.formatError(error);
    } finally {
        routerModelSuggestionsLoading = false;
        updateInputSuggestions();
    }
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

function clearInputSuggestions(): void {
    if (renderedInputSuggestionCount === 0 || !process.stdout.isTTY) {
        return;
    }

    const count = renderedInputSuggestionCount;

    for (let index = 0; index < count; index += 1) {
        process.stdout.write("\n");
        readline.clearLine(process.stdout, 0);
    }

    restoreCursorToInput(count);
    renderedInputSuggestionCount = 0;
}

function renderInputSuggestions(line: string): void {
    if (!process.stdout.isTTY) {
        return;
    }

    const suggestions = getInputSuggestions(line, rl.cursor);
    const nextKey = suggestionStateKey(suggestions);
    if (nextKey !== activeInputSuggestionKey) selectedInputSuggestion = 0;
    activeInputSuggestionKey = nextKey;
    inputSuggestions = suggestions;
    if (suggestions.length === 0) {
        if (isModelSuggestionInput(line, rl.cursor) && (routerModelSuggestionsLoading || routerModelSuggestionError)) {
            const notice = routerModelSuggestionsLoading
                ? "… loading server models"
                : `! model suggestions unavailable: ${routerModelSuggestionError}`;
            process.stdout.write("\n");
            readline.clearLine(process.stdout, 0);
            process.stdout.write(`\x1b[2m${notice.slice(0, Math.max(20, (process.stdout.columns || 100) - 2))}\x1b[0m`);
            restoreCursorToInput(1);
            renderedInputSuggestionCount = 1;
        }
        return;
    }

    selectedInputSuggestion = Math.min(selectedInputSuggestion, suggestions.length - 1);
    const labelWidth = Math.min(38, Math.max(...suggestions.map((item) => item.value.length)));
    const availableColumns = Math.max(30, (process.stdout.columns || 100) - 1);
    const lines = suggestions.map((item, index) => {
        const selected = index === selectedInputSuggestion;
        const prefix = selected ? "›" : " ";
        const label = item.value.length > labelWidth
            ? `${item.value.slice(0, Math.max(1, labelWidth - 1))}…`
            : item.value.padEnd(labelWidth, " ");
        const content = `${prefix} ${label}  ${item.description}`;
        const fitted = content.length > availableColumns
            ? `${content.slice(0, Math.max(1, availableColumns - 1))}…`
            : content;
        return `${selected ? "\x1b[36m" : "\x1b[2m"}${fitted}\x1b[0m`;
    });
    const hint = "  ↑↓ select · Enter run/select · Tab insert · Esc close";
    lines.push(`\x1b[2m${hint.slice(0, availableColumns)}\x1b[0m`);

    lines.forEach((lineContent) => {
        process.stdout.write("\n");
        readline.clearLine(process.stdout, 0);
        process.stdout.write(lineContent);
    });

    restoreCursorToInput(lines.length);
    renderedInputSuggestionCount = lines.length;
}

function updateInputSuggestions(): void {
    if (!process.stdout.isTTY || clarificationPromptActive) {
        return;
    }

    clearInputSuggestions();
    if (isModelSuggestionInput(rl.line, rl.cursor)
        && routerModelSuggestionCache.length === 0
        && !routerModelSuggestionsLoading
        && !routerModelSuggestionError) {
        void loadRouterModelSuggestions();
    }
    renderInputSuggestions(rl.line);
}

function clearInputSuggestionsBelow(): void {
    // Called right after Enter: readline has already moved the cursor down to
    // the first panel line, so clearing from cursor to end of screen removes it.
    if (renderedInputSuggestionCount > 0 && process.stdout.isTTY) {
        readline.clearScreenDown(process.stdout);
        statusBar.render();
    }

    inputSuggestions = [];
    selectedInputSuggestion = 0;
    activeInputSuggestionKey = "";
    renderedInputSuggestionCount = 0;
}

function replaceReadlineInput(line: string, cursor: number): void {
    const internal = rl as typeof rl & { line: string; cursor: number; _refreshLine?: () => void };
    internal.line = line;
    internal.cursor = cursor;
    internal._refreshLine?.();
}

function handleInputSuggestionKey(key: readline.Key): boolean {
    if (clarificationPromptActive || inputSuggestions.length === 0) {
        if (key.name === "escape" && renderedInputSuggestionCount > 0) {
            clearInputSuggestions();
            inputSuggestions = [];
            activeInputSuggestionKey = "";
            return true;
        }
        return false;
    }

    if (key.name === "up" || key.name === "down") {
        selectedInputSuggestion = moveSuggestionSelection(
            selectedInputSuggestion,
            inputSuggestions.length,
            key.name === "up" ? -1 : 1
        );
        clearInputSuggestions();
        renderInputSuggestions(rl.line);
        return true;
    }

    if (key.name === "return" || key.name === "enter" || key.name === "tab") {
        const selected = inputSuggestions[selectedInputSuggestion];
        if (!selected) return false;
        const applied = acceptInputSuggestion(
            rl.line,
            rl.cursor,
            selected,
            key.name as "enter" | "return" | "tab"
        );
        clearInputSuggestions();
        inputSuggestions = [];
        activeInputSuggestionKey = "";
        replaceReadlineInput(applied.line, applied.cursor);
        if (applied.submit) return false;
        setImmediate(updateInputSuggestions);
        return true;
    }

    if (key.name === "escape") {
        clearInputSuggestions();
        inputSuggestions = [];
        activeInputSuggestionKey = "";
        return true;
    }

    return false;
}

let inputSuggestionTtyWriteInstalled = false;

function installInputSuggestionTtyWrite(): void {
    if (inputSuggestionTtyWriteInstalled || !process.stdin.isTTY) return;
    const internal = rl as typeof rl & {
        _ttyWrite?: (input: string, key: readline.Key) => void;
    };
    const original = internal._ttyWrite;
    if (!original) return;
    inputSuggestionTtyWriteInstalled = true;
    internal._ttyWrite = function suggestionAwareTtyWrite(input: string, key: readline.Key): void {
        if (handleInputSuggestionKey(key)) return;
        original.call(rl, input, key);
        if (key.name !== "return" && key.name !== "enter") {
            setImmediate(updateInputSuggestions);
        }
    };
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
        const response = await llamaClient.chat({
            model,
            messages: routerMessages,
            sampling: actionSampling,
            signal
        });
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

function ask(activeSession: ChatSession, runMode: RunMode): void {
    statusBar.resume();
    const spinner = new Spinner("Thinking...");

    if (!inputSuggestionKeypressListenerAttached) {
        inputSuggestionKeypressListenerAttached = true;
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        installInputSuggestionTtyWrite();

        process.stdin.on("keypress", (_str: string, key: readline.Key) => {
            if (key?.ctrl && key.name === "c" && activeRequestController) {
                activeRequestController.abort();
                activeRequestSpinner?.log("Cancelling active request... completed file writes remain available through /undo.");
            }
        });
    }

    rl.question("You: ", async (message: string) => {
        const trimmed = message.trim();
        clearInputSuggestionsBelow();
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
            console.log("Available skills:");
            if (skills.length === 0) console.log("  None. Add ~/.codex/skills/<name>/SKILL.md or .cli/skills/<name>/SKILL.md");
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

        if (trimmed.toLowerCase() === "/log") {
            try {
                const viewerPath = generateLogViewer(appRoot);
                console.log(`Log viewer refreshed: ${viewerPath}`);
            } catch (error) {
                console.log(`Log viewer failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase() === "/color") {
            console.log(`Current LLM message color: ${terminalSettings.llmMessageColor}`);
            console.log("Supported names: black, red, green, yellow, blue, magenta, cyan, white, default, bright-black, bright-red, bright-green, bright-yellow, bright-blue, bright-magenta, bright-cyan, bright-white");
            console.log("Supported ANSI foreground codes: 30-37, 39, 90-97");
            console.log("Usage: /color <name-or-code>");
            console.log();
            ask(activeSession, runMode);
            return;
        }

        if (trimmed.toLowerCase().startsWith("/color ")) {
            const requestedColor = trimmed.slice("/color ".length).trim();
            const normalizedColor = normalizeTerminalColor(requestedColor);
            if (!normalizedColor) {
                console.log(`Unsupported color: ${requestedColor}`);
                console.log("Use /color to show supported names and ANSI foreground codes.");
            } else {
                try {
                    persistTerminalColor(normalizedColor);
                    console.log(`LLM message color changed and saved: ${normalizedColor}`);
                } catch (error) {
                    console.log(`Color setting failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
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
                routerModelSuggestionCache = [];
                routerModelSuggestionError = undefined;
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
        let journalTaskId: string | undefined;
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
            const unfinishedTaskContext = sessionTool.getUnfinishedTaskContext(activeSession.id);
            const unfinishedTaskMessage = unfinishedTaskContext
                ? [{ role: "assistant" as const, content: unfinishedTaskContext }]
                : [];
            const historyForModel = [
                ...toModelMessages(sessionHistory),
                ...unfinishedTaskMessage
            ];
            const historyForTask = [
                ...(activeSession.title ? [{ role: "user" as const, content: `Build task: ${activeSession.title}` }] : []),
                ...toModelMessages(taskHistory),
                ...unfinishedTaskMessage
            ];

            if (runMode === "agent" && !imagePrompt && !explicitReadPrompt && !explicitEditPrompt && !trimmed.startsWith("/")) {
                journalTaskId = sessionTool.beginTask(activeSession.id, trimmed);
                if (!journalTaskId) throw new Error("Could not create the durable session task journal.");
                const result = await agentRunner.run({
                    userMessage: trimmed,
                    historyForModel,
                    historyForTask,
                    spinner,
                    sessionId: activeSession.id,
                    taskId: journalTaskId,
                    signal: requestController.signal,
                    requestBudget
                });
                sessionTool.finishTask(activeSession.id, journalTaskId, result.answer);
                const elapsedMs = spinner.stop();
                if (debugEnabled) {
                    result.trace.print();
                }
                process.stdout.write(formatAiResponse(result.answer, undefined, terminalSettings.llmMessageColor));
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

                const planner = await llamaClient.chat({
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
                    sampling: plannerSampling,
                    signal: requestController.signal
                });
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

                const editResponse = await llamaClient.chat({
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
                    sampling: actionSampling,
                    signal: requestController.signal
                });
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
                process.stdout.write(formatAiResponse(editMessage, undefined, terminalSettings.llmMessageColor));
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
            const response = await llamaClient.chat({
                model,
                messages: chatMessages,
                sampling: chatSampling,
                signal: requestController.signal
            });
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
            process.stdout.write(formatAiResponse(answer, undefined, terminalSettings.llmMessageColor));
            console.log(formatCompletionLine(elapsedMs));
            printSessionUsage(activeSession.id);
            console.log();

            sessionTool.appendExchange(activeSession.id, trimmed, answer);
        } catch (error) {
            if (journalTaskId) {
                const interruptionReason = requestController.signal.aborted
                    ? requestController.signal.reason instanceof Error
                        ? requestController.signal.reason.message
                        : "Request cancelled by the user."
                    : llamaClient.formatError(error);
                sessionTool.interruptTask(activeSession.id, journalTaskId, interruptionReason);
            }
            const elapsedMs = spinner.stop();
            if (requestController.signal.aborted) {
                const reason = requestController.signal.reason instanceof Error && requestController.signal.reason.message.includes("budget")
                    ? requestController.signal.reason.message
                    : "Request cancelled.";
                console.log(`${reason} The CLI is ready for the next prompt; use /undo if a completed write should be reverted.`);
            }
            else {
                console.error(`Model request failed: ${llamaClient.formatError(error)}`);
                console.log("The task was saved as interrupted and the CLI is ready for the next prompt. Retry to continue from the session journal; use /model to confirm the loaded model.");
            }
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
    console.log("Skills: /skills");
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
    console.log("Tip: type /, $skill, or /model for inline suggestions");
    console.log();

    const activeSession = requestedSessionId
        ? sessionTool.resumeSession(requestedSessionId)
        : await sessionTool.selectSession(rl, activeWorkspace);
    if (!activeSession) {
        throw new Error(`Session not found: ${requestedSessionId}`);
    }
    const recoveredInterruptedTask = sessionTool.recoverInterruptedTask(activeSession.id);
    await restoreSessionWorkspace(activeSession);
    console.log(`Session: ${activeSession.title}`);
    if (recoveredInterruptedTask) {
        console.log("Recovered an unfinished task journal from the previous CLI process.");
    }
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
