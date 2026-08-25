import assert = require("node:assert/strict");
import http = require("node:http");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

const { getLlmConnectionSettings, loadApiEndpointSettings, validateCliSettings } = require("../cli/config") as {
    loadApiEndpointSettings: (root: string) => {
        provider?: "llama.cpp" | "openrouter";
        apiUrl?: string;
        bearerToken?: string;
        apiKeyEnv?: string;
        httpReferer?: string;
        xTitle?: string;
        model?: string;
        reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean };
        capabilities?: Record<string, boolean>;
    } | undefined;
    getLlmConnectionSettings: (settings: Record<string, unknown>, environment?: NodeJS.ProcessEnv) => {
        provider: "llama.cpp" | "openrouter";
        apiUrl: string;
        headers: Record<string, string>;
        apiKeyEnv?: string;
        reasoning?: Record<string, unknown>;
        capabilities?: Record<string, boolean>;
    };
    validateCliSettings: (settings: unknown) => string[];
};
const { LlamaCppProvider } = require("../cli/model/llamaCppProvider") as {
    LlamaCppProvider: new (apiUrl: string, timeoutMs?: number, options?: {
        headers?: Record<string, string>;
        healthCheckOnRetry?: boolean;
        provider?: "llama.cpp" | "openrouter";
        capabilities?: Record<string, boolean>;
    }) => {
        chat: (request: {
            model: string;
            messages: Array<{ role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string }>;
            responseFormat?: Record<string, unknown>;
            allowNativeTools?: boolean;
            sampling?: Record<string, unknown>;
        }) => Promise<{ content: string; rawProviderContent?: string; toolCall?: { id: string; name: string; arguments: string }; transportMeta?: Record<string, unknown> }>;
        close: () => void;
    };
};
const { resolveModelCapabilities, selectModelProtocol } = require("../cli/model/modelCapabilities") as {
    resolveModelCapabilities: (provider: "llama.cpp" | "openrouter", configured?: Record<string, boolean>) => Record<string, boolean>;
    selectModelProtocol: (capabilities: Record<string, boolean>) => string;
};
const { normalizeOpenRouterResponseFormat } = require("../cli/model/openRouterCompat") as {
    normalizeOpenRouterResponseFormat: (format: Record<string, unknown>, strictSchema?: boolean) => Record<string, unknown>;
};
const { buildOpenRouterTools } = require("../cli/model/openRouterTools") as {
    buildOpenRouterTools: (format: Record<string, unknown>) => Array<{ function?: { name?: string } }>;
};
const { getAllowedActionNames } = require("../cli/agentProtocol") as {
    getAllowedActionNames: (format: Record<string, unknown>) => string[];
};
const { AgentActionParser } = require("../cli/agent/agentActionParser") as {
    AgentActionParser: new (mcpTool: { resolveDirectCall: () => undefined }) => {
        admitContent: (content: string) => { ok: boolean; kind?: string };
    };
};
const { ActionAdmissionGate } = require("../cli/agent/action/actionAdmissionGate") as {
    ActionAdmissionGate: new (parser: { admitContent: (content: string) => { ok: boolean; kind?: string } }) => {
        admit: (input: { content: string; hasToolCall: boolean; finishReason: string; allowedActions?: string[] }) => { ok: boolean; kind?: string };
    };
};

const sharedCapabilities = resolveModelCapabilities("openrouter", { nativeTools: true, toolChoice: true });
assert.equal(selectModelProtocol(sharedCapabilities), "native_tools");
assert.equal(selectModelProtocol(resolveModelCapabilities("openrouter", { nativeTools: false })), "structured_output");
assert.equal(selectModelProtocol(resolveModelCapabilities("llama.cpp")), "constrained_json");
assert.equal(selectModelProtocol(resolveModelCapabilities("openrouter", {
    nativeTools: false,
    structuredOutput: false,
    constrainedGeneration: false
})), "plain_json");
const firstModelCapabilities = resolveModelCapabilities("openrouter", { nativeTools: true, toolChoice: true });
const secondModelCapabilities = resolveModelCapabilities("openrouter", { nativeTools: true, toolChoice: true });
assert.equal(
    selectModelProtocol(firstModelCapabilities),
    selectModelProtocol(secondModelCapabilities)
);
assert.deepEqual(normalizeOpenRouterResponseFormat({ type: "json_object", schema: { type: "object" } }, true), {
    type: "json_schema",
    json_schema: { name: "agent_action", strict: true, schema: { type: "object" } }
});
const mixedActionTools = buildOpenRouterTools({
    type: "json_object",
    schema: {
        oneOf: [
            {
                type: "object",
                properties: {
                    action: { const: "write_file" },
                    path: { type: "string" },
                    content: { type: "string" }
                },
                required: ["action", "path", "content"],
                additionalProperties: false
            },
            {
                type: "object",
                properties: {
                    action: { const: "refine_task" },
                    task: { type: "object" },
                    evidence: { type: "array" }
                },
                required: ["action", "task", "evidence"],
                additionalProperties: false
            }
        ]
    }
});
assert.deepEqual(mixedActionTools.map((tool) => tool.function?.name), ["write_file", "refine_task"]);

assert.deepEqual(validateCliSettings({
    provider: "openrouter",
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY"
}), []);

const connection = getLlmConnectionSettings({
    provider: "openrouter",
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
    httpReferer: "https://example.test",
    xTitle: "CLI test"
}, { OPENROUTER_API_KEY: "unit-test-key" });
assert.equal(connection.headers.Authorization, "Bearer unit-test-key");
assert.equal(connection.headers["HTTP-Referer"], "https://example.test");
assert.equal(connection.headers["X-Title"], "CLI test");
assert.throws(
    () => getLlmConnectionSettings({ provider: "openrouter" }, {}),
    /OPENROUTER_API_KEY is not set/
);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-openrouter-test-"));
try {
    const configDirectory = path.join(temporaryRoot, ".cli");
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(path.join(configDirectory, "api-endpoints.template.json"), JSON.stringify({
        provider: "openrouter",
        apiUrl: "https://openrouter.ai/api/v1/chat/completions",
        bearerToken: "<PUT_OPENROUTER_KEY_HERE>",
        httpReferer: "<YOUR_SITE_URL>",
        xTitle: "<YOUR_SITE_NAME>",
        model: "openai/gpt-4o",
        reasoning: { effort: "low" },
        capabilities: { nativeTools: true, toolChoice: true }
    }));
    fs.writeFileSync(path.join(configDirectory, "api-endpoints.json"), JSON.stringify({
        provider: "openrouter",
        apiUrl: "https://openrouter.ai/api/v1/chat/completions",
        bearerToken: "unit-test-key",
        httpReferer: "https://example.test",
        xTitle: "CLI test",
        model: "openai/gpt-4o",
        reasoning: { effort: "low" },
        capabilities: { nativeTools: true, toolChoice: true }
    }));
    const loadedEndpoint = loadApiEndpointSettings(temporaryRoot);
    assert.equal(loadedEndpoint?.bearerToken, "unit-test-key");
    assert.equal(loadedEndpoint?.model, "openai/gpt-4o");
    assert.equal(loadedEndpoint?.reasoning?.effort, "low");
    assert.equal(loadedEndpoint?.capabilities?.nativeTools, true);
    const loadedConnection = getLlmConnectionSettings({ apiEndpoint: loadedEndpoint }, {});
    assert.equal(loadedConnection.reasoning?.effort, "low");
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

async function main(): Promise<void> {
let requestCount = 0;
const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
        assert.equal(request.headers.authorization, "Bearer unit-test-key");
        assert.equal(request.headers["http-referer"], "https://example.test");
        assert.equal(request.headers["x-title"], "CLI test");
        requestCount += 1;
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        assert.equal(payload.model, "openai/gpt-4o");
        if (requestCount === 1) {
            assert.deepEqual(payload.response_format, { type: "json_object" });
            assert.deepEqual(payload.plugins, [{ id: "response-healing" }]);
            assert.equal(payload.tools, undefined);
            assert.equal(payload.repeat_penalty, undefined);
            assert.equal(payload.repetition_penalty, undefined);
            assert.equal(payload.top_k, 40);
            response.statusCode = 400;
            response.end(JSON.stringify({
                error: {
                    message: "Provider returned error",
                    metadata: { raw: "response format rejected by provider" }
                }
            }));
            return;
        }
        if (requestCount === 2) {
            assert.equal(payload.response_format, undefined);
            assert.equal(payload.plugins, undefined);
            assert.equal(payload.reasoning, undefined);
            assert.equal(payload.top_k, undefined);
            assert.equal(payload.temperature, 0.1);
            assert.equal(payload.top_p, undefined);
            assert.equal(payload.max_tokens, 256);
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({ action: "write_file", path: "main.go", content: "bad" })
                    }
                }]
            }));
            return;
        }
        if (requestCount === 5) {
            response.statusCode = 429;
            response.end(JSON.stringify({
                error: {
                    message: "temporarily rate-limited upstream"
                }
            }));
            return;
        }
        assert.ok(requestCount === 3 || requestCount === 4);
        assert.equal(payload.response_format, undefined);
        assert.equal(payload.plugins, undefined);
        assert.equal(payload.tool_choice, "required");
        assert.ok(Array.isArray(payload.tools));
        const tools = payload.tools as Array<{ function?: { name?: string; parameters?: Record<string, unknown> } }>;
        const writeTool = tools.find((tool) => tool.function?.name === "write_file");
        assert.ok(writeTool);
        assert.equal((writeTool.function?.parameters?.properties as Record<string, unknown>).action, undefined);
        assert.deepEqual((writeTool.function?.parameters?.required as string[]).sort(), ["content", "path"]);
        const argumentsPayload = requestCount === 3
            ? JSON.stringify({ path: "main.go", content: "package main", reason: "create the file" })
            : '{"path":';
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
            choices: [{
                message: {
                    content: null,
                    tool_calls: [{
                        id: requestCount === 3 ? "call_write_1" : "call_write_malformed",
                        type: "function",
                        function: { name: "write_file", arguments: argumentsPayload }
                    }]
                },
                finish_reason: "tool_calls"
            }]
        }));
    });
});

await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
});

try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
    const provider = new LlamaCppProvider(`http://127.0.0.1:${address.port}/v1/chat/completions`, 5000, {
        headers: connection.headers,
        healthCheckOnRetry: false,
        provider: "openrouter",
        capabilities: { nativeTools: true, toolChoice: true, structuredOutput: true }
    });
    try {
        const fallbackResponseFormat = {
            type: "json_object",
            schema: {
                oneOf: [
                    {
                        type: "object",
                        properties: {
                            action: { const: "read_file" },
                            path: { type: "string" }
                        },
                        required: ["action", "path"],
                        additionalProperties: false
                    },
                    {
                        type: "object",
                        properties: {
                            action: { const: "search_project" },
                            query: { type: "string" }
                        },
                        required: ["action", "query"],
                        additionalProperties: false
                    }
                ]
            }
        };
        const response = await provider.chat({
            model: "openai/gpt-4o",
            messages: [{ role: "user", content: "hello" }],
            responseFormat: fallbackResponseFormat,
            allowNativeTools: false,
            sampling: { temperature: 0.1, top_k: 40, repeat_penalty: 1.08, max_tokens: 256 }
        });
        assert.deepEqual(JSON.parse(response.content), {
            action: "write_file",
            path: "main.go",
            content: "bad"
        });
        assert.equal(response.transportMeta?.requestProtocol, "structured_output");
        assert.equal(response.transportMeta?.finalProtocol, "plain_json");
        assert.equal(response.transportMeta?.initialHttpStatus, 400);
        assert.equal(response.transportMeta?.finalHttpStatus, 200);
        assert.equal(response.transportMeta?.usedFallback, true);
        assert.equal(response.transportMeta?.usedResponseHealing, true);
        assert.doesNotMatch(JSON.stringify(response.transportMeta), /unit-test-key/);

        const allowedFallbackActions = getAllowedActionNames(fallbackResponseFormat);
        assert.deepEqual(allowedFallbackActions, ["read_file", "search_project"]);
        let fallbackExecutorCalled = false;
        const fallbackAdmission = new ActionAdmissionGate(
            new AgentActionParser({ resolveDirectCall: () => undefined })
        ).admit({
            content: response.content,
            hasToolCall: false,
            finishReason: "stop",
            allowedActions: allowedFallbackActions
        });
        if (fallbackAdmission.ok) fallbackExecutorCalled = true;
        assert.equal(fallbackAdmission.ok, false);
        assert.equal(fallbackAdmission.kind, "semantic_invalid");
        assert.equal(fallbackExecutorCalled, false);

        const toolResponse = await provider.chat({
            model: "openai/gpt-4o",
            messages: [{ role: "user", content: "create the file" }],
            responseFormat: {
                type: "json_object",
                schema: {
                    oneOf: [{
                        type: "object",
                        properties: {
                            action: { const: "write_file" },
                            path: { type: "string" },
                            content: { type: "string" },
                            reason: { type: "string" }
                        },
                        required: ["action", "path", "content"],
                        additionalProperties: false
                    }]
                }
            },
            allowNativeTools: true,
            sampling: { temperature: 0.1, max_tokens: 256 }
        });
        assert.equal(toolResponse.toolCall?.name, "write_file");
        assert.equal(toolResponse.toolCall?.id, "call_write_1");
        assert.equal(toolResponse.rawProviderContent, toolResponse.toolCall?.arguments);
        assert.equal(toolResponse.transportMeta?.requestProtocol, "native_tools");
        assert.equal(toolResponse.transportMeta?.usedTools, true);
        assert.equal(toolResponse.transportMeta?.usedFallback, false);
        assert.deepEqual(JSON.parse(toolResponse.content), {
            action: "write_file",
            path: "main.go",
            content: "package main",
            reason: "create the file"
        });
        const malformedToolResponse = await provider.chat({
            model: "openai/gpt-4o",
            messages: [{ role: "user", content: "create the file" }],
            responseFormat: {
                type: "json_object",
                schema: {
                    oneOf: [{
                        type: "object",
                        properties: {
                            action: { const: "write_file" },
                            path: { type: "string" },
                            content: { type: "string" }
                        },
                        required: ["action", "path", "content"],
                        additionalProperties: false
                    }]
                }
            },
            sampling: { temperature: 0.1, max_tokens: 256 }
        });
        assert.equal(malformedToolResponse.toolCall?.id, "call_write_malformed");
        assert.equal(malformedToolResponse.content, '{"path":');
        const malformedToolAdmission = new ActionAdmissionGate(
            new AgentActionParser({ resolveDirectCall: () => undefined })
        ).admit({
            content: malformedToolResponse.content,
            hasToolCall: true,
            finishReason: "tool_calls"
        });
        assert.equal(malformedToolAdmission.ok, false);
        assert.ok(["syntax_invalid", "schema_invalid"].includes(String(malformedToolAdmission.kind)));

        await assert.rejects(
            provider.chat({
                model: "openai/gpt-4o",
                messages: [{ role: "user", content: "rate limit test" }],
                responseFormat: { type: "json_object", schema: { oneOf: [{ type: "object" }] } },
                allowNativeTools: false,
                sampling: { max_tokens: 256 }
            }),
            (error: any) => error?.transportMeta?.initialHttpStatus === 429
                && error?.transportMeta?.finalHttpStatus === 429
                && error?.transportMeta?.usedFallback === false
        );
        assert.equal(requestCount, 5);
    } finally {
        provider.close();
    }
    assert.equal(requestCount, 5);
} finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("OpenRouter configuration tests passed.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
