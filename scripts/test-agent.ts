import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
const { loadCliSettings, getSamplingSettings } = require("../cli/config") as {
    loadCliSettings: (root?: string) => Record<string, unknown>;
    getSamplingSettings: (settings: Record<string, unknown>, kind: "action") => Record<string, number>;
};
const { AgentTool } = require("../cli/tools/agentTool") as { AgentTool: new () => {
    parseAction: (content: string) => { action?: string; reason?: string } | undefined;
    formatActionStatus: (action: unknown, turn: number, maxTurns: number) => string;
    close: () => Promise<void>;
} };
const { AgentTrace } = require("../cli/agentTrace") as { AgentTrace: new (logPath?: string) => {
    add: (entry: Record<string, unknown>) => void;
    save: () => void;
} };
const { SessionTool } = require("../cli/session") as { SessionTool: new (storagePath?: string) => {
    getContextMessages: (sessionId: string, limit?: number, afterTimestamp?: number) => Array<{ content: string }>;
    deleteSession: (sessionId: string) => boolean;
    clearSessions: () => number;
} };

async function main(): Promise<void> {
    const settings = loadCliSettings(path.resolve(__dirname, ".."));
    assert.equal(settings.contextLength, 65536);
    const actionSampling = getSamplingSettings(settings, "action");
    assert.equal(actionSampling.temperature, 0.1);
    assert.equal(actionSampling.max_tokens, 4096);

    const agent = new AgentTool();
    const action = agent.parseAction(JSON.stringify({
        action: "read_file",
        path: "README.md",
        reason: "Inspect the project documentation."
    }));
    assert.equal(action?.action, "read_file");
    assert.equal(action?.reason, "Inspect the project documentation.");
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
        assert.equal(session.deleteSession("test"), true);
        assert.equal(session.deleteSession("missing"), false);
        assert.deepEqual(session.getContextMessages("keep").map((item) => item.content), ["keep me"]);
        assert.equal(session.clearSessions(), 1);
        assert.deepEqual(session.getContextMessages("keep"), []);

        const tracePath = path.join(tempDirectory, "trace.jsonl");
        const trace = new AgentTrace(tracePath);
        trace.add({
            turn: 1,
            status: "ok",
            action: "write_file",
            arguments: { content: "private file body", apiKey: "secret-value" },
            observation: "token=secret-value"
        });
        trace.save();
        const savedTrace = fs.readFileSync(tracePath, "utf8");
        assert.ok(savedTrace.includes("[REDACTED]"));
        assert.ok(savedTrace.includes("[content omitted:"));
        assert.ok(!savedTrace.includes("secret-value"));
        assert.ok(!savedTrace.includes("private file body"));
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }

    console.log("Agent config, context boundary, trace, and redaction tests passed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
