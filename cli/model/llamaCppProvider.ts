import type { LLMProvider, LLMRequest, LLMResponse } from "./llmProvider";

const { LlamaClient } = require("../llamaClient") as { LlamaClient: new (apiUrl: string, timeoutMs?: number) => {
    post: (
        payload: Record<string, unknown>,
        onRetry?: (attempt: number, errorCode: string) => void,
        signal?: AbortSignal
    ) => Promise<{ data: any }>;
    formatError: (error: unknown) => string;
    close: () => void;
} };

class LlamaCppProvider implements LLMProvider {
    private readonly client: InstanceType<typeof LlamaClient>;

    constructor(apiUrl: string, timeoutMs?: number) {
        this.client = new LlamaClient(apiUrl, timeoutMs);
    }

    async chat(request: LLMRequest): Promise<LLMResponse> {
        const response = await this.post({
            model: request.model,
            messages: request.messages,
            ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
            ...(request.sampling ?? {})
        }, request.onRetry, request.signal);
        const choice = response.data?.choices?.[0];

        return {
            content: typeof choice?.message?.content === "string" ? choice.message.content : "",
            data: response.data,
            reasoningContent: choice?.message?.reasoning_content,
            finishReason: choice?.finish_reason,
            usage: response.data?.usage,
            timings: response.data?.timings
        };
    }

    private post(
        payload: Record<string, unknown>,
        onRetry?: (attempt: number, errorCode: string) => void,
        signal?: AbortSignal
    ): Promise<{ data: any }> {
        return this.client.post(payload, onRetry, signal);
    }

    formatError(error: unknown): string {
        return this.client.formatError(error);
    }

    close(): void {
        this.client.close();
    }
}

module.exports = { LlamaCppProvider };
