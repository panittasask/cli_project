import axios = require("axios");
import http = require("node:http");

type RetryCallback = (attempt: number, errorCode: string) => void;

class LlamaClient {
    private readonly agent = new http.Agent({ keepAlive: false });

    constructor(
        private readonly apiUrl: string,
        private readonly timeoutMs = 300000
    ) {}

    async post(payload: Record<string, unknown>, onRetry?: RetryCallback) {
        let lastError: unknown;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await axios.post(this.apiUrl, payload, {
                    timeout: this.timeoutMs,
                    httpAgent: this.agent,
                    headers: { Connection: "close" }
                });
            } catch (error) {
                lastError = error;
                if (attempt > 0 || !this.isRetryable(error) || !(await this.isServerHealthy())) {
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
            return error instanceof Error ? error.message : String(error);
        }

        const code = error.code ? `${error.code}: ` : "";
        const responseMessage = typeof error.response?.data === "string"
            ? error.response.data.slice(0, 500)
            : error.response?.data?.error?.message;
        return `${code}${responseMessage || error.message}`;
    }

    close(): void {
        this.agent.destroy();
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

module.exports = {
    LlamaClient
};
