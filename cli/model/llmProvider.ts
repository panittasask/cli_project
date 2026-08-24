export type LLMMessage = {
    role: "system" | "user" | "assistant";
    content: unknown;
};

export type LLMRequest = {
    model: string;
    messages: LLMMessage[];
    responseFormat?: Record<string, unknown>;
    sampling?: Record<string, unknown>;
    signal?: AbortSignal;
    onRetry?: (attempt: number, errorCode: string) => void;
};

export type LLMResponse = {
    content: string;
    data?: any;
    reasoningContent?: unknown;
    finishReason?: unknown;
    usage?: unknown;
    timings?: unknown;
};

export interface LLMProvider {
    chat(request: LLMRequest): Promise<LLMResponse>;
}
