import fs = require("node:fs");
import path = require("node:path");

type SamplingSettings = {
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
    max_tokens: number;
};

type SamplingProfile = Partial<SamplingSettings>;

type CliSettings = {
    llamaCppPath?: string;
    modelPath?: string;
    defaultModel?: string;
    device?: string;
    debug?: boolean;
    historyMessages?: number;
    sampling?: {
        chat?: SamplingProfile;
        planner?: SamplingProfile;
        action?: SamplingProfile;
    };
};

type SamplingKind = "chat" | "planner" | "action";

const defaults: Record<SamplingKind, SamplingSettings> = {
    chat: {
        temperature: 0.6,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.08,
        max_tokens: 2048
    },
    planner: {
        temperature: 0.1,
        top_p: 0.9,
        top_k: 20,
        repeat_penalty: 1.05,
        max_tokens: 1024
    },
    action: {
        temperature: 0.1,
        top_p: 0.9,
        top_k: 20,
        repeat_penalty: 1.05,
        max_tokens: 4096
    }
};

function loadCliSettings(appRoot = process.cwd()): CliSettings {
    const settingsPath = path.resolve(appRoot, ".cli", "settings.json");
    if (!fs.existsSync(settingsPath)) {
        return {};
    }

    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as CliSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
}

function readNumber(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return fallback;
    }

    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function getSamplingSettings(settings: CliSettings, kind: SamplingKind): SamplingSettings {
    const configured = settings.sampling?.[kind] ?? {};
    const prefix = `LLAMA_${kind.toUpperCase()}`;
    const merged = { ...defaults[kind], ...configured };

    return {
        temperature: readNumber(`${prefix}_TEMPERATURE`, merged.temperature),
        top_p: readNumber(`${prefix}_TOP_P`, merged.top_p),
        top_k: readNumber(`${prefix}_TOP_K`, merged.top_k),
        repeat_penalty: readNumber(`${prefix}_REPEAT_PENALTY`, merged.repeat_penalty),
        max_tokens: Math.max(1, Math.floor(readNumber(`${prefix}_MAX_TOKENS`, merged.max_tokens)))
    };
}

module.exports = {
    loadCliSettings,
    getSamplingSettings
};
