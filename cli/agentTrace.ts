import fs = require("node:fs");
import path = require("node:path");

type TraceEntry = {
    taskId: string;
    turn: number;
    timestamp: string;
    status: "action" | "ok" | "error" | "parse_error" | "final";
    action?: string | undefined;
    reason?: string | undefined;
    arguments?: unknown;
    observation?: string | undefined;
};

const sensitiveKey = /(^|_)(api_?key|token|secret|password|authorization|cookie|private_?key)($|_)/i;

function redactText(value: string): string {
    return value
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
        .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

function redact(value: unknown, key = ""): unknown {
    if (sensitiveKey.test(key)) {
        return "[REDACTED]";
    }

    if (typeof value === "string") {
        if (key === "content") {
            return `[content omitted: ${value.length} chars]`;
        }
        return redactText(value.length > 4000 ? `${value.slice(0, 4000)}...[truncated]` : value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => redact(item));
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
                childKey,
                redact(childValue, childKey)
            ])
        );
    }

    return value;
}

class AgentTrace {
    private readonly entries: TraceEntry[] = [];
    private readonly taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    constructor(private readonly logPath = path.resolve(process.cwd(), ".cli", "logs", "agent-trace.jsonl")) {}

    add(entry: Omit<TraceEntry, "taskId" | "timestamp">): void {
        this.entries.push({
            ...entry,
            taskId: this.taskId,
            timestamp: new Date().toISOString()
        });
    }

    save(): void {
        if (this.entries.length === 0) {
            return;
        }

        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        const lines = this.entries.map((entry) => JSON.stringify(redact(entry))).join("\n");
        fs.appendFileSync(this.logPath, `${lines}\n`, "utf8");
    }

    print(): void {
        if (this.entries.length === 0) {
            return;
        }

        console.log("Agent trace:");
        for (const entry of this.entries) {
            const label = entry.action ?? entry.status;
            const reason = entry.reason ? ` - ${redactText(entry.reason)}` : "";
            const outcome = entry.status === "ok" ? " [ok]" : entry.status === "error" ? " [error]" : "";
            console.log(`  ${entry.turn}. ${label}${outcome}${reason}`);
            if (entry.status === "error" && entry.observation) {
                console.log(`     ${redactText(entry.observation).slice(0, 240)}`);
            }
        }
        console.log();
    }
}

module.exports = {
    AgentTrace
};
