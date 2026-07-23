import fs = require("node:fs");
import path = require("node:path");
const { aggregateTraceSummaries, readTraceFiles, summarizeTraceEvents } = require("../cli/traceSummary") as {
    readTraceFiles: (paths: string[]) => Array<Record<string, unknown>>;
    summarizeTraceEvents: (events: Array<Record<string, unknown>>) => Array<{
        taskId: string;
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
        medianSuccessfulDurationMs: number;
        p95SuccessfulDurationMs: number;
        medianSuccessfulModelCalls: number;
        totalModelCalls: number;
        totalToolActions: number;
        totalErrors: number;
        repeatedOrNoProgress: number;
    };
};

const args = process.argv.slice(2);
const json = args.includes("--json");
const requestedPaths = args.filter((argument) => argument !== "--json");
const logDirectory = path.resolve(process.cwd(), ".cli", "logs", "agent");
const paths = requestedPaths.length > 0
    ? requestedPaths.map((filePath) => path.resolve(process.cwd(), filePath))
    : fs.existsSync(logDirectory)
        ? fs.readdirSync(logDirectory)
            .filter((name) => /^agent-trace-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(name))
            .sort()
            .map((name) => path.join(logDirectory, name))
        : [];

if (paths.length === 0) {
    console.error("No dated agent trace files were found. Pass one or more JSONL paths explicitly.");
    process.exitCode = 1;
} else {
    const summaries = summarizeTraceEvents(readTraceFiles(paths));
    const aggregate = aggregateTraceSummaries(summaries);
    if (json) {
        console.log(JSON.stringify({ files: paths, aggregate, tasks: summaries }, null, 2));
    } else {
        console.log(`Agent trace report: ${paths.length} file(s)`);
        console.log(`Tasks: ${aggregate.tasks} | success: ${aggregate.successful} (${(aggregate.successRate * 100).toFixed(1)}%) | model calls: ${aggregate.totalModelCalls} | tool actions: ${aggregate.totalToolActions}`);
        console.log(`Successful task median: ${(aggregate.medianSuccessfulDurationMs / 60_000).toFixed(1)} min, ${aggregate.medianSuccessfulModelCalls} model calls | p95: ${(aggregate.p95SuccessfulDurationMs / 60_000).toFixed(1)} min`);
        console.log(`Errors: ${aggregate.totalErrors} | repeated/no-progress: ${aggregate.repeatedOrNoProgress}`);
        console.log();
        console.log("Outcome     Minutes Calls Tools Errors Repeat Task");
        summaries.forEach((summary) => {
            const columns = [
                summary.outcome.padEnd(11),
                (summary.durationMs / 60_000).toFixed(1).padStart(7),
                String(summary.modelCalls).padStart(5),
                String(summary.toolActions).padStart(5),
                String(summary.errors).padStart(6),
                String(summary.repeatedOrNoProgress).padStart(6),
                summary.taskId
            ];
            console.log(columns.join(" "));
        });
    }
}
