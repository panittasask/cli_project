import type { AgentAction } from "./schema/agentAction.schema";
import type { AgentTaskContract } from "./schema/taskContract.schema";

export type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";
export type VerificationRequirement = "none" | "command" | "runtime";
export type AcceptanceContract = {
    evidence: "source" | "command" | "runtime" | "interaction";
    verification: VerificationRequirement;
    reason: string;
};
export type ProjectCompletionRequirement = import("../projectTypes").ProjectCompletionRequirement;
export type ProjectCheck = import("../projectTypes").ProjectCheck;

export type AgentActionHistory = {
    turn: number;
    action: AgentAction["action"];
    success?: boolean;
    observation?: string;
};

export type AgentInspection = {
    action: "list_files" | "search_project" | "search_files" | "read_file";
    path?: string;
    query?: string;
};

export type AgentWorkspaceState = {
    root: string;
    readPaths: Set<string>;
    writtenPaths: Set<string>;
    satisfiedPaths: Set<string>;
    visualPresentationPaths: Set<string>;
    validationFailures: Set<string>;
    successfulProjectChecks: Set<string>;
    pendingProjectChecks: Set<string>;
    successfulEvidenceRefs: Set<string>;
    successfulWorkspaceEvidenceRefs: Set<string>;
    inspections: AgentInspection[];
    explicitlyRequestedFiles: string[];
    projectChecks: ProjectCheck[];
    projectRequirement: ProjectCompletionRequirement | undefined;
};

export type AgentVerificationState = {
    requirement: VerificationRequirement;
    satisfied: boolean;
    attempted: boolean;
    failure: string | undefined;
    recoveryAttempts: number;
    unresolvedToolFailure: { action: string; output: string } | undefined;
    unresolvedMissingCommandTarget: boolean;
    lastFailedCommand: string | undefined;
    inconclusiveBlocker: string | undefined;
    pendingRuntimePortCorrection: string | undefined;
    pendingPackageScriptRecovery: { command: string; workdir: string; mode?: "probe" } | undefined;
    unsatisfiedFinalAttempts: number;
    recoveryActive: boolean;
};

export type AgentCompletionState = {
    status: "continue" | "completed" | "blocked" | "needs_user_input" | "failed";
    blockers: string[];
    finalRequested: boolean;
    finalBlocked: boolean;
    reason: string | undefined;
};

export type AgentResearchState = {
    sourceUrls: Set<string>;
    successfulMcpDiscovery: boolean;
    successfulMcpCall: boolean;
    mcpCallsDisabled: boolean;
    consecutiveEmptyWebSearches: number;
    webResearchExhausted: boolean;
};

export interface AgentContext {
    task?: AgentTaskContract;
    workflow: { kind: WorkflowKind; reason: string };
    input: { originalUserMessage: string; effectiveUserMessage: string };
    policy: {
        readOnly: boolean;
        mustWrite: boolean;
        acceptance: AcceptanceContract;
        readOnlyAllowsCommands: boolean;
    };
    turn: number;
    actions: AgentActionHistory[];
    evidence: string[];
    verification: AgentVerificationState;
    workspace: AgentWorkspaceState;
    research: AgentResearchState;
    completion: AgentCompletionState;
}

function createAgentContext(workspaceRoot: string): AgentContext {
    return {
        workflow: {
            kind: "general",
            reason: "Pending semantic classification in the agent's first tool action."
        },
        input: {
            originalUserMessage: "",
            effectiveUserMessage: ""
        },
        policy: {
            readOnly: false,
            mustWrite: false,
            acceptance: {
                evidence: "source",
                verification: "none",
                reason: "Pending the model-owned task contract."
            },
            readOnlyAllowsCommands: false
        },
        turn: 0,
        actions: [],
        evidence: [],
        verification: {
            requirement: "none",
            satisfied: true,
            attempted: false,
            failure: undefined,
            recoveryAttempts: 0,
            unresolvedToolFailure: undefined,
            unresolvedMissingCommandTarget: false,
            lastFailedCommand: undefined,
            inconclusiveBlocker: undefined,
            pendingRuntimePortCorrection: undefined,
            pendingPackageScriptRecovery: undefined,
            unsatisfiedFinalAttempts: 0,
            recoveryActive: false
        },
        workspace: {
            root: workspaceRoot,
            readPaths: new Set<string>(),
            writtenPaths: new Set<string>(),
            satisfiedPaths: new Set<string>(),
            visualPresentationPaths: new Set<string>(),
            validationFailures: new Set<string>(),
            successfulProjectChecks: new Set<string>(),
            pendingProjectChecks: new Set<string>(),
            successfulEvidenceRefs: new Set<string>(),
            successfulWorkspaceEvidenceRefs: new Set<string>(),
            inspections: [],
            explicitlyRequestedFiles: [],
            projectChecks: [],
            projectRequirement: undefined
        },
        research: {
            sourceUrls: new Set<string>(),
            successfulMcpDiscovery: false,
            successfulMcpCall: false,
            mcpCallsDisabled: false,
            consecutiveEmptyWebSearches: 0,
            webResearchExhausted: false
        },
        completion: {
            status: "continue",
            blockers: [],
            finalRequested: false,
            finalBlocked: false,
            reason: undefined
        }
    };
}

module.exports = { createAgentContext };
