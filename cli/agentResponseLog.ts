import fs = require("node:fs");
import path = require("node:path");
const { resolveJsonlLogPath } = require("./dailyLog") as {
    resolveJsonlLogPath: (target: string | { directory: string; basename: string }, date?: Date) => string;
};

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
    constructor(
        private readonly logTarget: string | { directory: string; basename: string } = {
            directory: path.resolve(process.cwd(), ".cli", "logs"),
            basename: "agent-model-responses"
        },
        private readonly taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    ) {}

    append(entry: AgentResponseLogEntry): void {
        const now = new Date();
        const logPath = resolveJsonlLogPath(this.logTarget, now);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${JSON.stringify({
            taskId: this.taskId,
            timestamp: now.toISOString(),
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
