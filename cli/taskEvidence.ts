type TaskEvidenceRequirement = "source" | "command" | "runtime" | "interaction" | "visual";
type VerificationRequirement = "none" | "command" | "runtime";
type AcceptanceEvidence = "source" | "command" | "runtime" | "interaction";

type TaskEvidencePolicy = {
    evidence: AcceptanceEvidence;
    verification: VerificationRequirement;
    visualPresentation: boolean;
};

function deriveTaskEvidencePolicy(
    requirements: TaskEvidenceRequirement[],
    declaredVerification: "none" | "command" | "runtime" | "interaction"
): TaskEvidencePolicy {
    const required = new Set(requirements);
    const visualPresentation = required.has("visual");
    if (required.has("interaction") || visualPresentation || declaredVerification === "interaction") {
        return { evidence: "interaction", verification: "runtime", visualPresentation };
    }
    if (required.has("runtime") || declaredVerification === "runtime") {
        return { evidence: "runtime", verification: "runtime", visualPresentation };
    }
    if (required.has("command") || declaredVerification === "command") {
        return { evidence: "command", verification: "command", visualPresentation };
    }
    return { evidence: "source", verification: "none", visualPresentation };
}

function isVisualPresentationMutation(filePath: string, replacementText = ""): boolean {
    if (/\.(?:css|scss|sass|less|styl)$/i.test(filePath)) return true;
    if (!/\.(?:html|tsx|jsx|vue|svelte|ts|js)$/i.test(filePath)) return false;
    return /<style\b|\bstyle\s*=|\bstyles?\s*:\s*(?:\[|`|'|")|\bstyled(?:\.\w+|\s*\()|\bcss\s*`/i.test(replacementText);
}

module.exports = {
    deriveTaskEvidencePolicy,
    isVisualPresentationMutation
};
