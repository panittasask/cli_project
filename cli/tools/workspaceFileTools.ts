import fs = require("node:fs");
import path = require("node:path");

type WorkspaceGuardLike = {
    resolveSafePath: (workspacePath: string, requestedPath: string) => string;
};
type ResolveCommandWorkdir = (workspace: string, command: string, requestedWorkdir?: string) => { workdir: string; autoSelected: boolean };

class WorkspaceFileTools {
    private readonly maxFileChars = 6000;
    private readonly maxListedFiles = 180;
    private readonly ignoredDirectories = new Set([
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
        "coverage",
        "$recycle.bin",
        "system volume information",
        "recovery"
    ]);

    constructor(
        private readonly workspaceGuard: WorkspaceGuardLike,
        private readonly resolveCommandWorkdir: ResolveCommandWorkdir
    ) {}
    prepareEdit(inputPath: string, oldText: string, newText: string): { ok: boolean; output: string; content?: string; changed?: boolean } {
        if (!inputPath.trim()) return { ok: false, output: "Missing file path." };
        if (!oldText) return { ok: false, output: "edit_file old_text must not be empty." };

        const resolved = this.resolveInsideWorkspace(inputPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            return { ok: false, output: this.missingFileMessage(inputPath) };
        }
        const current = fs.readFileSync(resolved, "utf8");
        const matchCount = current.split(oldText).length - 1;
        if (matchCount === 0 && newText) {
            const replacementCount = current.split(newText).length - 1;
            if (replacementCount === 1) {
                return {
                    ok: true,
                    changed: false,
                    output: `Replacement is already present in ${inputPath}.`,
                    content: current
                };
            }
        }
        if (matchCount !== 1) {
            return {
                ok: false,
                output: matchCount === 0
                    ? `edit_file old_text was not found in ${inputPath}. Read the file again and use an exact match. If line endings or whitespace still prevent an exact replacement after reading, use write_file with the complete corrected file content.`
                    : `edit_file old_text matched ${matchCount} locations in ${inputPath}; provide more surrounding text so it matches exactly once.`
            };
        }
        const content = current.replace(oldText, newText);
        return {
            ok: true,
            changed: content !== current,
            output: content === current ? `Replacement is already present in ${inputPath}.` : "Exact replacement prepared.",
            content
        };
    }

    listFiles(inputPath?: string): string {
        const root = this.resolveInsideWorkspace(inputPath || ".");
        const files: string[] = [];

        this.walk(root, files);

        const limited = files.slice(0, this.maxListedFiles);
        const suffix = files.length > limited.length ? `\n[Truncated: ${files.length - limited.length} more files]` : "";
        return limited.length > 0 ? `${limited.join("\n")}${suffix}` : "[Workspace is empty]";
    }

    searchFiles(query: string, inputPath?: string): string {
        const root = this.resolveInsideWorkspace(inputPath || ".");
        const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const files: string[] = [];
        const matches: string[] = [];

        this.walk(root, files);

        for (const relativeFile of files) {
            const absoluteFile = path.resolve(process.cwd(), relativeFile);
            let buffer: Buffer;
            try {
                buffer = fs.readFileSync(absoluteFile);
            } catch {
                continue;
            }
            if (buffer.includes(0)) {
                continue;
            }

            const lines = buffer.toString("utf8").split(/\r?\n/);
            lines.forEach((line, index) => {
                if (regex.test(line)) {
                    matches.push(`${relativeFile}:${index + 1}: ${line.trim()}`);
                }
            });

            if (matches.length >= 120) {
                break;
            }
        }

        return matches.length > 0 ? matches.join("\n") : "No matches.";
    }

    readFile(inputPath: string): string {
        const resolved = this.resolveInsideWorkspace(inputPath);

        if (!fs.existsSync(resolved)) {
            throw new Error(this.missingFileMessage(inputPath));
        }

        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            throw new Error(`Not a file: ${inputPath}`);
        }

        const buffer = fs.readFileSync(resolved);
        if (buffer.includes(0)) {
            throw new Error("Binary file is not supported.");
        }

        const content = buffer.toString("utf8");
        return this.truncate(`${content}${this.relatedManifestRecoveryContext(resolved, content)}`, this.maxFileChars);
    }

    private relatedManifestRecoveryContext(resolved: string, content: string): string {
        if (path.basename(resolved).toLowerCase() !== "package.json") return "";

        try {
            const manifest = JSON.parse(content) as Record<string, unknown>;
            const lockPath = path.join(path.dirname(resolved), "package-lock.json");
            if (!fs.existsSync(lockPath)) return "";
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
                packages?: Record<string, Record<string, unknown>>;
            };
            const root = lock.packages?.[""];
            if (!root) return "";

            const evidenceKeys = ["name", "version", "dependencies", "devDependencies"];
            const evidence = Object.fromEntries(evidenceKeys.filter((key) => root[key] !== undefined).map((key) => [key, root[key]]));
            const comparableManifest = Object.fromEntries(evidenceKeys.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]));
            if (JSON.stringify(evidence) === JSON.stringify(comparableManifest)) return "";

            return `\n\n[Recovery context: this manifest disagrees with same-directory package-lock.json root metadata. For every displayed field, copy the lockfile value exactly: remove dependency keys absent from the evidence, add keys that are present, and preserve unrelated manifest-only fields such as scripts/private. Do not guess or downgrade versions.]\n${JSON.stringify(evidence, null, 2)}`;
        } catch {
            return "";
        }
    }

    diagnosticSourceContext(errorOutput: string, command = "", requestedWorkdir?: string): string | undefined {
        const missing = errorOutput.match(/Cannot find name ['"]([^'"]+)['"]/i);
        const symbol = missing?.[1];
        if (!symbol || missing?.index === undefined) return undefined;

        const afterDiagnostic = errorOutput.slice(missing.index);
        const beforeDiagnostic = errorOutput.slice(0, missing.index);
        const location = afterDiagnostic.match(/(?:^|\r?\n)\s*([^\r\n]+?\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py)):(\d+)(?::\d+)?:/i)?.[1]
            ?? beforeDiagnostic.match(/(?:^|\r?\n)\s*([^\r\n]+?\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py))\(\d+,\d+\):[^\r\n]*$/i)?.[1]
            ?? beforeDiagnostic.match(/(?:^|\r?\n)\s*([^\r\n]+?\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py)):\d+(?::\d+)?:[^\r\n]*$/i)?.[1];
        if (!location) return undefined;

        let workdir = requestedWorkdir || ".";
        if (command.trim()) {
            try {
                workdir = this.resolveCommandWorkdir(process.cwd(), command, requestedWorkdir).workdir;
            } catch {
                // Keep the requested/default workdir when project inference fails.
            }
        }
        const files: string[] = [];
        this.walk(process.cwd(), files);
        const initialTarget = path.resolve(process.cwd(), workdir, location);
        const normalizedLocation = location.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
        const matchingTarget = files
            .filter((relativeFile) => relativeFile.replace(/\\/g, "/").toLowerCase().endsWith(normalizedLocation))
            .sort((left, right) => left.length - right.length)[0];
        const target = fs.existsSync(initialTarget) ? initialTarget : matchingTarget
            ? path.resolve(process.cwd(), matchingTarget)
            : initialTarget;
        const targetRelative = path.relative(process.cwd(), target).replace(/\\/g, "/");
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const exportedDefinition = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:abstract\\s+)?(?:class|function|const|let|var|interface|type|enum)\\s+${escaped}\\b`);
        const definition = files.find((relativeFile) => {
            const absolute = path.resolve(process.cwd(), relativeFile);
            if (absolute.toLowerCase() === target.toLowerCase()) return false;
            if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(relativeFile)) return false;
            try {
                return exportedDefinition.test(fs.readFileSync(absolute, "utf8"));
            } catch {
                return false;
            }
        });
        if (!definition) {
            return `Diagnostic source context: '${symbol}' is used in ${targetRelative}, but no exported definition was found in visible workspace source files. Define it or choose an existing exported symbol before retrying.`;
        }

        const definitionPath = definition.replace(/\\/g, "/");
        let moduleSpecifier = path.relative(path.dirname(target), path.resolve(process.cwd(), definition)).replace(/\\/g, "/")
            .replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, "")
            .replace(/\/index$/i, "");
        if (!moduleSpecifier.startsWith(".")) moduleSpecifier = `./${moduleSpecifier}`;
        return `Diagnostic source context: '${symbol}' is used in ${targetRelative}; an existing exported definition was found in ${definitionPath}. The target file has no in-scope declaration for that symbol. A direct source-level correction is to import it there with: import { ${symbol} } from '${moduleSpecifier}'; Keep the existing symbol reference and do not edit an unrelated registry file.`;
    }

    writeFile(inputPath: string, content: string): void {
        const resolved = this.resolveInsideWorkspace(inputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf8");
    }

    mcpConfigWriteError(inputPath: string, content: string): string | undefined {
        const normalizedPath = inputPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
        if (normalizedPath !== ".cli/mcp.json") return undefined;

        try {
            const parsed = JSON.parse(content) as { mcpServers?: unknown };
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
                || !parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
                return "Invalid .cli/mcp.json: it must be a JSON object with an object-valued mcpServers field. Use {\"mcpServers\":{...}}.";
            }
        } catch {
            return "Invalid .cli/mcp.json: content must be valid JSON with an object-valued mcpServers field.";
        }
        return undefined;
    }

    private walk(root: string, files: string[]): void {
        if (files.length >= this.maxListedFiles * 3) {
            return;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return;
        }

        entries.sort((left, right) => {
            if (left.isFile() !== right.isFile()) return left.isFile() ? -1 : 1;
            return left.name.localeCompare(right.name);
        });

        for (const entry of entries) {
            const absolute = path.join(root, entry.name);
            if (entry.isDirectory() && this.shouldIgnoreDirectory(absolute, entry.name)) {
                continue;
            }

            const relative = path.relative(process.cwd(), absolute) || ".";

            if (entry.isDirectory()) {
                this.walk(absolute, files);
            } else if (entry.isFile()) {
                files.push(relative);
            }
        }
    }

    private shouldIgnoreDirectory(absolutePath: string, name: string): boolean {
        const normalized = name.toLowerCase();
        if (this.ignoredDirectories.has(normalized) || normalized === "cache" || normalized === ".cache") return true;
        if (!normalized.startsWith(".")) return false;
        try {
            return fs.statSync(path.join(absolutePath, "cache")).isDirectory();
        } catch {
            return false;
        }
    }

    missingFileMessage(inputPath: string): string {
        const files: string[] = [];
        this.walk(process.cwd(), files);
        const normalizedTarget = inputPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
        const targetName = path.posix.basename(normalizedTarget);
        const targetDirectory = path.posix.dirname(normalizedTarget);
        const targetExtension = path.posix.extname(targetName);
        const targetSegments = targetDirectory === "." ? [] : targetDirectory.split("/");
        const commonDirectorySuffix = (candidate: string): number => {
            const candidateSegments = path.posix.dirname(candidate).split("/");
            let shared = 0;
            while (shared < targetSegments.length && shared < candidateSegments.length
                && targetSegments[targetSegments.length - shared - 1] === candidateSegments[candidateSegments.length - shared - 1]) {
                shared += 1;
            }
            return shared;
        };
        const distance = (left: string, right: string): number => {
            const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
            for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
                const current = [leftIndex];
                for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
                    current[rightIndex] = Math.min(
                        (current[rightIndex - 1] ?? 0) + 1,
                        (previous[rightIndex] ?? 0) + 1,
                        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
                    );
                }
                previous.splice(0, previous.length, ...current);
            }
            return previous[right.length] ?? Math.max(left.length, right.length);
        };
        const candidates = files
            .map((file) => file.replace(/\\/g, "/"))
            .map((file) => {
                const name = path.posix.basename(file).toLowerCase();
                const exactNameBonus = name === targetName ? -30 : 0;
                const extensionBonus = targetExtension && path.posix.extname(name) === targetExtension ? -4 : 0;
                const directoryBonus = commonDirectorySuffix(file.toLowerCase()) * -5;
                return { file, score: distance(targetName, name) * 4 + exactNameBonus + extensionBonus + directoryBonus };
            })
            .sort((left, right) => left.score - right.score || left.file.length - right.file.length || left.file.localeCompare(right.file))
            .slice(0, 5)
            .map((candidate) => candidate.file);
        return candidates.length > 0
            ? `File not found: ${inputPath}\nClosest visible files (verify the intended target before editing):\n${candidates.map((file) => `- ${file}`).join("\n")}`
            : `File not found: ${inputPath}`;
    }

    resolveInsideWorkspace(inputPath: string): string {
        return this.workspaceGuard.resolveSafePath(process.cwd(), inputPath);
    }

    truncate(content: string, maxChars: number): string {
        if (content.length <= maxChars) {
            return content;
        }

        const headChars = Math.ceil(maxChars / 2);
        const tailChars = Math.floor(maxChars / 2);
        return `${content.slice(0, headChars)}\n\n[Middle truncated; showing first ${headChars} and last ${tailChars} characters]\n\n${content.slice(-tailChars)}`;
    }

}

module.exports = { WorkspaceFileTools };
