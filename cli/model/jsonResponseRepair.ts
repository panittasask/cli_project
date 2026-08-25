const MAX_PROTOCOL_REGENERATION_ATTEMPTS = 2;
const PROTOCOL_REGENERATION_MAX_TOKENS = 4096;

type ProtocolRegenerationFailure = {
    kind: string;
    issues: string[];
    toolCallName?: string;
};

function buildProtocolRegenerationPrompt(failure: ProtocolRegenerationFailure): string {
    return [
        "Generate one new action for the original user request.",
        "Return exactly one action object accepted by the supplied response schema and nothing else.",
        "Do not quote, copy, explain, or repair the previous malformed response.",
        "Choose an action allowed by the current schema and provide every required field with a meaningful value.",
        "Do not invent missing file paths, commands, task-contract fields, or action parameters.",
        failure.toolCallName
            ? `The previous transport attempted action ${failure.toolCallName}, but choose it again only if it is still the correct action.`
            : "",
        `Previous response classification: ${failure.kind}.`,
        failure.issues.length > 0
            ? `Validation issues: ${failure.issues.slice(0, 4).join(" | ")}`
            : ""
    ].filter(Boolean).join("\n");
}

function getProtocolRegenerationSampling(sampling: Record<string, unknown>): Record<string, unknown> {
    const configuredMaxTokens = typeof sampling.max_tokens === "number" && Number.isFinite(sampling.max_tokens)
        ? Math.floor(sampling.max_tokens)
        : PROTOCOL_REGENERATION_MAX_TOKENS;
    const { reasoning: _reasoning, ...withoutReasoning } = sampling;
    return {
        ...withoutReasoning,
        temperature: 0,
        max_tokens: Math.max(256, Math.min(PROTOCOL_REGENERATION_MAX_TOKENS, configuredMaxTokens))
    };
}

module.exports = {
    MAX_PROTOCOL_REGENERATION_ATTEMPTS,
    PROTOCOL_REGENERATION_MAX_TOKENS,
    buildProtocolRegenerationPrompt,
    getProtocolRegenerationSampling
};
