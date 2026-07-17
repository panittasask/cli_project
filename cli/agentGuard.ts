import crypto = require("node:crypto");
const { normalizeCommandSignature } = require("./commandNormalizer") as {
    normalizeCommandSignature: (command: string) => string;
};

type GuardSettings = { maxTurns: number; maxSegments?: number; maxDurationMs: number; maxCompletionTokens: number; repeatLimit: number };
type GuardDecision = { status: "allow" | "replan" | "stop"; message?: string };

class AgentGuard {
    private readonly startedAt = Date.now();
    private completionTokens = 0;
    private readonly actionCounts = new Map<string, number>();
    private inspectionEpoch = 0;

    constructor(readonly settings: GuardSettings) {}

    recordCompletionTokens(tokens: number): void {
        if (Number.isFinite(tokens) && tokens > 0) this.completionTokens += Math.floor(tokens);
    }

    checkBudget(turn: number, now = Date.now()): string | undefined {
        if (turn > this.settings.maxTurns) return `turn budget reached (${this.settings.maxTurns})`;
        if (now - this.startedAt >= this.settings.maxDurationMs) return `wall-clock budget reached (${this.formatRemaining(now)})`;
        if (this.completionTokens >= this.settings.maxCompletionTokens) return `completion-token budget reached (${this.completionTokens}/${this.settings.maxCompletionTokens})`;
        return undefined;
    }

    registerAction(action: Record<string, unknown>): GuardDecision {
        const signature = this.signature(action);
        const count = (this.actionCounts.get(signature) ?? 0) + 1;
        this.actionCounts.set(signature, count);
        if (!this.isInspectionAction(action.action)) this.inspectionEpoch += 1;
        if (count === this.settings.repeatLimit) {
            return { status: "replan", message: `Repeated equivalent action ${count} times without file progress; choose a different action or return final.` };
        }
        if (count > this.settings.repeatLimit) {
            return { status: "stop", message: `Stopped equivalent action after ${count} attempts without file progress.` };
        }
        return { status: "allow" };
    }

    resetActionHistory(): void {
        this.actionCounts.clear();
    }

    formatRemaining(now = Date.now()): string {
        const remainingMs = Math.max(0, this.settings.maxDurationMs - (now - this.startedAt));
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")} left`;
    }

    private signature(action: Record<string, unknown>): string {
        const canonicalAction = { ...action };
        if (this.isInspectionAction(action.action)) {
            canonicalAction.inspection_epoch = this.inspectionEpoch;
        }
        if (action.action === "run_command" && typeof action.workdir !== "string") {
            canonicalAction.workdir = ".";
        }
        if ((action.action === "list_files" || action.action === "search_files")
            && typeof action.path !== "string") {
            canonicalAction.path = ".";
        }
        const normalized = Object.fromEntries(Object.entries(canonicalAction)
            .filter(([key]) => key !== "reason")
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => {
                if (key === "content" && typeof value === "string") {
                    return [key, crypto.createHash("sha256").update(value).digest("hex")];
                }
                if (key === "command" && typeof value === "string") {
                    return [key, normalizeCommandSignature(value)];
                }
                if ((key === "path" || key === "workdir") && typeof value === "string") {
                    return [key, value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()];
                }
                return [key, value];
            }));
        return JSON.stringify(normalized);
    }

    private isInspectionAction(action: unknown): boolean {
        return action === "read_file" || action === "list_files" || action === "search_files";
    }
}

module.exports = { AgentGuard };
