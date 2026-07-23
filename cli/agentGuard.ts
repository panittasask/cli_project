import crypto = require("node:crypto");
const { normalizeCommandSignature } = require("./commandNormalizer") as {
    normalizeCommandSignature: (command: string) => string;
};

type GuardSettings = { maxTurns: number; maxSegments?: number; maxDurationMs: number; maxCompletionTokens: number; repeatLimit: number };
type GuardDecision = { status: "allow" | "replan" | "stop"; message?: string };
type ToolObservation = { ok: boolean; output: string; changed?: boolean };

class AgentGuard {
    private readonly startedAt = Date.now();
    private completionTokens = 0;
    private readonly seenEvidencePairs = new Set<string>();
    private readonly repeatedEvidenceCounts = new Map<string, number>();
    private readonly quarantinedActions = new Set<string>();
    private readonly quarantineViolationCounts = new Map<string, number>();
    private pausedAt: number | undefined;
    private pausedDurationMs = 0;

    constructor(readonly settings: GuardSettings) {}

    recordCompletionTokens(tokens: number): void {
        if (Number.isFinite(tokens) && tokens > 0) this.completionTokens += Math.floor(tokens);
    }

    checkBudget(turn: number, now = Date.now()): string | undefined {
        if (this.settings.maxTurns > 0 && turn > this.settings.maxTurns) return `step budget reached (${this.settings.maxTurns})`;
        if (this.settings.maxDurationMs > 0 && this.elapsedMs(now) >= this.settings.maxDurationMs) return `wall-clock budget reached (${this.formatRemaining(now)})`;
        if (this.settings.maxCompletionTokens > 0 && this.completionTokens >= this.settings.maxCompletionTokens) return `completion-token budget reached (${this.completionTokens}/${this.settings.maxCompletionTokens})`;
        return undefined;
    }

    registerAction(action: Record<string, unknown>): GuardDecision {
        const signature = this.signature(action);
        if (this.quarantinedActions.has(signature)) {
            const violations = (this.quarantineViolationCounts.get(signature) ?? 0) + 1;
            this.quarantineViolationCounts.set(signature, violations);
            if (violations >= this.settings.repeatLimit) {
                return {
                    status: "stop",
                    message: `Stopped after the model ignored the quarantine for this exact action ${violations} times.`
                };
            }
            return {
                status: "replan",
                message: "This exact action is quarantined because it returned an identical observation repeatedly. Choose different arguments, another evidence-producing action, or return final."
            };
        }
        return { status: "allow" };
    }

    recordObservation(action: Record<string, unknown>, observation: ToolObservation): GuardDecision {
        const signature = this.signature(action);
        const fingerprint = this.observationFingerprint(observation);
        const evidencePair = `${signature}:${fingerprint}`;

        if (!this.seenEvidencePairs.has(evidencePair)) {
            // Any genuinely new observation, including a new failure, gives the
            // model new evidence to reason from and releases current
            // quarantines. Keep the global seen set so alternating old A/B
            // observations cannot masquerade as perpetual progress.
            this.seenEvidencePairs.add(evidencePair);
            this.repeatedEvidenceCounts.clear();
            this.quarantinedActions.clear();
            this.quarantineViolationCounts.clear();
            this.repeatedEvidenceCounts.set(evidencePair, 1);
            return { status: "allow" };
        }

        const count = (this.repeatedEvidenceCounts.get(evidencePair) ?? 0) + 1;
        this.repeatedEvidenceCounts.set(evidencePair, count);
        if (count >= this.settings.repeatLimit) {
            this.quarantinedActions.add(signature);
            return {
                status: "replan",
                message: `The exact action returned an identical observation ${count} times and is now quarantined. Choose different arguments, another evidence-producing action, or return final.`
            };
        }
        return { status: "allow" };
    }

    resetActionHistory(): void {
        this.seenEvidencePairs.clear();
        this.repeatedEvidenceCounts.clear();
        this.quarantinedActions.clear();
        this.quarantineViolationCounts.clear();
    }

    recordFileProgress(): void {
        // Kept as a compatibility alias for callers that already record
        // mutations. File changes are one kind of evidence progress, not the
        // only kind.
        this.resetActionHistory();
    }

    pause(now = Date.now()): void {
        if (this.pausedAt === undefined) this.pausedAt = now;
    }

    resume(now = Date.now()): void {
        if (this.pausedAt === undefined) return;
        this.pausedDurationMs += Math.max(0, now - this.pausedAt);
        this.pausedAt = undefined;
    }

    formatRemaining(now = Date.now()): string {
        if (this.settings.maxDurationMs <= 0) return "no time limit";
        const remainingMs = Math.max(0, this.settings.maxDurationMs - this.elapsedMs(now));
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")} left`;
    }

    private elapsedMs(now: number): number {
        const activePauseMs = this.pausedAt === undefined ? 0 : Math.max(0, now - this.pausedAt);
        return Math.max(0, now - this.startedAt - this.pausedDurationMs - activePauseMs);
    }

    private signature(action: Record<string, unknown>): string {
        const canonicalAction = { ...action };
        if (action.action === "run_command" && typeof action.workdir !== "string") {
            canonicalAction.workdir = ".";
        }
        if ((action.action === "list_files" || action.action === "search_files")
            && typeof action.path !== "string") {
            canonicalAction.path = ".";
        }
        const normalized = Object.fromEntries(Object.entries(canonicalAction)
            .filter(([key]) => key !== "reason" && key !== "task")
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

    private observationFingerprint(observation: ToolObservation): string {
        return crypto.createHash("sha256").update(JSON.stringify({
            ok: observation.ok,
            changed: observation.changed,
            output: observation.output
        })).digest("hex");
    }
}

module.exports = { AgentGuard };
