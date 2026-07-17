function formatElapsedTime(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);

    return hours > 0
        ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
        : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatCompletionLine(milliseconds: number, completed = true): string {
    return `${completed ? "Completed in" : "Stopped after"} ${formatElapsedTime(milliseconds)}`;
}

function formatSpinnerLine(
    frame: string,
    message: string,
    stepMilliseconds: number,
    totalMilliseconds: number,
    columns = 0
): string {
    const timing = `[step ${formatElapsedTime(stepMilliseconds)} | total ${formatElapsedTime(totalMilliseconds)}]`;
    const prefix = `${frame} `;
    const separator = "  ";
    const maxWidth = columns > 1 ? columns - 1 : 0;
    const availableMessageWidth = maxWidth > 0
        ? Math.max(1, maxWidth - prefix.length - separator.length - timing.length)
        : message.length;
    const visibleMessage = message.length > availableMessageWidth
        ? `${message.slice(0, Math.max(0, availableMessageWidth - 1))}…`
        : message;

    return `${prefix}${visibleMessage}${separator}${timing}`;
}

class Spinner {
    private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    private timer: NodeJS.Timeout | undefined;
    private index = 0;
    private taskStartedAt = 0;
    private stepStartedAt = 0;

    constructor(private message = "Thinking...") {}

    start(): void {
        if (this.timer) {
            return;
        }

        const now = Date.now();
        this.taskStartedAt = now;
        this.stepStartedAt = now;
        this.render(now);
        this.timer = setInterval(() => this.render(Date.now()), 100);
    }

    stop(): number {
        const elapsed = this.taskStartedAt > 0 ? Math.max(0, Date.now() - this.taskStartedAt) : 0;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            process.stdout.write("\r\x1b[K");
        }
        return elapsed;
    }

    suspend(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = undefined;
        process.stdout.write("\r\x1b[K");
    }

    resume(): void {
        if (this.timer || this.taskStartedAt === 0) return;
        this.render(Date.now());
        this.timer = setInterval(() => this.render(Date.now()), 100);
    }

    update(message: string): void {
        if (message !== this.message) {
            this.message = message;
            this.stepStartedAt = Date.now();
        }
    }

    log(message: string): void {
        if (this.timer) {
            process.stdout.write("\r\x1b[K");
        }

        process.stdout.write(`${message}\n`);
    }

    private render(now: number): void {
        const line = formatSpinnerLine(
            this.frames[this.index++ % this.frames.length] ?? "⠋",
            this.message,
            now - this.stepStartedAt,
            now - this.taskStartedAt,
            process.stdout.columns ?? 0
        );
        process.stdout.write(`\r\x1b[K${line}`);
    }
}

module.exports = {
    Spinner,
    formatCompletionLine,
    formatElapsedTime,
    formatSpinnerLine
};
