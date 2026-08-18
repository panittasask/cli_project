import path = require("node:path");
const { normalizeCommandSignature } = require("./commandNormalizer") as {
    normalizeCommandSignature: (command: string) => string;
};

class FailedCommandRegistry {
    private readonly failures = new Map<string, string>();
    private readonly blockedAttempts = new Map<string, number>();

    constructor(private readonly workspace: string) {}

    has(command: string, workdir = "."): boolean {
        return this.failures.has(this.key(command, workdir));
    }

    record(command: string, workdir = ".", errorOutput = ""): void {
        const key = this.key(command, workdir);
        if (!this.failures.has(key)) {
            this.failures.set(key, errorOutput.trim());
        }
    }

    failureFor(command: string, workdir = "."): string | undefined {
        return this.failures.get(this.key(command, workdir));
    }

    recordBlockedAttempt(command: string, workdir = "."): number {
        const key = this.key(command, workdir);
        const count = (this.blockedAttempts.get(key) ?? 0) + 1;
        this.blockedAttempts.set(key, count);
        return count;
    }

    clear(): void {
        this.failures.clear();
        this.blockedAttempts.clear();
    }

    private key(command: string, workdir: string): string {
        const absoluteWorkdir = path.resolve(this.workspace, workdir);
        const resolvedWorkdir = process.platform === "win32"
            ? absoluteWorkdir.toLowerCase()
            : absoluteWorkdir;
        return `${resolvedWorkdir}\n${normalizeCommandSignature(command)}`;
    }
}

module.exports = { FailedCommandRegistry };
