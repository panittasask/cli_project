import crypto = require("node:crypto");

type GuardSettings = { maxTurns: number; maxDurationMs: number; maxCompletionTokens: number; repeatLimit: number };
type GuardDecision = { status: "allow" | "replan" | "stop"; message?: string };

class AgentGuard {
    private readonly startedAt = Date.now();
    private completionTokens = 0;
    private lastActionSignature: string | undefined;
    private consecutiveActionCount = 0;

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
        if (signature === this.lastActionSignature) {
            this.consecutiveActionCount += 1;
        } else {
            this.lastActionSignature = signature;
            this.consecutiveActionCount = 1;
        }
        const count = this.consecutiveActionCount;
        if (count === this.settings.repeatLimit) {
            return { status: "replan", message: `Repeated identical action ${count} consecutive times; choose a different action or return final.` };
        }
        if (count > this.settings.repeatLimit) {
            return { status: "stop", message: `Stopped identical action after ${count} consecutive attempts.` };
        }
        return { status: "allow" };
    }

    formatRemaining(now = Date.now()): string {
        const remainingMs = Math.max(0, this.settings.maxDurationMs - (now - this.startedAt));
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")} left`;
    }

    private signature(action: Record<string, unknown>): string {
        const normalized = Object.fromEntries(Object.entries(action)
            .filter(([key]) => key !== "reason")
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [key, key === "content" && typeof value === "string"
                ? crypto.createHash("sha256").update(value).digest("hex")
                : value]));
        return JSON.stringify(normalized);
    }
}

module.exports = { AgentGuard };
