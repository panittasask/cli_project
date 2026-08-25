export type LLMMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: unknown;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
};

export type LLMRequest = {
    model: string;
    messages: LLMMessage[];
    responseFormat?: Record<string, unknown>;
    allowNativeTools?: boolean;
    sampling?: Record<string, unknown>;
    tools?: Array<Record<string, unknown>>;
    toolChoice?: "auto" | "none" | "required";
    signal?: AbortSignal;
    onRetry?: (attempt: number, errorCode: string) => void;
};

export type LLMResponse = {
    content: string;
    rawProviderContent?: string;
    toolCall?: {
        id: string;
        name: string;
        arguments: string;
    };
    data?: any;
    reasoningContent?: unknown;
    finishReason?: unknown;
    usage?: unknown;
    timings?: unknown;
    transportMeta?: {
        provider: "llama.cpp" | "openrouter";
        requestedModel: string;
        actualModel?: string;
        requestProtocol: "native_tools" | "structured_output" | "constrained_json" | "plain_json";
        finalProtocol: "native_tools" | "structured_output" | "constrained_json" | "plain_json";
        usedTools: boolean;
        toolChoice?: "auto" | "none" | "required";
        strictSchema: boolean;
        initialHttpStatus?: number;
        finalHttpStatus?: number;
        usedFallback: boolean;
        fallbackReason?: string;
        usedResponseHealing: boolean;
        finishReason?: unknown;
        latencyMs: number;
        rawContentLength: number;
        toolCallCount: number;
    };
};

export interface LLMProvider {
    chat(request: LLMRequest): Promise<LLMResponse>;
}
