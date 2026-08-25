export type ModelCapabilities = {
    nativeTools: boolean;
    toolChoice: boolean;
    structuredOutput: boolean;
    strictSchema: boolean;
    constrainedGeneration: boolean;
    responseHealing: boolean;
};

export type ModelProtocol = "native_tools" | "structured_output" | "constrained_json" | "plain_json";

function resolveModelCapabilities(
    provider: "llama.cpp" | "openrouter",
    configured: Partial<ModelCapabilities> = {}
): ModelCapabilities {
    const defaults: ModelCapabilities = provider === "openrouter"
        ? {
            nativeTools: false,
            toolChoice: false,
            structuredOutput: true,
            strictSchema: false,
            constrainedGeneration: false,
            responseHealing: true
        }
        : {
            nativeTools: false,
            toolChoice: false,
            structuredOutput: false,
            strictSchema: false,
            constrainedGeneration: true,
            responseHealing: false
        };
    return { ...defaults, ...configured };
}

function selectModelProtocol(capabilities: ModelCapabilities): ModelProtocol {
    if (capabilities.nativeTools) return "native_tools";
    if (capabilities.structuredOutput) return "structured_output";
    if (capabilities.constrainedGeneration) return "constrained_json";
    return "plain_json";
}

module.exports = { resolveModelCapabilities, selectModelProtocol };
