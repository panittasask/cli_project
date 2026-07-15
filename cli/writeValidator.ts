import childProcess = require("node:child_process");
import fs = require("node:fs");
import path = require("node:path");

type ValidationResult = { ok: boolean; validator: string; output: string };

class WriteValidator {
    constructor(private readonly workspace = process.cwd()) {}

    exists(inputPath: string): boolean {
        return fs.existsSync(this.resolve(inputPath));
    }

    validate(inputPath: string): ValidationResult {
        const absolute = this.resolve(inputPath);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
            return { ok: false, validator: "read-back", output: `Written file is missing: ${inputPath}` };
        }

        const extension = path.extname(absolute).toLowerCase();
        if (extension === ".json") {
            try {
                JSON.parse(fs.readFileSync(absolute, "utf8"));
                return { ok: true, validator: "JSON.parse", output: `Valid JSON: ${inputPath}` };
            } catch (error) {
                return { ok: false, validator: "JSON.parse", output: error instanceof Error ? error.message : String(error) };
            }
        }

        if ([".ts", ".tsx"].includes(extension)) {
            return this.command("TypeScript", "npx.cmd tsc --noEmit");
        }

        if (path.basename(absolute).toLowerCase() === ".gitignore") {
            const content = fs.readFileSync(absolute, "utf8");
            const badRules = content.split(/\r?\n/).map((line) => line.trim())
                .filter((line) => line === ".gitignore" || line === "*" || line === ".cli" || line === ".cli/");
            if (badRules.length > 0) {
                return { ok: false, validator: "git hygiene", output: `Unsafe .gitignore rule(s): ${badRules.join(", ")}` };
            }
            try {
                const ignoredTargets = [".cli-sessions.json", "node_modules"];
                const protectedTargets = [".gitignore", ".cli/mcp.json"];
                for (const target of ignoredTargets) {
                    childProcess.execFileSync("git", ["check-ignore", "--quiet", target], { cwd: this.workspace, windowsHide: true });
                }
                for (const target of protectedTargets) {
                    const check = childProcess.spawnSync("git", ["check-ignore", "--quiet", target], { cwd: this.workspace, windowsHide: true });
                    if (check.status === 0) throw new Error(`Protected file is ignored: ${target}`);
                }
                return { ok: true, validator: "git hygiene", output: "Generated files are ignored and protected config/source files remain visible to Git." };
            } catch (error) {
                return { ok: false, validator: "git hygiene", output: error instanceof Error ? error.message : String(error) };
            }
        }

        const size = fs.statSync(absolute).size;
        return { ok: size > 0, validator: "read-back", output: size > 0 ? `Read-back passed (${size} bytes).` : "Written file is empty." };
    }

    private command(validator: string, command: string): ValidationResult {
        try {
            const output = childProcess.execSync(command, {
                cwd: this.workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true
            }).trim();
            return { ok: true, validator, output: output || `${validator} passed.` };
        } catch (error) {
            const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
            const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim() || failure.message || `${validator} failed.`;
            return { ok: false, validator, output: output.slice(0, 6000) };
        }
    }

    private resolve(inputPath: string): string {
        const resolved = path.resolve(this.workspace, inputPath);
        const relative = path.relative(this.workspace, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside workspace: ${inputPath}`);
        return resolved;
    }
}

module.exports = { WriteValidator };
