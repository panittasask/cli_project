import axios = require("axios");
import http = require("node:http");

type RetryCallback = (attempt: number, errorCode: string) => void;

type LlamaClientOptions = {
    headers?: Record<string, string>;
    healthCheckOnRetry?: boolean;
    requestDelayMs?: number;
};

class LlamaClient {
    private readonly agent = new http.Agent({ keepAlive: false });
    private lastRequestStartedAt = 0;

    constructor(
        private readonly apiUrl: string,
        private readonly timeoutMs = 300000,
        private readonly options: LlamaClientOptions = {}
    ) {}

    async post(payload: Record<string, unknown>, onRetry?: RetryCallback, signal?: AbortSignal) {
        let lastError: unknown;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await this.waitForRequestSlot(signal);
                return await axios.post(this.apiUrl, payload, {
                    timeout: this.timeoutMs,
                    ...(signal ? { signal } : {}),
                    httpAgent: this.agent,
                    headers: { ...this.options.headers, Connection: "close" }
                });
            } catch (error) {
                lastError = error;
                if (signal?.aborted || attempt > 0 || !this.isRetryable(error)) {
                    throw error;
                }

                if (this.options.healthCheckOnRetry !== false && !(await this.isServerHealthy())) {
                    throw error;
                }

                const code = axios.isAxiosError(error) ? error.code || "CONNECTION_RESET" : "CONNECTION_RESET";
                onRetry?.(attempt + 1, code);
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }

        throw lastError;
    }

    formatError(error: unknown): string {
        if (!axios.isAxiosError(error)) {
            const message = error instanceof Error ? error.message : String(error);
            if (/operation was aborted|request was aborted|socket hang up/i.test(message)) {
                return "The model connection was interrupted while a response was in progress. The loaded llama.cpp model may have been stopped, unloaded, or switched; retry after confirming the model is loaded.";
            }
            return message;
        }

        const rawMessage = error.message || "";
        if (error.code === "ERR_CANCELED" || /operation was aborted|request was aborted/i.test(rawMessage)) {
            return "The model connection was interrupted while a response was in progress. The loaded llama.cpp model may have been stopped, unloaded, or switched; retry after confirming the model is loaded.";
        }
        if (error.code === "ECONNABORTED" && /timeout/i.test(rawMessage)) {
            return `The model request timed out before a response was received (${rawMessage}). Check the provider status/model or reduce the reasoning and output budget, then retry.`;
        }
        const code = error.code ? `${error.code}: ` : "";
        const status = error.response?.status ? `HTTP ${error.response.status}: ` : "";
        const responseData = error.response?.data;
        const responseMessage = typeof responseData === "string"
            ? responseData.slice(0, 1000)
            : formatResponseError(responseData);
        const initialError = (error as Error & { openRouterInitialError?: string }).openRouterInitialError;
        return `${code}${status}${responseMessage || rawMessage}${initialError ? ` | Initial OpenRouter request: ${initialError}` : ""}`;
    }

    close(): void {
        this.agent.destroy();
    }

    private async waitForRequestSlot(signal?: AbortSignal): Promise<void> {
        const delayMs = this.options.requestDelayMs ?? 0;
        if (delayMs <= 0) return;

        const remainingMs = delayMs - (Date.now() - this.lastRequestStartedAt);
        if (remainingMs > 0) {
            await new Promise<void>((resolve, reject) => {
                const onAbort = (): void => {
                    clearTimeout(timer);
                    reject(new Error("Request delay was cancelled."));
                };
                const timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, remainingMs);
                if (signal?.aborted) {
                    onAbort();
                } else {
                    signal?.addEventListener("abort", onAbort, { once: true });
                }
            });
        }
        this.lastRequestStartedAt = Date.now();
    }

    private isRetryable(error: unknown): boolean {
        if (!axios.isAxiosError(error)) {
            return false;
        }

        return error.code === "ECONNRESET"
            || error.code === "EPIPE"
            || error.message.toLowerCase().includes("socket hang up");
    }

    private async isServerHealthy(): Promise<boolean> {
        try {
            const healthUrl = new URL("/health", this.apiUrl).toString();
            await axios.get(healthUrl, {
                timeout: 3000,
                httpAgent: this.agent,
                headers: { Connection: "close" }
            });
            return true;
        } catch {
            return false;
        }
    }
}

function formatResponseError(responseData: any): string | undefined {
    if (!responseData) return undefined;
    const message = responseData.error?.message || responseData.message;
    const metadata = responseData.error?.metadata || responseData.error?.details || responseData.metadata;
    const detail = metadata ? safeErrorDetails(metadata) : undefined;
    if (message && detail) return `${String(message)} | details: ${detail}`;
    return message ? String(message) : safeErrorDetails(responseData);
}

function safeErrorDetails(value: unknown): string | undefined {
    try {
        const serialized = JSON.stringify(value);
        if (!serialized) return undefined;
        return serialized
            .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
            .replace(/sk-[A-Za-z0-9_-]+/gi, "[redacted]")
            .slice(0, 1400);
    } catch {
        return undefined;
    }
}

module.exports = {
    LlamaClient
};
