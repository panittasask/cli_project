import type { AgentContext } from "../agentContext";
import type { ProjectCheck, ProjectCompletionRequirement } from "../../projectTypes";

export type CompletionDecision =
    | { status: "continue" }
    | { status: "completed"; message: string }
    | { status: "blocked"; reason: string }
    | { status: "needs_user_input"; question: string };

export type FinalAction = {
    action: "final";
    answer?: string;
    completion_status?: "completed" | "already_satisfied" | "no_change_needed" | "incomplete";
    evidence?: string[];
    reason?: string;
};

export type FinalGateDecision =
    | { status: "accepted"; answer: string }
    | { status: "rejected"; reason: string; feedback: string }
    | { status: "incomplete"; answer: string; reason: string };

export type CompletionCoordinatorServices = {
    effectiveCompletionStatus: (
        status: "completed" | "already_satisfied" | "no_change_needed" | "incomplete",
        successfulWorkspaceChanges: number
    ) => "completed" | "already_satisfied" | "no_change_needed" | "incomplete";
    continuationNoWriteCompletionAllowed: (input: {
        continuation: boolean;
        evidence: string[];
        successfulEvidenceRefs: Set<string>;
        successfulWorkspaceEvidenceRefs: Set<string>;
        verificationRequired: boolean;
        verificationSatisfied: boolean;
        hasUnresolvedFailures: boolean;
    }) => boolean;
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
    answerLooksLikeBlockingClarification: (answer: string) => boolean;
    answerDefersRequiredWork: (answer: string) => boolean;
    discoverProjectChecks: (workspace: string, providers: import("../../projectTypes").ProjectCheckProvider[]) => ProjectCheck[];
    evaluateProjectCompletion: (workspace: string, requirement: ProjectCompletionRequirement) => string[];
    requiredProjectChecks: (requirement: ProjectCompletionRequirement, checks: ProjectCheck[]) => ProjectCheck[];
    formatIncompleteTaskAnswer: (blockers: string[], writtenPaths: string[]) => string;
};

export interface CompletionCoordinator {
    resetForAction(context: AgentContext): void;
    evaluate(context: AgentContext): CompletionDecision;
    evaluateFinal(action: FinalAction, context: AgentContext): FinalGateDecision;
    evaluateAtToolLimit(context: AgentContext): string[];
    formatIncomplete(context: AgentContext, blockers: string[]): string;
}

class DefaultCompletionCoordinator implements CompletionCoordinator {
    constructor(
        private readonly workspace: string,
        private readonly projectCheckProviders: import("../../projectTypes").ProjectCheckProvider[],
        private readonly services: CompletionCoordinatorServices
    ) {}

    resetForAction(context: AgentContext): void {
        context.completion.status = "continue";
        context.completion.finalBlocked = false;
        context.completion.blockers = [];
        context.completion.reason = undefined;
    }

    evaluate(context: AgentContext): CompletionDecision {
        if (context.completion.blockers.length > 0) {
            return { status: "blocked", reason: context.completion.blockers.join("; ") };
        }
        if (context.completion.finalRequested
            && (context.verification.requirement === "none" || context.verification.satisfied)) {
            return { status: "completed", message: context.completion.reason ?? "Completed." };
        }
        return { status: "continue" };
    }

    evaluateFinal(action: FinalAction, context: AgentContext): FinalGateDecision {
        context.completion.finalRequested = true;
        const proposedAnswer = action.answer?.trim() || "Done.";
        const completionStatus = this.services.effectiveCompletionStatus(
            action.completion_status ?? "completed",
            context.workspace.writtenPaths.size
        );
        const noChangeOutcome = completionStatus === "already_satisfied"
            || completionStatus === "no_change_needed";
        const incompleteReason = context.verification.unresolvedToolFailure?.output
            || context.verification.failure
            || context.verification.inconclusiveBlocker
            || (context.workspace.validationFailures.size > 0
                ? `validation remains unresolved for ${Array.from(context.workspace.validationFailures).join(", ")}`
                : context.verification.requirement !== "none" && !context.verification.satisfied
                    ? `required ${context.verification.requirement} verification has not succeeded`
                    : undefined);

        if (completionStatus === "incomplete") {
            if (!incompleteReason) {
                return this.reject(
                    context,
                    "incomplete status requires an actual unresolved implementation, tool, validation, or verification blocker",
                    "Use completion_status incomplete only when a concrete blocker remains. Otherwise return the evidence-backed completed, already_satisfied, or no_change_needed outcome."
                );
            }
            return this.incomplete(context, proposedAnswer, incompleteReason, true);
        }

        if (incompleteReason && context.verification.inconclusiveBlocker) {
            if (context.verification.unsatisfiedFinalAttempts >= 1) {
                return this.incomplete(context, proposedAnswer, incompleteReason, false);
            }
            context.verification.unsatisfiedFinalAttempts += 1;
        }

        const hasUnresolvedFailures = Boolean(
            context.verification.unresolvedToolFailure
            || context.verification.failure
            || context.workspace.validationFailures.size > 0
            || context.workspace.pendingProjectChecks.size > 0
        );
        const continuationSatisfied = this.services.continuationNoWriteCompletionAllowed({
            continuation: context.task?.continuation === true,
            evidence: action.evidence ?? [],
            successfulEvidenceRefs: context.workspace.successfulEvidenceRefs,
            successfulWorkspaceEvidenceRefs: context.workspace.successfulWorkspaceEvidenceRefs,
            verificationRequired: context.verification.requirement !== "none",
            verificationSatisfied: context.verification.satisfied,
            hasUnresolvedFailures
        });
        const noChangeBlocker = this.services.noChangeCompletionBlockReason({
            status: completionStatus,
            evidence: action.evidence ?? [],
            successfulEvidenceRefs: context.workspace.successfulEvidenceRefs,
            successfulWorkspaceEvidenceRefs: context.workspace.successfulWorkspaceEvidenceRefs,
            workspaceChangeRequired: context.policy.mustWrite,
            verificationRequired: context.verification.requirement !== "none",
            verificationSatisfied: context.verification.satisfied,
            hasUnresolvedFailures
        });

        if (this.services.answerLooksLikeBlockingClarification(proposedAnswer)) {
            return this.reject(
                context,
                "blocking clarification must use the interactive choice action",
                "Do not return a blocking question as final. Use ask_user with 2-6 concrete choices grounded in the context you already inspected; the CLI automatically accepts a free-text answer outside those choices."
            );
        }
        if (context.verification.unresolvedToolFailure) {
            return this.reject(
                context,
                `latest ${context.verification.unresolvedToolFailure.action} action is still failing`,
                `You cannot report completion while the latest tool failure is unresolved. Inspect the error and make a concrete correction or run a successful corrective command. A read-only inspection does not clear this failure. If the implementation progress is preserved but the required verifier is unavailable after this grounded attempt, return final with completion_status "incomplete" and describe the exact unverified criterion. Failure evidence: ${context.verification.unresolvedToolFailure.output.slice(0, 1400)}`
            );
        }
        if (context.task?.continuation && context.verification.requirement !== "none" && !context.verification.satisfied) {
            return this.reject(
                context,
                `required ${context.verification.requirement} verification has not succeeded for this continuation`,
                `You cannot report completion yet. ${this.requiredCheck(context)}. A successful build, typecheck, or file read alone does not prove runtime behavior. Continue the current contract; do not use refine_task merely to remove continuation or weaken its evidence requirement. If no finite verifier is available after a grounded attempt, return final with completion_status "incomplete" instead of changing unrelated configuration or substituting another service.`
            );
        }
        if (context.policy.mustWrite
            && context.workspace.writtenPaths.size === 0
            && context.workspace.satisfiedPaths.size === 0
            && !noChangeOutcome
            && !continuationSatisfied) {
            return this.reject(
                context,
                "this request requires a successful file write",
                context.task?.continuation
                    ? "This is continuation work. If current workspace evidence proves the prior edits already satisfy the task, run every required verification and return final citing both workspace and verification Evidence IDs; do not create a cosmetic change. Otherwise use edit_file or write_file for the real remaining correction."
                    : "You cannot return final yet. The user requested a file change, but no file has been changed. Use edit_file for an existing file or write_file for a new file, then verify the result before returning final."
            );
        }
        if (context.task?.evidence_requirements.includes("visual")
            && context.workspace.visualPresentationPaths.size === 0
            && !noChangeOutcome
            && !continuationSatisfied) {
            return this.reject(
                context,
                "visual presentation work has no successful styling mutation",
                "You cannot return final yet. The current task contract requires a rendered visual result, but no stylesheet or concrete embedded-style mutation succeeded. If successful workspace inspection proves the initial visual requirement was incorrect, use refine_task with those exact Evidence IDs while preserving task type and write scope. Otherwise inspect the styling owner, implement the visual styling, and run finite interaction verification."
            );
        }
        if (context.workspace.validationFailures.size > 0) {
            const failed = Array.from(context.workspace.validationFailures).join(", ");
            return this.reject(
                context,
                `validation still failing for ${failed}`,
                `You cannot return final yet. Validation is failing for: ${failed}. Inspect the error, fix the file, and validate again.`
            );
        }

        context.workspace.projectChecks = this.services.discoverProjectChecks(this.workspace, this.projectCheckProviders);
        if (context.workspace.projectRequirement) {
            const missingArtifacts = this.services.evaluateProjectCompletion(this.workspace, context.workspace.projectRequirement);
            if (missingArtifacts.length > 0) {
                return this.reject(
                    context,
                    `project completion profile is missing: ${missingArtifacts.join(", ")}`,
                    `You cannot return final yet. The requested ${context.workspace.projectRequirement.label} is incomplete. Missing: ${missingArtifacts.join(", ")}. Implement these items, then run the required checks. Do not return a starter scaffold or tell the user to expand it later.`
                );
            }
            const missingChecks = this.services.requiredProjectChecks(context.workspace.projectRequirement, context.workspace.projectChecks)
                .filter((check) => !context.workspace.successfulProjectChecks.has(check.id));
            if (missingChecks.length > 0) {
                const descriptions = missingChecks.map((check) => `${check.command} (workdir ${check.workdir})`);
                return this.reject(
                    context,
                    `required project checks have not succeeded: ${descriptions.join(", ")}`,
                    `You cannot return final yet. Run successful verification for: ${descriptions.join(", ")}. Use run_command.workdir exactly as discovered from each project manifest.`
                );
            }
        }
        const pendingChecks = context.workspace.projectChecks.filter((check) => (
            context.workspace.pendingProjectChecks.has(check.id)
            && !context.workspace.successfulProjectChecks.has(check.id)
        ));
        if (pendingChecks.length > 0) {
            const descriptions = pendingChecks.map((check) => `${check.command} (workdir ${check.workdir})`);
            return this.reject(
                context,
                `checks affected by the latest changes have not succeeded: ${descriptions.join(", ")}`,
                `You cannot return final yet. The latest file changes invalidated these manifest-discovered checks: ${descriptions.join(", ")}. Run each command in its discovered workdir; do not substitute an unrelated verification command.`
            );
        }
        if (context.verification.failure) {
            return this.reject(
                context,
                "the latest verification command failed",
                `You cannot report verified success yet because the latest verification command failed: ${context.verification.failure}. Inspect the error and run an OS-compatible verification command successfully. A read_file or search_files action can diagnose the problem but does not clear the failed verification. Do not assume a localhost server exists.`
            );
        }
        if (context.workspace.projectRequirement && this.services.answerDefersRequiredWork(proposedAnswer)) {
            return this.reject(
                context,
                "the answer describes a starter scaffold or defers required work",
                "Do not return a partial scaffold or ask the user to expand it later. Finish the requested implementation and checks, then summarize concrete completed behavior."
            );
        }
        if (!context.verification.satisfied && context.verification.requirement !== "none") {
            return this.reject(
                context,
                `required ${context.verification.requirement} verification has not succeeded after the latest write`,
                `You cannot report completion yet. The user gave an observable completion criterion. ${this.requiredCheck(context)}, inspect and fix any failure, and return final only after that command succeeds. A file read or successful build alone does not prove runtime behavior. If the required finite verifier is unavailable after a grounded attempt, return final with completion_status "incomplete" and state what remains unverified.`
            );
        }
        if (noChangeBlocker) {
            const workspaceEvidence = Array.from(context.workspace.successfulWorkspaceEvidenceRefs);
            const verificationEvidence = Array.from(context.workspace.successfulEvidenceRefs)
                .filter((reference) => !context.workspace.successfulWorkspaceEvidenceRefs.has(reference));
            return this.reject(
                context,
                noChangeBlocker,
                `You cannot claim already_satisfied or no_change_needed without citing the evidence that proves it. Cite at least one successful workspace Evidence ID${workspaceEvidence.length > 0 ? ` (${workspaceEvidence.join(", ")})` : ""}${context.verification.requirement !== "none" ? ` and the successful verification Evidence ID${verificationEvidence.length > 0 ? ` (${verificationEvidence.join(", ")})` : ""}` : ""}. Do not refine the contract or create a cosmetic change.`
            );
        }
        if (context.workflow.kind === "web_research"
            && !context.research.mcpCallsDisabled
            && !context.research.webResearchExhausted
            && context.research.sourceUrls.size < 2) {
            return this.reject(
                context,
                "web research needs at least two relevant source URLs",
                "You cannot return final yet. Web research requires at least two relevant source URLs from successful MCP observations. Refine the web query; do not use search_files."
            );
        }
        if (context.workflow.kind === "mcp_creation"
            && context.workspace.writtenPaths.size > 0
            && (!context.research.successfulMcpDiscovery || !context.research.successfulMcpCall)) {
            return this.reject(
                context,
                "MCP discovery and a successful tool call are required",
                "You cannot claim MCP completion yet. Run mcp_list_tools and one relevant mcp_call_tool successfully after implementation."
            );
        }

        const missingSources = Array.from(context.research.sourceUrls)
            .filter((sourceUrl) => !proposedAnswer.includes(sourceUrl));
        const answer = missingSources.length === 0
            ? proposedAnswer
            : `${proposedAnswer}\n\nSources:\n${missingSources.slice(0, 5).map((sourceUrl) => `- ${sourceUrl}`).join("\n")}`;
        context.completion.status = "completed";
        context.completion.finalBlocked = false;
        context.completion.blockers = [];
        context.completion.reason = answer;
        return { status: "accepted", answer };
    }

    evaluateAtToolLimit(context: AgentContext): string[] {
        const blockers: string[] = [];
        const continuationSatisfied = this.services.continuationNoWriteCompletionAllowed({
            continuation: context.task?.continuation === true,
            evidence: Array.from(context.workspace.successfulEvidenceRefs),
            successfulEvidenceRefs: context.workspace.successfulEvidenceRefs,
            successfulWorkspaceEvidenceRefs: context.workspace.successfulWorkspaceEvidenceRefs,
            verificationRequired: context.verification.requirement !== "none",
            verificationSatisfied: context.verification.satisfied,
            hasUnresolvedFailures: Boolean(
                context.verification.unresolvedToolFailure
                || context.verification.failure
                || context.workspace.validationFailures.size > 0
                || context.workspace.pendingProjectChecks.size > 0
            )
        });
        if (context.policy.mustWrite
            && context.workspace.writtenPaths.size === 0
            && context.workspace.satisfiedPaths.size === 0
            && !continuationSatisfied) {
            blockers.push("no successful workspace change or already-satisfied target was recorded");
        }
        if (context.workspace.validationFailures.size > 0) {
            blockers.push(`validation failing for ${Array.from(context.workspace.validationFailures).join(", ")}`);
        }
        if (context.verification.failure) blockers.push(`latest verification failed: ${context.verification.failure}`);
        context.workspace.projectChecks = this.services.discoverProjectChecks(this.workspace, this.projectCheckProviders);
        if (context.workspace.projectRequirement) {
            const missingArtifacts = this.services.evaluateProjectCompletion(this.workspace, context.workspace.projectRequirement);
            if (missingArtifacts.length > 0) blockers.push(`missing project artifacts: ${missingArtifacts.join(", ")}`);
            const missingChecks = this.services.requiredProjectChecks(context.workspace.projectRequirement, context.workspace.projectChecks)
                .filter((check) => !context.workspace.successfulProjectChecks.has(check.id));
            if (missingChecks.length > 0) blockers.push(`project checks not passed: ${missingChecks.map((check) => `${check.command} in ${check.workdir}`).join(", ")}`);
        }
        const pendingChecks = context.workspace.projectChecks.filter((check) => (
            context.workspace.pendingProjectChecks.has(check.id)
            && !context.workspace.successfulProjectChecks.has(check.id)
        ));
        if (pendingChecks.length > 0) blockers.push(`checks invalidated by file changes: ${pendingChecks.map((check) => `${check.command} in ${check.workdir}`).join(", ")}`);
        if (context.verification.requirement !== "none" && !context.verification.satisfied) {
            blockers.push(`${context.verification.requirement} verification not satisfied`);
        }
        if (context.workflow.kind === "web_research"
            && !context.research.mcpCallsDisabled
            && !context.research.webResearchExhausted
            && context.research.sourceUrls.size < 2) {
            blockers.push("fewer than two web source URLs were collected");
        }
        if (context.workflow.kind === "mcp_creation"
            && context.workspace.writtenPaths.size > 0
            && (!context.research.successfulMcpDiscovery || !context.research.successfulMcpCall)) {
            blockers.push("MCP discovery and a successful tool call were not completed");
        }
        context.completion.status = blockers.length > 0 ? "blocked" : "continue";
        context.completion.blockers = [...blockers];
        context.completion.reason = blockers.join("; ") || undefined;
        return blockers;
    }

    formatIncomplete(context: AgentContext, blockers: string[]): string {
        return this.services.formatIncompleteTaskAnswer(
            blockers,
            Array.from(context.workspace.writtenPaths)
        );
    }

    private requiredCheck(context: AgentContext): string {
        if (context.verification.requirement === "runtime") {
            return context.policy.acceptance.evidence === "interaction"
                ? "run a finite automated interaction test that performs the action and asserts the resulting state"
                : "run the manifest-defined runtime lifecycle or an OS-compatible probe of the requested URL, endpoint, server, or UI; use mode probe with a finite timeout for start/dev/serve scripts";
        }
        return "run the relevant test, build, lint, or verification command";
    }

    private reject(context: AgentContext, reason: string, feedback: string): FinalGateDecision {
        context.completion.status = "blocked";
        context.completion.finalBlocked = true;
        context.completion.reason = reason;
        context.completion.blockers = [reason];
        return { status: "rejected", reason, feedback };
    }

    private incomplete(context: AgentContext, proposedAnswer: string, reason: string, useProposedAnswer: boolean): FinalGateDecision {
        const conciseReason = reason.replace(/\s+/g, " ").trim().slice(0, 1200);
        const answer = useProposedAnswer
            ? `Status: incomplete.\n\n${proposedAnswer}\n\nUnverified requirement: ${conciseReason}`
            : `Status: incomplete.\n\nWorkspace changes remain in place, but the required verification could not be completed. ${conciseReason}\n\nThe CLI stopped recovery instead of continuing an unproductive verification loop.`;
        context.completion.status = "blocked";
        context.completion.finalBlocked = false;
        context.completion.reason = conciseReason;
        context.completion.blockers = [conciseReason];
        return { status: "incomplete", answer, reason: conciseReason };
    }
}

module.exports = { DefaultCompletionCoordinator };
