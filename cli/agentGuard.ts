import crypto = require("node:crypto");

type GuardSettings = { maxTurns: number; maxSegments?: number; maxDurationMs: number; maxCompletionTokens: number; repeatLimit: number };
type GuardDecision = { status: "allow" | "replan" | "stop"; message?: string; blockActions?: string[] };
type ToolObservation = { ok: boolean; output: string; changed?: boolean };

const inspectionActions = new Set(["list_files", "search_project", "search_files", "read_file"]);
const inspectionRecoveryBlockedActions = [...inspectionActions, "run_command"];
const inspectionStreakLimit = 6;

function isInspectionAction(action: Record<string, unknown>): boolean {
    const actionName = String(action.action ?? "");
    if (inspectionActions.has(actionName)) return true;
    if (actionName !== "run_command" || typeof action.command !== "string") return false;

    // Models sometimes use the shell as a larger read_file call. Treat a
    // command made only of workspace inspection operations as inspection too,
    // while leaving build/test and mutation commands available for recovery.
    const command = action.command;
    const readsWorkspace = /\b(?:Get-Content|gc|type|cat|Get-ChildItem|gci|dir|ls|rg|Select-String|git\s+(?:status|diff|log|show))\b/i.test(command);
    const mutatesWorkspace = /\b(?:Set-Content|sc|Out-File|Add-Content|ac|Copy-Item|cp|Move-Item|mv|Remove-Item|rm|del|Rename-Item|ri|New-Item|ni|npm\s+(?:install|uninstall|update)|pnpm\s+(?:add|remove|update)|yarn\s+(?:add|remove|upgrade)|bun\s+(?:add|remove|update)|git\s+(?:add|commit|checkout|restore|reset|apply))\b/i.test(command);
    const verifiesWorkspace = /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(?:build|test|verify|lint|check|typecheck)\b/i.test(command);
    return readsWorkspace && !mutatesWorkspace && !verifiesWorkspace;
}

class AgentGuard {
    private readonly startedAt = Date.now();
    private completionTokens = 0;
    private readonly seenEvidencePairs = new Set<string>();
    private readonly repeatedEvidenceCounts = new Map<string, number>();
    private readonly quarantinedActions = new Set<string>();
    private inspectionStreak = 0;
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
        if (this.inspectionStreak >= inspectionStreakLimit && isInspectionAction(action)) {
            return {
                status: "replan",
                message: "Inspection has stalled after several unchanged reads. Stop rereading the same workspace; make the required edit/write, run a finite verification, or return an evidence-backed final.",
                blockActions: [...inspectionRecoveryBlockedActions]
            };
        }
        const signature = this.signature(action);
        if (this.quarantinedActions.has(signature)) {
            // A command that has already produced the same failure is never
            // run again verbatim. Other tools remain available: a failed edit
            // often needs another read or a corrected replacement, and must
            // not terminate the task merely because the model made a mistake.
            if (action.action === "run_command") {
                return {
                    status: "replan",
                    message: "This exact command string is quarantined because it returned an identical observation repeatedly. Use a different command text or another corrective action; spacing, quotes, flags, and ports are part of command identity."
                };
            }
        }
        return { status: "allow" };
    }

    recordObservation(action: Record<string, unknown>, observation: ToolObservation): GuardDecision {
        if (isInspectionAction(action) && observation.ok && observation.changed !== true) {
            this.inspectionStreak += 1;
        } else if (observation.changed === true) {
            // A build/test can provide verification evidence, but it does not
            // make rereading the same unchanged workspace useful again. Only a
            // real workspace mutation releases an inspection stall.
            this.inspectionStreak = 0;
        }
        const signature = this.signature(action);
        const fingerprint = this.observationFingerprint(observation);
        const evidencePair = `${signature}:${fingerprint}`;

        if (this.inspectionStreak >= inspectionStreakLimit && isInspectionAction(action)) {
            return {
                status: "replan",
                message: "Inspection has stalled after several unchanged reads. Stop rereading the same workspace; make the required edit/write, run a finite verification, or return an evidence-backed final.",
                blockActions: [...inspectionRecoveryBlockedActions]
            };
        }

        if (!this.seenEvidencePairs.has(evidencePair)) {
            // Any genuinely new observation, including a new failure, gives the
            // model new evidence to reason from and releases current
            // quarantines. Retain counts for older evidence pairs so alternating
            // old A/B observations cannot masquerade as perpetual progress.
            this.seenEvidencePairs.add(evidencePair);
            this.quarantinedActions.clear();
            this.repeatedEvidenceCounts.set(evidencePair, 1);
            return { status: "allow" };
        }

        const count = (this.repeatedEvidenceCounts.get(evidencePair) ?? 0) + 1;
        this.repeatedEvidenceCounts.set(evidencePair, count);
        if (count >= this.settings.repeatLimit) {
            if (action.action === "run_command") {
                this.quarantinedActions.add(signature);
                return {
                    status: "replan",
                    message: `The exact command string returned an identical observation ${count} times and is now quarantined. Choose a different command text or correct the workspace before retrying.`
                };
            }
            return {
                status: "replan",
                message: this.inspectionStreak >= inspectionStreakLimit
                    ? "Inspection has stalled after several unchanged reads. Stop rereading the same workspace; make the required edit/write, run a finite verification, or return an evidence-backed final."
                    : `The action returned an identical observation ${count} times. Re-check the error and change the requested file operation; the task remains active for recovery.`,
                ...(this.inspectionStreak >= inspectionStreakLimit ? { blockActions: [...inspectionRecoveryBlockedActions] } : {})
            };
        }
        return { status: "allow" };
    }

    resetActionHistory(): void {
        this.seenEvidencePairs.clear();
        this.repeatedEvidenceCounts.clear();
        this.quarantinedActions.clear();
        this.inspectionStreak = 0;
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
        if (action.action === "run_command" && typeof action.command === "string") {
            // Command quarantine intentionally keys on the raw command text
            // alone. A different working directory, probe mode, or assertion
            // must not silently rerun a command that has already failed in
            // exactly the same form.
            return JSON.stringify({ action: "run_command", command: action.command });
        }
        const canonicalAction = { ...action };
        if (action.action === "run_command" && typeof action.workdir !== "string") {
            canonicalAction.workdir = ".";
        }
        if ((action.action === "list_files" || action.action === "search_project" || action.action === "search_files")
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
