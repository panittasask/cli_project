import fs = require("node:fs");
import path = require("node:path");
import type { AgentMessage, AgentRunnerDependencies } from "./agentRunnerDependencies";
import type { AgentContext } from "./agentContext";
import type { AgentAction } from "./schema/agentAction.schema";
import type { FinalAction } from "./completion/completionCoordinator";
const { createAgentContext } = require("./agentContext") as { createAgentContext: (workspaceRoot: string) => AgentContext };
const {
    MAX_PROTOCOL_REGENERATION_ATTEMPTS,
    buildProtocolRegenerationPrompt,
    getProtocolRegenerationSampling
} = require("../model/jsonResponseRepair") as {
    MAX_PROTOCOL_REGENERATION_ATTEMPTS: number;
    buildProtocolRegenerationPrompt: (failure: { kind: string; issues: string[]; toolCallName?: string }) => string;
    getProtocolRegenerationSampling: (sampling: Record<string, unknown>) => Record<string, unknown>;
};
const { getAllowedActionNames } = require("../agentProtocol") as {
    getAllowedActionNames: (responseFormat: Record<string, unknown>) => string[];
};
const { ModelProtocolHealth } = require("../model/modelProtocolHealth") as {
    ModelProtocolHealth: new (protocolFailureThreshold?: number, transportFailureThreshold?: number) => {
        recordProtocolFailure: () => Record<string, unknown>;
        recordTransportFailure: () => Record<string, unknown>;
        recordToolExecutionFailure: () => Record<string, unknown>;
        recordVerificationFailure: () => Record<string, unknown>;
        recordValidAction: () => Record<string, unknown>;
        snapshot: () => Record<string, unknown>;
    };
};

// A model can keep repeating a blocked final claim without producing new
// evidence. Keep a few retries for normal recovery, then stop with an honest
// incomplete result instead of burning the whole unbounded run on the same
// completion gate.
const MAX_CONSECUTIVE_FINAL_BLOCKS = 4;

type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";
type AcceptanceContract = {
    evidence: "source" | "command" | "runtime" | "interaction";
    verification: "none" | "command" | "runtime";
    reason: string;
};
type ClarificationRequest = import("../clarificationTypes").ClarificationRequest;
type ClarificationAnswer = import("../clarificationTypes").ClarificationAnswer;
type ProjectCompletionRequirement = import("../projectTypes").ProjectCompletionRequirement;
type ProjectCheck = import("../projectTypes").ProjectCheck;
type RequestBudgetControl = { pause: () => void; resume: () => void; clear: () => void };

const FIRST_RESPONSE_TASK_CONTRACT_INSTRUCTION = [
    "MANDATORY FIRST RESPONSE CONTRACT:",
    "Return exactly ONE JSON object and nothing else.",
    "The task contract must be a top-level `task` field in the SAME JSON object as the top-level `action` field.",
    "Never return the task contract as a separate JSON object, never return two JSON objects, and never omit `task`.",
    "The first response must include: action, task, and the action fields required by the selected action.",
    "The `task` object must include exactly these required fields: intent, task_type, continuation, requires_workspace_changes, verification, evidence_requirements, success_criteria.",
    "Use this shape (choose the real action and values; do not copy the example literally):",
    '{"action":"list_files","path":".","reason":"inspect the workspace","task":{"intent":"understand the workspace before acting","task_type":"coding","continuation":false,"requires_workspace_changes":true,"verification":"none","evidence_requirements":["source"],"success_criteria":["identify the relevant files"]}}',
    "Do not add markdown fences, explanations, or a standalone task object before or after the action object."
].join("\n");

type AgentRunnerResult = {
    answer: string;
    trace: AgentTraceLike;
    clarifications: string[];
};

type AgentTraceLike = {
    add: (entry: {
        turn: number;
        status: "action" | "ok" | "error" | "parse_error" | "final";
        action?: string;
        reason?: string;
        arguments?: unknown;
        observation?: string;
    }) => void;
    save: () => void;
    print: () => void;
};

type AgentRunRequest = {
    userMessage: string;
    historyForModel: Array<{ role: "user" | "assistant"; content: string }>;
    historyForTask: Array<{ role: "user" | "assistant"; content: string }>;
    sessionId: string;
    taskId: string;
    signal: AbortSignal;
    requestBudget: RequestBudgetControl;
};

class DefaultAgentRunner {
    constructor(private readonly dependencies: AgentRunnerDependencies) {}

    async run(request: AgentRunRequest): Promise<AgentRunnerResult> {
        const { llm, tools, task, verification, completion, state, events } = this.dependencies;
        const { userMessage, historyForModel, historyForTask, sessionId, taskId, signal, requestBudget } = request;
        const activeWorkspace = state.workspace;
        const projectCheckProviders = tools.projectCheckProviders;
        const appRoot = state.appRoot;
        const AgentTrace = state.trace;
        const AgentResponseLog = state.responseLog;
        const sessionTool = state.session;
        const debugLog = state.debugLog;
        const resolveJsonlLogPath = state.resolveJsonlLogPath;
        const agentTool = tools.agentTool;
        const llmProvider = llm.provider;
        const model = llm.model;
        const activeContextLength = llm.activeContextLength;
        const actionSampling = llm.actionSampling;
        const { getAgentReadOnlyResponseFormat, getAgentResponseFormat, getInitialAgentResponseFormat,
            getAgentRecoveryResponseFormat, getAgentMutationResponseFormat, getAgentFinalResponseFormat,
            buildInitialAgentMessages, buildCompactedAgentMessages, withoutMcpActions, recordResponseUsage,
            isReasoningOnlyTruncation: _isReasoningOnlyTruncation } = llm;
        const { selectTaskContext, historyMessageLimit, summarizeTaskContext, skillLoader,
            answerLooksLikeBlockingClarification, clarificationBlockReason, clarificationObservation,
            clarificationTranscriptLine, relevantClarificationInspections, promptForClarification,
            discoverProjectRoots, clarificationSettings } = task;
        const { discoverProjectChecks, formatProjectChecksPrompt, formatProjectCompletionPrompt,
            commandInvocationError, normalizeCommandSignature, packageScriptCommandsEquivalent,
            packageMutationRisk, commandMutatesWorkspaceFiles, commandCreatesWorkspaceFiles,
            projectChecksAffectedByWorkdir, projectChecksAffectedByPath,
            commandAddsTooling, packageLifecycleRoleChanges, diagnosticRecoveryGuidance,
            commandInvokesAgentTool, unownedProjectMutationReason,
            isVisualPresentationMutation, searchReturnedNoResults, checkpointStore,
            evaluateProjectCompletion, protectedProjectDeletionReason } = tools;
        const { verificationRecoveryTurnAllowance, WriteValidator,
            FailedCommandRegistry, countCompilerDiagnostics, compilerDiagnosticFingerprint } = verification;

        const progress = {
            update: (message: string) => events.emit({ type: "status", message }),
            log: (message: string) => events.emit({ type: "log", message }),
            suspend: () => events.emit({ type: "input_suspended" }),
            resume: () => events.emit({ type: "input_resumed" })
        };
        const context = createAgentContext(activeWorkspace);
        context.input.originalUserMessage = userMessage;
        context.input.effectiveUserMessage = userMessage;
        events.emit({ type: "task_started", task: userMessage });

            const guard = new state.guard(state.guardSettings);
            const maxTurnsPerSegment = guard.settings.maxTurns;
            const hasStepCadence = maxTurnsPerSegment > 0;
            const maxSegments = state.guardSettings.maxSegments;
            const unboundedSegments = maxSegments === 0;
            const maxSegmentsLabel = unboundedSegments ? "unbounded" : String(maxSegments);
            const maxTurns = unboundedSegments || !hasStepCadence ? Number.POSITIVE_INFINITY : maxTurnsPerSegment * maxSegments;
            const maxTurnsForLog = unboundedSegments || !hasStepCadence ? 0 : maxTurns;
            const recoveryTurnAllowance = Number.isFinite(maxTurns)
                ? verificationRecoveryTurnAllowance(maxTurnsPerSegment)
                : 0;
            const recoveryMaxTurns = Number.isFinite(maxTurns) ? maxTurns + recoveryTurnAllowance : maxTurns;
            context.workspace.projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
            let agentResponseFormat = context.policy.readOnly
                ? getAgentReadOnlyResponseFormat(context.workflow.kind, context.policy.readOnlyAllowsCommands)
                : getAgentResponseFormat(context.workflow.kind);
            const initialAgentResponseFormat = getInitialAgentResponseFormat();
            const relevantHistory = selectTaskContext(userMessage, historyForModel, context.workflow.kind, historyMessageLimit);
            const contextSummary = summarizeTaskContext(relevantHistory);
            const writeValidator = new WriteValidator(activeWorkspace);
            const availableSkills = skillLoader.discover(activeWorkspace);
            const selectedSkills = skillLoader.select(userMessage, availableSkills);
            const skillPrompt = skillLoader.formatPrompt(selectedSkills);
            context.workspace.explicitlyRequestedFiles = Array.from(context.input.effectiveUserMessage.matchAll(/(?:^|[\s"'`])((?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|ps1|yml|yaml|go))(?=$|[\s"'`,)])/gi))
                .map((match) => path.resolve(activeWorkspace, match[1] ?? "").toLowerCase());
            const failedCommands = new FailedCommandRegistry(activeWorkspace);
            const clarificationTranscript: string[] = [];
            const answeredClarifications = new Map<string, Record<string, unknown>>();
            const logDirectory = path.resolve(appRoot, ".cli", "logs", "agent");
            const traceTarget = { directory: logDirectory, basename: "agent-trace" };
            const responseTarget = { directory: logDirectory, basename: "agent-model-responses" };
            const trace = new AgentTrace(traceTarget, taskId, (entry: Record<string, unknown>) => {
                debugLog("Agent trace", entry);
                sessionTool.recordTaskEvent(sessionId, taskId, entry as {
                    turn: number;
                    status: "action" | "ok" | "error" | "parse_error" | "final";
                    action?: string;
                    reason?: string;
                    arguments?: unknown;
                    observation?: string;
                });
            });
            const responseLog = new AgentResponseLog(responseTarget, taskId);
            const protocolHealth = new ModelProtocolHealth(3, 2);
            trace.add({
                turn: 0,
                status: "action",
                action: "task_start",
                observation: JSON.stringify({
                    workflow: "pending_model_classification",
                    model,
                    contextLength: activeContextLength,
                    agentProfile: state.guardSettings.profile,
                    maxSteps: unboundedSegments || !hasStepCadence ? "unbounded" : maxTurns,
                    verificationRecoverySteps: recoveryTurnAllowance,
                    maxDurationMs: state.guardSettings.maxDurationMs
                })
            });
            trace.save();
            const buildCurrentSystemPrompt = (): Promise<string> => agentTool.buildSystemPrompt([
                context.task
                    ? `Model-owned task contract: ${JSON.stringify(context.task)}`
                    : FIRST_RESPONSE_TASK_CONTRACT_INSTRUCTION,
                context.task && context.verification.requirement !== "none"
                    ? `Completion requirement: ${context.verification.requirement} verification must succeed after the latest file change before final.`
                    : "",
                context.task ? `Final claims must not exceed successful ${context.policy.acceptance.evidence} evidence.` : "",
                context.policy.acceptance.evidence === "interaction"
                    ? "Trace the rendered declaration through its owning implementation, imports/providers, event handler, state transition, and output before editing. Inspect co-located implementation companions referenced by the target. Then use a finite automated interaction test that performs the user-visible action and asserts its observable outcome. A build, typecheck, source read, response-body text search, or unrelated HTTP probe is not sufficient. Prefer an existing project test runner over starting a development server."
                    : "",
                context.task?.evidence_requirements.includes("visual")
                    ? "This task has a visual presentation requirement. Inspect the owning rendered component/template and its styling companion, make a concrete styling change, and run a finite headless interaction check. Do not claim visual success from a build or source read alone."
                    : "",
                context.policy.readOnly ? "Read-only task contract: workspace changes are not part of this task. Do not edit, write, delete, install, scaffold, or run any command that mutates files." : "",
                formatProjectChecksPrompt(context.workspace.projectChecks),
                context.workspace.projectRequirement ? formatProjectCompletionPrompt(context.workspace.projectRequirement, context.workspace.projectChecks) : "",
                skillPrompt
            ].filter(Boolean).join("\n\n"));
            let systemPrompt = await buildCurrentSystemPrompt();
            let messages: AgentMessage[] = buildInitialAgentMessages(systemPrompt, contextSummary, userMessage);
            let recoveryResponseFormat: Record<string, unknown> | undefined;
            let consecutiveFinalBlocks = 0;
            const recoveryFormat = (extra: string | string[] = []) => getAgentRecoveryResponseFormat(
                context.workflow.kind,
                Array.from(new Set(Array.isArray(extra) ? extra : [extra])).filter(Boolean)
            );
            let segmentEvents: string[] = [];
            let contextCompactionCount = 0;
            const stepStatus = (step: number): string => hasStepCadence
                ? `step ${step}/${context.verification.recoveryActive ? recoveryMaxTurns : maxTurns}`
                : `step ${step}`;

            if (selectedSkills.length > 0) progress.log(`Skills: ${selectedSkills.map((skill: { name: string }) => skill.name).join(", ")}`);

            let lastExecutedTurn = 0;
            for (let turn = 1; ; turn += 1) {
                if (turn > maxTurns && !context.verification.recoveryActive) {
                    context.verification.recoveryActive = verification.coordinator.recover(context);
                    if (context.verification.recoveryActive) {
                        const observation = `Verification failed at the normal step limit. Continuing for up to ${recoveryTurnAllowance} recovery steps so the agent can inspect the error, correct the project, and rerun verification.`;
                        events.emit({ type: "recovery_started", message: observation });
                        trace.add({ turn, status: "action", action: "verification_recovery_started", observation });
                        trace.save();
                    }
                }
                if (turn > maxTurns && (!context.verification.recoveryActive || turn > recoveryMaxTurns)) break;
                lastExecutedTurn = turn;
                context.turn = turn;
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
                        maxSegments: context.verification.recoveryActive && maxSegments > 0
                            ? maxSegments + 1
                            : maxSegments,
                        writtenPaths: Array.from(context.workspace.writtenPaths),
                        satisfiedPaths: Array.from(context.workspace.satisfiedPaths),
                        validationFailures: Array.from(context.workspace.validationFailures),
                        ...(context.verification.failure ? { unresolvedVerificationFailure: context.verification.failure } : {}),
                        verificationRequirement: context.verification.requirement,
                        verificationSatisfied: context.verification.satisfied,
                        successfulEvidenceRefs: Array.from(context.workspace.successfulEvidenceRefs),
                        successfulWorkspaceEvidenceRefs: Array.from(context.workspace.successfulWorkspaceEvidenceRefs),
                        sourceUrls: Array.from(context.research.sourceUrls),
                        recentEvents: segmentEvents,
                        mcpCallsDisabled: context.research.mcpCallsDisabled
                    });
                    segmentEvents = [];
                    context.workspace.readPaths.clear();
                    sessionTool.resetActiveContextUsage(sessionId);
                    recoveryResponseFormat = undefined;
                    const trigger = compactForTokens ? `at 70% context usage (${contextTokenThreshold.toLocaleString()} tokens)` : "at the turn boundary";
                    const segmentLabel = context.verification.recoveryActive && compactedSegment > maxSegments
                        ? `${maxSegmentsLabel} + recovery`
                        : maxSegmentsLabel;
                    progress.log(`Compacted agent context ${trigger}; continuing segment ${compactedSegment}/${segmentLabel}.`);
                    trace.add({ turn, status: "action", action: "context_compaction", observation: `Continuing segment ${compactedSegment}/${segmentLabel} ${trigger}` });
                    trace.save();
                }
                const budgetError = guard.checkBudget(segmentTurn);
                if (budgetError) {
                    const answer = `Agent stopped safely because its ${budgetError}. Review the trace or continue with a narrower request.`;
                    trace.add({ turn, status: "error", action: "budget_stop", observation: answer });
                    trace.save();
                    return { answer, trace, clarifications: clarificationTranscript };
                }
                const selectedResponseFormat = recoveryResponseFormat
                    ?? (turn === 1 ? initialAgentResponseFormat : agentResponseFormat);
                const requestFormat = context.research.mcpCallsDisabled
                    ? withoutMcpActions(selectedResponseFormat)
                    : selectedResponseFormat;
                recoveryResponseFormat = undefined;
                progress.update(turn === 1
                    ? `Planning next step (step ${turn}, ${guard.formatRemaining()})...`
                    : `Reviewing results (step ${turn}, ${guard.formatRemaining()})...`);

                const samplingForRequest = actionSampling;
                const modelStartedAt = Date.now();
                debugLog("LLM request", { turn, model, messages, responseFormat: requestFormat, sampling: samplingForRequest });
                let response: Awaited<ReturnType<typeof llmProvider.chat>>;
                try {
                    response = await llmProvider.chat({
                        model,
                        messages,
                        responseFormat: requestFormat,
                        allowNativeTools: Boolean(context.task),
                        sampling: samplingForRequest,
                        signal,
                        onRetry: (_attempt: number, errorCode: string) => {
                            events.emit({ type: "retrying", message: `Model connection ${errorCode}; retrying...` });
                        }
                    });
                } catch (error) {
                    const providerFailure = formatProviderFailure(error);
                    const failureKind = classifyModelFailure(error, providerFailure);
                    const health = failureKind === "rate_limited"
                        ? protocolHealth.snapshot()
                        : protocolHealth.recordTransportFailure();
                    responseLog.append({
                        turn,
                        maxTurns: maxTurnsForLog,
                        kind: "provider_failure",
                        requestFormat,
                        rawContent: null,
                        parseError: `${failureKind}: ${providerFailure}`,
                        protocolRegenerationAttempt: 0,
                        protocolFailureKind: failureKind,
                        durationMs: Date.now() - modelStartedAt,
                        protocolHealth: health,
                        transport: (error as { transportMeta?: unknown } | undefined)?.transportMeta,
                        executorCalled: false
                    });
                    const answer = formatModelFailureAnswer(failureKind, providerFailure);
                    trace.add({ turn, status: "error", action: "model_transport_failure", observation: answer });
                    trace.save();
                    return { answer, trace, clarifications: clarificationTranscript };
                }
                const responseUsage = recordResponseUsage(sessionId, response.data);
                guard.recordCompletionTokens(responseUsage?.completionTokens ?? 0);

                const choice = response.data?.choices?.[0] ?? { message: {}, finish_reason: response.finishReason };
                let rawAssistantContent = response.rawProviderContent ?? response.content;
                let assistantContent = typeof response.content === "string" ? response.content.trim() : "";
                let currentToolCall = response.toolCall;
                let admission = tools.actionCoordinator.admit({
                    content: assistantContent,
                    finishReason: response.finishReason ?? choice.finish_reason,
                    hasToolCall: Boolean(currentToolCall),
                    requireTaskContract: !context.task
                });
                let action: AgentAction | undefined = admission.ok ? admission.action : undefined;
                let parseError = admission.ok ? undefined : `${admission.kind}: ${admission.issues.join(" | ")}`;
                let protocolHealthSnapshot = admission.ok
                    ? protocolHealth.recordValidAction()
                    : protocolHealth.recordProtocolFailure();
                debugLog("LLM response", {
                    turn,
                    rawContent: rawAssistantContent,
                    normalizedContent: assistantContent,
                    toolCall: currentToolCall,
                    reasoningContent: response.reasoningContent ?? choice.message.reasoning_content,
                    finishReason: response.finishReason ?? choice.finish_reason,
                    usage: response.data.usage,
                    timings: response.data.timings,
                    parsedAction: action,
                    parseError,
                    admission,
                    protocolHealth: protocolHealthSnapshot,
                    transport: (response as { transportMeta?: unknown }).transportMeta
                });
                responseLog.append({
                    turn,
                    maxTurns: maxTurnsForLog,
                    requestFormat,
                    rawContent: rawAssistantContent,
                    normalizedContent: assistantContent,
                    toolCall: currentToolCall,
                    reasoningContent: response.reasoningContent ?? choice.message.reasoning_content,
                    finishReason: response.finishReason ?? choice.finish_reason,
                    parsedAction: action?.action,
                    parseError,
                    durationMs: Date.now() - modelStartedAt,
                    usage: response.data.usage,
                    timings: response.data.timings,
                    admission,
                    syntaxValid: admission.syntaxValid,
                    schemaValid: admission.schemaValid,
                    semanticValid: admission.semanticValid,
                    localRepairUsed: admission.localRepairUsed,
                    protocolRegenerationAttempt: 0,
                    protocolFailureKind: admission.ok ? undefined : admission.kind,
                    protocolHealth: protocolHealthSnapshot,
                    circuitBreakerTripped: protocolHealthSnapshot.circuitBreakerTripped,
                    transport: (response as { transportMeta?: unknown }).transportMeta,
                    executorCalled: false
                });

                if (!admission.ok && MAX_PROTOCOL_REGENERATION_ATTEMPTS > 0) {
                    const compactProtocolContext = segmentEvents.slice(-3)
                        .map((event) => event.slice(0, 500))
                        .join("\n");
                    for (let regenerationAttempt = 1; regenerationAttempt <= MAX_PROTOCOL_REGENERATION_ATTEMPTS; regenerationAttempt += 1) {
                        const regenerationStartedAt = Date.now();
                        const regenerationPrompt = buildProtocolRegenerationPrompt({
                            kind: admission.kind,
                            issues: admission.issues,
                            ...(currentToolCall?.name ? { toolCallName: currentToolCall.name } : {})
                        });
                        progress.log(`[${stepStatus(turn)}] Regenerating clean action (attempt ${regenerationAttempt}/${MAX_PROTOCOL_REGENERATION_ATTEMPTS}) after ${admission.kind}...`);
                        const regenerationMessages: AgentMessage[] = [
                            {
                                role: "system",
                                content: [
                                    "You are in isolated protocol regeneration mode.",
                                    "Generate one new action object matching the supplied response schema.",
                                    "Do not return analysis, markdown, or the previous malformed object.",
                                    context.task
                                        ? `Current model-owned task contract: ${JSON.stringify(context.task)}`
                                        : FIRST_RESPONSE_TASK_CONTRACT_INSTRUCTION
                                ].join("\n")
                            },
                            {
                                role: "user",
                                content: [
                                    `Original user request:\n${context.input.effectiveUserMessage}`,
                                    compactProtocolContext ? `Recent valid host events:\n${compactProtocolContext}` : "",
                                    regenerationPrompt
                                ].filter(Boolean).join("\n\n")
                            }
                        ];

                        try {
                        const regenerationResponse = await llmProvider.chat({
                            model,
                            messages: regenerationMessages,
                            responseFormat: requestFormat,
                            allowNativeTools: Boolean(context.task),
                            sampling: getProtocolRegenerationSampling(samplingForRequest),
                            signal,
                            onRetry: (_attempt: number, errorCode: string) => {
                                events.emit({ type: "retrying", message: `Model protocol regeneration connection ${errorCode}; retrying...` });
                            }
                        });
                        const regenerationUsage = recordResponseUsage(sessionId, regenerationResponse.data);
                        guard.recordCompletionTokens(regenerationUsage?.completionTokens ?? 0);
                        const regeneratedRawContent = regenerationResponse.rawProviderContent ?? regenerationResponse.content;
                        const regeneratedContent = typeof regenerationResponse.content === "string"
                            ? regenerationResponse.content.trim()
                            : "";
                        const regenerationFinishReason = regenerationResponse.finishReason
                            ?? regenerationResponse.data?.choices?.[0]?.finish_reason;
                        const regeneratedAdmission = tools.actionCoordinator.admit({
                            content: regeneratedContent,
                            finishReason: regenerationFinishReason,
                            hasToolCall: Boolean(regenerationResponse.toolCall),
                            requireTaskContract: !context.task
                        });
                        const regenerationParseError = regeneratedAdmission.ok
                            ? undefined
                            : `${regeneratedAdmission.kind}: ${regeneratedAdmission.issues.join(" | ")}`;
                        protocolHealthSnapshot = regeneratedAdmission.ok
                            ? protocolHealth.recordValidAction()
                            : protocolHealth.recordProtocolFailure();
                        responseLog.append({
                            turn,
                            maxTurns: maxTurnsForLog,
                            kind: "protocol_regeneration",
                            regenerationAttempt,
                            requestFormat,
                            rawContent: regeneratedRawContent,
                            normalizedContent: regeneratedContent,
                            toolCall: regenerationResponse.toolCall,
                            finishReason: regenerationFinishReason,
                            parsedAction: regeneratedAdmission.ok ? regeneratedAdmission.action.action : undefined,
                            parseError: regenerationParseError,
                            durationMs: Date.now() - regenerationStartedAt,
                            usage: regenerationResponse.data?.usage,
                            timings: regenerationResponse.data?.timings,
                            admission: regeneratedAdmission,
                            syntaxValid: regeneratedAdmission.syntaxValid,
                            schemaValid: regeneratedAdmission.schemaValid,
                            semanticValid: regeneratedAdmission.semanticValid,
                            localRepairUsed: regeneratedAdmission.localRepairUsed,
                            protocolRegenerationAttempt: regenerationAttempt,
                            protocolFailureKind: regeneratedAdmission.ok ? undefined : regeneratedAdmission.kind,
                            protocolHealth: protocolHealthSnapshot,
                            circuitBreakerTripped: protocolHealthSnapshot.circuitBreakerTripped,
                            transport: (regenerationResponse as { transportMeta?: unknown }).transportMeta,
                            executorCalled: false
                        });
                        debugLog("LLM protocol regeneration response", {
                            turn,
                            regenerationAttempt,
                            rawContent: regeneratedRawContent,
                            normalizedContent: regeneratedContent,
                            toolCall: regenerationResponse.toolCall,
                            finishReason: regenerationFinishReason,
                            admission: regeneratedAdmission,
                            protocolHealth: protocolHealthSnapshot,
                            transport: (regenerationResponse as { transportMeta?: unknown }).transportMeta
                        });
                        if (regeneratedAdmission.ok) {
                            admission = regeneratedAdmission;
                            action = regeneratedAdmission.action;
                            rawAssistantContent = regeneratedRawContent;
                            assistantContent = regeneratedContent;
                            currentToolCall = regenerationResponse.toolCall;
                            parseError = undefined;
                            progress.log(`[${stepStatus(turn)}] Protocol regeneration produced a valid action.`);
                            break;
                        } else {
                            admission = regeneratedAdmission;
                            parseError = regenerationParseError;
                            progress.log(`[${stepStatus(turn)}] Regeneration attempt ${regenerationAttempt} returned invalid action; ${regenerationAttempt < MAX_PROTOCOL_REGENERATION_ATTEMPTS ? "retrying" : "stopping"}.`);
                        }
                    } catch (error) {
                        const regenerationFailure = formatProviderFailure(error);
                        const failureKind = classifyModelFailure(error, regenerationFailure);
                        protocolHealthSnapshot = failureKind === "rate_limited"
                            ? protocolHealth.snapshot()
                            : protocolHealth.recordTransportFailure();
                        responseLog.append({
                            turn,
                            maxTurns: maxTurnsForLog,
                            kind: "protocol_regeneration",
                            regenerationAttempt,
                            requestFormat,
                            rawContent: null,
                            parseError: `${failureKind}: ${regenerationFailure}`,
                            durationMs: Date.now() - regenerationStartedAt,
                            protocolRegenerationAttempt: regenerationAttempt,
                            protocolFailureKind: failureKind,
                            protocolHealth: protocolHealthSnapshot,
                            executorCalled: false
                        });
                        debugLog("LLM protocol regeneration failed", {
                            turn,
                            regenerationAttempt,
                            kind: failureKind,
                            error: regenerationFailure
                        });
                        const answer = formatProtocolRegenerationFailure(failureKind, regenerationFailure);
                        trace.add({ turn, status: "error", action: "model_protocol_circuit_breaker", observation: answer });
                        trace.save();
                        return { answer, trace, clarifications: clarificationTranscript };
                    }
                    }
                }

                if (!action) {
                    const answer = `Agent stopped safely because the selected model repeatedly returned invalid tool/action output (${parseError ?? "unsupported_protocol"}). No workspace action was executed from invalid responses.`;
                    trace.add({ turn, status: "error", action: "model_protocol_circuit_breaker", observation: answer });
                    trace.save();
                    return { answer, trace, clarifications: clarificationTranscript };
                }
                messages.push(currentToolCall
                    ? {
                        role: "assistant",
                        content: "",
                        tool_calls: [{
                            id: currentToolCall.id,
                            type: "function",
                            function: { name: currentToolCall.name, arguments: currentToolCall.arguments }
                        }]
                    }
                    : { role: "assistant", content: assistantContent });
                if (currentToolCall
                    && !["list_files", "search_files", "search_project", "read_file", "write_file", "edit_file", "delete_file", "run_command", "mcp_list_tools", "mcp_call_tool"].includes(action.action)) {
                    messages.push({
                        role: "tool",
                        tool_call_id: currentToolCall.id,
                        content: "The host received this action and is processing its workflow transition."
                    });
                }
                if (action.action !== "final") {
                    consecutiveFinalBlocks = 0;
                }
                if (action.action !== "final") {
                    completion.coordinator.resetForAction(context);
                }
                context.actions.push({
                    turn,
                    action: action.action as AgentAction["action"]
                });

                const initialTask = action.task;
                if (!context.task && initialTask) {
                    context.task = initialTask;
                    context.workflow = {
                        kind: initialTask.task_type,
                        reason: `Classified semantically by the agent: ${initialTask.intent}`
                    };
                    const preparedTask = task.coordinator.prepare(initialTask);
                    context.verification.requirement = preparedTask.acceptance.verification;
                    context.verification.satisfied = preparedTask.verificationSatisfied;
                    context.verification.attempted = false;
                    context.verification.failure = undefined;
                    context.verification.unresolvedMissingCommandTarget = false;
                    context.verification.inconclusiveBlocker = undefined;
                    context.verification.recoveryAttempts = 0;
                    context.verification.recoveryActive = false;
                    context.policy.readOnly = preparedTask.readOnly;
                    context.policy.mustWrite = preparedTask.mustWrite;
                    context.policy.acceptance = preparedTask.acceptance;
                    context.policy.readOnlyAllowsCommands = preparedTask.readOnlyAllowsCommands;
                    context.verification.satisfied = preparedTask.verificationSatisfied;
                    agentResponseFormat = context.policy.readOnly
                        ? getAgentReadOnlyResponseFormat(context.workflow.kind, context.policy.readOnlyAllowsCommands)
                        : getAgentResponseFormat(context.workflow.kind);
                    systemPrompt = await buildCurrentSystemPrompt();
                    const refreshedSystemMessage = buildInitialAgentMessages(systemPrompt, contextSummary, context.input.effectiveUserMessage)[0];
                    if (refreshedSystemMessage) messages[0] = refreshedSystemMessage;
                    trace.add({
                        turn,
                        status: "action",
                        action: "task_contract",
                        observation: JSON.stringify(context.task)
                    });
                    trace.save();
                    segmentEvents.push(`Task contract: ${initialTask.intent}`);
                    progress.log(`Task understood as ${context.workflow.kind}: ${initialTask.intent}`);
                }

                if (action.action === "refine_task") {
                    const refinedTask = action.task;
                    const currentTask = context.task;
                    if (!refinedTask || !currentTask) {
                        const answer = "Agent stopped safely because refine_task did not contain a valid current and replacement task contract.";
                        trace.add({ turn, status: "error", action: "model_protocol_circuit_breaker", observation: answer });
                        trace.save();
                        return { answer, trace, clarifications: clarificationTranscript };
                    }
                    const citedEvidence = action.evidence ?? [];
                    const refinementCheck = task.coordinator.validateRefinement(
                        currentTask,
                        refinedTask,
                        citedEvidence,
                        context.workspace.successfulWorkspaceEvidenceRefs
                    );
                    if (!refinementCheck.accepted) {
                        const observation = refinementCheck.reason;
                        recoveryResponseFormat = recoveryFormat("refine_task");
                        progress.log(`[${stepStatus(turn)}] ${observation}`);
                        trace.add({ turn, status: "error", action: "task_contract_refinement_blocked", reason: action.reason, observation });
                        trace.save();
                        messages.push({
                            role: "user",
                            content: `${observation} Do not repeat refine_task unchanged. Continue the current contract using file actions or the distinct verification it still requires. Successful workspace Evidence IDs currently available: ${Array.from(context.workspace.successfulWorkspaceEvidenceRefs).join(", ") || "none yet"}.`
                        });
                        continue;
                    }

                    const previousTaskContract = currentTask;
                    context.task = refinedTask;
                    const preparedTask = task.coordinator.prepare(
                        refinedTask,
                        `Refined by the model from workspace evidence ${citedEvidence.join(", ")}`
                    );
                    context.verification.requirement = preparedTask.acceptance.verification;
                    context.verification.satisfied = preparedTask.verificationSatisfied;
                    context.verification.attempted = false;
                    context.verification.failure = undefined;
                    context.verification.unresolvedMissingCommandTarget = false;
                    context.verification.inconclusiveBlocker = undefined;
                    context.verification.recoveryAttempts = 0;
                    context.verification.recoveryActive = false;
                    context.verification.requirement = preparedTask.acceptance.verification;
                    context.policy.acceptance = preparedTask.acceptance;
                    context.policy.readOnlyAllowsCommands = preparedTask.readOnlyAllowsCommands;
                    context.verification.satisfied = preparedTask.verificationSatisfied;
                    context.policy.readOnly = preparedTask.readOnly;
                    context.policy.mustWrite = preparedTask.mustWrite;
                    recoveryResponseFormat = undefined;
                    agentResponseFormat = context.policy.readOnly
                        ? getAgentReadOnlyResponseFormat(context.workflow.kind, context.policy.readOnlyAllowsCommands)
                        : getAgentResponseFormat(context.workflow.kind);
                    systemPrompt = await buildCurrentSystemPrompt();
                    const refreshedSystemMessage = buildInitialAgentMessages(systemPrompt, contextSummary, context.input.effectiveUserMessage)[0];
                    if (refreshedSystemMessage) messages[0] = refreshedSystemMessage;
                    guard.resetActionHistory();
                    const observation = JSON.stringify({
                        previous: previousTaskContract,
                        refined: context.task,
                        evidence: citedEvidence
                    });
                    trace.add({
                        turn,
                        status: "action",
                        action: "task_contract_refined",
                        reason: action.reason,
                        observation
                    });
                    trace.save();
                    segmentEvents.push(`Task contract refined from workspace evidence: ${refinedTask.intent}`);
                    progress.log(`[${stepStatus(turn)}] Task contract refined: ${refinedTask.intent}`);
                    messages.push({
                        role: "user",
                        content: `Task contract refinement accepted: ${observation}\nContinue using the refined verification and evidence requirements.`
                    });
                    continue;
                }

                // The loop ends only when the model explicitly returns final. Until
                // then each action becomes an observation for the next reasoning step.
                if (action.action === "ask_user") {
                    if (context.verification.unresolvedToolFailure) {
                        const failure = context.verification.unresolvedToolFailure.output.slice(0, 1400);
                        const output = `Blocked recovery clarification: ${context.verification.unresolvedToolFailure.action} is still failing. Tool failures must be diagnosed and corrected autonomously; do not ask the user to choose retry flags, troubleshooting commands, or implementation workarounds.`;
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
                        workspaceMutationRequired: context.policy.mustWrite,
                        successfulInspections: relevantClarificationInspections({
                            decision: request.decision,
                            question: request.question,
                            inspections: context.workspace.inspections
                        }).length,
                        answeredClarifications: answeredClarifications.size,
                        hasNewBlocker: Boolean(
                            context.verification.failure
                            || context.verification.unresolvedMissingCommandTarget
                            || context.workspace.validationFailures.size > 0
                        ),
                        decision: request.decision,
                        knownProjectRoots: discoverProjectRoots(activeWorkspace, projectCheckProviders).length,
                        asksNewVersusExisting: /(?:new|create|สร้าง)[\s\S]*(?:existing|current|ใช้โปรเจกต์|ใช้โปรเจค|ที่มีอยู่)/i.test(`${request.question} ${request.options.map((option) => `${option.id} ${option.label}`).join(" ")}`)
                            || /(?:existing|current|ใช้โปรเจกต์|ใช้โปรเจค|ที่มีอยู่)[\s\S]*(?:new|create|สร้าง)/i.test(`${request.question} ${request.options.map((option) => `${option.id} ${option.label}`).join(" ")}`),
                        ...clarificationSettings
                    });
                    if (clarificationBlocked) {
                        recoveryResponseFormat = recoveryFormat("ask_user");
                        progress.log(`[${stepStatus(turn)}] Clarification blocked: ${clarificationBlocked}`);
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
                    progress.suspend();
                    requestBudget.pause();
                    guard.pause();
                    let answer: ClarificationAnswer;
                    try {
                        answer = await promptForClarification(request, signal);
                    } finally {
                        guard.resume();
                        requestBudget.resume();
                        progress.resume();
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
                        const completedWrites = context.workspace.writtenPaths.size > 0
                            ? ` การเปลี่ยนแปลงที่ทำสำเร็จก่อนยกเลิกยังอยู่ใน workspace: ${Array.from(context.workspace.writtenPaths).join(", ")}`
                            : "";
                        return {
                            answer: `ยกเลิกงานตามคำขอแล้ว${completedWrites}`,
                            trace,
                            clarifications: clarificationTranscript
                        };
                    }
                    answeredClarifications.set(clarificationKey, observation);
                    context.input.effectiveUserMessage = `${userMessage}\n\nUser clarifications:\n${clarificationTranscript.map((line) => `- ${line}`).join("\n")}`;
                    systemPrompt = await buildCurrentSystemPrompt();
                    const refreshedSystemMessage = buildInitialAgentMessages(systemPrompt, contextSummary, context.input.effectiveUserMessage)[0];
                    if (refreshedSystemMessage) messages[0] = refreshedSystemMessage;
                    guard.resetActionHistory();
                    segmentEvents.push(`Step ${segmentTurn}: user clarification answered`);
                    messages.push({
                        role: "user",
                        content: `User clarification observation: ${JSON.stringify(observation)}\nContinue the same task using this answer. Do not ask the same question again.`
                    });
                    continue;
                }

                if (action.action === "final") {
                    const gate = await completion.coordinator.evaluateFinal(
                        action as unknown as FinalAction,
                        context
                    );
                    if (gate.status === "rejected") {
                        consecutiveFinalBlocks += 1;
                        if (consecutiveFinalBlocks > MAX_CONSECUTIVE_FINAL_BLOCKS) {
                            const loopReason = `The model repeated the same completion blocker ${consecutiveFinalBlocks} times without producing new evidence: ${gate.reason}`;
                            const answer = completion.coordinator.formatIncomplete(context, [loopReason]);
                            trace.add({
                                turn,
                                status: "error",
                                action: "final_loop_stop",
                                reason: action.reason,
                                observation: loopReason
                            });
                            trace.save();
                            return { answer, trace, clarifications: clarificationTranscript };
                        }
                        recoveryResponseFormat = recoveryFormat("final");
                        progress.log(`[${stepStatus(turn)}] Final blocked: ${gate.reason}`);
                        trace.add({
                            turn,
                            status: "error",
                            action: "final_blocked",
                            reason: action.reason,
                            observation: gate.reason
                        });
                        trace.save();
                        segmentEvents.push(`final_blocked [error]: ${gate.reason}`);
                        messages.push({ role: "user", content: gate.feedback });
                        continue;
                    }
                    if (gate.status === "incomplete") {
                        trace.add({
                            turn,
                            status: "final",
                            action: "final_incomplete",
                            reason: action.reason,
                            observation: gate.reason
                        });
                        trace.save();
                        return { answer: gate.answer, trace, clarifications: clarificationTranscript };
                    }
                    progress.update("Preparing final answer...");
                    trace.add({ turn, status: "final", action: "final", reason: action.reason });
                    trace.save();
                    return { answer: gate.answer, trace, clarifications: clarificationTranscript };
                }
                if (action.action === "run_command" && action.command && context.verification.lastFailedCommand
                    && context.verification.failure && commandInvocationError(context.verification.failure)
                    && normalizeCommandSignature(action.command) !== normalizeCommandSignature(context.verification.lastFailedCommand)) {
                    guard.resetActionHistory();
                }
                if (action.action === "run_command" && action.command
                    && failedCommands.has(action.command, action.workdir ?? ".")) {
                    const blockedAttempt = failedCommands.recordBlockedAttempt(action.command, action.workdir ?? ".");
                    const originalFailure = failedCommands.failureFor(action.command, action.workdir ?? ".");
                    const output = [
                        "Blocked repeated failed command: this exact command already failed in the current workspace state. Do not run it again unchanged. Submit a corrected command with different arguments or a different workdir. After a successful workspace change, the original verification command may be tried again.",
                        originalFailure
                            ? `Original failure from the first attempt:\n${originalFailure}`
                            : "Original failure output was unavailable."
                    ].join("\n\n");
                    progress.log(`[${stepStatus(turn)}] ${output}`);
                    trace.add({
                        turn,
                        status: "error",
                        action: "repeated_failed_command_blocked",
                        reason: action.reason,
                        arguments: action,
                        observation: output
                    });
                    trace.save();
                    if (blockedAttempt >= guard.settings.repeatLimit) {
                        const answer = `Status: incomplete.\n\nThe model repeatedly retried an exact command that was already known to fail in the unchanged workspace state. The command was blocked ${blockedAttempt} times after its original failure. Workspace changes remain in place; inspect the recorded command error and provide a corrected command or change the workspace before retrying.`;
                        trace.add({
                            turn,
                            status: "final",
                            action: "repeated_failed_command_stop",
                            observation: answer
                        });
                        trace.save();
                        return { answer, trace, clarifications: clarificationTranscript };
                    }
                    recoveryResponseFormat = recoveryFormat("refine_task");
                    messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                    continue;
                }
                const guardDecision = guard.registerAction(action as Record<string, unknown>);
                if (guardDecision.status === "replan") {
                    const repeatObservation = guardDecision.message ?? "This exact action is quarantined.";
                    progress.log(`[${stepStatus(turn)}] ${guardDecision.message}`);
                    trace.add({ turn, status: "error", action: "repeat_quarantine", arguments: action, observation: repeatObservation });
                    trace.save();
                    const completedWrites = context.workspace.writtenPaths.size > 0
                        ? ` Successful writes so far: ${Array.from(context.workspace.writtenPaths).join(", ")}.`
                        : "";
                    messages.push({
                        role: "user",
                        content: `Observation: ${repeatObservation}${completedWrites} This blocks only the exact action signature in the current evidence state; use different arguments, another action, or return an evidence-backed final.`
                    });
                    continue;
                }
                if (guardDecision.status === "stop") {
                    const observation = guardDecision.message ?? "The model repeatedly ignored an exact-action quarantine.";
                    trace.add({ turn, status: "error", action: "repeat_stop", arguments: action, observation });
                    trace.save();
                    return {
                        answer: `Agent stopped because it repeatedly retried an exact action after that action was quarantined. ${observation}`,
                        trace,
                        clarifications: clarificationTranscript
                    };
                }

                if (action.action === "run_command" && commandInvokesAgentTool(action.command ?? "")) {
                    const output = context.research.mcpCallsDisabled
                        ? "Blocked protocol misuse: MCP is disabled for this task because no configured server is available. Do not invoke agent action names through the shell."
                        : "Blocked protocol misuse: mcp_call_tool and mcp_list_tools are agent actions, not shell commands. Return the corresponding MCP action JSON instead.";
                    recoveryResponseFormat = recoveryFormat(["run_command", "final"]);
                    progress.log(`[${stepStatus(turn)}] ${output}`);
                    trace.add({ turn, status: "error", action: "shell_tool_call_blocked", reason: action.reason, arguments: action, observation: output });
                    trace.save();
                    messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                    continue;
                }

                if (action.action === "run_command" && action.command
                    && context.verification.unresolvedMissingCommandTarget
                    && commandAddsTooling(action.command)
                    && !/(?:\blint(?:er|ing)?\b|\btooling\b|\bplugin\b|ติดตั้ง|เพิ่ม.*(?:เครื่องมือ|ปลั๊กอิน))/i.test(userMessage)) {
                    const output = "Blocked scope expansion: a missing optional command target does not authorize installing new tooling. Use a finite verification command already declared by the project, or inspect the manifest to find one.";
                    progress.log(`[${stepStatus(turn)}] ${output}`);
                    trace.add({ turn, status: "error", action: action.action, reason: action.reason, arguments: action, observation: output });
                    trace.save();
                    messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                    continue;
                }
                const attemptsReadOnlyMutation = context.policy.readOnly && (
                    ["write_file", "edit_file", "delete_file"].includes(action.action ?? "")
                    || (action.action === "run_command" && commandMutatesWorkspaceFiles(action.command ?? ""))
                );
                if (attemptsReadOnlyMutation) {
                    const output = "Blocked by the model-owned read-only task contract: workspace changes are outside this task. Inspect with read/list/search or return a factual final answer without mutating files.";
                    recoveryResponseFormat = getAgentReadOnlyResponseFormat(context.workflow.kind, context.policy.readOnlyAllowsCommands);
                    progress.log(`[${stepStatus(turn)}] ${output}`);
                    trace.add({ turn, status: "error", action: "read_only_mutation_blocked", reason: action.reason, arguments: action, observation: output });
                    trace.save();
                    messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                    continue;
                }

                if (["write_file", "edit_file", "delete_file"].includes(action.action ?? "") && action.path) {
                    const normalizedMutationPath = action.path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
                    if (normalizedMutationPath === ".cli/mcp.json" && context.workflow.kind !== "mcp_creation") {
                        const output = "Blocked MCP config mutation: .cli/mcp.json is only changed for an explicit MCP-server creation task. Keep the existing configuration while working on this project.";
                        recoveryResponseFormat = recoveryFormat(["read_file", "final"]);
                        progress.log(`[${stepStatus(turn)}] ${output}`);
                        trace.add({ turn, status: "error", action: "mcp_config_mutation_blocked", reason: action.reason, arguments: action, observation: output });
                        trace.save();
                        messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                        continue;
                    }
                    context.workspace.projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                    const scopeFailure = unownedProjectMutationReason(action.path, context.workspace.projectChecks);
                    if (scopeFailure) {
                        const output = `Blocked unscoped project mutation: ${scopeFailure}`;
                        recoveryResponseFormat = recoveryFormat([action.action ?? "write_file", "final"]);
                        progress.log(`[${stepStatus(turn)}] ${output}`);
                        trace.add({ turn, status: "error", action: "project_scope_blocked", reason: action.reason, arguments: action, observation: output });
                        trace.save();
                        messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                        continue;
                    }
                }

                if (action.action === "run_command" && action.command) {
                    if (context.verification.pendingRuntimePortCorrection) {
                        const output = `Blocked repeated runtime probe: ${context.verification.pendingRuntimePortCorrection} Inspect and edit the real workspace server/client port configuration before running another command. Do not create or validate an auxiliary substitute server.`;
                        recoveryResponseFormat = recoveryFormat(["run_command", "write_file", "delete_file", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"]);
                        progress.log(`[${stepStatus(turn)}] ${output}`);
                        trace.add({ turn, status: "error", action: "runtime_probe_blocked_pending_correction", reason: action.reason, arguments: action, observation: output });
                        trace.save();
                        messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                        continue;
                    }
                    if (context.verification.pendingPackageScriptRecovery) {
                        const sameCommand = normalizeCommandSignature(action.command) === normalizeCommandSignature(context.verification.pendingPackageScriptRecovery.command)
                            || packageScriptCommandsEquivalent(action.command, context.verification.pendingPackageScriptRecovery.command);
                        const sameWorkdir = path.resolve(activeWorkspace, action.workdir ?? ".")
                            === path.resolve(activeWorkspace, context.verification.pendingPackageScriptRecovery.workdir);
                        const correctMode = context.verification.pendingPackageScriptRecovery.mode !== "probe" || action.mode === "probe";
                        if (!sameCommand || !sameWorkdir || !correctMode) {
                            const modeHint = context.verification.pendingPackageScriptRecovery.mode === "probe"
                                ? ', "mode":"probe", "timeout_ms":10000'
                                : "";
                            const output = `Blocked repeated local-executable workaround: the project manifest already provides the authoritative lifecycle command. Run {"action":"run_command","command":${JSON.stringify(context.verification.pendingPackageScriptRecovery.command)},"workdir":${JSON.stringify(context.verification.pendingPackageScriptRecovery.workdir)}${modeHint}} before trying another command. File inspection and source corrections remain available.`;
                            recoveryResponseFormat = recoveryFormat(["read_file", "search_project", "search_files", "edit_file", "write_file", "delete_file", "run_command", "final"]);
                            progress.log(`[${stepStatus(turn)}] ${output}`);
                            trace.add({ turn, status: "error", action: "local_executable_workaround_blocked", reason: action.reason, arguments: action, observation: output });
                            trace.save();
                            messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                            continue;
                        }
                    }
                    const packageRisk = packageMutationRisk(activeWorkspace, userMessage, action.command, action.workdir);
                    if (packageRisk) {
                        const output = `Blocked package mutation: ${packageRisk}. Inspect the selected manifest and lockfile, then use an exact user-authorized package and compatible package manager.`;
                        recoveryResponseFormat = recoveryFormat("final");
                        progress.log(`[${stepStatus(turn)}] ${output}`);
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
                        progress.log(`[${stepStatus(turn)}] ${output}`);
                        trace.add({ turn, status: "error", action: action.action, reason: action.reason, arguments: action, observation: output });
                        trace.save();
                        messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                        continue;
                    }
                }

                const validationBeforeMutation = (action.action === "write_file" || action.action === "edit_file") && action.path
                    ? writeValidator.validateProjectFor(action.path)
                    : undefined;
                const packageManifestBeforeMutation = (action.action === "write_file" || action.action === "edit_file") && action.path
                    && path.basename(action.path).toLowerCase() === "package.json"
                    && writeValidator.exists(action.path)
                    ? fs.readFileSync(path.resolve(activeWorkspace, action.path), "utf8")
                    : undefined;
                const completionBeforeDelete = action.action === "delete_file" && context.workspace.projectRequirement
                    ? evaluateProjectCompletion(activeWorkspace, context.workspace.projectRequirement)
                    : undefined;
                let mutationCheckpointId: string | undefined;
                if (action.action === "write_file" && action.path && typeof action.content === "string") {
                    const absolute = path.resolve(activeWorkspace, action.path);
                    const alreadyMatches = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
                        && fs.readFileSync(absolute, "utf8") === action.content;
                    if (!alreadyMatches) {
                        const checkpoint = checkpointStore.checkpoint(activeWorkspace, action.path, action.content);
                        mutationCheckpointId = checkpoint.id;
                        progress.log(checkpoint.preview);
                        progress.log(`Checkpoint: ${checkpoint.id} (use /undo to restore)`);
                    }
                }
                if (action.action === "edit_file" && action.path && typeof action.old_text === "string" && typeof action.new_text === "string") {
                    const prepared = agentTool.prepareEdit(action.path, action.old_text, action.new_text);
                    if (prepared.ok && prepared.content !== undefined && prepared.changed !== false) {
                        const checkpoint = checkpointStore.checkpoint(activeWorkspace, action.path, prepared.content);
                        mutationCheckpointId = checkpoint.id;
                        progress.log(checkpoint.preview);
                        progress.log(`Checkpoint: ${checkpoint.id} (use /undo to restore)`);
                    }
                }
                if (action.action === "delete_file" && action.path && writeValidator.exists(action.path)) {
                    const checkpoint = checkpointStore.checkpoint(activeWorkspace, action.path, "");
                    mutationCheckpointId = checkpoint.id;
                    progress.log(checkpoint.preview);
                    progress.log(`Checkpoint: ${checkpoint.id} (use /undo to restore)`);
                }
                // Persist the selected action before execution. If the process exits
                // inside a command, filesystem operation, or external tool call, the
                // next CLI process can still explain exactly where the task stopped.
                sessionTool.recordTaskEvent(sessionId, taskId, {
                    turn,
                    status: "action",
                    action: action.action ?? "unknown_action",
                    ...(action.reason ? { reason: action.reason } : {}),
                    arguments: action
                });
                progress.log(tools.actionCoordinator.formatStatus(action, segmentTurn, maxTurnsPerSegment));
                events.emit({ type: "tool_started", tool: action.action ?? "unknown_action" });
                debugLog("Tool request", { turn, action });
                let result = await tools.actionCoordinator.execute(action);
                if (action.action === "run_command" && !result.ok && result.recommendedCommand) {
                    context.verification.pendingPackageScriptRecovery = {
                        command: result.recommendedCommand,
                        workdir: result.recommendedWorkdir ?? action.workdir ?? ".",
                        ...(result.recommendedMode ? { mode: result.recommendedMode } : {})
                    };
                    recoveryResponseFormat = recoveryFormat(["read_file", "search_project", "search_files", "edit_file", "write_file", "delete_file", "run_command", "final"]);
                } else if (action.action === "run_command" && context.verification.pendingPackageScriptRecovery
                    && (normalizeCommandSignature(action.command ?? "") === normalizeCommandSignature(context.verification.pendingPackageScriptRecovery.command)
                        || packageScriptCommandsEquivalent(action.command ?? "", context.verification.pendingPackageScriptRecovery.command))) {
                    // Once the authoritative lifecycle was actually attempted, any
                    // further failure belongs to the project rather than invocation recovery.
                    context.verification.pendingPackageScriptRecovery = undefined;
                }
                if (action.action === "run_command" && !result.ok && result.failureKind === "inference_port_collision") {
                    context.verification.pendingRuntimePortCorrection = "The previous runtime request reached the CLI's llama.cpp inference endpoint on the same loopback port instead of the workspace service.";
                    recoveryResponseFormat = recoveryFormat(["run_command", "write_file", "delete_file", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"]);
                }
                if (action.action === "run_command" && action.command && !result.ok) {
                    failedCommands.record(action.command, action.workdir ?? ".", result.output);
                }
                if (context.workflow.kind !== "mcp_creation" && action.action === "mcp_list_tools" && result.ok
                    && (/"servers"\s*:\s*\[\s*\]/i.test(result.output) || /Unknown MCP server/i.test(result.output))) {
                    context.research.mcpCallsDisabled = true;
                    result = {
                        ok: false,
                        output: `${result.output}\nMCP disabled for this request because no configured server is available. Use local file tools and do not invent server names.`
                    };
                }
                if (context.workflow.kind !== "mcp_creation" && action.action === "mcp_call_tool" && !result.ok
                    && /Unknown MCP server|No MCP servers configured/i.test(result.output)) {
                    context.research.mcpCallsDisabled = true;
                    result = {
                        ...result,
                        output: `${result.output}\nMCP disabled for this request. Use local file tools and do not invent server names.`
                    };
                }
                if (result.ok && ["list_files", "search_project", "search_files", "read_file"].includes(action.action ?? "")) {
                    context.workspace.inspections.push({
                        action: action.action as "list_files" | "search_project" | "search_files" | "read_file",
                        ...(action.path ? { path: action.path } : {}),
                        ...(action.query ? { query: action.query } : {})
                    });
                }
                if (action.action === "read_file" && result.ok && action.path) {
                    const resolvedReadPath = path.resolve(activeWorkspace, action.path).toLowerCase();
                    context.workspace.readPaths.add(resolvedReadPath);
                    if (context.policy.readOnly && context.verification.requirement === "none" && context.workspace.explicitlyRequestedFiles.length > 0
                        && context.workspace.explicitlyRequestedFiles.every((requestedPath) => context.workspace.readPaths.has(requestedPath))) {
                        recoveryResponseFormat = getAgentFinalResponseFormat();
                    }
                }
                if (action.action === "run_command" && result.ok && commandMutatesWorkspaceFiles(action.command ?? "")) {
                    guard.recordFileProgress();
                    failedCommands.clear();
                    context.workspace.writtenPaths.add(commandCreatesWorkspaceFiles(action.command ?? "")
                        ? "[project scaffold generated by command]"
                        : "[dependency metadata updated by command]");
                    context.workspace.projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                    const effectiveWorkdir = action.workdir
                        ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
                    projectChecksAffectedByWorkdir(effectiveWorkdir, context.workspace.projectChecks).forEach((checkId: string) => {
                        context.workspace.successfulProjectChecks.delete(checkId);
                        context.workspace.pendingProjectChecks.add(checkId);
                    });
                    result.output += `\n${formatProjectChecksPrompt(context.workspace.projectChecks)}`;
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
                    if (validation.ok || rollback?.ok) context.workspace.validationFailures.delete(action.path);
                    else context.workspace.validationFailures.add(action.path);
                    if (!rollback?.ok && result.changed !== false) {
                        // A write changes the file version. Do not let an earlier read
                        // authorize a later mutation against stale contents.
                        context.workspace.readPaths.delete(path.resolve(activeWorkspace, action.path).toLowerCase());
                        guard.recordFileProgress();
                        failedCommands.clear();
                        context.workspace.writtenPaths.add(action.path);
                        if (isVisualPresentationMutation(
                            action.path,
                            action.action === "write_file" ? action.content ?? "" : action.new_text ?? ""
                        )) context.workspace.visualPresentationPaths.add(action.path);
                        context.workspace.projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                        projectChecksAffectedByPath(action.path, context.workspace.projectChecks).forEach((checkId: string) => {
                            context.workspace.successfulProjectChecks.delete(checkId);
                            context.workspace.pendingProjectChecks.add(checkId);
                        });
                        result.output += `\n${formatProjectChecksPrompt(context.workspace.projectChecks)}`;
                        if (context.workflow.kind === "mcp_creation") {
                            context.research.successfulMcpDiscovery = false;
                            context.research.successfulMcpCall = false;
                        }
                        if (action.action === "edit_file" && validation.ok) context.verification.pendingRuntimePortCorrection = undefined;
                    } else if (validation.ok && result.changed === false) {
                        context.workspace.satisfiedPaths.add(action.path);
                        if (context.verification.requirement === "none" && !context.workspace.projectRequirement) {
                            recoveryResponseFormat = getAgentFinalResponseFormat();
                        }
                    }
                }
                if (action.action === "delete_file" && result.ok && action.path) {
                    const completionAfterDelete = context.workspace.projectRequirement
                        ? evaluateProjectCompletion(activeWorkspace, context.workspace.projectRequirement)
                        : [];
                    const introducedBlockers = completionBeforeDelete
                        ? completionAfterDelete.filter((reason: string) => !completionBeforeDelete.includes(reason))
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
                        context.workspace.readPaths.delete(path.resolve(activeWorkspace, action.path).toLowerCase());
                        guard.recordFileProgress();
                        failedCommands.clear();
                        context.workspace.validationFailures.delete(action.path);
                        context.workspace.writtenPaths.add(action.path);
                        context.workspace.projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                        projectChecksAffectedByPath(action.path, context.workspace.projectChecks).forEach((checkId: string) => {
                            context.workspace.successfulProjectChecks.delete(checkId);
                            context.workspace.pendingProjectChecks.add(checkId);
                        });
                        result.output += `\n${formatProjectChecksPrompt(context.workspace.projectChecks)}`;
                        if (context.workflow.kind === "mcp_creation") {
                            context.research.successfulMcpDiscovery = false;
                            context.research.successfulMcpCall = false;
                        }
                    }
                }
                if (action.action === "mcp_list_tools" && result.ok) context.research.successfulMcpDiscovery = true;
                if (action.action === "mcp_call_tool" && result.ok) context.research.successfulMcpCall = true;
                await verification.coordinator.observeAction(action, result, context);
                await verification.coordinator.evaluate(context);
                const executionFailureKind = result.ok
                    ? undefined
                    : action.action === "run_command" && context.verification.requirement !== "none"
                        ? "verification_failed"
                        : "tool_execution_failed";
                const executionHealth = result.ok
                    ? protocolHealth.snapshot()
                    : executionFailureKind === "verification_failed"
                        ? protocolHealth.recordVerificationFailure()
                        : protocolHealth.recordToolExecutionFailure();
                responseLog.append({
                    turn,
                    maxTurns: maxTurnsForLog,
                    kind: "action_execution",
                    requestFormat,
                    rawContent: null,
                    parsedAction: action.action,
                    executorCalled: true,
                    toolExecutionStatus: result.ok ? "ok" : "error",
                    executionFailureKind,
                    protocolHealth: executionHealth
                });
                context.actions[context.actions.length - 1] = {
                    turn,
                    action: action.action as AgentAction["action"],
                    success: result.ok,
                    observation: result.output.slice(0, 500)
                };
                const observationGuardDecision = guard.recordObservation(action as Record<string, unknown>, result);
                if (observationGuardDecision.status === "replan") {
                    const quarantineMessage = observationGuardDecision.message ?? "This exact action is quarantined.";
                    trace.add({
                        turn,
                        status: "error",
                        action: "repeat_quarantine",
                        arguments: action,
                        observation: quarantineMessage
                    });
                    result = {
                        ...result,
                        output: `${result.output}\nLoop guard: ${quarantineMessage}`
                    };
                }
                events.emit({ type: "tool_completed", tool: action.action ?? "unknown_action", success: result.ok });
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
                    urls.forEach((sourceUrl: string) => context.research.sourceUrls.add(sourceUrl));
                    if (context.workflow.kind === "web_research" && urls.length === 0 && searchReturnedNoResults(result.output)) {
                        context.research.consecutiveEmptyWebSearches += 1;
                        if (context.research.consecutiveEmptyWebSearches >= 2) {
                            context.research.webResearchExhausted = true;
                            recoveryResponseFormat = getAgentFinalResponseFormat();
                            const observation = "Web search returned no usable results for two distinct attempts. Stop searching and return a concise final answer that clearly states the information could not be found through the configured search provider.";
                            trace.add({ turn, status: "error", action: "web_search_exhausted", observation });
                            trace.save();
                            messages.push({ role: "user", content: `Observation: ${observation}` });
                            continue;
                        }
                    } else if (urls.length > 0) {
                        context.research.consecutiveEmptyWebSearches = 0;
                    }
                }
                const observation = tools.actionCoordinator.formatObservation(action, result);
                debugLog("Tool observation -> LLM", { turn, action: action.action, observation });
                messages.push(currentToolCall
                    ? { role: "tool", tool_call_id: currentToolCall.id, content: observation }
                    : { role: "user", content: `Observation: ${observation}` });
            }

            const toolLimitBlockers = completion.coordinator.evaluateAtToolLimit(context);
            const completionDecision = completion.coordinator.evaluate(context);
            if (toolLimitBlockers.length > 0 || completionDecision.status === "blocked") {
                const answer = completion.coordinator.formatIncomplete(context, toolLimitBlockers);
                const executedTurnLimit = context.verification.recoveryActive ? recoveryMaxTurns : maxTurns;
                progress.log(`[${lastExecutedTurn}/${executedTurnLimit}] Tool limit reached; task remains incomplete`);
                trace.add({
                    turn: lastExecutedTurn + 1,
                    status: "error",
                    action: "incomplete_after_tool_limit",
                    observation: toolLimitBlockers.join("; ")
                });
                trace.save();
                return { answer, trace, clarifications: clarificationTranscript };
            }
            const executedTurnLimit = context.verification.recoveryActive ? recoveryMaxTurns : maxTurns;
            progress.log(`[${lastExecutedTurn}/${executedTurnLimit}] Tool limit reached after all completion gates passed; preparing a final summary`);
            progress.update("Summarizing completed work...");
            messages.push({
                role: "user",
                content: `No more tool actions are available for this task. Return one final JSON object now:
        {"action":"final","answer":"Summarize what was completed, validations that actually ran, any failures, and concrete remaining work."}
        Do not call another tool. Do not claim unverified success.`
            });

            try {
                const modelStartedAt = Date.now();
                const finalResponseFormat = getAgentFinalResponseFormat();
                debugLog("LLM final-summary request", { model, messages, responseFormat: finalResponseFormat, sampling: actionSampling });
                const response = await llmProvider.chat({
                    model,
                    messages,
                    responseFormat: finalResponseFormat,
                    sampling: actionSampling,
                    signal,
                    onRetry: (_attempt: number, errorCode: string) => {
                        events.emit({ type: "retrying", message: `llama.cpp connection ${errorCode}; retrying final summary...` });
                    }
                });
                const responseUsage = recordResponseUsage(sessionId, response.data);
                guard.recordCompletionTokens(responseUsage?.completionTokens ?? 0);
                const choice = response.data?.choices?.[0] ?? { message: {}, finish_reason: response.finishReason };
                const rawAssistantContent = response.rawProviderContent ?? response.content;
                const assistantContent = typeof response.content === "string" ? response.content.trim() : "";
                const finalAdmission = tools.actionCoordinator.admit({
                    content: assistantContent,
                    finishReason: response.finishReason ?? choice.finish_reason,
                    hasToolCall: Boolean(response.toolCall),
                    allowedActions: getAllowedActionNames(finalResponseFormat)
                });
                const finalAction = finalAdmission.ok ? finalAdmission.action : undefined;
                debugLog("LLM final-summary response", {
                    rawContent: rawAssistantContent,
                    reasoningContent: choice.message.reasoning_content,
                    finishReason: choice.finish_reason,
                    parsedAction: finalAction,
                    usage: response.data.usage,
                    timings: response.data.timings,
                    admission: finalAdmission,
                    transport: (response as { transportMeta?: unknown }).transportMeta
                });
                responseLog.append({
                    turn: lastExecutedTurn + 1,
                    maxTurns: maxTurnsForLog,
                    requestFormat: finalResponseFormat,
                    rawContent: rawAssistantContent,
                    reasoningContent: choice.message.reasoning_content,
                    finishReason: choice.finish_reason,
                    parsedAction: finalAction?.action,
                    parseError: finalAdmission.ok ? undefined : `${finalAdmission.kind}: ${finalAdmission.issues.join(" | ")}`,
                    durationMs: Date.now() - modelStartedAt,
                    usage: response.data.usage,
                    timings: response.data.timings,
                    admission: finalAdmission,
                    syntaxValid: finalAdmission.syntaxValid,
                    schemaValid: finalAdmission.schemaValid,
                    semanticValid: finalAdmission.semanticValid,
                    localRepairUsed: finalAdmission.localRepairUsed,
                    protocolRegenerationAttempt: 0,
                    protocolFailureKind: finalAdmission.ok ? undefined : finalAdmission.kind,
                    transport: (response as { transportMeta?: unknown }).transportMeta,
                    executorCalled: false
                });

                if (finalAction?.action === "final" && finalAction.answer.trim()) {
                    const answer = finalAction.answer.trim();
                    const missingSources = Array.from(context.research.sourceUrls).filter((sourceUrl) => !answer.includes(sourceUrl));
                    const finalAnswer = missingSources.length === 0
                        ? answer
                        : `${answer}\n\nSources:\n${missingSources.slice(0, 5).map((sourceUrl) => `- ${sourceUrl}`).join("\n")}`;
                    trace.add({
                        turn: lastExecutedTurn + 1,
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
                    turn: lastExecutedTurn + 1,
                    status: "error",
                    action: "final_after_tool_limit",
                    observation: message
                });
            }

            const answer = "Agent completed the maximum number of tool actions but could not produce a final summary. Review the trace and ask it to inspect the existing files before continuing.";
            trace.add({ turn: lastExecutedTurn + 1, status: "error", action: "final_summary_failed", observation: answer });
            trace.save();
            return { answer, trace, clarifications: clarificationTranscript };

    }
}

function formatProviderFailure(error: unknown): string {
    const candidate = error as {
        code?: unknown;
        message?: unknown;
        response?: { status?: unknown; data?: unknown };
        transportMeta?: { initialHttpStatus?: number; finalHttpStatus?: number };
    } | undefined;
    const status = typeof candidate?.response?.status === "number"
        ? candidate.response.status
        : candidate?.transportMeta?.finalHttpStatus ?? candidate?.transportMeta?.initialHttpStatus;
    const responseData = candidate?.response?.data as {
        error?: { message?: unknown; metadata?: unknown; details?: unknown };
        message?: unknown;
    } | undefined;
    const responseMessage = responseData?.error?.message ?? responseData?.message;
    const responseDetails = responseData?.error?.metadata ?? responseData?.error?.details;
    const code = status !== undefined
        ? `HTTP_${status}`
        : typeof candidate?.code === "string" && candidate.code
            ? candidate.code
            : "MODEL_REQUEST_FAILED";
    const message = responseMessage !== undefined
        ? String(responseMessage)
        : typeof candidate?.message === "string" && candidate.message
            ? candidate.message
            : String(error);
    const details = responseDetails === undefined ? "" : ` | details: ${safeErrorDetails(responseDetails)}`;
    return `${code}: ${redactProviderText(message)}${details}`;
}

function safeErrorDetails(value: unknown): string {
    try {
        return redactProviderText(JSON.stringify(value)).slice(0, 1400);
    } catch {
        return "[unavailable]";
    }
}

function redactProviderText(value: string): string {
    return value
        .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
        .replace(/sk-[A-Za-z0-9_-]+/gi, "[redacted]");
}

function providerErrorCode(providerFailure: string): string {
    const separator = providerFailure.indexOf(":");
    return separator > 0 ? providerFailure.slice(0, separator) : "MODEL_REQUEST_FAILED";
}

function classifyModelFailure(error: unknown, message: string): "timeout" | "rate_limited" | "transport_error" {
    const transportMeta = (error as { transportMeta?: { initialHttpStatus?: number; finalHttpStatus?: number } } | undefined)?.transportMeta;
    const status = (error as { response?: { status?: number } } | undefined)?.response?.status
        ?? transportMeta?.finalHttpStatus
        ?? transportMeta?.initialHttpStatus;
    if (status === 429 || /\b429\b|rate[- ]?limit|temporarily rate-limited/i.test(message)) return "rate_limited";
    if (status === 408 || /timeout|ECONNABORTED/i.test(message)) return "timeout";
    return "transport_error";
}

function formatModelFailureAnswer(failureKind: "timeout" | "rate_limited" | "transport_error", providerFailure: string): string {
    const guidance = failureKind === "rate_limited"
        ? "Retry shortly or switch model/provider."
        : failureKind === "timeout"
            ? "Retry after reducing the reasoning/output budget or check provider availability."
            : "Check the endpoint, API key, model, and provider response.";
    return [
        "Agent stopped safely because the model request failed.",
        `Error code: ${providerErrorCode(providerFailure)} (${failureKind})`,
        `Error message: ${providerFailure}`,
        guidance,
        "No workspace action was executed."
    ].join("\n");
}

function formatProtocolRegenerationFailure(failureKind: "timeout" | "rate_limited" | "transport_error", providerFailure: string): string {
    const guidance = failureKind === "rate_limited"
        ? "Retry shortly or switch model/provider."
        : "No workspace action was executed from the invalid response.";
    return [
        "Agent stopped safely because protocol regeneration failed.",
        `Error code: ${providerErrorCode(providerFailure)} (${failureKind})`,
        `Error message: ${providerFailure}`,
        guidance
    ].join("\n");
}

module.exports = { DefaultAgentRunner };
