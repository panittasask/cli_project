import fs = require("node:fs");

type TraceEvent = {
    taskId?: string;
    turn?: number;
    timestamp?: string;
    status?: string;
    action?: string;
    observation?: string;
};

type TaskOutcome = "success" | "incomplete" | "stopped" | "failed";

type TaskTraceSummary = {
    taskId: string;
    outcome: TaskOutcome;
    firstTimestamp: string;
    lastTimestamp: string;
    durationMs: number;
    modelCalls: number;
    toolActions: number;
    events: number;
    errors: number;
    repeatedOrNoProgress: number;
    parseErrors: number;
    finalBlocked: number;
};

const toolActions = new Set([
    "list_files",
    "search_files",
    "read_file",
    "write_file",
    "edit_file",
    "delete_file",
    "run_command",
    "mcp_list_tools",
    "mcp_call_tool"
]);

const hostOnlyActions = new Set([
    "context_compaction",
    "budget_stop",
    "incomplete_after_tool_limit",
    "repeat_stop",
    "final_summary_failed"
]);

function parseTraceJsonl(content: string): TraceEvent[] {
    return content.split(/\r?\n/).flatMap((line) => {
        if (!line.trim()) return [];
        try {
            const parsed = JSON.parse(line) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? [parsed as TraceEvent]
                : [];
        } catch {
            return [];
        }
    });
}

function readTraceFiles(paths: string[]): TraceEvent[] {
    return paths.flatMap((filePath) => parseTraceJsonl(fs.readFileSync(filePath, "utf8")));
}

function summarizeTraceEvents(events: TraceEvent[]): TaskTraceSummary[] {
    const byTask = new Map<string, TraceEvent[]>();
    for (const event of events) {
        if (typeof event.taskId !== "string" || !event.taskId.trim()) continue;
        const entries = byTask.get(event.taskId) ?? [];
        entries.push(event);
        byTask.set(event.taskId, entries);
    }

    return Array.from(byTask, ([taskId, taskEvents]) => {
        const ordered = taskEvents
            .filter((event) => typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)))
            .sort((left, right) => Date.parse(left.timestamp ?? "") - Date.parse(right.timestamp ?? ""));
        const firstTimestamp = ordered[0]?.timestamp ?? "";
        const lastTimestamp = ordered[ordered.length - 1]?.timestamp ?? firstTimestamp;
        const successfulFinal = taskEvents.some((event) => (
            event.status === "final" && (event.action === "final" || event.action === "final_after_tool_limit")
        ));
        const incomplete = taskEvents.some((event) => event.action === "incomplete_after_tool_limit");
        const stopped = taskEvents.some((event) => event.action === "repeat_stop" || event.action === "budget_stop");
        const modelTurns = new Set(taskEvents.flatMap((event) => (
            typeof event.turn === "number" && event.turn > 0 && !hostOnlyActions.has(event.action ?? "")
                ? [event.turn]
                : []
        )));
        const repeatedOrNoProgress = taskEvents.filter((event) => (
            ["repeat_guard", "repeat_quarantine", "repeat_stop"].includes(event.action ?? "")
            || /\b(?:No file change|already has the requested content|without (?:file )?progress)\b/i.test(event.observation ?? "")
        )).length;

        return {
            taskId,
            outcome: successfulFinal ? "success" : incomplete ? "incomplete" : stopped ? "stopped" : "failed",
            firstTimestamp,
            lastTimestamp,
            durationMs: firstTimestamp && lastTimestamp
                ? Math.max(0, Date.parse(lastTimestamp) - Date.parse(firstTimestamp))
                : 0,
            modelCalls: modelTurns.size,
            toolActions: taskEvents.filter((event) => toolActions.has(event.action ?? "") && (event.status === "ok" || event.status === "error")).length,
            events: taskEvents.length,
            errors: taskEvents.filter((event) => event.status === "error").length,
            repeatedOrNoProgress,
            parseErrors: taskEvents.filter((event) => event.status === "parse_error").length,
            finalBlocked: taskEvents.filter((event) => event.action === "final_blocked").length
        } satisfies TaskTraceSummary;
    }).sort((left, right) => left.firstTimestamp.localeCompare(right.firstTimestamp));
}

function percentile(values: number[], ratio: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index] ?? 0;
}

function aggregateTraceSummaries(summaries: TaskTraceSummary[]) {
    const successful = summaries.filter((summary) => summary.outcome === "success");
    const durations = successful.map((summary) => summary.durationMs);
    const calls = successful.map((summary) => summary.modelCalls);
    return {
        tasks: summaries.length,
        successful: successful.length,
        successRate: summaries.length === 0 ? 0 : successful.length / summaries.length,
        medianSuccessfulDurationMs: percentile(durations, 0.5),
        p95SuccessfulDurationMs: percentile(durations, 0.95),
        medianSuccessfulModelCalls: percentile(calls, 0.5),
        totalModelCalls: summaries.reduce((sum, summary) => sum + summary.modelCalls, 0),
        totalToolActions: summaries.reduce((sum, summary) => sum + summary.toolActions, 0),
        totalErrors: summaries.reduce((sum, summary) => sum + summary.errors, 0),
        repeatedOrNoProgress: summaries.reduce((sum, summary) => sum + summary.repeatedOrNoProgress, 0)
    };
}

module.exports = {
    aggregateTraceSummaries,
    parseTraceJsonl,
    readTraceFiles,
    summarizeTraceEvents
};
