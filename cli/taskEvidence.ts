type TaskEvidenceRequirement = "source" | "command" | "runtime" | "interaction" | "visual";
type VerificationRequirement = "none" | "command" | "runtime";
type AcceptanceEvidence = "source" | "command" | "runtime" | "interaction";

type TaskEvidencePolicy = {
    evidence: AcceptanceEvidence;
    verification: VerificationRequirement;
    visualPresentation: boolean;
};

type ComparableTaskContract = {
    intent: string;
    task_type: string;
    continuation: boolean;
    requires_workspace_changes: boolean;
    verification: string;
    evidence_requirements: string[];
    success_criteria: string[];
};

function deriveTaskEvidencePolicy(
    requirements: TaskEvidenceRequirement[],
    declaredVerification: "none" | "command" | "runtime" | "interaction"
): TaskEvidencePolicy {
    const required = new Set(requirements);
    const visualPresentation = required.has("visual");
    if (required.has("interaction") || visualPresentation) {
        return { evidence: "interaction", verification: "runtime", visualPresentation };
    }
    if (required.has("runtime")) {
        return { evidence: "runtime", verification: "runtime", visualPresentation };
    }
    if (required.has("command")) {
        return { evidence: "command", verification: "command", visualPresentation };
    }
    // evidence_requirements is the model's explicit list of proof required by
    // the outcome, so it is authoritative when the redundant scalar
    // verification field disagrees. Retain the scalar only as a defensive
    // fallback for callers outside the schema that provide no requirements.
    if (required.size === 0 && declaredVerification === "interaction") {
        return { evidence: "interaction", verification: "runtime", visualPresentation };
    }
    if (required.size === 0 && declaredVerification === "runtime") {
        return { evidence: "runtime", verification: "runtime", visualPresentation };
    }
    if (required.size === 0 && declaredVerification === "command") {
        return { evidence: "command", verification: "command", visualPresentation };
    }
    return { evidence: "source", verification: "none", visualPresentation };
}

function isVisualPresentationMutation(filePath: string, replacementText = ""): boolean {
    if (/\.(?:css|scss|sass|less|styl)$/i.test(filePath)) return true;
    if (!/\.(?:html|tsx|jsx|vue|svelte|ts|js)$/i.test(filePath)) return false;
    return /<style\b|\bstyle\s*=|\bstyles?\s*:\s*(?:\[|`|'|")|\bstyled(?:\.\w+|\s*\()|\bcss\s*`/i.test(replacementText);
}

function taskContractsEquivalent(left: ComparableTaskContract, right: ComparableTaskContract): boolean {
    const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");
    const normalizeList = (values: string[]): string[] => (
        Array.from(new Set(values.map(normalizeText))).sort((a, b) => a.localeCompare(b))
    );
    return normalizeText(left.intent) === normalizeText(right.intent)
        && left.task_type === right.task_type
        && left.continuation === right.continuation
        && left.requires_workspace_changes === right.requires_workspace_changes
        && left.verification === right.verification
        && JSON.stringify(normalizeList(left.evidence_requirements)) === JSON.stringify(normalizeList(right.evidence_requirements))
        && JSON.stringify(normalizeList(left.success_criteria)) === JSON.stringify(normalizeList(right.success_criteria));
}

module.exports = {
    deriveTaskEvidencePolicy,
    isVisualPresentationMutation,
    taskContractsEquivalent
};
