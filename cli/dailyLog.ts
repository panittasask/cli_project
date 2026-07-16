import path = require("node:path");

type DailyLogTarget = {
    directory: string;
    basename: string;
};

function formatLocalDate(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function resolveJsonlLogPath(target: string | DailyLogTarget, date = new Date()): string {
    if (typeof target === "string") return target;
    return path.resolve(target.directory, `${target.basename}-${formatLocalDate(date)}.jsonl`);
}

module.exports = { formatLocalDate, resolveJsonlLogPath };
