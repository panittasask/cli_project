import type { AgentEventSink } from "./agentEvents";
import type { ActionCoordinator } from "./action/actionCoordinator";
import type { TaskCoordinator } from "./task/taskCoordinator";
import type { VerificationCoordinator } from "./verification/verificationCoordinator";
import type { CompletionCoordinator } from "./completion/completionCoordinator";
import type { AgentToolResult } from "./agentSchema";
import type { LLMProvider } from "../model/llmProvider";
import type { ProjectCheck, ProjectCheckProvider, ProjectCompletionRequirement } from "../projectTypes";
import type { ClarificationRequest, ClarificationAnswer } from "../clarificationTypes";

export interface AgentJsonObject { [key: string]: unknown; }
export type AgentMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
};
export type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";
export type VerificationRequirement = "none" | "command" | "runtime";
export type AcceptanceContract = {
    evidence: "source" | "command" | "runtime" | "interaction";
    verification: VerificationRequirement;
    reason: string;
};

export type AgentGuardSettings = {
    profile: "quick" | "standard" | "deep";
    maxTurns: number;
    maxSegments: number;
    maxDurationMs: number;
    maxCompletionTokens: number;
    repeatLimit: number;
};

export type AgentGuard = {
    settings: AgentGuardSettings;
    recordCompletionTokens: (tokens: number) => void;
    checkBudget: (turn: number) => string | undefined;
    registerAction: (action: AgentJsonObject) => { status: "allow" | "replan" | "stop"; message?: string };
    recordObservation: (action: AgentJsonObject, observation: AgentToolResult) => { status: "allow" | "replan" | "stop"; message?: string };
    resetActionHistory: () => void;
    recordFileProgress: () => void;
    pause: () => void;
    resume: () => void;
    formatRemaining: () => string;
};

export type WriteValidation = { ok: boolean; validator: string; output: string };
export type WriteValidator = {
    validateProjectFor: (filePath: string) => WriteValidation | undefined;
    validate: (filePath: string) => WriteValidation;
    exists: (filePath: string) => boolean;
};

export type FailedCommandRegistry = {
    has: (command: string, workdir?: string) => boolean;
    record: (command: string, workdir?: string, errorOutput?: string) => void;
    failureFor: (command: string, workdir?: string) => string | undefined;
    recordBlockedAttempt: (command: string, workdir?: string) => number;
    clear: () => void;
};

export type CheckpointStore = {
    checkpoint: (workspace: string, inputPath: string, nextContent: string) => { id: string; preview: string };
    undoLatest: (workspace: string, checkpointId?: string) => { ok: boolean; message: string };
};

export type AgentToolPort = {
    buildSystemPrompt: (workflowInstructions?: string) => Promise<string>;
    prepareEdit: (filePath: string, oldText: string, newText: string) => { ok: boolean; content?: string; changed?: boolean };
    diagnosticSourceContext: (output: string, command?: string, requestedWorkdir?: string) => string | undefined;
};

export type Skill = { name: string; description: string; body: string };
export type SkillLoader = {
    discover: (workspace: string) => Skill[];
    select: (message: string, skills: Skill[]) => Skill[];
    formatPrompt: (skills: Skill[]) => string;
};

export type ClarificationSettings = {
    maxClarifications: number;
    requireInspection: boolean;
    secondRequiresBlocker: boolean;
};

export type AgentTrace = {
    add: (entry: {
        turn: number;
        status: "action" | "ok" | "error" | "parse_error" | "final";
        action?: string | undefined;
        reason?: string | undefined;
        arguments?: unknown | undefined;
        observation?: string | undefined;
    }) => void;
    save: () => void;
    print: () => void;
};

export type ResponseLog = {
    append(entry: unknown): void;
};

export interface AgentLlmServices {
    provider: LLMProvider;
    actionSampling: AgentJsonObject & { max_tokens: number };
    model: string;
    activeContextLength: number;
    getAgentReadOnlyResponseFormat: (workflow: WorkflowKind, allowCommands?: boolean) => AgentJsonObject;
    getAgentResponseFormat: (workflow: WorkflowKind) => AgentJsonObject;
    getInitialAgentResponseFormat: () => AgentJsonObject;
    getAgentRecoveryResponseFormat: (workflow: WorkflowKind, blockedAction: string | string[]) => AgentJsonObject;
    getAgentMutationResponseFormat: (blockedAction?: string) => AgentJsonObject;
    getAgentFinalResponseFormat: () => AgentJsonObject;
    buildInitialAgentMessages: (systemPrompt: string, contextSummary: string, userMessage: string) => AgentMessage[];
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
            verificationRequirement?: VerificationRequirement;
            verificationSatisfied?: boolean;
            successfulEvidenceRefs?: string[];
            successfulWorkspaceEvidenceRefs?: string[];
            sourceUrls: string[];
            recentEvents: string[];
            mcpCallsDisabled?: boolean;
        }
    ) => AgentMessage[];
    withoutMcpActions: (responseFormat: AgentJsonObject) => AgentJsonObject;
    recordResponseUsage: (sessionId: string, data: unknown) => { completionTokens: number } | undefined;
    isReasoningOnlyTruncation: (input: { content: unknown; reasoningContent: unknown; finishReason: unknown }) => boolean;
    reasoningOnlyRetryMaxTokens: (configuredMaxTokens: number) => number;
    MAX_REASONING_ONLY_RETRIES: number;
    REASONING_ONLY_PARSE_ERROR: string;
    formatReasoningOnlyRecoveryPrompt: (attempt: number) => string;
}

export interface AgentToolServices {
    activeWorkspace: string;
    projectCheckProviders: ProjectCheckProvider[];
    agentTool: AgentToolPort;
    actionCoordinator: ActionCoordinator;
    checkpointStore: CheckpointStore;
    discoverProjectChecks: (workspace: string, providers: ProjectCheckProvider[]) => ProjectCheck[];
    formatProjectChecksPrompt: (checks: ProjectCheck[]) => string;
    formatProjectCompletionPrompt: (requirement: ProjectCompletionRequirement, checks: ProjectCheck[]) => string;
    commandInvocationError: (output: string) => boolean;
    normalizeCommandSignature: (command: string) => string;
    packageScriptCommandsEquivalent: (left: string, right: string) => boolean;
    packageMutationRisk: (workspace: string, userMessage: string, command: string, requestedWorkdir?: string) => string | undefined;
    commandMutatesWorkspaceFiles: (command: string) => boolean;
    commandCreatesWorkspaceFiles: (command: string) => boolean;
    projectChecksAffectedByWorkdir: (workdir: string | undefined, checks: ProjectCheck[]) => string[];
    projectChecksAffectedByPath: (filePath: string, checks: ProjectCheck[]) => string[];
    commandAddsTooling: (command: string) => boolean;
    packageLifecycleRoleChanges: (beforeContent: string, afterContent: string) => string[];
    diagnosticRecoveryGuidance: (output: string) => string | undefined;
    commandInvokesAgentTool: (command: string) => boolean;
    unownedProjectMutationReason: (filePath: string, checks: ProjectCheck[]) => string | undefined;
    isVisualPresentationMutation: (filePath: string, replacementText?: string) => boolean;
    searchReturnedNoResults: (output: string) => boolean;
    evaluateProjectCompletion: (workspace: string, requirement: ProjectCompletionRequirement) => string[];
    protectedProjectDeletionReason: (workspace: string, filePath: string, userMessage: string) => string | undefined;
}

export interface AgentTaskServices {
    coordinator: TaskCoordinator;
    selectTaskContext: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, workflow: WorkflowKind, limit: number) => Array<{ role: "user" | "assistant"; content: string }>;
    historyMessageLimit: number;
    summarizeTaskContext: (messages: Array<{ role: "user" | "assistant"; content: string }>) => string;
    skillLoader: SkillLoader;
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
    clarificationObservation: (request: ClarificationRequest, answer: ClarificationAnswer) => AgentJsonObject;
    clarificationTranscriptLine: (request: ClarificationRequest, answer: ClarificationAnswer) => string;
    relevantClarificationInspections: (input: {
        decision: ClarificationRequest["decision"];
        question: string;
        inspections: Array<{ action: "list_files" | "search_project" | "search_files" | "read_file"; path?: string; query?: string }>;
    }) => Array<{ action: "list_files" | "search_project" | "search_files" | "read_file"; path?: string; query?: string }>;
    promptForClarification: (request: ClarificationRequest, signal: AbortSignal) => Promise<ClarificationAnswer>;
    discoverProjectRoots: (workspace: string, providers: ProjectCheckProvider[]) => string[];
    clarificationSettings: ClarificationSettings;
}

export interface AgentVerificationServices {
    coordinator: VerificationCoordinator;
    verificationRecoveryTurnAllowance: (maxTurnsPerSegment: number) => number;
    WriteValidator: new (workspace: string) => WriteValidator;
    FailedCommandRegistry: new (workspace: string) => FailedCommandRegistry;
    countCompilerDiagnostics: (output: string) => number;
    compilerDiagnosticFingerprint: (output: string) => string[];
}

export interface AgentCompletionServices {
    coordinator: CompletionCoordinator;
}

export interface AgentStateServices {
    workspace: string;
    appRoot: string;
    guard: new (settings: AgentGuardSettings) => AgentGuard;
    guardSettings: AgentGuardSettings;
    session: {
        getUsage: (sessionId: string) => { activeContextTokens: number };
        resetActiveContextUsage: (sessionId: string) => void;
        recordTaskEvent(sessionId: string, taskId: string, event: unknown): void;
    };
    trace: new (target: { directory: string; basename: string }, taskId: string, onEntry: (entry: AgentJsonObject) => void) => AgentTrace;
    responseLog: new (target: { directory: string; basename: string }, taskId: string) => ResponseLog;
    resolveJsonlLogPath: (target: { directory: string; basename: string }) => string;
    debugLog: (message: string, details?: unknown) => void;
}

export interface AgentRunnerDependencies {
    llm: AgentLlmServices;
    tools: AgentToolServices;
    task: AgentTaskServices;
    verification: AgentVerificationServices;
    completion: AgentCompletionServices;
    state: AgentStateServices;
    events: AgentEventSink;
}

module.exports = {};
