import fs = require("node:fs");
import path = require("node:path");

type AgentResponseLogEntry = {
    turn: number;
    maxTurns: number;
    requestFormat: unknown;
    rawContent: unknown;
    reasoningContent?: unknown;
    finishReason?: unknown;
    parsedAction?: string | undefined;
    parseError?: string | undefined;
};

class AgentResponseLog {
    private readonly taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    constructor(
        private readonly logPath = path.resolve(process.cwd(), ".cli", "logs", "agent-model-responses.jsonl")
    ) {}

    append(entry: AgentResponseLogEntry): void {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        fs.appendFileSync(this.logPath, `${JSON.stringify({
            taskId: this.taskId,
            timestamp: new Date().toISOString(),
            accepted: Boolean(entry.parsedAction),
            ...entry,
            rawContent: entry.rawContent ?? null,
            reasoningContent: entry.reasoningContent ?? null,
            finishReason: entry.finishReason ?? null,
            parsedAction: entry.parsedAction ?? null,
            parseError: entry.parseError ?? null
        })}\n`, "utf8");
    }
}

module.exports = {
    AgentResponseLog
};
