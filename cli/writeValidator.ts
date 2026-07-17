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
                const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as Record<string, unknown>;
                if (path.basename(absolute).toLowerCase() === "package.json") {
                    const lockPath = path.join(path.dirname(absolute), "package-lock.json");
                    if (fs.existsSync(lockPath)) {
                        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { packages?: Record<string, Record<string, unknown>> };
                        const root = lock.packages?.[""];
                        if (root) {
                            const keys = ["name", "version", "dependencies", "devDependencies"];
                            const mismatches = keys.filter((key) => root[key] !== undefined
                                && JSON.stringify(parsed[key] ?? {}) !== JSON.stringify(root[key] ?? {}));
                            if (mismatches.length > 0) {
                                return {
                                    ok: false,
                                    validator: "package-lock metadata",
                                    output: `package.json disagrees with same-directory package-lock.json for fields: ${mismatches.join(", ")}. Copy those root lockfile values exactly and preserve unrelated manifest-only fields.`
                                };
                            }
                        }
                    }
                }
                return { ok: true, validator: "JSON.parse", output: `Valid JSON: ${inputPath}` };
            } catch (error) {
                return { ok: false, validator: "JSON.parse", output: error instanceof Error ? error.message : String(error) };
            }
        }

        if (path.basename(absolute).toLowerCase() === "go.mod") {
            const content = fs.readFileSync(absolute, "utf8");
            const directModules = content.split(/\r?\n/).flatMap((line) => {
                const normalized = line.trim().replace(/^require\s+/, "");
                if (!normalized || normalized === "(" || normalized === ")" || /\/\/\s*indirect\b/.test(normalized)) return [];
                const match = normalized.match(/^([^\s]+)\s+v\d[^\s]*/);
                return match?.[1] && match[1].includes(".") ? [match[1]] : [];
            });
            const projectRoot = path.dirname(absolute);
            const sourceText = this.collectSourceText(projectRoot, ".go");
            const unused = directModules.filter((modulePath) => (
                !sourceText.includes(`"${modulePath}`) && !sourceText.includes(`\`${modulePath}`)
            ));
            if (unused.length > 0) {
                return {
                    ok: false,
                    validator: "Go module usage",
                    output: `Direct go.mod requirements have no import evidence in project source: ${unused.join(", ")}. Remove guessed dependencies or import an intentionally used module before retrying.`
                };
            }
            return this.fileCommand("Go module", "go", ["mod", "edit", "-json"], projectRoot);
        }

        if ([".ts", ".tsx"].includes(extension)) {
            const projectRoot = this.projectRootFor(inputPath);
            const localCompiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
            if (fs.existsSync(localCompiler)) {
                return this.fileCommand("TypeScript", process.execPath, [localCompiler, "--noEmit"], projectRoot);
            }
            const size = fs.statSync(absolute).size;
            return {
                ok: size > 0,
                validator: "TypeScript read-back",
                output: size > 0
                    ? "No project-local TypeScript compiler was found; compiler validation is deferred to a manifest-discovered project check."
                    : "Written TypeScript file is empty."
            };
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

    validateProjectFor(inputPath: string): ValidationResult | undefined {
        const extension = path.extname(inputPath).toLowerCase();
        if (![".ts", ".tsx"].includes(extension)) return undefined;

        const projectRoot = this.projectRootFor(inputPath);
        const localCompiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
        if (fs.existsSync(localCompiler)) {
            return this.fileCommand("TypeScript", process.execPath, [localCompiler, "--noEmit"], projectRoot);
        }

        return undefined;
    }

    projectRootFor(inputPath: string): string {
        return this.nearestProjectRoot(this.resolve(inputPath));
    }

    private fileCommand(validator: string, executable: string, args: string[], cwd: string): ValidationResult {
        try {
            const output = childProcess.execFileSync(executable, args, {
                cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true
            }).trim();
            return { ok: true, validator, output: output || `${validator} passed.` };
        } catch (error) {
            const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
            const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim() || failure.message || `${validator} failed.`;
            return { ok: false, validator, output: output.slice(0, 6000) };
        }
    }

    private nearestProjectRoot(file: string): string {
        const workspace = path.resolve(this.workspace);
        let directory = path.dirname(file);
        while (true) {
            if (fs.existsSync(path.join(directory, "tsconfig.json")) || fs.existsSync(path.join(directory, "package.json"))) {
                return directory;
            }
            if (directory.toLowerCase() === workspace.toLowerCase()) return workspace;
            const parent = path.dirname(directory);
            if (parent === directory || !this.isInsideWorkspace(parent)) return workspace;
            directory = parent;
        }
    }

    private collectSourceText(root: string, extension: string): string {
        const ignored = new Set([".git", "node_modules", "vendor", "dist", "build"]);
        const chunks: string[] = [];
        const visit = (directory: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (entry.isDirectory() && ignored.has(entry.name.toLowerCase())) continue;
                const target = path.join(directory, entry.name);
                if (entry.isDirectory()) visit(target);
                else if (entry.isFile() && path.extname(entry.name).toLowerCase() === extension) {
                    try { chunks.push(fs.readFileSync(target, "utf8")); } catch { /* ignore unreadable source */ }
                }
            }
        };
        visit(root);
        return chunks.join("\n");
    }

    private isInsideWorkspace(candidate: string): boolean {
        const relative = path.relative(this.workspace, candidate);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
    }

    private resolve(inputPath: string): string {
        const resolved = path.resolve(this.workspace, inputPath);
        const relative = path.relative(this.workspace, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside workspace: ${inputPath}`);
        return resolved;
    }
}

module.exports = { WriteValidator };
