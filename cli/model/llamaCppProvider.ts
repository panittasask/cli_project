import type { LLMProvider, LLMRequest, LLMResponse } from "./llmProvider";
import type { ModelCapabilities, ModelProtocol } from "./modelCapabilities";

const { buildOpenRouterFallbackPayload, normalizeOpenRouterResponseFormat, normalizeOpenRouterSampling } = require("./openRouterCompat") as {
    buildOpenRouterFallbackPayload: (request: { model: string; messages: unknown[]; sampling?: Record<string, unknown> | undefined }) => Record<string, unknown>;
    normalizeOpenRouterResponseFormat: (responseFormat: Record<string, unknown> | undefined, strictSchema?: boolean) => Record<string, unknown> | undefined;
    normalizeOpenRouterSampling: (sampling: Record<string, unknown> | undefined) => Record<string, unknown> | undefined;
};
const { resolveModelCapabilities, selectModelProtocol } = require("./modelCapabilities") as {
    resolveModelCapabilities: (provider: "llama.cpp" | "openrouter", configured?: Partial<ModelCapabilities>) => ModelCapabilities;
    selectModelProtocol: (capabilities: ModelCapabilities) => ModelProtocol;
};
const { buildOpenRouterTools } = require("./openRouterTools") as {
    buildOpenRouterTools: (responseFormat: Record<string, unknown> | undefined) => Array<Record<string, unknown>>;
};

const { LlamaClient } = require("../llamaClient") as { LlamaClient: new (apiUrl: string, timeoutMs?: number, options?: {
    headers?: Record<string, string>;
    healthCheckOnRetry?: boolean;
    requestDelayMs?: number;
}) => {
    post: (
        payload: Record<string, unknown>,
        onRetry?: (attempt: number, errorCode: string) => void,
        signal?: AbortSignal
    ) => Promise<{ data: any; status?: number }>;
    formatError: (error: unknown) => string;
    close: () => void;
} };

class LlamaCppProvider implements LLMProvider {
    private readonly client: InstanceType<typeof LlamaClient>;
    private readonly isOpenRouter: boolean;
    private readonly providerName: "llama.cpp" | "openrouter";
    private readonly capabilities: ModelCapabilities;

    constructor(apiUrl: string, timeoutMs?: number, options?: {
        headers?: Record<string, string>;
        healthCheckOnRetry?: boolean;
        requestDelayMs?: number;
        provider?: "llama.cpp" | "openrouter";
        capabilities?: Partial<ModelCapabilities>;
    }) {
        this.providerName = options?.provider === "openrouter" ? "openrouter" : "llama.cpp";
        this.isOpenRouter = this.providerName === "openrouter";
        this.capabilities = resolveModelCapabilities(this.providerName, options?.capabilities);
        this.client = new LlamaClient(apiUrl, timeoutMs, options);
    }

    async chat(request: LLMRequest): Promise<LLMResponse> {
        const startedAt = Date.now();
        const preferredProtocol = request.allowNativeTools === false && this.capabilities.nativeTools
            ? selectModelProtocol({ ...this.capabilities, nativeTools: false })
            : selectModelProtocol(this.capabilities);
        const openRouterTools = this.isOpenRouter && preferredProtocol === "native_tools"
            ? buildOpenRouterTools(request.responseFormat)
            : [];
        const requestProtocol = preferredProtocol === "native_tools" && openRouterTools.length === 0
            ? selectModelProtocol({ ...this.capabilities, nativeTools: false })
            : preferredProtocol;
        const useOpenRouterTools = this.isOpenRouter
            && requestProtocol === "native_tools"
            && openRouterTools.length > 0;
        const useStructuredResponse = requestProtocol === "structured_output" || requestProtocol === "constrained_json";
        const strictSchema = useStructuredResponse && this.capabilities.strictSchema;
        const responseFormat = useOpenRouterTools || requestProtocol === "plain_json"
            ? undefined
            : this.isOpenRouter
                ? normalizeOpenRouterResponseFormat(request.responseFormat, strictSchema)
                : request.responseFormat;
        const sampling = this.isOpenRouter
            ? normalizeOpenRouterSampling(request.sampling)
            : request.sampling;
        const toolChoice = useOpenRouterTools
            ? this.capabilities.toolChoice
                ? request.toolChoice ?? "required"
                : "auto"
            : undefined;
        const usedResponseHealing = this.isOpenRouter
            && !useOpenRouterTools
            && Boolean(responseFormat)
            && this.capabilities.responseHealing;
        const requiredParameterRouting = this.isOpenRouter
            && (Boolean(responseFormat) || useOpenRouterTools);
        const payload = {
            model: request.model,
            messages: request.messages,
            ...(responseFormat ? { response_format: responseFormat } : {}),
            ...(useOpenRouterTools ? {
                tools: openRouterTools,
                tool_choice: toolChoice,
                parallel_tool_calls: false
            } : {}),
            ...(requiredParameterRouting ? { provider: { require_parameters: true } } : {}),
            ...(usedResponseHealing ? { plugins: [{ id: "response-healing" }] } : {}),
            ...(sampling ?? {})
        };
        let response: { data: any; status?: number };
        let initialHttpStatus: number | undefined;
        let usedFallback = false;
        let fallbackReason: string | undefined;
        let finalProtocol = requestProtocol;
        try {
            response = await this.post(payload, request.onRetry, request.signal);
            initialHttpStatus = response.status;
        } catch (error) {
            initialHttpStatus = getHttpStatus(error);
            if (!this.isOpenRouter || !isBadRequest(error)) {
                attachTransportMeta(error, {
                    provider: this.providerName,
                    requestedModel: request.model,
                    requestProtocol,
                    finalProtocol: requestProtocol,
                    usedTools: useOpenRouterTools,
                    strictSchema,
                    initialHttpStatus,
                    finalHttpStatus: initialHttpStatus,
                    usedFallback: false,
                    usedResponseHealing,
                    requiredParameterRouting,
                    latencyMs: Date.now() - startedAt
                });
                throw error;
            }

            try {
                usedFallback = true;
                fallbackReason = this.client.formatError(error);
                finalProtocol = "plain_json";
                response = await this.post(
                    buildOpenRouterFallbackPayload({
                        model: request.model,
                        messages: request.messages,
                        sampling
                    }),
                    request.onRetry,
                    request.signal
                );
            } catch (fallbackError) {
                attachOpenRouterInitialError(fallbackError, this.client.formatError(error));
                attachTransportMeta(fallbackError, {
                    provider: this.providerName,
                    requestedModel: request.model,
                    requestProtocol,
                    finalProtocol: "plain_json",
                    usedTools: false,
                    strictSchema,
                    initialHttpStatus,
                    finalHttpStatus: getHttpStatus(fallbackError),
                    usedFallback: true,
                    fallbackReason: this.client.formatError(error),
                    usedResponseHealing: false,
                    requiredParameterRouting: false,
                    latencyMs: Date.now() - startedAt
                });
                throw fallbackError;
            }
        }
        const choice = response.data?.choices?.[0];
        const message = choice?.message;
        const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        const hasAmbiguousToolCalls = toolCalls.length > 1;
        const toolCallCandidate = hasAmbiguousToolCalls ? undefined : toolCalls[0];
        const toolCall = toolCallCandidate?.function && typeof toolCallCandidate.function.name === "string"
            ? {
                id: typeof toolCallCandidate.id === "string" ? toolCallCandidate.id : `tool_call_${Date.now()}`,
                name: toolCallCandidate.function.name,
                arguments: typeof toolCallCandidate.function.arguments === "string" ? toolCallCandidate.function.arguments : ""
            }
            : undefined;
        const providerContent = typeof message?.content === "string"
            ? message.content
            : toolCall?.arguments ?? "";
        let normalizedContent = hasAmbiguousToolCalls
            ? JSON.stringify({ protocol_error: "multiple_tool_calls", tool_call_count: toolCalls.length })
            : providerContent;
        if (toolCall && !hasAmbiguousToolCalls) {
            try {
                const parsedArguments = JSON.parse(toolCall.arguments) as unknown;
                normalizedContent = JSON.stringify({
                    ...(parsedArguments && typeof parsedArguments === "object" && !Array.isArray(parsedArguments)
                        ? parsedArguments as Record<string, unknown>
                        : {}),
                    action: toolCall.name
                });
            } catch {
                // Keep the exact malformed arguments for local validation/recovery.
                normalizedContent = toolCall.arguments;
            }
        }

        return {
            content: normalizedContent,
            rawProviderContent: providerContent,
            ...(toolCall ? { toolCall } : {}),
            data: response.data,
            reasoningContent: choice?.message?.reasoning_content,
            finishReason: choice?.finish_reason,
            usage: response.data?.usage,
            timings: response.data?.timings,
            transportMeta: {
                provider: this.providerName,
                requestedModel: request.model,
                ...(typeof response.data?.model === "string" ? { actualModel: response.data.model } : {}),
                requestProtocol,
                finalProtocol,
                usedTools: useOpenRouterTools,
                ...(toolChoice ? { toolChoice } : {}),
                strictSchema,
                ...(initialHttpStatus !== undefined ? { initialHttpStatus } : {}),
                ...(response.status !== undefined ? { finalHttpStatus: response.status } : {}),
                usedFallback,
                ...(fallbackReason ? { fallbackReason } : {}),
                usedResponseHealing,
                requiredParameterRouting,
                finishReason: choice?.finish_reason,
                latencyMs: Date.now() - startedAt,
                rawContentLength: providerContent.length,
                toolCallCount: toolCalls.length
            }
        };
    }

    private post(
        payload: Record<string, unknown>,
        onRetry?: (attempt: number, errorCode: string) => void,
        signal?: AbortSignal
    ): Promise<{ data: any; status?: number }> {
        return this.client.post(payload, onRetry, signal);
    }

    formatError(error: unknown): string {
        return this.client.formatError(error);
    }

    close(): void {
        this.client.close();
    }
}

function getHttpStatus(error: unknown): number | undefined {
    return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

function isBadRequest(error: unknown): boolean {
    const response = (error as { response?: { status?: number } } | undefined)?.response;
    if (response?.status !== undefined) return response.status === 400;
    return (error as { code?: string } | undefined)?.code === "ERR_BAD_REQUEST";
}

function attachOpenRouterInitialError(error: unknown, message: string): void {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return;
    try {
        Object.defineProperty(error, "openRouterInitialError", {
            value: message,
            enumerable: false,
            configurable: true
        });
    } catch {
        // Preserve the fallback error even when the Axios error is immutable.
    }
}

function attachTransportMeta(error: unknown, transportMeta: Record<string, unknown>): void {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return;
    try {
        Object.defineProperty(error, "transportMeta", {
            value: transportMeta,
            enumerable: false,
            configurable: true
        });
    } catch {
        // Preserve the provider error when metadata cannot be attached.
    }
}

module.exports = { LlamaCppProvider };
