type ResponseFormat = Record<string, unknown>;
type Sampling = Record<string, unknown>;
type ChatRequest = {
    model: string;
    messages: unknown[];
    sampling?: Sampling | undefined;
};

function normalizeOpenRouterResponseFormat(
    responseFormat: ResponseFormat | undefined,
    strictSchema = false
): ResponseFormat | undefined {
    if (!responseFormat) return undefined;

    // The local llama.cpp endpoint accepts the schema alongside json_object,
    // while OpenRouter expects the schema in a separate json_schema envelope.
    // Send the schema even when strict mode is disabled so compatible endpoints
    // can constrain generation; host-side admission remains authoritative.
    if (responseFormat.type === "json_object") {
        if (responseFormat.schema && typeof responseFormat.schema === "object") {
            return {
                type: "json_schema",
                json_schema: {
                    name: "agent_action",
                    strict: strictSchema,
                    schema: responseFormat.schema
                }
            };
        }
        return { type: "json_object" };
    }
    return responseFormat;
}

function normalizeOpenRouterSampling(sampling: Sampling | undefined): Sampling | undefined {
    if (!sampling) return undefined;

    // repeat_penalty is a llama.cpp setting. OpenRouter exposes a similarly
    // named repetition_penalty parameter, but model support is optional.
    // Omitting it keeps the request valid across OpenRouter models;
    // temperature/top_p/top_k remain supported.
    const { repeat_penalty: _repeatPenalty, ...rest } = sampling;
    return rest;
}

function buildOpenRouterFallbackPayload(request: ChatRequest): Record<string, unknown> {
    const safeSampling: Sampling = {};
    for (const field of ["temperature", "top_p", "max_tokens"] as const) {
        const value = request.sampling?.[field];
        if (value !== undefined) safeSampling[field] = value;
    }
    return {
        model: request.model,
        messages: request.messages,
        ...safeSampling
    };
}

module.exports = {
    buildOpenRouterFallbackPayload,
    normalizeOpenRouterResponseFormat,
    normalizeOpenRouterSampling
};
