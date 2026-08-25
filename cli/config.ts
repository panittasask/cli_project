import fs = require("node:fs");
import path = require("node:path");
const { DEFAULT_LLM_MESSAGE_COLOR, isSupportedTerminalColor, normalizeTerminalColor } = require("./terminalStyle") as {
    DEFAULT_LLM_MESSAGE_COLOR: string;
    isSupportedTerminalColor: (value: unknown) => boolean;
    normalizeTerminalColor: (value: unknown) => string | undefined;
};

type SamplingSettings = {
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
    max_tokens: number;
};

type SamplingProfile = Partial<SamplingSettings>;
type ReasoningEffort = "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

type ApiEndpointSettings = {
    provider?: "llama.cpp" | "openrouter";
    apiUrl?: string;
    bearerToken?: string;
    apiKeyEnv?: string;
    httpReferer?: string;
    xTitle?: string;
    model?: string;
    requestDelayMs?: number;
    reasoning?: {
        effort?: ReasoningEffort;
        max_tokens?: number;
        exclude?: boolean;
    };
    capabilities?: {
        nativeTools?: boolean;
        toolChoice?: boolean;
        structuredOutput?: boolean;
        strictSchema?: boolean;
        constrainedGeneration?: boolean;
        responseHealing?: boolean;
    };
};

type CliSettings = {
    llamaCppPath?: string;
    modelPath?: string;
    provider?: "llama.cpp" | "openrouter";
    apiUrl?: string;
    apiKeyEnv?: string;
    httpReferer?: string;
    xTitle?: string;
    apiEndpoint?: ApiEndpointSettings;
    routerMode?: boolean;
    modelsMax?: number;
    defaultModel?: string;
    contextLength?: number;
    device?: string;
    hardwareProfile?: "auto" | "intel-arc" | "rtx-4070-super" | "default";
    llamaRuntime?: {
        fit?: "on" | "off";
        gpuLayers?: string;
        batchSize?: number;
        ubatchSize?: number;
        kvCacheType?: string;
        reasoningBudget?: number;
    };
    debug?: boolean;
    historyMessages?: number;
    terminal?: {
        llmMessageColor?: string | number;
    };
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

type LlmConnectionSettings = {
    provider: "llama.cpp" | "openrouter";
    apiUrl: string;
    headers: Record<string, string>;
    apiKeyEnv?: string;
    model?: string;
    requestDelayMs: number;
    reasoning?: Record<string, unknown>;
    capabilities?: ApiEndpointSettings["capabilities"];
};

const DEFAULT_LLAMA_API_URL = "http://127.0.0.1:8080/v1/chat/completions";
const DEFAULT_OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const agentBudgetProfiles: Record<AgentBudgetProfile, Omit<AgentBudgetSettings, "profile">> = {
    quick: {
        maxTurns: 6,
        maxSegments: 1,
        maxDurationMs: 4 * 60_000,
        maxCompletionTokens: 4_000,
        repeatLimit: 2
    },
    standard: {
        maxTurns: 12,
        maxSegments: 1,
        maxDurationMs: 8 * 60_000,
        maxCompletionTokens: 8_000,
        repeatLimit: 2
    },
    deep: {
        maxTurns: 12,
        maxSegments: 2,
        maxDurationMs: 20 * 60_000,
        maxCompletionTokens: 12_000,
        repeatLimit: 2
    }
};

// Profiles supply defaults only. Explicit user settings and environment
// overrides are allowed to request a larger budget within these global safety
// ceilings; a profile must not silently rewrite a saved user preference.
const agentBudgetLimits = {
    // maxTurns and maxDurationMinutes accept 0 for an unbounded agent run.
    // Positive values remain optional step/time limits for callers that need them.
    maxTurns: 1_000,
    maxSegments: 20,
    maxDurationMinutes: 720,
    maxCompletionTokens: 128_000,
    repeatLimit: 20
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
        max_tokens: 4096
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
    if (!parsed || typeof parsed !== "object") return {};
    const apiEndpoint = loadApiEndpointSettings(appRoot);
    return apiEndpoint ? { ...parsed, apiEndpoint } : parsed;
}

function readJsonObject(filePath: string, label: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must contain one JSON object.`);
    }
    return parsed as Record<string, unknown>;
}

function loadApiEndpointSettings(appRoot = process.cwd()): ApiEndpointSettings | undefined {
    const templatePath = path.resolve(appRoot, ".cli", "api-endpoints.template.json");
    const actualPath = path.resolve(appRoot, ".cli", "api-endpoints.json");
    if (!fs.existsSync(actualPath)) return undefined;
    if (!fs.existsSync(templatePath)) {
        throw new Error(`API endpoint template not found: ${templatePath}`);
    }

    const template = readJsonObject(templatePath, "api-endpoints.template.json");
    const actual = readJsonObject(actualPath, "api-endpoints.json");
    const allowedFields = new Set(Object.keys(template));
    const unknownFields = Object.keys(actual).filter((field) => !allowedFields.has(field));
    if (unknownFields.length > 0) {
        throw new Error(`api-endpoints.json contains fields not defined by api-endpoints.template.json: ${unknownFields.join(", ")}`);
    }

    const readOptionalString = (field: string): string | undefined => {
        if (actual[field] === undefined) return undefined;
        if (typeof actual[field] !== "string") throw new Error(`api-endpoints.json field '${field}' must be a string.`);
        const value = actual[field].trim();
        return value || undefined;
    };
    const provider = readOptionalString("provider");
    if (provider !== undefined && provider !== "llama.cpp" && provider !== "openrouter") {
        throw new Error("api-endpoints.json field 'provider' must be llama.cpp or openrouter.");
    }

    const apiUrl = readOptionalString("apiUrl");
    if (apiUrl) {
        try {
            const parsed = new URL(apiUrl);
            if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
        } catch {
            throw new Error("api-endpoints.json field 'apiUrl' must use http or https.");
        }
    }

    let requestDelayMs: number | undefined;
    if (actual.requestDelayMs !== undefined) {
        if (typeof actual.requestDelayMs !== "number" || !Number.isInteger(actual.requestDelayMs) || actual.requestDelayMs < 0 || actual.requestDelayMs > 300_000) {
            throw new Error("api-endpoints.json field 'requestDelayMs' must be an integer from 0 to 300000.");
        }
        requestDelayMs = actual.requestDelayMs;
    }

    let reasoning: ApiEndpointSettings["reasoning"];
    if (actual.reasoning !== undefined) {
        if (!actual.reasoning || typeof actual.reasoning !== "object" || Array.isArray(actual.reasoning)) {
            throw new Error("api-endpoints.json field 'reasoning' must be an object.");
        }
        const configuredReasoning = actual.reasoning as Record<string, unknown>;
        const effort = configuredReasoning.effort;
        if (effort !== undefined && (typeof effort !== "string" || !["max", "xhigh", "high", "medium", "low", "minimal", "none"].includes(effort))) {
            throw new Error("api-endpoints.json field 'reasoning.effort' is invalid.");
        }
        const maxTokens = configuredReasoning.max_tokens;
        if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1)) {
            throw new Error("api-endpoints.json field 'reasoning.max_tokens' must be a positive integer.");
        }
        const exclude = configuredReasoning.exclude;
        if (exclude !== undefined && typeof exclude !== "boolean") {
            throw new Error("api-endpoints.json field 'reasoning.exclude' must be boolean.");
        }
        const unknownReasoningFields = Object.keys(configuredReasoning).filter((field) => !["effort", "max_tokens", "exclude"].includes(field));
        if (unknownReasoningFields.length > 0) {
            throw new Error(`api-endpoints.json reasoning contains unsupported fields: ${unknownReasoningFields.join(", ")}`);
        }
        const parsedReasoning: NonNullable<ApiEndpointSettings["reasoning"]> = {};
        if (typeof effort === "string") parsedReasoning.effort = effort as ReasoningEffort;
        if (typeof maxTokens === "number") parsedReasoning.max_tokens = maxTokens;
        if (typeof exclude === "boolean") parsedReasoning.exclude = exclude;
        reasoning = parsedReasoning;
    }

    let capabilities: ApiEndpointSettings["capabilities"];
    if (actual.capabilities !== undefined) {
        if (!actual.capabilities || typeof actual.capabilities !== "object" || Array.isArray(actual.capabilities)) {
            throw new Error("api-endpoints.json field 'capabilities' must be an object.");
        }
        const configuredCapabilities = actual.capabilities as Record<string, unknown>;
        const supportedCapabilityFields = [
            "nativeTools",
            "toolChoice",
            "structuredOutput",
            "strictSchema",
            "constrainedGeneration",
            "responseHealing"
        ] as const;
        const unknownCapabilityFields = Object.keys(configuredCapabilities)
            .filter((field) => !supportedCapabilityFields.includes(field as typeof supportedCapabilityFields[number]));
        if (unknownCapabilityFields.length > 0) {
            throw new Error(`api-endpoints.json capabilities contains unsupported fields: ${unknownCapabilityFields.join(", ")}`);
        }
        const parsedCapabilities: NonNullable<ApiEndpointSettings["capabilities"]> = {};
        for (const field of supportedCapabilityFields) {
            const value = configuredCapabilities[field];
            if (value !== undefined && typeof value !== "boolean") {
                throw new Error(`api-endpoints.json field 'capabilities.${field}' must be boolean.`);
            }
            if (typeof value === "boolean") parsedCapabilities[field] = value;
        }
        capabilities = parsedCapabilities;
    }

    return {
        ...(provider ? { provider } : {}),
        ...(apiUrl ? { apiUrl } : {}),
        ...(["bearerToken", "apiKeyEnv", "httpReferer", "xTitle", "model"].reduce<Record<string, string>>((result, field) => {
            const value = readOptionalString(field);
            if (value) result[field] = value;
            return result;
        }, {}) as Pick<ApiEndpointSettings, "bearerToken" | "apiKeyEnv" | "httpReferer" | "xTitle" | "model">),
        ...(requestDelayMs !== undefined ? { requestDelayMs } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(capabilities ? { capabilities } : {})
    };
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
    if (settings.provider !== undefined && (typeof settings.provider !== "string" || !["llama.cpp", "openrouter"].includes(settings.provider))) {
        errors.push("provider must be llama.cpp or openrouter");
    }
    for (const field of ["apiUrl", "apiKeyEnv", "httpReferer", "xTitle"]) {
        if (settings[field] !== undefined && (typeof settings[field] !== "string" || !String(settings[field]).trim())) errors.push(`${field} must be a non-empty string`);
    }
    if (settings.apiKeyEnv !== undefined && (typeof settings.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.apiKeyEnv))) {
        errors.push("apiKeyEnv must be a valid environment variable name");
    }
    if (settings.hardwareProfile !== undefined && (typeof settings.hardwareProfile !== "string"
        || !["auto", "intel-arc", "rtx-4070-super", "default"].includes(settings.hardwareProfile))) {
        errors.push("hardwareProfile must be auto, intel-arc, rtx-4070-super, or default");
    }
    if (settings.llamaRuntime !== undefined && (!settings.llamaRuntime || typeof settings.llamaRuntime !== "object" || Array.isArray(settings.llamaRuntime))) {
        errors.push("llamaRuntime must be an object");
    } else if (settings.llamaRuntime) {
        const runtime = settings.llamaRuntime as Record<string, unknown>;
        if (runtime.fit !== undefined && (typeof runtime.fit !== "string" || !["on", "off"].includes(runtime.fit))) {
            errors.push("llamaRuntime.fit must be on or off");
        }
        if (runtime.gpuLayers !== undefined && (typeof runtime.gpuLayers !== "string" || !/^(?:all|auto|\d+)$/i.test(runtime.gpuLayers.trim()))) {
            errors.push("llamaRuntime.gpuLayers must be all, auto, or a non-negative integer");
        }
        numberField(runtime, "batchSize", "llamaRuntime.batchSize", 1);
        numberField(runtime, "ubatchSize", "llamaRuntime.ubatchSize", 1);
        if (typeof runtime.batchSize === "number" && typeof runtime.ubatchSize === "number" && runtime.ubatchSize > runtime.batchSize) {
            errors.push("llamaRuntime.ubatchSize must not exceed llamaRuntime.batchSize");
        }
        const allowedCacheTypes = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];
        if (runtime.kvCacheType !== undefined && (typeof runtime.kvCacheType !== "string" || !allowedCacheTypes.includes(runtime.kvCacheType.trim().toLowerCase()))) {
            errors.push("llamaRuntime.kvCacheType is not a supported KV cache type");
        }
        numberField(runtime, "reasoningBudget", "llamaRuntime.reasoningBudget", -1);
    }

    if (settings.terminal !== undefined && (!settings.terminal || typeof settings.terminal !== "object" || Array.isArray(settings.terminal))) {
        errors.push("terminal must be an object");
    } else if (settings.terminal) {
        const terminal = settings.terminal as Record<string, unknown>;
        if (terminal.llmMessageColor !== undefined && !isSupportedTerminalColor(terminal.llmMessageColor)) {
            errors.push("terminal.llmMessageColor must be a supported color name or ANSI foreground code (30-37, 39, or 90-97)");
        }
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
        numberField(agent, "maxTurns", "agent.maxTurns", 0, agentBudgetLimits.maxTurns);
        numberField(agent, "maxSegments", "agent.maxSegments", 0, agentBudgetLimits.maxSegments);
        numberField(agent, "maxDurationMinutes", "agent.maxDurationMinutes", 0, agentBudgetLimits.maxDurationMinutes);
        numberField(agent, "maxCompletionTokens", "agent.maxCompletionTokens", 0, agentBudgetLimits.maxCompletionTokens);
        numberField(agent, "repeatLimit", "agent.repeatLimit", 2, agentBudgetLimits.repeatLimit);
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
        maxTurns: boundedInteger("CLI_AGENT_MAX_TURNS", configured.maxTurns, budget.maxTurns, agentBudgetLimits.maxTurns, 0),
        maxSegments: boundedInteger("CLI_AGENT_MAX_SEGMENTS", configured.maxSegments, budget.maxSegments, agentBudgetLimits.maxSegments, 0),
        maxDurationMs: boundedInteger(
            "CLI_AGENT_MAX_MINUTES",
            configured.maxDurationMinutes,
            budget.maxDurationMs / 60_000,
            agentBudgetLimits.maxDurationMinutes,
            0
        ) * 60_000,
        maxCompletionTokens: boundedInteger(
            "CLI_AGENT_MAX_COMPLETION_TOKENS",
            configured.maxCompletionTokens,
            budget.maxCompletionTokens,
            agentBudgetLimits.maxCompletionTokens,
            0
        ),
        repeatLimit: boundedInteger("CLI_AGENT_REPEAT_LIMIT", configured.repeatLimit, budget.repeatLimit, agentBudgetLimits.repeatLimit, 2)
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

function getTerminalSettings(settings: CliSettings): { llmMessageColor: string } {
    return {
        llmMessageColor: normalizeTerminalColor(settings.terminal?.llmMessageColor) ?? DEFAULT_LLM_MESSAGE_COLOR
    };
}

function getLlmConnectionSettings(settings: CliSettings, environment: NodeJS.ProcessEnv = process.env): LlmConnectionSettings {
    const endpoint = settings.apiEndpoint;
    const configuredProvider = environment.LLM_PROVIDER?.trim().toLowerCase()
        || endpoint?.provider
        || settings.provider
        || "llama.cpp";
    const provider = configuredProvider === "openrouter" ? "openrouter" : configuredProvider === "llama.cpp" ? "llama.cpp" : undefined;
    if (!provider) {
        throw new Error("LLM_PROVIDER or settings.provider must be llama.cpp or openrouter.");
    }

    const apiUrl = environment.LLM_API_URL?.trim()
        || environment.LLAMA_API_URL?.trim()
        || endpoint?.apiUrl?.trim()
        || settings.apiUrl?.trim()
        || (provider === "openrouter" ? DEFAULT_OPENROUTER_API_URL : DEFAULT_LLAMA_API_URL);
    try {
        const parsed = new URL(apiUrl);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
    } catch {
        throw new Error(`LLM API URL must use http or https: ${apiUrl}`);
    }

    if (provider === "llama.cpp") {
        return {
            provider,
            apiUrl,
            headers: {},
            requestDelayMs: endpoint?.requestDelayMs ?? 0,
            ...(endpoint?.capabilities ? { capabilities: endpoint.capabilities } : {})
        };
    }

    const apiKeyEnv = environment.LLM_API_KEY_ENV?.trim()
        || endpoint?.apiKeyEnv?.trim()
        || settings.apiKeyEnv?.trim()
        || "OPENROUTER_API_KEY";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        throw new Error("apiKeyEnv must be a valid environment variable name.");
    }
    const bearerToken = endpoint?.bearerToken?.trim();
    const configuredBearerToken = bearerToken && !/^<[^>]+>$/.test(bearerToken) ? bearerToken : undefined;
    const apiKey = configuredBearerToken || environment[apiKeyEnv]?.trim();
    if (!apiKey) {
        throw new Error(`OpenRouter is selected, but ${apiKeyEnv} is not set. Put the key in the environment; do not save it in settings.json.`);
    }

    const httpReferer = environment.OPENROUTER_HTTP_REFERER?.trim() || settings.httpReferer?.trim();
    const xTitle = environment.OPENROUTER_X_TITLE?.trim() || settings.xTitle?.trim();
    return {
        provider,
        apiUrl,
        apiKeyEnv,
        requestDelayMs: endpoint?.requestDelayMs ?? 0,
        ...(endpoint?.model?.trim() ? { model: endpoint.model.trim() } : {}),
        reasoning: endpoint?.reasoning ?? { effort: "low" },
        ...(endpoint?.capabilities ? { capabilities: endpoint.capabilities } : {}),
        headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(httpReferer ? { "HTTP-Referer": httpReferer } : {}),
            ...(xTitle ? { "X-Title": xTitle } : {})
        }
    };
}

module.exports = {
    getClarificationSettings,
    getProjectCheckProviders,
    getTerminalSettings,
    initializeCliSettings,
    validateCliSettings,
    validateCliSettingsFile,
    loadCliSettings,
    loadApiEndpointSettings,
    getSamplingSettings,
    getAgentGuardSettings,
    getLlmConnectionSettings
};
