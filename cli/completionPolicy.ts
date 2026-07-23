type CompletionStatus = "completed" | "already_satisfied" | "no_change_needed";

type NoChangeCompletionInput = {
    status: CompletionStatus;
    evidence: string[];
    successfulEvidenceRefs: Set<string>;
    successfulWorkspaceEvidenceRefs: Set<string>;
    workspaceChangeRequired: boolean;
    verificationRequired: boolean;
    verificationSatisfied: boolean;
    hasUnresolvedFailures: boolean;
};

class CompletionBlockerTracker {
    private readonly counts = new Map<string, number>();

    constructor(readonly limit: number) {}

    record(summary: string): { count: number; shouldStop: boolean } {
        const count = (this.counts.get(summary) ?? 0) + 1;
        this.counts.set(summary, count);
        return { count, shouldStop: count >= this.limit };
    }
}

function effectiveCompletionStatus(status: CompletionStatus, successfulWorkspaceChanges: number): CompletionStatus {
    // Once this task has actually changed workspace state, a local model using
    // "already_satisfied" is a labeling mistake rather than a no-change claim.
    // The host still applies every validation and verification gate.
    return successfulWorkspaceChanges > 0 ? "completed" : status;
}

function noChangeCompletionBlockReason(input: NoChangeCompletionInput): string | undefined {
    if (input.status === "completed") return undefined;
    if (input.hasUnresolvedFailures) {
        return "a no-change outcome cannot be accepted while a tool, validation, or verification failure is unresolved";
    }
    const citedSuccessfulEvidence = input.evidence.some((reference) => input.successfulEvidenceRefs.has(reference));
    if (!citedSuccessfulEvidence) {
        return "a no-change outcome must cite at least one successful host-issued evidence ID";
    }
    if (input.workspaceChangeRequired
        && !input.evidence.some((reference) => input.successfulWorkspaceEvidenceRefs.has(reference))) {
        return "a no-change outcome for a workspace-change request requires cited workspace inspection or no-op evidence";
    }
    if (input.verificationRequired && !input.verificationSatisfied) {
        return "a no-change outcome has not satisfied the task's required verification";
    }
    return undefined;
}

module.exports = { CompletionBlockerTracker, effectiveCompletionStatus, noChangeCompletionBlockReason };
