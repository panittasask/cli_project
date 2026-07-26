import childProcess = require("node:child_process");
import crypto = require("node:crypto");
import fs = require("node:fs");
import path = require("node:path");

type IndexedFile = {
    path: string;
    size: number;
    mtimeMs: number;
    hash: string;
    language: string;
    kind: "manifest" | "config" | "test" | "source" | "documentation" | "other";
    symbols: string[];
    imports: string[];
    content: string;
};

type StoredProjectIndex = {
    version: 1;
    workspace: string;
    generatedAt: string;
    files: IndexedFile[];
};

type ProjectSearchResult = {
    path: string;
    score: number;
    kind: IndexedFile["kind"];
    language: string;
    symbols: string[];
    imports: string[];
    matches: Array<{ line: number; text: string }>;
};

const INDEX_VERSION = 1;
const MAX_FILES = 10_000;
const MAX_CONTENT_CHARS_PER_FILE = 40_000;
const MAX_TOTAL_CONTENT_CHARS = 20_000_000;
const MAX_FILE_BYTES = 1_000_000;
const IGNORED_PARTS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage",
    ".cache",
    "cache",
    "logs"
]);
const MANIFEST_NAMES = new Set([
    "package.json",
    "deno.json",
    "go.mod",
    "cargo.toml",
    "pyproject.toml",
    "pom.xml",
    "composer.json"
]);
const CONFIG_NAMES = new Set([
    "tsconfig.json",
    "jsconfig.json",
    "angular.json",
    "vite.config.ts",
    "vite.config.js",
    "webpack.config.js",
    "eslint.config.js",
    "eslint.config.mjs"
]);

function normalizeRelative(file: string): string {
    return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function tokenize(value: string): string[] {
    const aliases: Record<string, string[]> = {
        configuration: ["config"],
        configurations: ["config"],
        settings: ["config"],
        typescript: ["ts"],
        javascript: ["js"],
        tests: ["test"],
        testing: ["test"],
        dependencies: ["dependency"],
        packages: ["package"]
    };
    const ignored = new Set(["find", "project", "related", "relevant", "source", "file", "files", "code"]);
    const tokens = value.toLowerCase()
        .split(/[^\p{L}\p{N}_.@/-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !ignored.has(token));
    return Array.from(new Set(tokens.flatMap((token) => [token, ...(aliases[token] ?? [])])));
}

function languageFor(file: string): string {
    const extension = path.extname(file).toLowerCase();
    const names: Record<string, string> = {
        ".ts": "TypeScript",
        ".tsx": "TypeScript JSX",
        ".js": "JavaScript",
        ".jsx": "JavaScript JSX",
        ".mjs": "JavaScript",
        ".cjs": "JavaScript",
        ".json": "JSON",
        ".go": "Go",
        ".rs": "Rust",
        ".py": "Python",
        ".java": "Java",
        ".kt": "Kotlin",
        ".cs": "C#",
        ".fs": "F#",
        ".html": "HTML",
        ".css": "CSS",
        ".scss": "SCSS",
        ".md": "Markdown",
        ".yml": "YAML",
        ".yaml": "YAML",
        ".toml": "TOML",
        ".ps1": "PowerShell"
    };
    return names[extension] ?? (extension ? extension.slice(1).toUpperCase() : "text");
}

function kindFor(file: string): IndexedFile["kind"] {
    const name = path.basename(file).toLowerCase();
    if (MANIFEST_NAMES.has(name) || /\.(?:sln|csproj|fsproj)$/i.test(name)) return "manifest";
    if (CONFIG_NAMES.has(name) || /(?:^|[._-])config(?:[._-]|$)/i.test(name)) return "config";
    if (/(?:^|[\\/_.-])(?:test|tests|spec|specs)(?:[\\/_.-]|$)/i.test(file)) return "test";
    if (/\.(?:ts|tsx|js|jsx|mjs|cjs|go|rs|py|java|kt|cs|fs|html|css|scss)$/i.test(file)) return "source";
    if (/\.(?:md|txt|rst)$/i.test(file)) return "documentation";
    return "other";
}

function mayPersistContent(file: string): boolean {
    const name = path.basename(file).toLowerCase();
    if (name === ".env" || name.startsWith(".env.")) return false;
    if (/\.(?:pem|key|p12|pfx|jks)$/i.test(name)) return false;
    return !/(?:credential|credentials|secret|secrets|token|tokens)(?:[._-]|$)/i.test(name);
}

function extractSymbols(content: string): string[] {
    const symbols = new Set<string>();
    const patterns = [
        /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
        /\b(?:func|type|struct|class|def)\s+([A-Za-z_][\w]*)/g
    ];
    for (const pattern of patterns) {
        for (const match of content.matchAll(pattern)) {
            if (match[1]) symbols.add(match[1]);
            if (symbols.size >= 80) return Array.from(symbols);
        }
    }
    return Array.from(symbols);
}

function extractImports(content: string): string[] {
    const imports = new Set<string>();
    const patterns = [
        /\bfrom\s+["']([^"']+)["']/g,
        /\brequire\(\s*["']([^"']+)["']\s*\)/g,
        /^\s*import\s+["']([^"']+)["']/gm,
        /^\s*use\s+([^;\s]+)/gm
    ];
    for (const pattern of patterns) {
        for (const match of content.matchAll(pattern)) {
            if (match[1]) imports.add(match[1]);
            if (imports.size >= 80) return Array.from(imports);
        }
    }
    return Array.from(imports);
}

class ProjectIndex {
    private files = new Map<string, IndexedFile>();
    private lastRefreshAt = 0;
    private dirty = true;
    private readonly cachePath: string;

    constructor(private readonly workspace: string) {
        this.workspace = path.resolve(workspace);
        this.cachePath = path.join(this.workspace, ".cli", "cache", "project-index-v1.json");
        this.load();
    }

    markDirty(): void {
        this.dirty = true;
    }

    refresh(force = false): void {
        if (!force && !this.dirty && Date.now() - this.lastRefreshAt < 2_000) return;
        const candidates = this.enumerateFiles();
        const previous = this.files;
        const next = new Map<string, IndexedFile>();
        let totalContentChars = 0;

        for (const relative of candidates) {
            const absolute = path.join(this.workspace, relative);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(absolute);
            } catch {
                continue;
            }
            if (!stat.isFile()) continue;
            const cached = previous.get(relative);
            if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
                next.set(relative, cached);
                totalContentChars += cached.content.length;
                continue;
            }
            const indexed = this.indexFile(relative, absolute, stat, totalContentChars);
            next.set(relative, indexed);
            totalContentChars += indexed.content.length;
        }

        this.files = next;
        this.lastRefreshAt = Date.now();
        this.dirty = false;
        this.save();
    }

    summary(): string {
        this.refresh();
        const files = Array.from(this.files.values());
        const roots = this.projectRoots(files);
        const counts = files.reduce<Record<string, number>>((result, file) => {
            result[file.kind] = (result[file.kind] ?? 0) + 1;
            return result;
        }, {});
        const keyFiles = files
            .filter((file) => file.kind === "manifest" || file.kind === "config")
            .slice(0, 30)
            .map((file) => file.path);
        const topDirectories = this.topDirectories(files);
        return [
            `Indexed project: ${files.length} files`,
            `Project roots: ${roots.length > 0 ? roots.join(", ") : "."}`,
            `Kinds: ${Object.entries(counts).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none"}`,
            `Top directories: ${topDirectories.join(", ") || "."}`,
            `Manifests/config: ${keyFiles.join(", ") || "none"}`,
            "Use search_project to retrieve ranked paths, symbols, imports, and matching lines before read_file."
        ].join("\n");
    }

    search(query: string, limit = 12, inputPath?: string): string {
        this.refresh();
        const normalizedRoot = inputPath ? normalizeRelative(inputPath).replace(/\/+$/, "") : "";
        const terms = tokenize(query);
        if (terms.length === 0) return JSON.stringify({ query, indexedFiles: this.files.size, results: [] });
        const results = Array.from(this.files.values())
            .filter((file) => !normalizedRoot || file.path === normalizedRoot || file.path.startsWith(`${normalizedRoot}/`))
            .map((file) => this.scoreFile(file, terms))
            .filter((result): result is ProjectSearchResult => result !== undefined)
            .filter((result) => result.score > 0)
            .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
            .slice(0, Math.max(1, Math.min(30, Math.floor(limit))));
        return JSON.stringify({
            query,
            indexedFiles: this.files.size,
            generatedAt: new Date(this.lastRefreshAt).toISOString(),
            results
        }, null, 2);
    }

    private scoreFile(file: IndexedFile, terms: string[]): ProjectSearchResult | undefined {
        const pathText = file.path.toLowerCase();
        const symbolText = file.symbols.join(" ").toLowerCase();
        const importText = file.imports.join(" ").toLowerCase();
        const contentText = file.content.toLowerCase();
        let score = file.kind === "manifest" || file.kind === "config" ? 1 : 0;
        if (file.kind === "config" && terms.some((term) => term === "config" || term === "configuration" || term === "settings")) {
            score += 50;
        }
        if (file.kind === "manifest" && terms.some((term) => ["manifest", "package", "dependency", "dependencies"].includes(term))) {
            score += 40;
        }
        if (CONFIG_NAMES.has(path.basename(file.path).toLowerCase())) score += 12;
        const matchedTerms = new Set<string>();
        for (const term of terms) {
            if (pathText.includes(term)) {
                score += path.basename(pathText).includes(term) ? 18 : 10;
                matchedTerms.add(term);
            }
            if (symbolText.includes(term)) {
                score += 12;
                matchedTerms.add(term);
            }
            if (importText.includes(term)) {
                score += 8;
                matchedTerms.add(term);
            }
            if (contentText.includes(term)) {
                score += 3;
                matchedTerms.add(term);
            }
        }
        if (matchedTerms.size === 0) return undefined;
        score += matchedTerms.size * matchedTerms.size * 2;
        const matches: Array<{ line: number; text: string }> = [];
        const lines = file.content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < 5; index += 1) {
            const line = lines[index] ?? "";
            const lower = line.toLowerCase();
            if (terms.some((term) => lower.includes(term))) {
                matches.push({ line: index + 1, text: line.trim().slice(0, 240) });
            }
        }
        return {
            path: file.path,
            score,
            kind: file.kind,
            language: file.language,
            symbols: file.symbols.slice(0, 20),
            imports: file.imports.slice(0, 20),
            matches
        };
    }

    private enumerateFiles(): string[] {
        const gitFiles = this.gitFiles();
        if (gitFiles.length > 0) return gitFiles.slice(0, MAX_FILES);
        const files: string[] = [];
        const visit = (directory: string): void => {
            if (files.length >= MAX_FILES) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }
            entries.sort((left, right) => left.name.localeCompare(right.name));
            for (const entry of entries) {
                if (files.length >= MAX_FILES) break;
                const absolute = path.join(directory, entry.name);
                const relative = normalizeRelative(path.relative(this.workspace, absolute));
                if (this.isIgnored(relative)) continue;
                if (entry.isDirectory()) visit(absolute);
                else if (entry.isFile()) files.push(relative);
            }
        };
        visit(this.workspace);
        return files;
    }

    private gitFiles(): string[] {
        try {
            const output = childProcess.execFileSync(
                "git",
                ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                {
                    cwd: this.workspace,
                    encoding: "utf8",
                    windowsHide: true,
                    maxBuffer: 20_000_000,
                    stdio: ["ignore", "pipe", "ignore"]
                }
            );
            return output.split("\0")
                .map(normalizeRelative)
                .filter(Boolean)
                .filter((file) => !this.isIgnored(file))
                .sort((left, right) => left.localeCompare(right));
        } catch {
            return [];
        }
    }

    private isIgnored(relative: string): boolean {
        const parts = normalizeRelative(relative).toLowerCase().split("/");
        if (parts.some((part) => IGNORED_PARTS.has(part))) return true;
        return parts[0] === ".cli" && (parts[1] === "cache" || parts[1] === "logs");
    }

    private indexFile(relative: string, absolute: string, stat: fs.Stats, totalContentChars: number): IndexedFile {
        let content = "";
        if (mayPersistContent(relative) && stat.size <= MAX_FILE_BYTES && totalContentChars < MAX_TOTAL_CONTENT_CHARS) {
            try {
                const buffer = fs.readFileSync(absolute);
                if (!buffer.includes(0)) {
                    const remaining = MAX_TOTAL_CONTENT_CHARS - totalContentChars;
                    content = buffer.toString("utf8").slice(0, Math.min(MAX_CONTENT_CHARS_PER_FILE, remaining));
                }
            } catch {
                content = "";
            }
        }
        return {
            path: relative,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            hash: crypto.createHash("sha1").update(content || `${stat.size}:${stat.mtimeMs}`).digest("hex"),
            language: languageFor(relative),
            kind: kindFor(relative),
            symbols: extractSymbols(content),
            imports: extractImports(content),
            content
        };
    }

    private projectRoots(files: IndexedFile[]): string[] {
        return Array.from(new Set(
            files.filter((file) => file.kind === "manifest")
                .map((file) => path.posix.dirname(file.path))
                .map((directory) => directory === "." ? "." : directory)
        )).sort();
    }

    private topDirectories(files: IndexedFile[]): string[] {
        const counts = new Map<string, number>();
        for (const file of files) {
            const directory = file.path.includes("/") ? file.path.split("/")[0]! : ".";
            counts.set(directory, (counts.get(directory) ?? 0) + 1);
        }
        return Array.from(counts.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 12)
            .map(([directory, count]) => `${directory} (${count})`);
    }

    private load(): void {
        try {
            const stored = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as StoredProjectIndex;
            if (stored.version !== INDEX_VERSION || path.resolve(stored.workspace) !== this.workspace || !Array.isArray(stored.files)) return;
            this.files = new Map(stored.files.map((file) => [file.path, file]));
        } catch {
            // A missing or stale cache is rebuilt on first use.
        }
    }

    private save(): void {
        const stored: StoredProjectIndex = {
            version: INDEX_VERSION,
            workspace: this.workspace,
            generatedAt: new Date(this.lastRefreshAt).toISOString(),
            files: Array.from(this.files.values())
        };
        try {
            fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
            const temporary = `${this.cachePath}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, `${JSON.stringify(stored)}\n`, "utf8");
            fs.renameSync(temporary, this.cachePath);
        } catch {
            // Index persistence is an optimization; in-memory search still works.
        }
    }
}

module.exports = { ProjectIndex };
