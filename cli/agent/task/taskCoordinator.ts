import type { AgentTaskContract } from "../schema/taskContract.schema";

type TaskEvidencePolicy = {
    evidence: "source" | "command" | "runtime" | "interaction";
    verification: "none" | "command" | "runtime";
    visualPresentation: boolean;
};

type TaskPolicyPort = {
    deriveTaskEvidencePolicy: (
        requirements: AgentTaskContract["evidence_requirements"],
        verification: AgentTaskContract["verification"]
    ) => TaskEvidencePolicy;
    taskContractsEquivalent: (left: AgentTaskContract, right: AgentTaskContract) => boolean;
};

export type PreparedAgentTask = {
    contract: AgentTaskContract;
    readOnly: boolean;
    mustWrite: boolean;
    acceptance: {
        evidence: TaskEvidencePolicy["evidence"];
        verification: TaskEvidencePolicy["verification"];
        reason: string;
    };
    readOnlyAllowsCommands: boolean;
    verificationSatisfied: boolean;
};

export type TaskRefinementCheck =
    | { accepted: true }
    | { accepted: false; reason: string };

export interface TaskCoordinator {
    prepare(contract: AgentTaskContract, reasonPrefix?: string): PreparedAgentTask;
    validateRefinement(
        current: AgentTaskContract | undefined,
        proposed: AgentTaskContract | undefined,
        evidence: string[],
        successfulWorkspaceEvidence: Set<string>
    ): TaskRefinementCheck;
}

class DefaultTaskCoordinator implements TaskCoordinator {
    constructor(private readonly policy: TaskPolicyPort) {}

    prepare(contract: AgentTaskContract, reasonPrefix = "Defined by the model from the user goal"): PreparedAgentTask {
        const evidencePolicy = this.policy.deriveTaskEvidencePolicy(
            contract.evidence_requirements,
            contract.verification
        );
        const readOnly = !contract.requires_workspace_changes;
        return {
            contract,
            readOnly,
            mustWrite: contract.requires_workspace_changes,
            acceptance: {
                evidence: evidencePolicy.evidence,
                verification: evidencePolicy.verification,
                reason: `${reasonPrefix}: ${contract.success_criteria.join("; ")}`
            },
            readOnlyAllowsCommands: evidencePolicy.verification !== "none",
            verificationSatisfied: evidencePolicy.verification === "none"
        };
    }

    validateRefinement(
        current: AgentTaskContract | undefined,
        proposed: AgentTaskContract | undefined,
        evidence: string[],
        successfulWorkspaceEvidence: Set<string>
    ): TaskRefinementCheck {
        const invalidEvidence = evidence.filter((evidenceId) => !successfulWorkspaceEvidence.has(evidenceId));
        const scopeChanged = !current
            || !proposed
            || proposed.task_type !== current.task_type
            || proposed.requires_workspace_changes !== current.requires_workspace_changes
            || proposed.continuation !== current.continuation;
        const unchangedContract = Boolean(current && proposed && this.policy.taskContractsEquivalent(current, proposed));
        if (!proposed || evidence.length === 0 || invalidEvidence.length > 0 || scopeChanged || unchangedContract) {
            const reasons = [
                !proposed ? "a complete refined task contract is required" : "",
                evidence.length === 0 ? "at least one successful workspace Evidence ID is required" : "",
                invalidEvidence.length > 0 ? `unknown or non-workspace evidence: ${invalidEvidence.join(", ")}` : "",
                scopeChanged ? "task_type, continuation, and requires_workspace_changes cannot change during refinement" : "",
                unchangedContract ? "the proposed contract is equivalent to the current contract and makes no refinement" : ""
            ].filter(Boolean);
            return { accepted: false, reason: `Task contract refinement rejected: ${reasons.join("; ")}.` };
        }
        return { accepted: true };
    }
}

module.exports = { DefaultTaskCoordinator };
