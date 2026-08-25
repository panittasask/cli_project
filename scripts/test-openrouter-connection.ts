import fs = require("node:fs");
import path = require("node:path");

type EndpointConfig = {
    provider?: string;
    apiUrl?: string;
    bearerToken?: string;
    apiKeyEnv?: string;
    httpReferer?: string;
    xTitle?: string;
    model?: string;
};

function readEndpointConfig(): EndpointConfig {
    const configPath = path.resolve(process.cwd(), ".cli", "api-endpoints.json");
    if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(".cli/api-endpoints.json must contain one JSON object.");
    }
    return parsed as EndpointConfig;
}

function redact(value: unknown): unknown {
    if (typeof value === "string") {
        return value
            .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
            .replace(/sk-[A-Za-z0-9_-]+/gi, "[redacted]");
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            /authorization|bearerToken|apiKey|secret|token/i.test(key) ? "[redacted]" : redact(item)
        ]));
    }
    return value;
}

async function main(): Promise<void> {
    const config = readEndpointConfig();
    const apiUrl = config.apiUrl?.trim();
    const model = config.model?.trim();
    const bearerToken = config.bearerToken?.trim()
        || (config.apiKeyEnv ? process.env[config.apiKeyEnv]?.trim() : undefined)
        || process.env.OPENROUTER_API_KEY?.trim();

    if (!apiUrl) throw new Error("apiUrl is missing in .cli/api-endpoints.json.");
    if (!model) throw new Error("model is missing in .cli/api-endpoints.json.");
    if (!bearerToken || /^<[^>]+>$/.test(bearerToken)) {
        throw new Error("No usable bearer token was found in api-endpoints.json or the configured environment variable.");
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json"
    };
    if (config.httpReferer && !/^<[^>]+>$/.test(config.httpReferer)) headers["HTTP-Referer"] = config.httpReferer;
    if (config.xTitle && !/^<[^>]+>$/.test(config.xTitle)) headers["X-Title"] = config.xTitle;

    const payload = {
        model,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        temperature: 0,
        max_tokens: 16
    };

    console.log(`Testing OpenRouter connection: ${apiUrl}`);
    console.log(`Configured model: ${model}`);
    console.log("Request mode: plain chat completion (no tools, schema, plugins, or reasoning options)");

    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });
        const rawBody = await response.text();
        let body: unknown = rawBody;
        try {
            body = JSON.parse(rawBody) as unknown;
        } catch {
            // Keep non-JSON provider responses as text.
        }

        console.log(`HTTP status: ${response.status} ${response.statusText}`);
        console.log(`Request ID: ${response.headers.get("x-request-id") ?? "not provided"}`);
        console.log("Response:");
        console.log(JSON.stringify(redact(body), null, 2));
        process.exitCode = response.ok ? 0 : 1;
    } catch (error) {
        console.error("Connection failed:");
        console.error(redact(error instanceof Error ? error.message : error));
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("Test setup failed:");
    console.error(redact(error instanceof Error ? error.message : error));
    process.exitCode = 1;
});
