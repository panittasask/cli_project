import type { AgentAction } from "../schema/agentAction.schema";
import type { AgentToolResult } from "../agentSchema";
import type { AgentContext } from "../agentContext";
import type { AgentEventSink } from "../agentEvents";
import type { ProjectCheck } from "../../projectTypes";

export type VerificationResult = {
    required: boolean;
    success: boolean;
    attempted: boolean;
    reason?: string;
};

export type VerificationCoordinatorServices = {
    events: AgentEventSink;
    commandInvocationError: (output: string) => boolean;
    commandMutatesWorkspaceFiles: (command: string) => boolean;
    missingCommandTargetError: (output: string) => boolean;
    commandSatisfiesAcceptance: (
        command: string,
        acceptance: AgentContext["policy"]["acceptance"],
        options?: { probe?: boolean }
    ) => boolean;
    projectChecksForCommand: (command: string, checks: ProjectCheck[], workdir?: string) => string[];
};

export interface VerificationCoordinator {
    observeAction(action: AgentAction, result: AgentToolResult, context: AgentContext): void;
    evaluate(context: AgentContext): VerificationResult;
    recover(context: AgentContext): boolean;
}

class DefaultVerificationCoordinator implements VerificationCoordinator {
    constructor(private readonly services: VerificationCoordinatorServices) {}

    observeAction(action: AgentAction, result: AgentToolResult, context: AgentContext): void {
        const requirement = context.verification.requirement;
        const isCommand = action.action === "run_command";
        const isMutation = ["write_file", "edit_file", "delete_file"].includes(action.action);
        const changesWorkspace = result.ok && (
            (isMutation && result.changed !== false)
            || (isCommand && this.services.commandMutatesWorkspaceFiles(action.command ?? ""))
        );

        if (changesWorkspace && requirement !== "none") {
            context.verification.satisfied = false;
            context.verification.failure = undefined;
            context.verification.inconclusiveBlocker = undefined;
            context.verification.unsatisfiedFinalAttempts = 0;
        }

        const invocationFailure = isCommand && !result.ok && this.services.commandInvocationError(result.output);
        if (!result.ok && !invocationFailure) {
            context.verification.unresolvedToolFailure = {
                action: action.action,
                output: result.output
            };
        } else if (result.ok && (isMutation || isCommand)) {
            context.verification.unresolvedToolFailure = undefined;
        }

        if (!isCommand || requirement === "none") {
            this.recordEvidence(action, result, context);
            return;
        }

        context.verification.attempted = true;
        this.services.events.emit({ type: "verification_started" });

        const effectiveWorkdir = action.workdir
            ?? result.output.match(/\[Auto-selected workdir: (.+)]/)?.[1];
        const completedChecks = result.ok
            ? this.services.projectChecksForCommand(
                action.command ?? "",
                context.workspace.projectChecks,
                effectiveWorkdir
            )
            : [];
        completedChecks.forEach((checkId) => context.workspace.successfulProjectChecks.add(checkId));

        if ((result.ok && result.probeTimedOut && result.assertionPassed !== true)
            || (!result.ok
                && action.mode === "probe"
                && ["runtime", "timeout", "inference_port_collision"].includes(result.failureKind ?? ""))) {
            context.verification.inconclusiveBlocker = result.output.slice(0, 2000);
        }

        if (!result.ok) {
            context.verification.lastFailedCommand = action.command;
            context.verification.unresolvedMissingCommandTarget = this.services.missingCommandTargetError(result.output);
            const invocationFailure = this.services.commandInvocationError(result.output);
            const knownProjectCheck = this.services.projectChecksForCommand(
                action.command ?? "",
                context.workspace.projectChecks,
                effectiveWorkdir
            ).length > 0;
            const requiredVerification = this.services.commandSatisfiesAcceptance(
                action.command ?? "",
                context.policy.acceptance,
                { probe: action.mode === "probe" }
            );
            if (!invocationFailure && (knownProjectCheck || requiredVerification)) {
                context.verification.failure = result.output.slice(0, 2000);
            }
            context.verification.satisfied = false;
            this.recordEvidence(action, result, context);
            this.services.events.emit({ type: "verification_completed", success: false });
            return;
        }

        context.verification.lastFailedCommand = undefined;
        if (completedChecks.length > 0) {
            context.verification.failure = undefined;
            context.verification.unresolvedMissingCommandTarget = false;
        }

        const wroteInteractionTest = context.policy.acceptance.evidence === "interaction"
            && Array.from(context.workspace.writtenPaths).some((file) => /(?:^|[\\/])[^\\/]*(?:e2e|spec|test)\.[^\\/]+$/i.test(file));
        const satisfiesRequiredCheck = this.services.commandSatisfiesAcceptance(
            action.command ?? "",
            context.policy.acceptance,
            { probe: action.mode === "probe" }
        ) || (wroteInteractionTest && completedChecks.length > 0 && /\btest\b/i.test(action.command ?? ""));

        if (satisfiesRequiredCheck && result.assertionPassed !== false) {
            context.verification.satisfied = true;
            context.verification.failure = undefined;
            context.verification.unresolvedMissingCommandTarget = false;
            context.verification.inconclusiveBlocker = undefined;
            context.verification.unsatisfiedFinalAttempts = 0;
        } else if (satisfiesRequiredCheck && result.assertionPassed === false) {
            context.verification.satisfied = false;
            context.verification.failure = result.output.slice(0, 2000);
        }

        if (result.probeTimedOut && result.assertionPassed !== true) {
            context.verification.inconclusiveBlocker = result.output.slice(0, 2000);
        }
        this.recordEvidence(action, result, context);
        this.services.events.emit({
            type: "verification_completed",
            success: result.assertionPassed !== false && (satisfiesRequiredCheck || completedChecks.length > 0)
        });
    }

    evaluate(context: AgentContext): VerificationResult {
        if (context.verification.requirement === "none") {
            return { required: false, success: true, attempted: false };
        }
        return {
            required: true,
            success: context.verification.satisfied,
            attempted: context.verification.attempted,
            ...(context.verification.failure ? { reason: context.verification.failure } : {})
        };
    }

    recover(context: AgentContext): boolean {
        const verification = this.evaluate(context);
        if (!verification.required || verification.success) return false;
        context.verification.recoveryAttempts += 1;
        context.verification.recoveryActive = true;
        return true;
    }

    private recordEvidence(action: AgentAction, result: AgentToolResult, context: AgentContext): void {
        const evidenceEligible = result.ok && (
            ["list_files", "search_project", "search_files", "read_file", "run_command", "mcp_list_tools", "mcp_call_tool"].includes(action.action)
            || (["write_file", "edit_file"].includes(action.action) && result.changed === false)
        );
        if (!evidenceEligible) return;

        const evidenceRef = `evidence_${context.turn}_${action.action}`;
        context.workspace.successfulEvidenceRefs.add(evidenceRef);
        context.evidence.push(evidenceRef);
        const workspaceEvidence = ["list_files", "search_project", "search_files", "read_file"].includes(action.action)
            || (["write_file", "edit_file"].includes(action.action) && result.changed === false);
        if (workspaceEvidence) context.workspace.successfulWorkspaceEvidenceRefs.add(evidenceRef);
        result.output = `${result.output}\nEvidence ID: ${evidenceRef}`;
    }
}

module.exports = { DefaultVerificationCoordinator };
