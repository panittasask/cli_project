const REASONING_ONLY_PARSE_ERROR = "reasoning-only model response reached completion limit before action JSON";
const MAX_REASONING_ONLY_RETRIES = 2;

type ModelResponseShape = {
    content: unknown;
    reasoningContent: unknown;
    finishReason: unknown;
};

function isReasoningOnlyTruncation(response: ModelResponseShape): boolean {
    const content = typeof response.content === "string" ? response.content.trim() : "";
    const reasoning = typeof response.reasoningContent === "string" ? response.reasoningContent.trim() : "";
    return !content && reasoning.length > 0 && response.finishReason === "length";
}

function reasoningOnlyRetryMaxTokens(configuredMaxTokens: number): number {
    const configured = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
        ? Math.floor(configuredMaxTokens)
        : 2048;
    // A retry should force a compact action, not grant the model a larger
    // reasoning allowance after it already consumed the original one.
    return Math.min(4096, Math.max(1024, configured));
}

function formatReasoningOnlyRecoveryPrompt(attempt: number): string {
    return [
        `Recovery attempt ${attempt}/${MAX_REASONING_ONLY_RETRIES}: the previous response used its entire output allowance for internal reasoning and emitted no action JSON.`,
        "Keep internal reasoning minimal on this retry and emit exactly one compact JSON action immediately.",
        "Do not explain the action outside the JSON object. Choose the smallest useful next action from the current response schema.",
        "If a file change would be large, prefer one small edit_file replacement after reading the current file."
    ].join(" ");
}

module.exports = {
    MAX_REASONING_ONLY_RETRIES,
    REASONING_ONLY_PARSE_ERROR,
    formatReasoningOnlyRecoveryPrompt,
    isReasoningOnlyTruncation,
    reasoningOnlyRetryMaxTokens
};
