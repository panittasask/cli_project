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
            await axios.post(endpoint(this.apiUrl, "/models/unload"), { model: entry.id }, { timeout: 30_000 });
        }

        if (target.status !== "loaded") {
            await axios.post(endpoint(this.apiUrl, "/models/load"), { model: target.id }, { timeout: this.loadTimeoutMs });
        }

        const deadline = Date.now() + this.loadTimeoutMs;
        while (Date.now() < deadline) {
            const refreshed = await this.list();
            const current = refreshed.find((entry) => entry.id === target.id);
            if (current?.status === "loaded") {
                return { model: current, unloaded: loaded.map((entry) => entry.id) };
            }
            if (current?.failed) throw new Error(`llama.cpp failed to load model: ${target.id}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        throw new Error(`Timed out while loading model: ${target.id}`);
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
}

module.exports = {
    ModelRouterClient,
    normalizeRouterModel,
    resolveRouterModel,
    routerErrorMessage
};
