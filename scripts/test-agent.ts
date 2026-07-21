import assert = require("node:assert/strict");
import fs = require("node:fs");
import http = require("node:http");
import net = require("node:net");
import os = require("node:os");
import path = require("node:path");
const { loadCliSettings, getSamplingSettings, getAgentGuardSettings, getClarificationSettings, getProjectCheckProviders, initializeCliSettings, validateCliSettings, validateCliSettingsFile } = require("../cli/config") as {
    loadCliSettings: (root?: string) => Record<string, unknown>;
    getSamplingSettings: (settings: Record<string, unknown>, kind: "action") => Record<string, number>;
    getAgentGuardSettings: (settings: Record<string, unknown>) => {
        profile: "quick" | "standard" | "deep";
        maxTurns: number;
        maxSegments: number;
        maxDurationMs: number;
        maxCompletionTokens: number;
        repeatLimit: number;
    };
    getClarificationSettings: (settings: Record<string, unknown>) => { maxClarifications: number; requireInspection: boolean; secondRequiresBlocker: boolean };
    getProjectCheckProviders: (settings: Record<string, unknown>) => Array<Record<string, unknown>>;
    initializeCliSettings: (root?: string) => { created: boolean; path: string; message: string };
    validateCliSettings: (settings: unknown) => string[];
    validateCliSettingsFile: (root?: string) => { ok: boolean; source: string; errors: string[] };
};
const { AgentTool } = require("../cli/tools/agentTool") as { AgentTool: new (configRoot?: string, commandTimeoutOverrideMs?: number) => {
    parseAction: (content: string) => { action?: string; reason?: string; path?: string; old_text?: string; new_text?: string; workdir?: string } | undefined;
    explainParseFailure: (content: string) => string;
    formatActionStatus: (action: unknown, turn: number, maxTurns: number) => string;
    execute: (action: unknown) => Promise<{ ok: boolean; output: string; changed?: boolean }>;
    prepareEdit: (path: string, oldText: string, newText: string) => { ok: boolean; output: string; content?: string; changed?: boolean };
    close: () => Promise<void>;
} };
const { AgentResponseLog } = require("../cli/agentResponseLog") as { AgentResponseLog: new (logTarget?: string | { directory: string; basename: string }) => {
    append: (entry: Record<string, unknown>) => void;
} };
const { buildStatusBarFrame, formatStatusBar } = require("../cli/statusBar") as {
    buildStatusBarFrame: (state: { model: string; contextUsed: number; contextLimit: number; workspace: string }, columns: number, rows: number) => string;
    formatStatusBar: (state: { model: string; contextUsed: number; contextLimit: number; workspace: string }, columns: number) => string;
};
const { formatCompletionLine, formatElapsedTime, formatSpinnerLine } = require("../cli/spinner") as {
    formatCompletionLine: (milliseconds: number, completed?: boolean) => string;
    formatElapsedTime: (milliseconds: number) => string;
    formatSpinnerLine: (frame: string, message: string, stepMilliseconds: number, totalMilliseconds: number, columns?: number) => string;
};
const { formatSessionHistory } = require("../cli/sessionHistory") as {
    formatSessionHistory: (messages: Array<{ role: "user" | "assistant"; content: string }>, maxMessages?: number) => string;
};
const { formatLocalDate, resolveJsonlLogPath } = require("../cli/dailyLog") as {
    formatLocalDate: (date?: Date) => string;
    resolveJsonlLogPath: (target: string | { directory: string; basename: string }, date?: Date) => string;
};
const { AgentTrace } = require("../cli/agentTrace") as { AgentTrace: new (
    logTarget?: string | { directory: string; basename: string },
    taskId?: string,
    onEntry?: (entry: { action?: string }) => void
) => {
    add: (entry: Record<string, unknown>) => void;
    save: () => void;
} };
const { SessionTool } = require("../cli/session") as { SessionTool: new (storagePath?: string) => {
    getContextMessages: (sessionId: string, limit?: number, afterTimestamp?: number) => Array<{ content: string }>;
    resumeSession: (sessionId: string) => { id: string; workspace?: string } | undefined;
    setWorkspace: (sessionId: string, workspace: string) => boolean;
    deleteSession: (sessionId: string) => boolean;
    clearSessions: () => number;
    recordUsage: (sessionId: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
    getUsage: (sessionId: string) => {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        requestCount: number;
        activeContextTokens: number;
    };
    resetActiveContextUsage: (sessionId: string) => void;
} };
const { LlamaClient } = require("../cli/llamaClient") as { LlamaClient: new (apiUrl: string, timeoutMs?: number) => {
    post: (
        payload: Record<string, unknown>,
        onRetry?: (attempt: number, errorCode: string) => void,
        signal?: AbortSignal
    ) => Promise<{ data: { choices: Array<{ message: { content: string } }> } }>;
    formatError: (error: unknown) => string;
    close: () => void;
} };
const { ModelRouterClient, resolveRouterModel } = require("../cli/modelRouter") as {
    ModelRouterClient: new (apiUrl: string, timeoutMs?: number) => {
        list: () => Promise<Array<{ id: string; status: string }>>;
        switch: (selection: string) => Promise<{ model: { id: string; status: string }; unloaded: string[] }>;
    };
    resolveRouterModel: (models: Array<{ id: string; path?: string; status: string; failed: boolean }>, selection: string) => { id: string } | undefined;
};
const { aggregateTraceSummaries, parseTraceJsonl, summarizeTraceEvents } = require("../cli/traceSummary") as {
    parseTraceJsonl: (content: string) => Array<Record<string, unknown>>;
    summarizeTraceEvents: (events: Array<Record<string, unknown>>) => Array<{
        outcome: string;
        durationMs: number;
        modelCalls: number;
        toolActions: number;
        errors: number;
        repeatedOrNoProgress: number;
    }>;
    aggregateTraceSummaries: (summaries: Array<Record<string, unknown>>) => {
        tasks: number;
        successful: number;
        successRate: number;
        medianSuccessfulModelCalls: number;
        repeatedOrNoProgress: number;
    };
};

async function testRequestCancellation(): Promise<void> {
    const server = http.createServer((_request, _response) => {
        // Deliberately leave the request pending until AbortController cancels it.
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new LlamaClient(`http://127.0.0.1:${address.port}/v1/chat/completions`, 5000);
    const controller = new AbortController();
    const pending = client.post({ model: "test" }, undefined, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
        const code = (error as { code?: string }).code;
        return code === "ERR_CANCELED";
    });
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function testConnectionResetRetry(): Promise<void> {
    let completionRequests = 0;
    const server = http.createServer((request, response) => {
        if (request.url === "/health") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ status: "ok" }));
            return;
        }

        if (request.url === "/v1/chat/completions") {
            completionRequests += 1;
            if (completionRequests === 1) {
                request.socket.destroy();
                return;
            }

            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({
                choices: [{ message: { content: "recovered" } }]
            }));
            return;
        }

        response.writeHead(404);
        response.end();
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new LlamaClient(`http://127.0.0.1:${address.port}/v1/chat/completions`, 5000);
    let retries = 0;

    try {
        const response = await client.post({ model: "test", messages: [] }, () => {
            retries += 1;
        });
        assert.equal(response.data.choices[0]?.message.content, "recovered");
        assert.equal(completionRequests, 2);
        assert.equal(retries, 1);
        assert.equal(client.formatError(Object.assign(new Error("reset"), { code: "ECONNRESET" })), "reset");
    } finally {
        client.close();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

async function testModelRouterSwitch(): Promise<void> {
    const models = [
        { id: "alpha.gguf", path: "C:\\Models\\alpha.gguf", status: { value: "loaded" } },
        { id: "beta.gguf", path: "C:\\Models\\beta.gguf", status: { value: "unloaded" } }
    ];
    const actions: string[] = [];
    const server = http.createServer((request, response) => {
        if (request.method === "GET" && request.url?.startsWith("/models")) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ data: models }));
            return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
            const payload = JSON.parse(body) as { model: string };
            if (request.url === "/models/unload") {
                actions.push(`unload:${payload.model}`);
                const entry = models.find((candidate) => candidate.id === payload.model);
                if (entry) entry.status.value = "unloaded";
            } else if (request.url === "/models/load") {
                actions.push(`load:${payload.model}`);
                const entry = models.find((candidate) => candidate.id === payload.model);
                if (entry) entry.status.value = "loaded";
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ success: true }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const client = new ModelRouterClient(`http://127.0.0.1:${address.port}/v1/chat/completions`, 5000);
        const listed = await client.list();
        assert.equal(resolveRouterModel(listed as any, "2")?.id, "beta.gguf");
        assert.equal(resolveRouterModel(listed as any, "ALPHA.GGUF")?.id, "alpha.gguf");
        assert.equal(resolveRouterModel([{ id: "gamma", status: "unloaded", failed: false }], "gamma.gguf")?.id, "gamma");
        const result = await client.switch("beta.gguf");
        assert.equal(result.model.id, "beta.gguf");
        assert.deepEqual(result.unloaded, ["alpha.gguf"]);
        assert.deepEqual(actions, ["unload:alpha.gguf", "load:beta.gguf"]);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

async function main(): Promise<void> {
    await testConnectionResetRetry();
    await testRequestCancellation();
    await testModelRouterSwitch();

    const traceEvents = parseTraceJsonl([
        JSON.stringify({ taskId: "one", turn: 1, timestamp: "2026-07-20T00:00:00.000Z", status: "ok", action: "read_file" }),
        JSON.stringify({ taskId: "one", turn: 2, timestamp: "2026-07-20T00:01:00.000Z", status: "error", action: "repeat_guard", observation: "without file progress" }),
        JSON.stringify({ taskId: "one", turn: 3, timestamp: "2026-07-20T00:02:00.000Z", status: "final", action: "final" }),
        JSON.stringify({ taskId: "two", turn: 1, timestamp: "2026-07-20T00:03:00.000Z", status: "error", action: "incomplete_after_tool_limit" }),
        "not-json"
    ].join("\n"));
    const traceSummaries = summarizeTraceEvents(traceEvents);
    assert.equal(traceSummaries.length, 2);
    assert.deepEqual(traceSummaries[0], {
        taskId: "one",
        outcome: "success",
        firstTimestamp: "2026-07-20T00:00:00.000Z",
        lastTimestamp: "2026-07-20T00:02:00.000Z",
        durationMs: 120_000,
        modelCalls: 3,
        toolActions: 1,
        events: 3,
        errors: 1,
        repeatedOrNoProgress: 1,
        parseErrors: 0,
        finalBlocked: 0
    });
    const aggregateTrace = aggregateTraceSummaries(traceSummaries);
    assert.equal(aggregateTrace.tasks, 2);
    assert.equal(aggregateTrace.successful, 1);
    assert.equal(aggregateTrace.successRate, 0.5);
    assert.equal(aggregateTrace.medianSuccessfulModelCalls, 3);
    assert.equal(aggregateTrace.repeatedOrNoProgress, 1);

    const settings = loadCliSettings(path.resolve(__dirname, ".."));
    const configuredContextLength = settings.contextLength;
    assert.ok(typeof configuredContextLength === "number" && configuredContextLength > 0);
    const settingsInitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-settings-init-"));
    try {
        const prototypeDirectory = path.join(settingsInitRoot, ".cli");
        fs.mkdirSync(prototypeDirectory, { recursive: true });
        fs.copyFileSync(path.resolve(__dirname, "..", ".cli", "settings.example.json"), path.join(prototypeDirectory, "settings.example.json"));
        const prototypeSettings = loadCliSettings(settingsInitRoot);
        assert.deepEqual(getAgentGuardSettings(prototypeSettings), {
            profile: "standard",
            maxTurns: 12,
            maxSegments: 1,
            maxDurationMs: 480_000,
            maxCompletionTokens: 8000,
            repeatLimit: 2
        });
        assert.deepEqual(getClarificationSettings(prototypeSettings), {
            maxClarifications: 2,
            requireInspection: true,
            secondRequiresBlocker: true
        });
        assert.equal(getSamplingSettings(prototypeSettings, "action").max_tokens, 2048);
        assert.deepEqual(validateCliSettings(prototypeSettings), []);
        assert.equal(validateCliSettingsFile(settingsInitRoot).source, "settings.example.json");
        const initialized = initializeCliSettings(settingsInitRoot);
        assert.equal(initialized.created, true);
        assert.equal((loadCliSettings(settingsInitRoot).agent as Record<string, unknown>).maxSegments, 1);
        fs.writeFileSync(initialized.path, "{\"preserved\":true}\n", "utf8");
        const repeated = initializeCliSettings(settingsInitRoot);
        assert.equal(repeated.created, false);
        assert.deepEqual(loadCliSettings(settingsInitRoot), { preserved: true });
        fs.writeFileSync(initialized.path, JSON.stringify({ contextLength: 12, hardwareProfile: "unknown", agent: { maxSegments: 0 }, sampling: { action: { top_p: 3 } } }), "utf8");
        const invalidSettings = validateCliSettingsFile(settingsInitRoot);
        assert.equal(invalidSettings.ok, false);
        assert.match(invalidSettings.errors.join("\n"), /contextLength/);
        assert.match(invalidSettings.errors.join("\n"), /agent\.maxSegments/);
        assert.match(invalidSettings.errors.join("\n"), /sampling\.action\.top_p/);
        assert.match(invalidSettings.errors.join("\n"), /hardwareProfile/);
    } finally {
        fs.rmSync(settingsInitRoot, { recursive: true, force: true });
    }
    const actionSampling = getSamplingSettings({ sampling: { action: { max_tokens: 4096 } } }, "action");
    assert.equal(actionSampling.temperature, 0.1);
    assert.equal(actionSampling.max_tokens, 4096);
    assert.deepEqual(getAgentGuardSettings({
        agent: {
            maxTurns: 12,
            maxSegments: 1,
            maxDurationMinutes: 8,
            maxCompletionTokens: 8000,
            repeatLimit: 2
        }
    }), {
        profile: "standard",
        maxTurns: 12,
        maxSegments: 1,
        maxDurationMs: 480_000,
        maxCompletionTokens: 8000,
        repeatLimit: 2
    });
    assert.deepEqual(getAgentGuardSettings({ agent: {
        profile: "quick",
        maxTurns: 50,
        maxSegments: 3,
        maxDurationMinutes: 60,
        maxCompletionTokens: 16000,
        repeatLimit: 5
    } }), {
        profile: "quick",
        maxTurns: 4,
        maxSegments: 1,
        maxDurationMs: 180_000,
        maxCompletionTokens: 3000,
        repeatLimit: 2
    });
    assert.deepEqual(getAgentGuardSettings({ agent: { profile: "deep" } }), {
        profile: "deep",
        maxTurns: 12,
        maxSegments: 2,
        maxDurationMs: 1_200_000,
        maxCompletionTokens: 16000,
        repeatLimit: 2
    });
    assert.deepEqual(getClarificationSettings({ agent: {
        maxClarifications: 3,
        requireInspectionBeforeClarification: false,
        secondClarificationRequiresBlocker: false
    } }), { maxClarifications: 3, requireInspection: false, secondRequiresBlocker: false });
    assert.deepEqual(getProjectCheckProviders({ projectChecks: [{
        manifest: "deno.json",
        command: "deno test",
        affectedExtensions: ["ts"]
    }] }), [{
        manifest: "deno.json",
        command: "deno test",
        affectedExtensions: [".ts"],
        affectedFiles: []
    }]);
    assert.deepEqual(getProjectCheckProviders({ projectChecks: [{ manifest: "../outside.json", command: "bad\ncommand" }] }), []);

    const agent = new AgentTool();
    const action = agent.parseAction(JSON.stringify({
        action: "read_file",
        path: "README.md",
        reason: "Inspect the project documentation."
    }));
    assert.equal(action?.action, "read_file");
    assert.equal(action?.reason, "Inspect the project documentation.");
    assert.equal(agent.parseAction([
        "I will inspect the project.",
        JSON.stringify({ note: "not an action" }),
        "```json",
        JSON.stringify({
            action: "read_file",
            path: "package.json",
            reason: "Inspect package metadata."
        }),
        "```"
    ].join("\n"))?.action, "read_file");
    assert.equal(agent.parseAction('{"action":"read_file","path":"README.md","reason":"brace } inside a string"}')?.action, "read_file");
    const editAction = agent.parseAction(JSON.stringify({
        action: "edit_file",
        path: "login.html",
        old_text: "margin-top: 15px",
        new_text: "margin-top: 25px",
        reason: "Adjust spacing"
    }));
    assert.equal(editAction?.action, "edit_file");
    const deleteAction = agent.parseAction(JSON.stringify({
        action: "delete_file",
        path: "obsolete.txt",
        reason: "Remove an obsolete file."
    }));
    assert.equal(deleteAction?.action, "delete_file");
    assert.equal(deleteAction?.path, "obsolete.txt");
    assert.equal(editAction?.old_text, "margin-top: 15px");
    const commandAction = agent.parseAction(JSON.stringify({
        action: "run_command",
        command: "go test ./...",
        workdir: "go",
        reason: "Run Go tests in the module directory."
    }));
    assert.equal(commandAction?.action, "run_command");
    assert.equal(commandAction?.workdir, "go");
    assert.equal(agent.parseAction('{"action":"unknown_action"}'), undefined);
    assert.equal(agent.explainParseFailure("plain text summary"), "no valid JSON object found in model content");
    assert.equal(agent.explainParseFailure('{"action":"unknown_action"}'), "unsupported action: unknown_action");
    assert.equal(formatStatusBar({
        model: "model.gguf",
        contextUsed: 1200,
        contextLimit: 65536,
        workspace: "D:\\work"
    }, 120).length, 120);
    assert.equal(formatStatusBar({
        model: "very-long-model-name.gguf",
        contextUsed: 1200,
        contextLimit: 65536,
        workspace: "D:\\very-long-workspace"
    }, 30).length, 30);
    const fixedStatusFrame = buildStatusBarFrame({
        model: "model.gguf",
        contextUsed: 1200,
        contextLimit: 65536,
        workspace: "D:\\work"
    }, 120, 30);
    assert.ok(fixedStatusFrame.includes("\x1b[30;1H"));
    assert.ok(fixedStatusFrame.startsWith("\x1b7"));
    assert.ok(fixedStatusFrame.endsWith("\x1b8"));
    assert.ok(!fixedStatusFrame.includes("\n"));
    assert.equal(formatElapsedTime(0), "00:00");
    assert.equal(formatElapsedTime(65_000), "01:05");
    assert.equal(formatElapsedTime(3_661_000), "01:01:01");
    assert.equal(formatCompletionLine(434_000), "Completed in 07:14");
    assert.equal(formatCompletionLine(65_000, false), "Stopped after 01:05");
    const localLogDate = new Date(2026, 6, 16, 12, 0, 0);
    assert.equal(formatLocalDate(localLogDate), "2026-07-16");
    assert.equal(
        resolveJsonlLogPath({ directory: "D:\\logs", basename: "agent-trace" }, localLogDate),
        path.resolve("D:\\logs", "agent-trace-2026-07-16.jsonl")
    );
    const spinnerLine = formatSpinnerLine("⠹", "Reviewing results and planning (9/12)...", 98_000, 434_000, 80);
    assert.ok(spinnerLine.includes("step 01:38 | total 07:14"));
    assert.ok(spinnerLine.length <= 79);
    const renderedHistory = formatSessionHistory(Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `message ${index + 1}${index === 7 ? "\nsecond line" : ""}`
    })), 6);
    assert.ok(renderedHistory.includes("Recent session history (6 messages)"));
    assert.ok(!renderedHistory.includes("message 1"));
    assert.ok(!renderedHistory.includes("message 2"));
    assert.ok(renderedHistory.includes("message 3"));
    assert.ok(renderedHistory.includes("AI: message 8\n    second line"));
    assert.equal(formatSessionHistory([], 6), "No previous messages in this session.");
    assert.equal(
        agent.formatActionStatus({
            action: "read_file",
            path: "README.md",
            reason: "Inspect the project documentation."
        }, 1, 12),
        "[1/12] Reading file: README.md - Inspect the project documentation."
    );
    assert.ok(!agent.formatActionStatus({
        action: "run_command",
        command: "tool --token=secret-value",
        reason: "Verify the command"
    }, 2, 12).includes("secret-value"));
    const unixMkdir = await agent.execute({ action: "run_command", command: "mkdir -p LoginPage" });
    assert.equal(unixMkdir.ok, false);
    assert.match(unixMkdir.output, /Blocked unsafe command/);
    const forcedAudit = await agent.execute({ action: "run_command", command: "npm audit fix --force" });
    assert.equal(forcedAudit.ok, false);
    assert.match(forcedAudit.output, /Blocked unsafe command/);
    const auditMutation = await agent.execute({ action: "run_command", command: "npm audit fix" });
    assert.equal(auditMutation.ok, false);
    assert.match(auditMutation.output, /Blocked unsafe command/);
    const dependencyBypass = await agent.execute({ action: "run_command", command: "npm install --legacy-peer-deps" });
    assert.equal(dependencyBypass.ok, false);
    assert.match(dependencyBypass.output, /Blocked unsafe command/);
    const interactiveServer = await agent.execute({ action: "run_command", command: "ng serve --open" });
    assert.equal(interactiveServer.ok, false);
    assert.match(interactiveServer.output, /Blocked interactive command/);
    if (process.platform === "win32") {
        const reservation = net.createServer();
        await new Promise<void>((resolve, reject) => {
            reservation.once("error", reject);
            reservation.listen(0, "127.0.0.1", resolve);
        });
        const address = reservation.address();
        assert.ok(address && typeof address !== "string");
        const port = address.port;
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        const timeoutAgent = new AgentTool(process.cwd(), 750);
        try {
            const timedOut = await timeoutAgent.execute({
                action: "run_command",
                command: `node -e "require('node:net').createServer().listen(${port}); setInterval(function(){},1000)"`
            });
            assert.equal(timedOut.ok, false);
            assert.match(timedOut.output, /process tree was terminated/);
            const probe = net.createServer();
            await new Promise<void>((resolve, reject) => {
                probe.once("error", reject);
                probe.listen(port, "127.0.0.1", resolve);
            });
            await new Promise<void>((resolve) => probe.close(() => resolve()));
        } finally {
            await timeoutAgent.close();
        }
    }
    if (process.platform === "win32") {
        const powershellCheck = await agent.execute({ action: "run_command", command: "Write-Output 'powershell-ok'" });
        assert.equal(powershellCheck.ok, true);
        assert.match(powershellCheck.output, /powershell-ok/);
        const wrappedPowershellCheck = await agent.execute({
            action: "run_command",
            command: "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"Write-Output 'normalized-ok'\""
        });
        assert.equal(wrappedPowershellCheck.ok, true);
        assert.match(wrappedPowershellCheck.output, /normalized-ok/);
        const encodedPowershellCheck = await agent.execute({
            action: "run_command",
            command: "powershell.exe -EncodedCommand blocked"
        });
        assert.equal(encodedPowershellCheck.ok, false);
        assert.match(encodedPowershellCheck.output, /Unsupported nested PowerShell/);
        const unixCheck = await agent.execute({ action: "run_command", command: "grep margin-top login.html" });
        assert.equal(unixCheck.ok, false);
        assert.match(unixCheck.output, /Unsupported Unix command/);
        const destructiveCheck = await agent.execute({ action: "run_command", command: "Remove-Item stale.exe" });
        assert.equal(destructiveCheck.ok, false);
        assert.match(destructiveCheck.output, /Blocked unsafe command/);
    }
    const editDirectory = fs.mkdtempSync(path.join(process.cwd(), ".agent-edit-test-"));
    try {
        const editPath = path.join(editDirectory, "sample.html");
        fs.writeFileSync(editPath, ".button { margin-top: 15px; }", "utf8");
        const relativeEditPath = path.relative(process.cwd(), editPath);
        const relativeWorkdir = path.relative(process.cwd(), editDirectory);
        const emptyDirectory = path.join(editDirectory, "empty");
        fs.mkdirSync(emptyDirectory);
        const hiddenToolCache = path.join(editDirectory, ".tooling", "cache");
        fs.mkdirSync(hiddenToolCache, { recursive: true });
        fs.writeFileSync(path.join(hiddenToolCache, "noise.txt"), "generated", "utf8");
        fs.writeFileSync(path.join(editDirectory, "literal-search.txt"), "RouterModule.forRoot(routes)", "utf8");
        const literalSearch = await agent.execute({
            action: "search_files",
            query: "RouterModule.forRoot(routes)",
            path: path.relative(process.cwd(), editDirectory)
        });
        assert.equal(literalSearch.ok, true);
        assert.match(literalSearch.output, /literal-search\.txt/);
        const manifestDirectory = path.join(editDirectory, "recovery-project");
        fs.mkdirSync(manifestDirectory);
        fs.writeFileSync(path.join(manifestDirectory, "package.json"), "{}", "utf8");
        fs.writeFileSync(path.join(manifestDirectory, "package-lock.json"), JSON.stringify({
            lockfileVersion: 3,
            packages: { "": { name: "recovery-project", version: "1.2.3", dependencies: { library: "^4.5.6" } } }
        }), "utf8");
        const manifestRead = await agent.execute({
            action: "read_file",
            path: path.relative(process.cwd(), path.join(manifestDirectory, "package.json"))
        });
        assert.equal(manifestRead.ok, true);
        assert.match(manifestRead.output, /manifest disagrees with same-directory package-lock\.json/);
        assert.match(manifestRead.output, /\^4\.5\.6/);
        const filteredListResult = await agent.execute({
            action: "list_files",
            path: path.relative(process.cwd(), editDirectory)
        });
        assert.equal(filteredListResult.ok, true);
        assert.doesNotMatch(filteredListResult.output, /noise\.txt/);
        assert.match(filteredListResult.output, /sample\.html/);
        const missingRead = await agent.execute({
            action: "read_file",
            path: path.join(path.relative(process.cwd(), editDirectory), "sample.htm")
        });
        assert.equal(missingRead.ok, false);
        assert.match(missingRead.output, /Closest visible files/);
        assert.match(missingRead.output, /sample\.html/);
        const emptyListResult = await agent.execute({
            action: "list_files",
            path: path.relative(process.cwd(), emptyDirectory)
        });
        assert.equal(emptyListResult.ok, true);
        assert.equal(emptyListResult.output, "[Workspace is empty]");
        const workdirResult = await agent.execute({
            action: "run_command",
            command: process.platform === "win32" ? "(Get-Location).Path" : "pwd",
            workdir: relativeWorkdir
        });
        assert.equal(workdirResult.ok, true);
        assert.equal(path.resolve(workdirResult.output.trim()), path.resolve(editDirectory));
        const outsideWorkdir = await agent.execute({
            action: "run_command",
            command: process.platform === "win32" ? "Write-Output blocked" : "printf blocked",
            workdir: ".."
        });
        assert.equal(outsideWorkdir.ok, false);
        assert.match(outsideWorkdir.output, /outside workspace/);
        const preparedEdit = agent.prepareEdit(relativeEditPath, "margin-top: 15px", "margin-top: 25px");
        assert.equal(preparedEdit.ok, true);
        const editResult = await agent.execute({
            action: "edit_file",
            path: relativeEditPath,
            old_text: "margin-top: 15px",
            new_text: "margin-top: 25px"
        });
        assert.equal(editResult.ok, true);
        assert.equal(editResult.changed, true);
        assert.match(fs.readFileSync(editPath, "utf8"), /margin-top: 25px/);
        const repeatedEdit = await agent.execute({
            action: "edit_file",
            path: relativeEditPath,
            old_text: "margin-top: 15px",
            new_text: "margin-top: 25px"
        });
        assert.equal(repeatedEdit.ok, true);
        assert.equal(repeatedEdit.changed, false);
        assert.match(repeatedEdit.output, /No change needed/);
        const repeatedWrite = await agent.execute({
            action: "write_file",
            path: relativeEditPath,
            content: fs.readFileSync(editPath, "utf8")
        });
        assert.equal(repeatedWrite.ok, true);
        assert.equal(repeatedWrite.changed, false);
        const deletePath = path.join(editDirectory, "obsolete.txt");
        fs.writeFileSync(deletePath, "obsolete", "utf8");
        const deleteResult = await agent.execute({
            action: "delete_file",
            path: path.relative(process.cwd(), deletePath)
        });
        assert.equal(deleteResult.ok, true);
        assert.equal(fs.existsSync(deletePath), false);
        fs.writeFileSync(editPath, "same same", "utf8");
        assert.equal(agent.prepareEdit(relativeEditPath, "same", "next").ok, false);
    } finally {
        fs.rmSync(editDirectory, { recursive: true, force: true });
    }
    await agent.close();

    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agent-test-"));
    try {
        const sessionPath = path.join(tempDirectory, "sessions.json");
        fs.writeFileSync(sessionPath, JSON.stringify({
            version: 1,
            sessions: [
                {
                    id: "test",
                    title: "test",
                    createdAt: 100,
                    updatedAt: 300,
                    messages: [
                        { role: "user", content: "old task", timestamp: 100 },
                        { role: "assistant", content: "old answer", timestamp: 100 },
                        { role: "user", content: "new task", timestamp: 300 }
                    ]
                },
                {
                    id: "keep",
                    title: "keep",
                    createdAt: 200,
                    updatedAt: 200,
                    messages: [{ role: "user", content: "keep me", timestamp: 200 }]
                }
            ]
        }), "utf8");
        const session = new SessionTool(sessionPath);
        assert.deepEqual(session.getContextMessages("test", 6, 200).map((item) => item.content), ["new task"]);
        assert.equal(session.resumeSession("test")?.id, "test");
        assert.equal(session.resumeSession("missing"), undefined);
        const savedWorkspace = path.join(tempDirectory, "workspace");
        assert.equal(session.setWorkspace("test", savedWorkspace), true);
        assert.equal(session.resumeSession("test")?.workspace, path.resolve(savedWorkspace));
        assert.equal(session.setWorkspace("missing", savedWorkspace), false);
        session.recordUsage("test", { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
        session.recordUsage("test", { promptTokens: 140, completionTokens: 30, totalTokens: 170 });
        assert.deepEqual(session.getUsage("test"), {
            promptTokens: 240,
            completionTokens: 50,
            totalTokens: 290,
            requestCount: 2,
            activeContextTokens: 170
        });
        session.resetActiveContextUsage("test");
        assert.equal(session.getUsage("test").activeContextTokens, 0);
        assert.equal(session.getUsage("test").totalTokens, 290);
        assert.equal(session.deleteSession("test"), true);
        assert.equal(session.deleteSession("missing"), false);
        assert.deepEqual(session.getContextMessages("keep").map((item) => item.content), ["keep me"]);
        assert.equal(session.clearSessions(), 1);
        assert.deepEqual(session.getContextMessages("keep"), []);

        const tracePath = path.join(tempDirectory, "trace.jsonl");
        const responseLogPath = path.join(tempDirectory, "responses.jsonl");
        const responseLog = new AgentResponseLog(responseLogPath);
        responseLog.append({
            turn: 1,
            maxTurns: 12,
            requestFormat: { type: "json_object" },
            rawContent: "plain model content",
            durationMs: 1234,
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            parseError: "no valid JSON object found in model content"
        });
        const loggedResponse = JSON.parse(fs.readFileSync(responseLogPath, "utf8"));
        assert.equal(loggedResponse.accepted, false);
        assert.equal(loggedResponse.rawContent, "plain model content");
        assert.equal(loggedResponse.durationMs, 1234);
        assert.equal(loggedResponse.usage.total_tokens, 12);
        assert.equal(loggedResponse.parseError, "no valid JSON object found in model content");
        const dailyResponseLog = new AgentResponseLog({ directory: tempDirectory, basename: "daily-responses" });
        dailyResponseLog.append({
            turn: 1,
            maxTurns: 1,
            requestFormat: {},
            rawContent: "daily",
            parsedAction: "final"
        });
        assert.ok(fs.existsSync(path.join(tempDirectory, `daily-responses-${formatLocalDate()}.jsonl`)));
        const liveTraceEntries: Array<{ action?: string }> = [];
        const trace = new AgentTrace(tracePath, undefined, (entry) => liveTraceEntries.push(entry));
        trace.add({
            turn: 1,
            status: "ok",
            action: "write_file",
            arguments: { content: "private file body", apiKey: "secret-value" },
            observation: "token=secret-value"
        });
        trace.save();
        assert.equal(liveTraceEntries.length, 1);
        assert.equal(liveTraceEntries[0]?.action, "write_file");
        trace.add({
            turn: 2,
            status: "parse_error",
            action: "invalid_json",
            observation: "second entry"
        });
        trace.save();
        trace.save();
        const savedTrace = fs.readFileSync(tracePath, "utf8");
        assert.equal(savedTrace.trim().split(/\r?\n/).length, 2);
        assert.ok(savedTrace.includes("[REDACTED]"));
        assert.ok(savedTrace.includes("[content omitted:"));
        assert.ok(!savedTrace.includes("secret-value"));
        assert.ok(!savedTrace.includes("private file body"));
        const dailyTrace = new AgentTrace({ directory: tempDirectory, basename: "daily-trace" });
        dailyTrace.add({ turn: 1, status: "final", action: "final" });
        dailyTrace.save();
        assert.ok(fs.existsSync(path.join(tempDirectory, `daily-trace-${formatLocalDate()}.jsonl`)));
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }

    console.log("Agent config, connection retry, context boundary, trace, and redaction tests passed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
