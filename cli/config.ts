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
    apiUrl?: string;
    routerMode?: boolean;
    modelsMax?: number;
    defaultModel?: string;
    contextLength?: number;
    device?: string;
    hardwareProfile?: "auto" | "intel-arc" | "rtx-4070-super" | "default";
    debug?: boolean;
    historyMessages?: number;
    agent?: {
        profile?: AgentBudgetProfile;
        maxTurns?: number;
        maxSegments?: number;
        maxDurationMinutes?: number;
        maxCompletionTokens?: number;
        repeatLimit?: number;
        maxClarifications?: number;
        requireInspectionBeforeClarification?: boolean;
        secondClarificationRequiresBlocker?: boolean;
    };
    projectChecks?: ProjectCheckProvider[];
    sampling?: {
        chat?: SamplingProfile;
        planner?: SamplingProfile;
        action?: SamplingProfile;
    };
};

type ProjectCheckProvider = {
    manifest: string;
    command: string;
    label?: string;
    ecosystem?: string;
    affectedExtensions?: string[];
    affectedFiles?: string[];
};

type SamplingKind = "chat" | "planner" | "action";
type AgentBudgetProfile = "quick" | "standard" | "deep";

type AgentBudgetSettings = {
    profile: AgentBudgetProfile;
    maxTurns: number;
    maxSegments: number;
    maxDurationMs: number;
    maxCompletionTokens: number;
    repeatLimit: number;
};

const agentBudgetProfiles: Record<AgentBudgetProfile, Omit<AgentBudgetSettings, "profile">> = {
    quick: {
        maxTurns: 4,
        maxSegments: 1,
        maxDurationMs: 3 * 60_000,
        maxCompletionTokens: 3000,
        repeatLimit: 2
    },
    standard: {
        maxTurns: 12,
        maxSegments: 1,
        maxDurationMs: 8 * 60_000,
        maxCompletionTokens: 8000,
        repeatLimit: 2
    },
    deep: {
        maxTurns: 12,
        maxSegments: 2,
        maxDurationMs: 20 * 60_000,
        maxCompletionTokens: 16000,
        repeatLimit: 2
    }
};

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
        max_tokens: 2048
    }
};

function loadCliSettings(appRoot = process.cwd()): CliSettings {
    const personalSettingsPath = path.resolve(appRoot, ".cli", "settings.json");
    const prototypePath = path.resolve(appRoot, ".cli", "settings.example.json");
    const settingsPath = fs.existsSync(personalSettingsPath) ? personalSettingsPath : prototypePath;
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

function initializeCliSettings(appRoot = process.cwd()): { created: boolean; path: string; message: string } {
    const cliDirectory = path.resolve(appRoot, ".cli");
    const settingsPath = path.join(cliDirectory, "settings.json");
    const prototypePath = path.join(cliDirectory, "settings.example.json");
    if (fs.existsSync(settingsPath)) {
        return { created: false, path: settingsPath, message: "Settings already exist; nothing was overwritten." };
    }
    if (!fs.existsSync(prototypePath)) {
        return { created: false, path: settingsPath, message: `Settings prototype not found: ${prototypePath}` };
    }
    const parsed = JSON.parse(fs.readFileSync(prototypePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { created: false, path: settingsPath, message: "Settings prototype must contain one JSON object." };
    }
    fs.mkdirSync(cliDirectory, { recursive: true });
    try {
        fs.copyFileSync(prototypePath, settingsPath, fs.constants.COPYFILE_EXCL);
        return { created: true, path: settingsPath, message: "Created settings from settings.example.json." };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { created: false, path: settingsPath, message: "Settings already exist; nothing was overwritten." };
        }
        throw error;
    }
}

function validateCliSettings(input: unknown): string[] {
    if (!input || typeof input !== "object" || Array.isArray(input)) return ["settings must contain one JSON object"];
    const settings = input as Record<string, unknown>;
    const errors: string[] = [];
    const numberField = (owner: Record<string, unknown>, key: string, label: string, minimum: number, maximum = Number.POSITIVE_INFINITY): void => {
        if (owner[key] === undefined) return;
        const value = owner[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
            errors.push(`${label} must be a finite number between ${minimum} and ${maximum === Number.POSITIVE_INFINITY ? "unbounded" : maximum}`);
        }
    };
    const booleanField = (owner: Record<string, unknown>, key: string, label = key): void => {
        if (owner[key] !== undefined && typeof owner[key] !== "boolean") errors.push(`${label} must be boolean`);
    };
    numberField(settings, "contextLength", "contextLength", 512);
    numberField(settings, "historyMessages", "historyMessages", 0);
    numberField(settings, "modelsMax", "modelsMax", 1, 32);
    booleanField(settings, "debug");
    booleanField(settings, "routerMode");
    for (const field of ["llamaCppPath", "modelPath", "defaultModel", "device"]) {
        if (settings[field] !== undefined && (typeof settings[field] !== "string" || !String(settings[field]).trim())) errors.push(`${field} must be a non-empty string`);
    }
    if (settings.hardwareProfile !== undefined && (typeof settings.hardwareProfile !== "string"
        || !["auto", "intel-arc", "rtx-4070-super", "default"].includes(settings.hardwareProfile))) {
        errors.push("hardwareProfile must be auto, intel-arc, rtx-4070-super, or default");
    }

    if (settings.agent !== undefined && (!settings.agent || typeof settings.agent !== "object" || Array.isArray(settings.agent))) {
        errors.push("agent must be an object");
    } else if (settings.agent) {
        const agent = settings.agent as Record<string, unknown>;
        const profile = typeof agent.profile === "string" && ["quick", "standard", "deep"].includes(agent.profile)
            ? agent.profile as AgentBudgetProfile
            : "standard";
        if (agent.profile !== undefined && (typeof agent.profile !== "string" || !["quick", "standard", "deep"].includes(agent.profile))) {
            errors.push("agent.profile must be quick, standard, or deep");
        }
        const budget = agentBudgetProfiles[profile];
        numberField(agent, "maxTurns", "agent.maxTurns", 1, budget.maxTurns);
        numberField(agent, "maxSegments", "agent.maxSegments", 1, budget.maxSegments);
        numberField(agent, "maxDurationMinutes", "agent.maxDurationMinutes", 1, budget.maxDurationMs / 60_000);
        numberField(agent, "maxCompletionTokens", "agent.maxCompletionTokens", 256, budget.maxCompletionTokens);
        numberField(agent, "repeatLimit", "agent.repeatLimit", 2, budget.repeatLimit);
        numberField(agent, "maxClarifications", "agent.maxClarifications", 0);
        booleanField(agent, "requireInspectionBeforeClarification", "agent.requireInspectionBeforeClarification");
        booleanField(agent, "secondClarificationRequiresBlocker", "agent.secondClarificationRequiresBlocker");
    }

    if (settings.sampling !== undefined && (!settings.sampling || typeof settings.sampling !== "object" || Array.isArray(settings.sampling))) {
        errors.push("sampling must be an object");
    } else if (settings.sampling) {
        const sampling = settings.sampling as Record<string, unknown>;
        for (const profileName of ["chat", "planner", "action"]) {
            const rawProfile = sampling[profileName];
            if (rawProfile === undefined) continue;
            if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
                errors.push(`sampling.${profileName} must be an object`);
                continue;
            }
            const profile = rawProfile as Record<string, unknown>;
            numberField(profile, "temperature", `sampling.${profileName}.temperature`, 0, 2);
            numberField(profile, "top_p", `sampling.${profileName}.top_p`, 0, 1);
            numberField(profile, "top_k", `sampling.${profileName}.top_k`, 0);
            numberField(profile, "repeat_penalty", `sampling.${profileName}.repeat_penalty`, 0.01);
            numberField(profile, "max_tokens", `sampling.${profileName}.max_tokens`, 1);
        }
    }

    if (settings.projectChecks !== undefined) {
        if (!Array.isArray(settings.projectChecks)) errors.push("projectChecks must be an array");
        else settings.projectChecks.forEach((candidate, index) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
                errors.push(`projectChecks[${index}] must be an object`);
                return;
            }
            const provider = candidate as Record<string, unknown>;
            const manifest = typeof provider.manifest === "string" ? provider.manifest.trim().replace(/\\/g, "/") : "";
            const command = typeof provider.command === "string" ? provider.command.trim() : "";
            if (!manifest) errors.push(`projectChecks[${index}].manifest must be a non-empty string`);
            else if (path.isAbsolute(manifest) || manifest.split("/").includes("..")) errors.push(`projectChecks[${index}].manifest must stay inside the workspace`);
            if (!command) errors.push(`projectChecks[${index}].command must be a non-empty string`);
            else if (/[\r\n]/.test(command)) errors.push(`projectChecks[${index}].command must be one line`);
            for (const field of ["affectedExtensions", "affectedFiles"]) {
                if (provider[field] !== undefined && (!Array.isArray(provider[field]) || (provider[field] as unknown[]).some((item) => typeof item !== "string" || !item.trim()))) {
                    errors.push(`projectChecks[${index}].${field} must be an array of non-empty strings`);
                }
            }
        });
    }
    return errors;
}

function validateCliSettingsFile(appRoot = process.cwd()): { ok: boolean; path: string; source: "settings.json" | "settings.example.json" | "none"; errors: string[] } {
    const personalPath = path.resolve(appRoot, ".cli", "settings.json");
    const prototypePath = path.resolve(appRoot, ".cli", "settings.example.json");
    const targetPath = fs.existsSync(personalPath) ? personalPath : prototypePath;
    const source = fs.existsSync(personalPath) ? "settings.json" : fs.existsSync(prototypePath) ? "settings.example.json" : "none";
    if (source === "none") return { ok: false, path: personalPath, source, errors: ["no settings.json or settings.example.json was found"] };
    try {
        const errors = validateCliSettings(JSON.parse(fs.readFileSync(targetPath, "utf8")));
        return { ok: errors.length === 0, path: targetPath, source, errors };
    } catch (error) {
        return { ok: false, path: targetPath, source, errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
}

function readBoolean(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    if (/^(?:1|true|on|yes)$/i.test(raw)) return true;
    if (/^(?:0|false|off|no)$/i.test(raw)) return false;
    return fallback;
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

function getAgentGuardSettings(settings: CliSettings): AgentBudgetSettings {
    const configured = settings.agent ?? {};
    const requestedProfile = process.env.CLI_AGENT_PROFILE?.trim().toLowerCase() || configured.profile || "standard";
    const profile: AgentBudgetProfile = requestedProfile === "quick" || requestedProfile === "deep"
        ? requestedProfile
        : "standard";
    const budget = agentBudgetProfiles[profile];
    const boundedInteger = (envName: string, configuredValue: number | undefined, fallback: number, maximum: number, minimum = 1): number => (
        Math.min(maximum, Math.max(minimum, Math.floor(readNumber(envName, configuredValue ?? fallback))))
    );
    return {
        profile,
        maxTurns: boundedInteger("CLI_AGENT_MAX_TURNS", configured.maxTurns, budget.maxTurns, budget.maxTurns),
        maxSegments: boundedInteger("CLI_AGENT_MAX_SEGMENTS", configured.maxSegments, budget.maxSegments, budget.maxSegments),
        maxDurationMs: boundedInteger(
            "CLI_AGENT_MAX_MINUTES",
            configured.maxDurationMinutes,
            budget.maxDurationMs / 60_000,
            budget.maxDurationMs / 60_000
        ) * 60_000,
        maxCompletionTokens: boundedInteger(
            "CLI_AGENT_MAX_COMPLETION_TOKENS",
            configured.maxCompletionTokens,
            budget.maxCompletionTokens,
            budget.maxCompletionTokens,
            256
        ),
        repeatLimit: boundedInteger("CLI_AGENT_REPEAT_LIMIT", configured.repeatLimit, budget.repeatLimit, budget.repeatLimit, 2)
    };
}

function getClarificationSettings(settings: CliSettings): { maxClarifications: number; requireInspection: boolean; secondRequiresBlocker: boolean } {
    const configured = settings.agent ?? {};
    return {
        maxClarifications: Math.max(0, Math.floor(readNumber("CLI_AGENT_MAX_CLARIFICATIONS", configured.maxClarifications ?? 2))),
        requireInspection: readBoolean("CLI_AGENT_REQUIRE_INSPECTION_BEFORE_CLARIFICATION", configured.requireInspectionBeforeClarification ?? true),
        secondRequiresBlocker: readBoolean("CLI_AGENT_SECOND_CLARIFICATION_REQUIRES_BLOCKER", configured.secondClarificationRequiresBlocker ?? true)
    };
}

function getProjectCheckProviders(settings: CliSettings): ProjectCheckProvider[] {
    if (!Array.isArray(settings.projectChecks)) return [];
    return settings.projectChecks.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const manifest = typeof candidate.manifest === "string" ? candidate.manifest.trim().replace(/\\/g, "/") : "";
        const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
        if (!manifest || !command || path.isAbsolute(manifest) || manifest.split("/").includes("..") || /[\r\n]/.test(command)) return [];
        const strings = (value: unknown, prefix = "") => Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
                .map((item) => `${prefix}${item.trim().toLowerCase().replace(/^\.?/, "")}`)
            : [];
        return [{
            manifest,
            command,
            ...(typeof candidate.label === "string" && candidate.label.trim() ? { label: candidate.label.trim().slice(0, 120) } : {}),
            ...(typeof candidate.ecosystem === "string" && candidate.ecosystem.trim() ? { ecosystem: candidate.ecosystem.trim().toLowerCase().slice(0, 40) } : {}),
            affectedExtensions: strings(candidate.affectedExtensions, "."),
            affectedFiles: strings(candidate.affectedFiles)
        }];
    });
}

module.exports = {
    getClarificationSettings,
    getProjectCheckProviders,
    initializeCliSettings,
    validateCliSettings,
    validateCliSettingsFile,
    loadCliSettings,
    getSamplingSettings,
    getAgentGuardSettings
};
