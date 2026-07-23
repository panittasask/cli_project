import axios = require("axios");
import path = require("node:path");

type RouterModel = {
    id: string;
    path?: string;
    status: string;
    failed: boolean;
};

function endpoint(apiUrl: string, route: string): string {
    return new URL(route, apiUrl).toString();
}

function normalizeRouterModel(candidate: unknown): RouterModel | undefined {
    if (!candidate || typeof candidate !== "object") return undefined;
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
    const rawStatus = raw.status && typeof raw.status === "object"
        ? raw.status as Record<string, unknown>
        : {};
    return {
        id: raw.id,
        ...(typeof raw.path === "string" && raw.path ? { path: raw.path } : {}),
        status: typeof rawStatus.value === "string" ? rawStatus.value : "unknown",
        failed: rawStatus.failed === true
    };
}

function resolveRouterModel(models: RouterModel[], selection: string): RouterModel | undefined {
    const trimmed = selection.trim();
    if (/^\d+$/.test(trimmed)) {
        const index = Number(trimmed) - 1;
        return index >= 0 && index < models.length ? models[index] : undefined;
    }

    const normalized = trimmed.toLowerCase();
    const normalizedWithoutExtension = normalized.replace(/\.gguf$/i, "");
    return models.find((entry) => entry.id.toLowerCase() === normalized)
        || models.find((entry) => entry.id.toLowerCase().replace(/\.gguf$/i, "") === normalizedWithoutExtension)
        || models.find((entry) => path.basename(entry.path || "").toLowerCase() === normalized);
}

function selectActiveModelId(entries: unknown[]): string | undefined {
    const records = entries.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
    const loaded = records.find((entry) => {
        const status = entry.status && typeof entry.status === "object"
            ? entry.status as Record<string, unknown>
            : undefined;
        return status?.value === "loaded" && typeof entry.id === "string" && entry.id.length > 0;
    });
    if (typeof loaded?.id === "string") return loaded.id;

    // A standalone llama-server exposes one status-less model entry. Do not
    // fall back to an explicitly unloaded router entry.
    const standalone = records.find((entry) => entry.status === undefined
        && typeof entry.id === "string" && entry.id.length > 0);
    return typeof standalone?.id === "string" ? standalone.id : undefined;
}

function routerErrorMessage(error: unknown): string {
    if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : String(error);
    const responseMessage = typeof error.response?.data === "string"
        ? error.response.data.slice(0, 500)
        : error.response?.data?.error?.message;
    return responseMessage || error.message;
}

class ModelRouterClient {
    constructor(
        private readonly apiUrl: string,
        private readonly loadTimeoutMs = 300_000
    ) {}

    async list(): Promise<RouterModel[]> {
        const response = await axios.get(endpoint(this.apiUrl, "/models?reload=1"), { timeout: 10_000 });
        const entries = Array.isArray(response.data?.data) ? response.data.data : [];
        return entries.flatMap((entry: unknown) => {
            const normalized = normalizeRouterModel(entry);
            return normalized ? [normalized] : [];
        });
    }

    async switch(selection: string): Promise<{ model: RouterModel; unloaded: string[] }> {
        const models = await this.list();
        const target = resolveRouterModel(models, selection);
        if (!target) {
            throw new Error(`Model not found: ${selection}. Use /model to list server models.`);
        }

        const loaded = models.filter((entry) => entry.status === "loaded" && entry.id !== target.id);
        for (const entry of loaded) {
            await this.assertModelIdle(entry.id);
            await this.transitionModel(entry.id, "/models/unload", "unloaded", 30_000);
        }

        if (target.status !== "loaded") {
            await this.transitionModel(target.id, "/models/load", "loaded", this.loadTimeoutMs);
        }

        const refreshed = await this.list();
        const current = refreshed.find((entry) => entry.id === target.id);
        if (current?.status !== "loaded") throw new Error(`llama.cpp did not report the selected model as loaded: ${target.id}`);
        return { model: current, unloaded: loaded.map((entry) => entry.id) };
    }

    formatError(error: unknown): string {
        return routerErrorMessage(error);
    }

    private async assertModelIdle(modelId: string): Promise<void> {
        const slotsUrl = new URL("/slots", this.apiUrl);
        slotsUrl.searchParams.set("model", modelId);
        const response = await axios.get(slotsUrl.toString(), { timeout: 5_000 });
        const slots = Array.isArray(response.data) ? response.data : [];
        if (slots.some((slot: { is_processing?: unknown }) => slot.is_processing === true)) {
            throw new Error(`Cannot switch models while '${modelId}' is processing an active request. Wait for the current response to finish, then retry the model switch.`);
        }
    }

    private async transitionModel(
        modelId: string,
        route: "/models/load" | "/models/unload",
        desiredStatus: "loaded" | "unloaded",
        timeoutMs: number
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let lastError: unknown;

        for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
            let transientMutationFailure = false;
            try {
                await axios.post(endpoint(this.apiUrl, route), { model: modelId }, {
                    timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now()))
                });
            } catch (error) {
                lastError = error;
                if (!this.isTransientConnectionError(error)) throw error;
                transientMutationFailure = true;
            }

            let unchangedPolls = 0;
            while (Date.now() < deadline) {
                try {
                    const current = (await this.list()).find((entry) => entry.id === modelId);
                    if (current?.status === desiredStatus) return;
                    if (current?.failed) throw new Error(`llama.cpp failed to ${desiredStatus === "loaded" ? "load" : "unload"} model: ${modelId}`);
                    const oppositeStatus = desiredStatus === "loaded" ? "unloaded" : "loaded";
                    unchangedPolls = current?.status === oppositeStatus ? unchangedPolls + 1 : 0;
                } catch (error) {
                    lastError = error;
                    if (!this.isTransientConnectionError(error)) throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
                // Retry the mutation if the router accepted no state change
                // for several polls after resetting the HTTP connection.
                if (attempt === 0 && transientMutationFailure && unchangedPolls >= 6) break;
            }
        }

        if (lastError) throw new Error(
            `Model ${desiredStatus === "loaded" ? "load" : "unload"} did not complete after a transient router disconnect: ${routerErrorMessage(lastError)}`
        );
        throw new Error(`Timed out while waiting for model '${modelId}' to become ${desiredStatus}.`);
    }

    private isTransientConnectionError(error: unknown): boolean {
        if (!axios.isAxiosError(error)) return false;
        return ["ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT", "ERR_NETWORK"].includes(error.code || "")
            || /socket hang up|connection reset/i.test(error.message);
    }
}

module.exports = {
    ModelRouterClient,
    normalizeRouterModel,
    resolveRouterModel,
    selectActiveModelId,
    routerErrorMessage
};
