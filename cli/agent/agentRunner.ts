import fs = require("node:fs");
import path = require("node:path");

type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";
type AcceptanceContract = {
    evidence: "source" | "command" | "runtime" | "interaction";
    verification: "none" | "command" | "runtime";
    reason: string;
};
type ClarificationRequest = import("../clarificationTypes").ClarificationRequest;
type ClarificationAnswer = import("../clarificationTypes").ClarificationAnswer;
type ProjectCompletionRequirement = import("../projectTypes").ProjectCompletionRequirement;
type RequestBudgetControl = { pause: () => void; resume: () => void; clear: () => void };

type AgentRunnerResult = {
    answer: string;
    trace: any;
    clarifications: string[];
};

type RunnerSpinner = {
    update: (message: string) => void;
    log: (message: string) => void;
    suspend: () => void;
    resume: () => void;
};

type AgentRunRequest = {
    userMessage: string;
    historyForModel: Array<{ role: "user" | "assistant"; content: string }>;
    historyForTask: Array<{ role: "user" | "assistant"; content: string }>;
    spinner: RunnerSpinner;
    sessionId: string;
    taskId: string;
    signal: AbortSignal;
    requestBudget: RequestBudgetControl;
};

type AgentRunnerServices = Record<string, any>;

class DefaultAgentRunner {
    constructor(private readonly services: AgentRunnerServices) {}

    async run(request: AgentRunRequest): Promise<AgentRunnerResult> {
        const {
            userMessage,
            historyForModel,
            historyForTask,
            spinner,
            sessionId,
            taskId,
            signal,
            requestBudget
        } = request;
        const {
            AgentGuard,
            agentGuardSettings,
            verificationRecoveryTurnAllowance,
            shouldActivateVerificationRecovery,
            discoverProjectChecks,
            activeWorkspace,
            projectCheckProviders,
            getAgentReadOnlyResponseFormat,
            getAgentResponseFormat,
            getInitialAgentResponseFormat,
            llmProvider,
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
            model,
            activeContextLength,
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
            unownedProjectMutationReason,
            countCompilerDiagnostics,
            compilerDiagnosticFingerprint,
            packageLifecycleRoleChanges,
            diagnosticRecoveryGuidance,
            missingCommandTargetError,
            commandInvokesAgentTool,
            isVisualPresentationMutation,
            searchReturnedNoResults,
            checkpointStore,
            clarificationSettings
        } = this.services;

            const guard = new AgentGuard(agentGuardSettings);
            const maxTurnsPerSegment = guard.settings.maxTurns;
            const hasStepCadence = maxTurnsPerSegment > 0;
            const maxSegments = agentGuardSettings.maxSegments;
            const unboundedSegments = maxSegments === 0;
            const maxSegmentsLabel = unboundedSegments ? "unbounded" : String(maxSegments);
            const maxTurns = unboundedSegments || !hasStepCadence ? Number.POSITIVE_INFINITY : maxTurnsPerSegment * maxSegments;
            const maxTurnsForLog = unboundedSegments || !hasStepCadence ? 0 : maxTurns;
            const recoveryTurnAllowance = Number.isFinite(maxTurns)
                ? verificationRecoveryTurnAllowance(maxTurnsPerSegment)
                : 0;
            const recoveryMaxTurns = Number.isFinite(maxTurns) ? maxTurns + recoveryTurnAllowance : maxTurns;
            let verificationRecoveryActive = false;
            let effectiveUserMessage = userMessage;
            let workflow: { kind: WorkflowKind; reason: string } = {
                kind: "general",
                reason: "Pending semantic classification in the agent's first tool action."
            };
            let readOnlyRequest = false;
            let mustWrite = false;
            let acceptance: AcceptanceContract = {
                evidence: "source",
                verification: "none",
                reason: "Pending the model-owned task contract."
            };
            let verificationRequirement = acceptance.verification;
            let readOnlyAllowsCommands = false;
            let projectRequirement: ProjectCompletionRequirement | undefined;
            let taskContract: {
                intent: string;
                task_type: WorkflowKind;
                continuation: boolean;
                requires_workspace_changes: boolean;
                verification: "none" | "command" | "runtime" | "interaction";
                evidence_requirements: Array<"source" | "command" | "runtime" | "interaction" | "visual">;
                success_criteria: string[];
            } | undefined;
            let projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
            let agentResponseFormat = readOnlyRequest ? getAgentReadOnlyResponseFormat(workflow.kind, readOnlyAllowsCommands) : getAgentResponseFormat(workflow.kind);
            const initialAgentResponseFormat = getInitialAgentResponseFormat();
            const relevantHistory = selectTaskContext(userMessage, historyForModel, workflow.kind, historyMessageLimit);
            const contextSummary = summarizeTaskContext(relevantHistory);
            const writeValidator = new WriteValidator(activeWorkspace);
            const availableSkills = skillLoader.discover(activeWorkspace);
            const selectedSkills = skillLoader.select(userMessage, availableSkills);
            const skillPrompt = skillLoader.formatPrompt(selectedSkills);
            const readPaths = new Set<string>();
            const explicitlyRequestedFiles = Array.from(effectiveUserMessage.matchAll(/(?:^|[\s"'`])((?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|ps1|yml|yaml|go))(?=$|[\s"'`,)])/gi))
                .map((match) => path.resolve(activeWorkspace, match[1] ?? "").toLowerCase());
            const validationFailures = new Set<string>();
            let unresolvedVerificationFailure: string | undefined;
            let unresolvedToolFailure: { action: string; output: string } | undefined;
            let pendingRuntimePortCorrection: string | undefined;
            let pendingPackageScriptRecovery: { command: string; workdir: string; mode?: "probe" } | undefined;
            let unresolvedMissingCommandTarget = false;
            let lastFailedCommand: string | undefined;
            let inconclusiveVerificationBlocker: string | undefined;
            let unsatisfiedFinalAttempts = 0;
            const failedCommands = new FailedCommandRegistry(activeWorkspace);
            let verificationSatisfied = verificationRequirement === "none";
            const successfulProjectChecks = new Set<string>();
            const pendingProjectChecks = new Set<string>();
            const clarificationTranscript: string[] = [];
            const answeredClarifications = new Map<string, Record<string, unknown>>();
            const contextInspections: Array<{ action: "list_files" | "search_project" | "search_files" | "read_file"; path?: string; query?: string }> = [];
            const writtenPaths = new Set<string>();
            const visualPresentationPaths = new Set<string>();
            const satisfiedPaths = new Set<string>();
            const successfulEvidenceRefs = new Set<string>();
            const successfulWorkspaceEvidenceRefs = new Set<string>();
            let successfulMcpDiscovery = false;
            let successfulMcpCall = false;
            let mcpCallsDisabled = false;
            const sourceUrls = new Set<string>();
            let consecutiveEmptyWebSearches = 0;
            let webResearchExhausted = false;
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
            trace.add({
                turn: 0,
                status: "action",
                action: "task_start",
                observation: JSON.stringify({
                    workflow: "pending_model_classification",
                    model,
                    contextLength: activeContextLength,
                    agentProfile: agentGuardSettings.profile,
                    maxSteps: unboundedSegments || !hasStepCadence ? "unbounded" : maxTurns,
                    verificationRecoverySteps: recoveryTurnAllowance,
                    maxDurationMs: agentGuardSettings.maxDurationMs
                })
            });
            trace.save();
            const responseLogDisplayPath = path.relative(appRoot, resolveJsonlLogPath(responseTarget));
            const buildCurrentSystemPrompt = (): Promise<string> => agentTool.buildSystemPrompt([
                taskContract
                    ? `Model-owned task contract: ${JSON.stringify(taskContract)}`
                    : "First-response requirement: infer the user's intent and observable success criteria, include the task contract, and choose the first useful action in the same JSON response.",
                taskContract && verificationRequirement !== "none"
                    ? `Completion requirement: ${verificationRequirement} verification must succeed after the latest file change before final.`
                    : "",
                taskContract ? `Final claims must not exceed successful ${acceptance.evidence} evidence.` : "",
                acceptance.evidence === "interaction"
                    ? "Trace the rendered declaration through its owning implementation, imports/providers, event handler, state transition, and output before editing. Inspect co-located implementation companions referenced by the target. Then use a finite automated interaction test that performs the user-visible action and asserts its observable outcome. A build, typecheck, source read, response-body text search, or unrelated HTTP probe is not sufficient. Prefer an existing project test runner over starting a development server."
                    : "",
                taskContract?.evidence_requirements.includes("visual")
                    ? "This task has a visual acceptance requirement. Inspect the owning rendered component/template and its styling companion, make a concrete styling change, and run a finite headless interaction check. Do not claim visual success from a build or source read alone."
                    : "",
                readOnlyRequest ? "Read-only task contract: workspace changes are not part of this task. Do not edit, write, delete, install, scaffold, or run any command that mutates files." : "",
                formatProjectChecksPrompt(projectChecks),
                projectRequirement ? formatProjectCompletionPrompt(projectRequirement, projectChecks) : "",
                skillPrompt
            ].filter(Boolean).join("\n\n"));
            let systemPrompt = await buildCurrentSystemPrompt();
            let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = buildInitialAgentMessages(systemPrompt, contextSummary, userMessage);
            let recoveryResponseFormat: Record<string, unknown> | undefined;
            let reasoningOnlyRetryPending = false;
            let consecutiveReasoningOnlyTruncations = 0;
            const recoveryFormat = (extra: string | string[] = []) => getAgentRecoveryResponseFormat(
                workflow.kind,
                Array.from(new Set(Array.isArray(extra) ? extra : [extra])).filter(Boolean)
            );
            let segmentEvents: string[] = [];
            let contextCompactionCount = 0;
            const stepStatus = (step: number): string => hasStepCadence
                ? `step ${step}/${verificationRecoveryActive ? recoveryMaxTurns : maxTurns}`
                : `step ${step}`;

            if (selectedSkills.length > 0) spinner.log(`Skills: ${selectedSkills.map((skill: any) => skill.name).join(", ")}`);

            let lastExecutedTurn = 0;
            for (let turn = 1; ; turn += 1) {
                if (turn > maxTurns && !verificationRecoveryActive) {
                    verificationRecoveryActive = shouldActivateVerificationRecovery({
                        boundedRun: Number.isFinite(maxTurns),
                        baseLimitReached: true,
                        verificationRequiredAndUnsatisfied: verificationRequirement !== "none" && !verificationSatisfied,
                        pendingProjectChecks: Array.from(pendingProjectChecks).some((checkId) => !successfulProjectChecks.has(checkId)),
                        ...(unresolvedVerificationFailure ? { unresolvedVerificationFailure } : {})
                    });
                    if (verificationRecoveryActive) {
                        const observation = `Verification failed at the normal step limit. Continuing for up to ${recoveryTurnAllowance} recovery steps so the agent can inspect the error, correct the project, and rerun verification.`;
                        spinner.log(`[recovery] ${observation}`);
                        trace.add({ turn, status: "action", action: "verification_recovery_started", observation });
                        trace.save();
                    }
                }
                if (turn > maxTurns && (!verificationRecoveryActive || turn > recoveryMaxTurns)) break;
                lastExecutedTurn = turn;
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
                        maxSegments: verificationRecoveryActive && maxSegments > 0
                            ? maxSegments + 1
                            : maxSegments,
                        writtenPaths: Array.from(writtenPaths),
                        satisfiedPaths: Array.from(satisfiedPaths),
                        validationFailures: Array.from(validationFailures),
                        ...(unresolvedVerificationFailure ? { unresolvedVerificationFailure } : {}),
                        verificationRequirement,
                        verificationSatisfied,
                        successfulEvidenceRefs: Array.from(successfulEvidenceRefs),
                        successfulWorkspaceEvidenceRefs: Array.from(successfulWorkspaceEvidenceRefs),
                        sourceUrls: Array.from(sourceUrls),
                        recentEvents: segmentEvents,
                        mcpCallsDisabled
                    });
                    segmentEvents = [];
                    readPaths.clear();
                    sessionTool.resetActiveContextUsage(sessionId);
                    recoveryResponseFormat = undefined;
                    const trigger = compactForTokens ? `at 70% context usage (${contextTokenThreshold.toLocaleString()} tokens)` : "at the turn boundary";
                    const segmentLabel = verificationRecoveryActive && compactedSegment > maxSegments
                        ? `${maxSegmentsLabel} + recovery`
                        : maxSegmentsLabel;
                    spinner.log(`Compacted agent context ${trigger}; continuing segment ${compactedSegment}/${segmentLabel}.`);
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
                const requestFormat = mcpCallsDisabled
                    ? withoutMcpActions(selectedResponseFormat)
                    : selectedResponseFormat;
                recoveryResponseFormat = undefined;
                spinner.update(turn === 1
                    ? `Planning next step (step ${turn}, ${guard.formatRemaining()})...`
                    : `Reviewing results (step ${turn}, ${guard.formatRemaining()})...`);

                const samplingForRequest = reasoningOnlyRetryPending
                    ? { ...actionSampling, max_tokens: reasoningOnlyRetryMaxTokens(actionSampling.max_tokens) }
                    : actionSampling;
                reasoningOnlyRetryPending = false;
                const modelStartedAt = Date.now();
                debugLog("LLM request", { turn, model, messages, responseFormat: requestFormat, sampling: samplingForRequest });
                const response = await llmProvider.chat({
                    model,
                    messages,
                    responseFormat: requestFormat,
                    sampling: samplingForRequest,
                    signal,
                    onRetry: (_attempt: number, errorCode: string) => {
                    spinner.update(`llama.cpp connection ${errorCode}; retrying...`);
                    }
                });
                const responseUsage = recordResponseUsage(sessionId, response.data);
                guard.recordCompletionTokens(responseUsage?.completionTokens ?? 0);

                const choice = response.data.choices[0];
                const rawAssistantContent = choice.message.content;
                const assistantContent = typeof rawAssistantContent === "string" ? rawAssistantContent.trim() : "";
                const reasoningOnlyTruncation = isReasoningOnlyTruncation({
                    content: rawAssistantContent,
                    reasoningContent: choice.message.reasoning_content,
                    finishReason: choice.finish_reason
                });
                const action = agentTool.parseAction(assistantContent) as {
                    action?: string;
                    answer?: string;
                    completion_status?: "completed" | "already_satisfied" | "no_change_needed" | "incomplete";
                    evidence?: string[];
                    tool?: string;
                    reason?: string;
                    path?: string;
                    query?: string;
                    content?: string;
                    old_text?: string;
                    new_text?: string;
                    command?: string;
                    workdir?: string;
                    mode?: "normal" | "probe";
                    timeout_ms?: number;
                    expect?: {
                        exit_code?: 0;
                        output_includes?: string[];
                        output_excludes?: string[];
                    };
                    question?: string;
                    decision?: ClarificationRequest["decision"];
                    options?: Array<{ id: string; label: string; description?: string }>;
                    server?: string;
                    arguments?: Record<string, unknown>;
                    task?: {
                        intent: string;
                        task_type: WorkflowKind;
                        continuation: boolean;
                        requires_workspace_changes: boolean;
                        verification: "none" | "command" | "runtime" | "interaction";
                        evidence_requirements: Array<"source" | "command" | "runtime" | "interaction" | "visual">;
                        success_criteria: string[];
                    };
                } | undefined;
                const parseError = action
                    ? undefined
                    : reasoningOnlyTruncation
                        ? REASONING_ONLY_PARSE_ERROR
                        : agentTool.explainParseFailure(assistantContent);
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
                    if (!reasoningOnlyTruncation) consecutiveReasoningOnlyTruncations = 0;
                    segmentEvents.push(`Step ${segmentTurn}: invalid model action (${parseError ?? "unknown parse error"})`);
                    spinner.log(`[${stepStatus(turn)}] Invalid model action (${parseError}); logged to ${responseLogDisplayPath}`);
                    trace.add({
                        turn,
                        status: "parse_error",
                        action: "invalid_action",
                        observation: assistantContent.slice(0, 1000)
                    });
                    trace.save();
                    if (reasoningOnlyTruncation) {
                        consecutiveReasoningOnlyTruncations += 1;
                        if (consecutiveReasoningOnlyTruncations > MAX_REASONING_ONLY_RETRIES) {
                            const answer = `Agent stopped safely after ${MAX_REASONING_ONLY_RETRIES} reasoning-only recovery retries because the model still emitted no action JSON. The response log contains the truncated reasoning for diagnosis.`;
                            trace.add({
                                turn,
                                status: "error",
                                action: "reasoning_only_recovery_exhausted",
                                observation: answer
                            });
                            trace.save();
                            return { answer, trace, clarifications: clarificationTranscript };
                        }
                        reasoningOnlyRetryPending = true;
                        recoveryResponseFormat = recoveryFormat();
                        messages.push({
                            role: "user",
                            content: formatReasoningOnlyRecoveryPrompt(consecutiveReasoningOnlyTruncations)
                        });
                    } else if (choice.finish_reason === "length") {
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
                consecutiveReasoningOnlyTruncations = 0;

                if (!taskContract && !action.task) {
                    recoveryResponseFormat = initialAgentResponseFormat;
                    const output = "The first action is missing the required model-owned task contract.";
                    spinner.log(`[${stepStatus(turn)}] ${output}`);
                    trace.add({ turn, status: "parse_error", action: "missing_task_contract", observation: output });
                    trace.save();
                    messages.push({
                        role: "user",
                        content: "Return one action again and include task with intent, task_type, continuation, requires_workspace_changes, verification, evidence_requirements, and observable success_criteria. Set continuation semantically from the current request and session context. Choose all evidence requirements implied by the outcome and choose the useful first action in the same JSON object."
                    });
                    continue;
                }

                if (!taskContract && action.task) {
                    taskContract = action.task;
                    workflow = {
                        kind: taskContract.task_type,
                        reason: `Classified semantically by the agent: ${taskContract.intent}`
                    };
                    readOnlyRequest = !taskContract.requires_workspace_changes;
                    mustWrite = taskContract.requires_workspace_changes;
                    const evidencePolicy = deriveTaskEvidencePolicy(
                        taskContract.evidence_requirements,
                        taskContract.verification
                    );
                    verificationRequirement = evidencePolicy.verification;
                    acceptance = {
                        evidence: evidencePolicy.evidence,
                        verification: verificationRequirement,
                        reason: `Defined by the model from the user goal: ${taskContract.success_criteria.join("; ")}`
                    };
                    readOnlyAllowsCommands = verificationRequirement !== "none";
                    verificationSatisfied = verificationRequirement === "none";
                    agentResponseFormat = readOnlyRequest
                        ? getAgentReadOnlyResponseFormat(workflow.kind, readOnlyAllowsCommands)
                        : getAgentResponseFormat(workflow.kind);
                    systemPrompt = await buildCurrentSystemPrompt();
                    const refreshedSystemMessage = buildInitialAgentMessages(systemPrompt, contextSummary, effectiveUserMessage)[0];
                    if (refreshedSystemMessage) messages[0] = refreshedSystemMessage;
                    trace.add({
                        turn,
                        status: "action",
                        action: "task_contract",
                        observation: JSON.stringify(taskContract)
                    });
                    trace.save();
                    segmentEvents.push(`Task contract: ${taskContract.intent}`);
                    spinner.log(`Task understood as ${workflow.kind}: ${taskContract.intent}`);
                }

                if (action.action === "refine_task") {
                    const refinedTask = action.task;
                    const citedEvidence = action.evidence ?? [];
                    const invalidEvidence = citedEvidence.filter((evidenceId) => !successfulWorkspaceEvidenceRefs.has(evidenceId));
                    const scopeChanged = !taskContract
                        || refinedTask?.task_type !== taskContract.task_type
                        || refinedTask?.requires_workspace_changes !== taskContract.requires_workspace_changes
                        || refinedTask?.continuation !== taskContract.continuation;
                    const unchangedContract = Boolean(
                        taskContract
                        && refinedTask
                        && taskContractsEquivalent(taskContract, refinedTask)
                    );
                    if (!refinedTask || citedEvidence.length === 0 || invalidEvidence.length > 0 || scopeChanged || unchangedContract) {
                        const reasons = [
                            !refinedTask ? "a complete refined task contract is required" : "",
                            citedEvidence.length === 0 ? "at least one successful workspace Evidence ID is required" : "",
                            invalidEvidence.length > 0 ? `unknown or non-workspace evidence: ${invalidEvidence.join(", ")}` : "",
                            scopeChanged ? "task_type, continuation, and requires_workspace_changes cannot change during refinement" : "",
                            unchangedContract ? "the proposed contract is equivalent to the current contract and makes no refinement" : ""
                        ].filter(Boolean);
                        const observation = `Task contract refinement rejected: ${reasons.join("; ")}.`;
                        recoveryResponseFormat = recoveryFormat("refine_task");
                        spinner.log(`[${stepStatus(turn)}] ${observation}`);
                        trace.add({ turn, status: "error", action: "task_contract_refinement_blocked", reason: action.reason, observation });
                        trace.save();
                        messages.push({
                            role: "user",
                            content: `${observation} Do not repeat refine_task unchanged. Continue the current contract using file actions or the distinct verification it still requires. Successful workspace Evidence IDs currently available: ${Array.from(successfulWorkspaceEvidenceRefs).join(", ") || "none yet"}.`
                        });
                        continue;
                    }

                    const previousTaskContract = taskContract;
                    taskContract = refinedTask;
                    const evidencePolicy = deriveTaskEvidencePolicy(
                        taskContract.evidence_requirements,
                        taskContract.verification
                    );
                    verificationRequirement = evidencePolicy.verification;
                    acceptance = {
                        evidence: evidencePolicy.evidence,
                        verification: verificationRequirement,
                        reason: `Refined by the model from workspace evidence ${citedEvidence.join(", ")}: ${taskContract.success_criteria.join("; ")}`
                    };
                    readOnlyAllowsCommands = verificationRequirement !== "none";
                    verificationSatisfied = verificationRequirement === "none";
                    recoveryResponseFormat = undefined;
                    agentResponseFormat = readOnlyRequest
                        ? getAgentReadOnlyResponseFormat(workflow.kind, readOnlyAllowsCommands)
                        : getAgentResponseFormat(workflow.kind);
                    systemPrompt = await buildCurrentSystemPrompt();
                    const refreshedSystemMessage = buildInitialAgentMessages(systemPrompt, contextSummary, effectiveUserMessage)[0];
                    if (refreshedSystemMessage) messages[0] = refreshedSystemMessage;
                    guard.resetActionHistory();
                    const observation = JSON.stringify({
                        previous: previousTaskContract,
                        refined: taskContract,
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
                    segmentEvents.push(`Task contract refined from workspace evidence: ${taskContract.intent}`);
                    spinner.log(`[${stepStatus(turn)}] Task contract refined: ${taskContract.intent}`);
                    messages.push({
                        role: "user",
                        content: `Task contract refinement accepted: ${observation}\nContinue using the refined verification and evidence requirements.`
                    });
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
                    effectiveUserMessage = `${userMessage}\n\nUser clarifications:\n${clarificationTranscript.map((line) => `- ${line}`).join("\n")}`;
                    systemPrompt = await buildCurrentSystemPrompt();
                    const refreshedSystemMessage = buildInitialAgentMessages(systemPrompt, contextSummary, effectiveUserMessage)[0];
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
                    const completionStatus = effectiveCompletionStatus(
                        action.completion_status ?? "completed",
                        writtenPaths.size
                    );
                    const noChangeOutcome = completionStatus === "already_satisfied"
                        || completionStatus === "no_change_needed";
                    const incompleteReason = unresolvedToolFailure?.output
                        || unresolvedVerificationFailure
                        || inconclusiveVerificationBlocker
                        || (validationFailures.size > 0
                            ? `validation remains unresolved for ${Array.from(validationFailures).join(", ")}`
                            : verificationRequirement !== "none" && !verificationSatisfied
                                ? `required ${verificationRequirement} verification has not succeeded`
                                : undefined);
                    const finishIncomplete = (reason: string, useProposedAnswer: boolean): {
                        answer: string;
                        trace: any;
                        clarifications: string[];
                    } => {
                        const conciseReason = reason.replace(/\s+/g, " ").trim().slice(0, 1200);
                        const answer = useProposedAnswer
                            ? `Status: incomplete.\n\n${proposedAnswer}\n\nUnverified requirement: ${conciseReason}`
                            : `Status: incomplete.\n\nWorkspace changes remain in place, but the required verification could not be completed. ${conciseReason}\n\nThe CLI stopped recovery instead of continuing an unproductive verification loop.`;
                        trace.add({
                            turn,
                            status: "final",
                            action: "final_incomplete",
                            reason: action.reason,
                            observation: conciseReason
                        });
                        trace.save();
                        return { answer, trace, clarifications: clarificationTranscript };
                    };
                    if (completionStatus === "incomplete") {
                        if (!incompleteReason) {
                            rejectFinal(
                                "incomplete status requires an actual unresolved implementation, tool, validation, or verification blocker",
                                "Use completion_status incomplete only when a concrete blocker remains. Otherwise return the evidence-backed completed, already_satisfied, or no_change_needed outcome."
                            );
                            continue;
                        }
                        return finishIncomplete(incompleteReason, true);
                    }
                    if (incompleteReason && inconclusiveVerificationBlocker) {
                        if (unsatisfiedFinalAttempts >= 1) {
                            return finishIncomplete(incompleteReason, false);
                        }
                        unsatisfiedFinalAttempts += 1;
                    }
                    const continuationStateSatisfied = continuationNoWriteCompletionAllowed({
                        continuation: taskContract?.continuation === true,
                        evidence: action.evidence ?? [],
                        successfulEvidenceRefs,
                        successfulWorkspaceEvidenceRefs,
                        verificationRequired: verificationRequirement !== "none",
                        verificationSatisfied,
                        hasUnresolvedFailures: Boolean(
                            unresolvedToolFailure
                            || unresolvedVerificationFailure
                            || validationFailures.size > 0
                            || pendingProjectChecks.size > 0
                        )
                    });
                    const noChangeBlocker = noChangeCompletionBlockReason({
                        status: completionStatus,
                        evidence: action.evidence ?? [],
                        successfulEvidenceRefs,
                        successfulWorkspaceEvidenceRefs,
                        workspaceChangeRequired: mustWrite,
                        verificationRequired: verificationRequirement !== "none",
                        verificationSatisfied,
                        hasUnresolvedFailures: Boolean(
                            unresolvedToolFailure
                            || unresolvedVerificationFailure
                            || validationFailures.size > 0
                        )
                    });
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
                            `You cannot report completion while the latest tool failure is unresolved. Inspect the error and make a concrete correction or run a successful corrective command. A read-only inspection does not clear this failure. If the implementation progress is preserved but the required verifier is unavailable after this grounded attempt, return final with completion_status "incomplete" and describe the exact unverified criterion. Failure evidence: ${unresolvedToolFailure.output.slice(0, 1400)}`
                        );
                        continue;
                    }
                    if (taskContract?.continuation && verificationRequirement !== "none" && !verificationSatisfied) {
                        const requiredCheck = verificationRequirement === "runtime"
                            ? acceptance.evidence === "interaction"
                                ? "run a finite automated interaction test that performs the action and asserts the resulting state"
                                : "run the manifest-defined runtime lifecycle or an OS-compatible probe of the requested URL, endpoint, server, or UI; use mode probe with a finite timeout for start/dev/serve scripts"
                            : "run the relevant test, build, lint, or verification command";
                        rejectFinal(
                            `required ${verificationRequirement} verification has not succeeded for this continuation`,
                            `You cannot report completion yet. ${requiredCheck}. A successful build, typecheck, or file read alone does not prove runtime behavior. Continue the current contract; do not use refine_task merely to remove continuation or weaken its evidence requirement. If no finite verifier is available after a grounded attempt, return final with completion_status "incomplete" instead of changing unrelated configuration or substituting another service.`
                        );
                        continue;
                    }
                    if (mustWrite && writtenPaths.size === 0 && satisfiedPaths.size === 0 && !noChangeOutcome && !continuationStateSatisfied) {
                        rejectFinal(
                            "this request requires a successful file write",
                            taskContract?.continuation
                                ? "This is continuation work. If current workspace evidence proves the prior edits already satisfy the task, run every required verification and return final citing both workspace and verification Evidence IDs; do not create a cosmetic change. Otherwise use edit_file or write_file for the real remaining correction."
                                : "You cannot return final yet. The user requested a file change, but no file has been changed. Use edit_file for an existing file or write_file for a new file, then verify the result before returning final."
                        );
                        continue;
                    }
                    if (taskContract?.evidence_requirements.includes("visual")
                        && visualPresentationPaths.size === 0
                        && !noChangeOutcome
                        && !continuationStateSatisfied) {
                        rejectFinal(
                            "visual presentation work has no successful styling mutation",
                            "You cannot return final yet. The current task contract requires a rendered visual result, but no stylesheet or concrete embedded-style mutation succeeded. If successful workspace inspection proves the initial visual requirement was incorrect, use refine_task with those exact Evidence IDs while preserving task type and write scope. Otherwise inspect the styling owner, implement the visual styling, and run finite interaction verification."
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
                            .filter((check: any) => !successfulProjectChecks.has(check.id));
                        if (missingChecks.length > 0) {
                            const descriptions = missingChecks.map((check: any) => `${check.command} (workdir ${check.workdir})`);
                            rejectFinal(
                                `required project checks have not succeeded: ${descriptions.join(", ")}`,
                                `You cannot return final yet. Run successful verification for: ${descriptions.join(", ")}. Use run_command.workdir exactly as discovered from each project manifest.`
                            );
                            continue;
                        }
                    }
                        const pendingChecks = projectChecks.filter((check: any) => (
                        pendingProjectChecks.has(check.id) && !successfulProjectChecks.has(check.id)
                    ));
                    if (pendingChecks.length > 0) {
                            const descriptions = pendingChecks.map((check: any) => `${check.command} (workdir ${check.workdir})`);
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
                    const verificationWasActivated = verificationRequirement !== "none";
                    if (!verificationSatisfied && verificationWasActivated) {
                        const requiredCheck = verificationRequirement === "runtime"
                            ? acceptance.evidence === "interaction"
                                ? "run a finite automated interaction test that performs the action and asserts the resulting state"
                                : "run the manifest-defined runtime lifecycle or an OS-compatible probe of the requested URL, endpoint, server, or UI; use mode probe with a finite timeout for start/dev/serve scripts"
                            : "run the relevant test, build, lint, or verification command";
                        rejectFinal(
                            `required ${verificationRequirement} verification has not succeeded after the latest write`,
                            `You cannot report completion yet. The user gave an observable completion criterion. ${requiredCheck}, inspect and fix any failure, and return final only after that command succeeds. A file read or successful build alone does not prove runtime behavior. If the required finite verifier is unavailable after a grounded attempt, return final with completion_status "incomplete" and state what remains unverified.`
                        );
                        continue;
                    }
                    if (noChangeBlocker) {
                        const availableWorkspaceEvidence = Array.from(successfulWorkspaceEvidenceRefs);
                        const availableVerificationEvidence = Array.from(successfulEvidenceRefs)
                            .filter((reference) => !successfulWorkspaceEvidenceRefs.has(reference));
                        rejectFinal(
                            noChangeBlocker,
                            `You cannot claim already_satisfied or no_change_needed without citing the evidence that proves it. Cite at least one successful workspace Evidence ID${availableWorkspaceEvidence.length > 0 ? ` (${availableWorkspaceEvidence.join(", ")})` : ""}${verificationRequirement !== "none" ? ` and the successful verification Evidence ID${availableVerificationEvidence.length > 0 ? ` (${availableVerificationEvidence.join(", ")})` : ""}` : ""}. Do not refine the contract or create a cosmetic change.`
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
                    spinner.log(`[${stepStatus(turn)}] ${output}`);
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
                    spinner.log(`[${stepStatus(turn)}] ${guardDecision.message}`);
                    trace.add({ turn, status: "error", action: "repeat_quarantine", arguments: action, observation: repeatObservation });
                    trace.save();
                    const completedWrites = writtenPaths.size > 0
                        ? ` Successful writes so far: ${Array.from(writtenPaths).join(", ")}.`
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
                    const output = mcpCallsDisabled
                        ? "Blocked protocol misuse: MCP is disabled for this task because no configured server is available. Do not invoke agent action names through the shell."
                        : "Blocked protocol misuse: mcp_call_tool and mcp_list_tools are agent actions, not shell commands. Return the corresponding MCP action JSON instead.";
                    recoveryResponseFormat = recoveryFormat(["run_command", "final"]);
                    spinner.log(`[${stepStatus(turn)}] ${output}`);
                    trace.add({ turn, status: "error", action: "shell_tool_call_blocked", reason: action.reason, arguments: action, observation: output });
                    trace.save();
                    messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                    continue;
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
                    const output = "Blocked by the model-owned read-only task contract: workspace changes are outside this task. Inspect with read/list/search or return a factual final answer without mutating files.";
                    recoveryResponseFormat = getAgentReadOnlyResponseFormat(workflow.kind, readOnlyAllowsCommands);
                    spinner.log(`[${stepStatus(turn)}] ${output}`);
                    trace.add({ turn, status: "error", action: "read_only_mutation_blocked", reason: action.reason, arguments: action, observation: output });
                    trace.save();
                    messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                    continue;
                }

                if (["write_file", "edit_file", "delete_file"].includes(action.action ?? "") && action.path) {
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

                if (action.action === "run_command" && action.command) {
                    if (pendingRuntimePortCorrection) {
                        const output = `Blocked repeated runtime probe: ${pendingRuntimePortCorrection} Inspect and edit the real workspace server/client port configuration before running another command. Do not create or validate an auxiliary substitute server.`;
                        recoveryResponseFormat = recoveryFormat(["run_command", "write_file", "delete_file", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"]);
                        spinner.log(`[${stepStatus(turn)}] ${output}`);
                        trace.add({ turn, status: "error", action: "runtime_probe_blocked_pending_correction", reason: action.reason, arguments: action, observation: output });
                        trace.save();
                        messages.push({ role: "user", content: `Observation: ${JSON.stringify({ action: action.action, status: "error", output })}` });
                        continue;
                    }
                    if (pendingPackageScriptRecovery) {
                        const sameCommand = normalizeCommandSignature(action.command) === normalizeCommandSignature(pendingPackageScriptRecovery.command)
                            || packageScriptCommandsEquivalent(action.command, pendingPackageScriptRecovery.command);
                        const sameWorkdir = path.resolve(activeWorkspace, action.workdir ?? ".")
                            === path.resolve(activeWorkspace, pendingPackageScriptRecovery.workdir);
                        const correctMode = pendingPackageScriptRecovery.mode !== "probe" || action.mode === "probe";
                        if (!sameCommand || !sameWorkdir || !correctMode) {
                            const modeHint = pendingPackageScriptRecovery.mode === "probe"
                                ? ', "mode":"probe", "timeout_ms":10000'
                                : "";
                            const output = `Blocked repeated local-executable workaround: the project manifest already provides the authoritative lifecycle command. Run {"action":"run_command","command":${JSON.stringify(pendingPackageScriptRecovery.command)},"workdir":${JSON.stringify(pendingPackageScriptRecovery.workdir)}${modeHint}} before trying another command. File inspection and source corrections remain available.`;
                            recoveryResponseFormat = recoveryFormat(["read_file", "search_project", "search_files", "edit_file", "write_file", "delete_file", "run_command", "final"]);
                            spinner.log(`[${stepStatus(turn)}] ${output}`);
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
                spinner.log(agentTool.formatActionStatus(action, segmentTurn, maxTurnsPerSegment));
                spinner.update(`Executing ${action.action}...`);
                debugLog("Tool request", { turn, action });
                let result = await agentTool.execute(action);
                if (action.action === "run_command" && !result.ok && result.recommendedCommand) {
                    pendingPackageScriptRecovery = {
                        command: result.recommendedCommand,
                        workdir: result.recommendedWorkdir ?? action.workdir ?? ".",
                        ...(result.recommendedMode ? { mode: result.recommendedMode } : {})
                    };
                    recoveryResponseFormat = recoveryFormat(["read_file", "search_project", "search_files", "edit_file", "write_file", "delete_file", "run_command", "final"]);
                } else if (action.action === "run_command" && pendingPackageScriptRecovery
                    && (normalizeCommandSignature(action.command ?? "") === normalizeCommandSignature(pendingPackageScriptRecovery.command)
                        || packageScriptCommandsEquivalent(action.command ?? "", pendingPackageScriptRecovery.command))) {
                    // Once the authoritative lifecycle was actually attempted, any
                    // further failure belongs to the project rather than invocation recovery.
                    pendingPackageScriptRecovery = undefined;
                }
                if (action.action === "run_command" && !result.ok && result.failureKind === "inference_port_collision") {
                    pendingRuntimePortCorrection = "The previous runtime request reached the CLI's llama.cpp inference endpoint on the same loopback port instead of the workspace service.";
                    recoveryResponseFormat = recoveryFormat(["run_command", "write_file", "delete_file", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"]);
                }
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
                if (result.ok && ["list_files", "search_project", "search_files", "read_file"].includes(action.action ?? "")) {
                    contextInspections.push({
                        action: action.action as "list_files" | "search_project" | "search_files" | "read_file",
                        ...(action.path ? { path: action.path } : {}),
                        ...(action.query ? { query: action.query } : {})
                    });
                }
                if (action.action === "read_file" && result.ok && action.path) {
                    const resolvedReadPath = path.resolve(activeWorkspace, action.path).toLowerCase();
                    readPaths.add(resolvedReadPath);
                    if (readOnlyRequest && verificationRequirement === "none" && explicitlyRequestedFiles.length > 0
                        && explicitlyRequestedFiles.every((requestedPath) => readPaths.has(requestedPath))) {
                        recoveryResponseFormat = getAgentFinalResponseFormat();
                    }
                }
                if (action.action === "run_command" && result.ok && commandMutatesWorkspaceFiles(action.command ?? "")) {
                    guard.recordFileProgress();
                    failedCommands.clear();
                    inconclusiveVerificationBlocker = undefined;
                    unsatisfiedFinalAttempts = 0;
                    writtenPaths.add(commandCreatesWorkspaceFiles(action.command ?? "")
                        ? "[project scaffold generated by command]"
                        : "[dependency metadata updated by command]");
                    projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                    const effectiveWorkdir = action.workdir
                        ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
                    projectChecksAffectedByWorkdir(effectiveWorkdir, projectChecks).forEach((checkId: string) => {
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
                        failedCommands.clear();
                        inconclusiveVerificationBlocker = undefined;
                        unsatisfiedFinalAttempts = 0;
                        writtenPaths.add(action.path);
                        if (isVisualPresentationMutation(
                            action.path,
                            action.action === "write_file" ? action.content ?? "" : action.new_text ?? ""
                        )) visualPresentationPaths.add(action.path);
                        projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                        projectChecksAffectedByPath(action.path, projectChecks).forEach((checkId: string) => {
                            successfulProjectChecks.delete(checkId);
                            pendingProjectChecks.add(checkId);
                        });
                        result.output += `\n${formatProjectChecksPrompt(projectChecks)}`;
                        if (verificationRequirement !== "none") verificationSatisfied = false;
                        if (workflow.kind === "mcp_creation") {
                            successfulMcpDiscovery = false;
                            successfulMcpCall = false;
                        }
                        if (action.action === "edit_file" && validation.ok) pendingRuntimePortCorrection = undefined;
                    } else if (validation.ok && result.changed === false) {
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
                        readPaths.delete(path.resolve(activeWorkspace, action.path).toLowerCase());
                        guard.recordFileProgress();
                        failedCommands.clear();
                        inconclusiveVerificationBlocker = undefined;
                        unsatisfiedFinalAttempts = 0;
                        validationFailures.delete(action.path);
                        writtenPaths.add(action.path);
                        projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                        projectChecksAffectedByPath(action.path, projectChecks).forEach((checkId: string) => {
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
                if (action.action === "run_command"
                    && verificationRequirement !== "none"
                    && (
                        (result.ok && result.probeTimedOut && result.assertionPassed !== true)
                        || (!result.ok
                            && action.mode === "probe"
                            && ["runtime", "timeout", "inference_port_collision"].includes(result.failureKind ?? ""))
                    )) {
                    inconclusiveVerificationBlocker = result.output.slice(0, 2000);
                }
                if (action.action === "run_command" && !result.ok) {
                    lastFailedCommand = action.command;
                    failedCommands.record(action.command ?? "", action.workdir ?? ".", result.output);
                    unresolvedMissingCommandTarget = missingCommandTargetError(result.output);
                    const invocationFailure = commandInvocationError(result.output);
                    const effectiveWorkdir = action.workdir
                        ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
                    const failedKnownCheck = projectChecksForCommand(action.command ?? "", projectChecks, effectiveWorkdir).length > 0;
                    const failedRequiredVerification = commandSatisfiesAcceptance(
                        action.command ?? "",
                        acceptance,
                        { probe: action.mode === "probe" }
                    );
                    // A rejected command line never exercised the project. Preserve it
                    // as diagnostic feedback, but do not mistake it for failed product
                    // verification that permanently blocks completion.
                    if (!invocationFailure && (failedKnownCheck || failedRequiredVerification)) {
                        unresolvedVerificationFailure = result.output.slice(0, 2000);
                    }
                    if (invocationFailure) {
                        recoveryResponseFormat = recoveryFormat(["edit_file", "write_file", "delete_file", "final"]);
                    }
                    if (verificationRequirement !== "none") verificationSatisfied = false;
                } else if (action.action === "run_command" && result.ok) {
                    lastFailedCommand = undefined;
                    projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
                    const effectiveWorkdir = action.workdir
                        ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
                    const completedProjectChecks = projectChecksForCommand(action.command ?? "", projectChecks, effectiveWorkdir);
                    completedProjectChecks.forEach((checkId: string) => successfulProjectChecks.add(checkId));
                    const wroteInteractionTest = acceptance.evidence === "interaction"
                        && Array.from(writtenPaths).some((file) => /(?:^|[\\/])[^\\/]*(?:e2e|spec|test)\.[^\\/]+$/i.test(file));
                    const satisfiesRequiredCheck = commandSatisfiesAcceptance(
                        action.command ?? "",
                        acceptance,
                        { probe: action.mode === "probe" }
                    )
                        || (wroteInteractionTest && completedProjectChecks.length > 0 && /\btest\b/i.test(action.command ?? ""));
                    if (completedProjectChecks.length > 0) {
                        unresolvedVerificationFailure = undefined;
                        unresolvedMissingCommandTarget = false;
                    }
                    if (satisfiesRequiredCheck && result.assertionPassed !== false) {
                        verificationSatisfied = true;
                        unresolvedVerificationFailure = undefined;
                        unresolvedMissingCommandTarget = false;
                        inconclusiveVerificationBlocker = undefined;
                        unsatisfiedFinalAttempts = 0;
                    } else if (satisfiesRequiredCheck && result.assertionPassed === false) {
                        unresolvedVerificationFailure = result.output.slice(0, 2000);
                    }
                }
                const nonBlockingInvocationFailure = action.action === "run_command"
                    && !result.ok
                    && commandInvocationError(result.output);
                if (!result.ok) {
                    if (!nonBlockingInvocationFailure) {
                        unresolvedToolFailure = {
                            action: action.action ?? "unknown_action",
                            output: result.output
                        };
                    }
                } else if (["write_file", "edit_file", "delete_file", "run_command"].includes(action.action ?? "")) {
                    unresolvedToolFailure = undefined;
                }
                const observationGuardDecision = guard.recordObservation(action as Record<string, unknown>, result);
                if (result.ok && (
                    ["list_files", "search_project", "search_files", "read_file", "run_command", "mcp_list_tools", "mcp_call_tool"].includes(action.action ?? "")
                    || (["write_file", "edit_file"].includes(action.action ?? "") && result.changed === false)
                )) {
                    const evidenceRef = `evidence_${turn}_${action.action}`;
                    successfulEvidenceRefs.add(evidenceRef);
                    if (
                        ["list_files", "search_project", "search_files", "read_file"].includes(action.action ?? "")
                        || (["write_file", "edit_file"].includes(action.action ?? "") && result.changed === false)
                    ) {
                        successfulWorkspaceEvidenceRefs.add(evidenceRef);
                    }
                    result = {
                        ...result,
                        output: `${result.output}\nEvidence ID: ${evidenceRef}`
                    };
                }
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
                    urls.forEach((sourceUrl: string) => sourceUrls.add(sourceUrl));
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
            const continuationStateSatisfiedAtLimit = continuationNoWriteCompletionAllowed({
                continuation: taskContract?.continuation === true,
                evidence: Array.from(successfulEvidenceRefs),
                successfulEvidenceRefs,
                successfulWorkspaceEvidenceRefs,
                verificationRequired: verificationRequirement !== "none",
                verificationSatisfied,
                hasUnresolvedFailures: Boolean(
                    unresolvedToolFailure
                    || unresolvedVerificationFailure
                    || validationFailures.size > 0
                    || pendingProjectChecks.size > 0
                )
            });
            if (mustWrite && writtenPaths.size === 0 && satisfiedPaths.size === 0 && !continuationStateSatisfiedAtLimit) {
                toolLimitBlockers.push("no successful workspace change or already-satisfied target was recorded");
            }
            if (validationFailures.size > 0) toolLimitBlockers.push(`validation failing for ${Array.from(validationFailures).join(", ")}`);
            if (unresolvedVerificationFailure) toolLimitBlockers.push(`latest verification failed: ${unresolvedVerificationFailure}`);
            projectChecks = discoverProjectChecks(activeWorkspace, projectCheckProviders);
            if (projectRequirement) {
                const missingArtifacts = evaluateProjectCompletion(activeWorkspace, projectRequirement);
                if (missingArtifacts.length > 0) toolLimitBlockers.push(`missing project artifacts: ${missingArtifacts.join(", ")}`);
                const missingChecks = requiredProjectChecks(projectRequirement, projectChecks)
                    .filter((check: any) => !successfulProjectChecks.has(check.id));
                if (missingChecks.length > 0) {
                    toolLimitBlockers.push(`project checks not passed: ${missingChecks.map((check: any) => `${check.command} in ${check.workdir}`).join(", ")}`);
                }
            }
                const pendingChecks = projectChecks.filter((check: any) => (
                pendingProjectChecks.has(check.id) && !successfulProjectChecks.has(check.id)
            ));
            if (pendingChecks.length > 0) {
                    toolLimitBlockers.push(`checks invalidated by file changes: ${pendingChecks.map((check: any) => `${check.command} in ${check.workdir}`).join(", ")}`);
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
                const executedTurnLimit = verificationRecoveryActive ? recoveryMaxTurns : maxTurns;
                spinner.log(`[${lastExecutedTurn}/${executedTurnLimit}] Tool limit reached; task remains incomplete`);
                trace.add({
                    turn: lastExecutedTurn + 1,
                    status: "error",
                    action: "incomplete_after_tool_limit",
                    observation: toolLimitBlockers.join("; ")
                });
                trace.save();
                return { answer, trace, clarifications: clarificationTranscript };
            }

            const executedTurnLimit = verificationRecoveryActive ? recoveryMaxTurns : maxTurns;
            spinner.log(`[${lastExecutedTurn}/${executedTurnLimit}] Tool limit reached after all completion gates passed; preparing a final summary`);
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
                const response = await llmProvider.chat({
                    model,
                    messages,
                    responseFormat: agentResponseFormat,
                    sampling: actionSampling,
                    signal,
                    onRetry: (_attempt: number, errorCode: string) => {
                    spinner.update(`llama.cpp connection ${errorCode}; retrying final summary...`);
                    }
                });
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
                    turn: lastExecutedTurn + 1,
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

module.exports = { DefaultAgentRunner };
