import fs = require("node:fs");
import path = require("node:path");

const ignoredWorkspaceDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage"
]);

function shouldIgnoreDiscoveryDirectory(absolutePath: string, name: string): boolean {
    const normalized = name.toLowerCase();
    if (ignoredWorkspaceDirectories.has(normalized) || normalized === "cache" || normalized === ".cache") return true;
    if (!normalized.startsWith(".")) return false;
    try {
        return fs.statSync(path.join(absolutePath, "cache")).isDirectory();
    } catch {
        return false;
    }
}

function stripMatchingQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    return (first === last && (first === '"' || first === "'"))
        ? trimmed.slice(1, -1).trim()
        : trimmed;
}

function unwrapWindowsPowerShellCommand(command: string): string {
    let normalized = command.trim();

    // The CLI already launches PowerShell. Local models occasionally wrap the
    // command in powershell.exe again, which breaks quoting and obscures repeat
    // detection. Remove up to three redundant wrapper layers.
    for (let depth = 0; depth < 3; depth += 1) {
        const wrapper = normalized.match(/^(?:powershell|pwsh)(?:\.exe)?\b([\s\S]*)$/i);
        if (!wrapper) break;

        const argumentsText = wrapper[1] ?? "";
        const commandFlag = /(?:^|\s)-(?:command|c)\b\s*/i.exec(argumentsText);
        if (!commandFlag || commandFlag.index === undefined) break;

        const inner = argumentsText.slice(commandFlag.index + commandFlag[0].length);
        const unwrapped = stripMatchingQuotes(inner);
        if (!unwrapped) break;
        normalized = unwrapped;
    }

    return normalized;
}

function normalizeCommandSignature(command: string): string {
    const unwrapped = unwrapWindowsPowerShellCommand(command);
    return unwrapped
        .replace(/^set-location\s+\(get-location\)\s*;\s*/i, "")
        .replace(/["']/g, "")
        .replace(/\\/g, "/")
        .replace(/\s*;\s*/g, ";")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function commandTimeoutMs(command: string): number {
    const normalized = normalizeCommandSignature(command);
    const isDependencyInstall = /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:install|i|ci|add|uninstall|remove)\b/.test(normalized);
    const isProjectScaffold = /^(?:npx(?:\.cmd)?\s+)?[^\s]+\s+(?:new|init|create)\b|^npx(?:\.cmd)?\s+create-[\w-]+\b|^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+create\b/.test(normalized);
    return isDependencyInstall || isProjectScaffold ? 180_000 : 30_000;
}

function commandCreatesWorkspaceFiles(command: string): boolean {
    const normalized = normalizeCommandSignature(command);
    return /^(?:npx(?:\.cmd)?\s+)?[^\s]+\s+(?:new|init|create)\b|^npx(?:\.cmd)?\s+create-[\w-]+\b|^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+create\b/.test(normalized);
}

function commandMutatesWorkspaceFiles(command: string): boolean {
    const normalized = normalizeCommandSignature(command);
    if (commandCreatesWorkspaceFiles(normalized)) return true;
    return /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:install|i|ci|add|uninstall|remove)\b/.test(normalized);
}

function commandAddsTooling(command: string): boolean {
    const normalized = normalizeCommandSignature(command);
    return /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:add|install|i)\s+[^-\s]/.test(normalized)
        || /^\S+\s+add\s+[^-\s]/.test(normalized);
}

function findManifestDirectories(root: string, manifestName: string, limit = 2): string[] {
    const directories: string[] = [];

    const visit = (directory: string): void => {
        if (directories.length >= limit) return;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === manifestName.toLowerCase())) {
            directories.push(directory);
            if (directories.length >= limit) return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const childDirectory = path.join(directory, entry.name);
            if (shouldIgnoreDiscoveryDirectory(childDirectory, entry.name)) continue;
            visit(childDirectory);
            if (directories.length >= limit) return;
        }
    };

    visit(root);
    return directories;
}

function readPackageScripts(directory: string): Record<string, string> {
    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
        return Object.fromEntries(Object.entries(packageJson.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
        return {};
    }
}

function readPackageDependencyNames(directory: string): string[] {
    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
            dependencies?: Record<string, unknown>;
            devDependencies?: Record<string, unknown>;
        };
        return Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
    } catch {
        return [];
    }
}

function packageScriptRequest(command: string): string | undefined {
    const normalized = normalizeCommandSignature(command);
    const match = normalized.match(/^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?([^\s]+)/);
    if (!match) return undefined;
    const requested = match[1];
    if (!requested || ["install", "i", "ci", "add", "remove", "uninstall", "create"].includes(requested)) return undefined;
    return requested;
}

function commandExecutable(command: string): string | undefined {
    const normalized = normalizeCommandSignature(command);
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens[0] === "npx" || tokens[0] === "npx.cmd") return tokens[1];
    if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.cmd"].includes(tokens[0] ?? "")) return undefined;
    return tokens[0]?.replace(/\.cmd$/, "");
}

function packageMatchesCommand(directory: string, command: string): boolean {
    const scripts = readPackageScripts(directory);
    const requestedScript = packageScriptRequest(command);
    if (requestedScript) return typeof scripts[requestedScript] === "string";

    const executable = commandExecutable(command);
    if (!executable) return false;
    const executablePattern = new RegExp(`(?:^|[;&|]\\s*|\\s)${executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.cmd)?(?:\\s|$)`, "i");
    return Object.values(scripts).some((script) => executablePattern.test(normalizeCommandSignature(script)));
}

function commandWorkdirCandidates(workspace: string, command: string): string[] {
    if (commandCreatesWorkspaceFiles(command)) return [];
    return findManifestDirectories(workspace, "package.json", 30)
        .filter((directory) => packageMatchesCommand(directory, command))
        .map((directory) => path.relative(workspace, directory) || ".");
}

function structuralProjectDirectories(workspace: string, limit = 12): string[] {
    const directories = new Set<string>();
    const visit = (directory: string): void => {
        if (directories.size >= limit) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (directories.size >= limit) return;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!shouldIgnoreDiscoveryDirectory(absolute, entry.name)) visit(absolute);
                continue;
            }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
            if (/^(?:package(?:-lock)?|tsconfig(?:\.[\w-]+)?)\.json$/i.test(entry.name)) continue;
            try {
                if (fs.statSync(absolute).size > 100_000) continue;
                const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as Record<string, unknown>;
                const hasProjectShape = (parsed.projects && typeof parsed.projects === "object")
                    || (parsed.workspace && typeof parsed.workspace === "object")
                    || typeof parsed.projectType === "string"
                    || (parsed.targets && typeof parsed.targets === "object");
                if (hasProjectShape) directories.add(path.relative(workspace, directory) || ".");
            } catch {
                // Non-JSON and partial configuration files are ignored.
            }
        }
    };
    visit(workspace);
    return Array.from(directories);
}

function resolveCommandWorkdir(workspace: string, command: string, requestedWorkdir?: string): { workdir: string; autoSelected: boolean } {
    if (requestedWorkdir?.trim()) {
        return { workdir: requestedWorkdir.trim(), autoSelected: false };
    }

    const normalized = normalizeCommandSignature(command);
    if (/^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:install|i|ci|add)(?:\s|$)/.test(normalized)) {
        const manifestDirectories = findManifestDirectories(workspace, "package.json", 30);
        if (manifestDirectories.length === 1) {
            const relativeDirectory = path.relative(workspace, manifestDirectories[0] ?? workspace) || ".";
            return { workdir: relativeDirectory, autoSelected: relativeDirectory !== "." };
        }
    }

    const matches = commandWorkdirCandidates(workspace, command);
    const structuralMatches = structuralProjectDirectories(workspace);
    if (commandExecutable(command) && matches.length > 0 && structuralMatches.length > 0) {
        const scored = Array.from(new Set([...matches, ...structuralMatches])).map((candidate) => ({
            candidate,
            score: (matches.includes(candidate) ? 2 : 0) + (structuralMatches.includes(candidate) ? 3 : 0)
        })).sort((left, right) => right.score - left.score);
        const best = scored[0];
        const runnerUp = scored[1];
        if (best && (!runnerUp || best.score > runnerUp.score)) {
            return { workdir: best.candidate, autoSelected: best.candidate !== "." };
        }
    }
    if (matches.includes(".")) return { workdir: ".", autoSelected: false };
    const match = matches[0];
    if (matches.length !== 1 || !match) {
        return { workdir: ".", autoSelected: false };
    }

    return { workdir: match, autoSelected: true };
}

function projectRootSummary(workspace: string, relativeDirectory: string): string {
    const directory = path.resolve(workspace, relativeDirectory);
    const scripts = Object.keys(readPackageScripts(directory));
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return `${relativeDirectory}: unavailable`;
    }
    const locks = entries.filter((name) => /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(name));
    const configs = entries.filter((name) => {
        if (!name.toLowerCase().endsWith(".json") || /^(?:package(?:-lock)?|tsconfig(?:\.[\w-]+)?)\.json$/i.test(name)) return false;
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>;
            return Boolean((parsed.projects && typeof parsed.projects === "object")
                || (parsed.workspace && typeof parsed.workspace === "object")
                || typeof parsed.projectType === "string"
                || (parsed.targets && typeof parsed.targets === "object"));
        } catch {
            return false;
        }
    });
    return `${relativeDirectory}: scripts=[${scripts.join(", ") || "none"}], structural-config=[${configs.join(", ") || "none"}], lockfiles=[${locks.join(", ") || "none"}]`;
}

function commandFailureGuidance(workspace: string, command: string, errorOutput: string): string {
    const normalized = normalizeCommandSignature(command);
    const error = errorOutput.toLowerCase();
    const retryRule = "Do not repeat the unchanged command. Change the source/configuration, command, or workdir before retrying.";

    if (/etimedout|timed out|timeout/.test(error)) {
        return `The command timed out and its child process may have continued. Inspect generated files and dependency state before deciding whether another command is needed. ${retryRule}`;
    }

    if (/blocked unsafe command|blocked interactive command|unsupported unix command|unsupported nested powershell/.test(error)) {
        return `The command form is not permitted by this runner. Use a built-in file action or a safe, finite, platform-compatible verification command. ${retryRule}`;
    }

    if (/outside (?:a |the )?workspace|project definition could not be found|module file not found|cannot find main module|does not contain main module|could not find a package manifest|\b[\w.-]+(?:\.json|\.toml|\.mod|\.sln|\.csproj)\b[^\r\n]*not found/.test(error)) {
        const manifestCandidates = commandWorkdirCandidates(workspace, normalized);
        const candidates = manifestCandidates.length > 0
            ? Array.from(new Set([...manifestCandidates, ...structuralProjectDirectories(workspace)]))
            : [];
        const locationHint = candidates.length > 0
            ? ` Project workdir candidates inferred from manifests/configuration: ${candidates.join(", ")}. Candidate details: ${candidates.map((candidate) => projectRootSummary(workspace, candidate)).join("; ")}.`
            : " Locate the relevant project manifest and set run_command.workdir to its directory.";
        return `The command appears to be running outside its project workspace.${locationHint} ${retryRule}`;
    }

    if (/is not recognized as an internal or external command|command not found|cannot find module|could not determine executable/.test(error)) {
        return `A required executable or dependency is unavailable in the current project directory. Inspect the relevant manifest and lockfile, then install declared dependencies in that manifest's directory before running a finite build or test. ${retryRule}`;
    }

    if (/address already in use|only one usage of each socket address/.test(error)) {
        return `The requested port is already occupied. Probe the expected local endpoint to determine whether the required service is already running; do not start an identical server again. ${retryRule}`;
    }

    const diagnosticHint = diagnosticRecoveryGuidance(errorOutput);
    return `${diagnosticHint ? `${diagnosticHint} ` : ""}Read the first actionable error below, inspect the referenced file or project manifest, and make a concrete correction before another verification attempt. ${retryRule}`;
}

function diagnosticRecoveryGuidance(errorOutput: string): string | undefined {
    if (commandInvocationError(errorOutput)) {
        return "The command invocation itself is invalid or unsupported. Correct or remove the rejected command/option based on this error; do not edit project source or configuration merely to preserve the same invalid invocation.";
    }
    const missingIdentifier = errorOutput.match(/Cannot find name ['"]([^'"]+)['"]/i)?.[1];
    if (missingIdentifier) {
        return `Identifier '${missingIdentifier}' is unresolved in the referenced source file. Add or import an existing definition there; renaming it to another unresolved identifier or only registering it elsewhere is not a fix.`;
    }
    const missingExport = errorOutput.match(/has no exported member ['"]([^'"]+)['"]/i)?.[1];
    if (missingExport) {
        return `The imported member '${missingExport}' is not exported by that module. Inspect the module's actual exports and correct the import or implementation before retrying.`;
    }
    if (/is not a known element/i.test(errorOutput)) {
        return "Follow the diagnostic's stated component/import owner. Do not suppress the error with a schema unless the element is intentionally an external custom element.";
    }
    return undefined;
}

function commandInvocationError(errorOutput: string): boolean {
    return /\b(?:unknown|unrecognized|unsupported|invalid) (?:argument|option|flag|command)\b|\bunexpected argument\b|\brequires? (?:an? )?(?:argument|value)\b|\bcommand not found\b|\bis not recognized as (?:an internal|the name of)/i.test(errorOutput)
        || missingCommandTargetError(errorOutput);
}

function missingCommandTargetError(errorOutput: string): boolean {
    const plain = errorOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    return /\bcannot\s+find[\s\S]{0,100}\btarget\b|\btarget\b[\s\S]{0,100}(?:does\s+not\s+exist|was\s+not\s+found)/i.test(plain);
}

function commandInteractiveRisk(command: string, workspace: string, workdir = "."): string | undefined {
    const normalized = normalizeCommandSignature(command);

    if (/(?:^|\s)--open(?:=|\s|$)|\b(?:start-process|invoke-item|explorer(?:\.exe)?|rundll32(?:\.exe)?)\b[^\r\n]*https?:\/\//.test(normalized)) {
        return "automatic browser launching is not allowed in agent run_command";
    }

    if (/(?:^|\s)--watch(?:=|\s+)(?!false\b)|(?:^|\s)--watch(?:\s|$)|(?:^|\s)(?:serve|dev|watch)(?:\s|$)/.test(normalized)) {
        return "long-running serve/dev/watch commands are not allowed in agent run_command; use a finite build or non-watch test command";
    }

    if (/(?:^|\s)test(?:\s|$)/.test(normalized)) {
        const browserRunner = readPackageDependencyNames(path.resolve(workspace, workdir)).find((dependency) => (
            /^(?:karma-(?:chrome|firefox|edge)-launcher|@?playwright\/test|playwright|puppeteer|cypress|selenium-webdriver|webdriverio|nightwatch)$/i.test(dependency)
        ));
        if (browserRunner) {
            return `test setup includes browser runner '${browserRunner}', which may launch a browser process; use a finite build, typecheck, lint, or non-browser test target`;
        }
    }

    const npmScript = normalized.match(/^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(start|dev|serve|watch|test)\b/);
    if (!npmScript) return undefined;

    const scriptName = npmScript[1];
    if (!scriptName) return undefined;
    if (["start", "dev", "serve", "watch"].includes(scriptName)) {
        return `package lifecycle '${scriptName}' is expected to be long-running; use a finite build or test script`;
    }
    const script = readPackageScripts(path.resolve(workspace, workdir))[scriptName];
    if (typeof script === "string") {
        const scriptRisk = commandInteractiveRisk(script, workspace, workdir);
        if (scriptRisk) return `package script '${scriptName}' is interactive: ${scriptRisk}`;
    }

    return undefined;
}

function packageContentAddsBrowserAutoOpen(filePath: string, content: string): boolean {
    if (path.basename(filePath).toLowerCase() !== "package.json") return false;
    try {
        const packageJson = JSON.parse(content) as { scripts?: Record<string, unknown> };
        return Object.values(packageJson.scripts ?? {}).some((script) => (
            typeof script === "string"
            && /(?:^|\s)--open(?:=|\s|$)/i.test(script)
        ));
    } catch {
        return false;
    }
}

function packageLifecycleRoleChanges(beforeContent: string, afterContent: string): string[] {
    const role = (command: unknown): string | undefined => {
        if (typeof command !== "string") return undefined;
        const normalized = normalizeCommandSignature(command);
        if (/\b(?:serve|server|dev|start|watch)\b/.test(normalized)) return "runtime";
        if (/\b(?:build|bundle|compile)\b/.test(normalized)) return "build";
        if (/\b(?:test|spec)\b/.test(normalized)) return "test";
        if (/\b(?:lint|typecheck|type-check|check-types)\b/.test(normalized)) return "analysis";
        return undefined;
    };
    try {
        const before = JSON.parse(beforeContent) as { scripts?: Record<string, unknown> };
        const after = JSON.parse(afterContent) as { scripts?: Record<string, unknown> };
        return Object.keys(before.scripts ?? {}).filter((name) => {
            if (!(name in (after.scripts ?? {}))) return false;
            const beforeRole = role(before.scripts?.[name]);
            const afterRole = role(after.scripts?.[name]);
            return Boolean(beforeRole && afterRole && beforeRole !== afterRole);
        });
    } catch {
        return [];
    }
}

type PackageMutation = {
    manager: "npm" | "pnpm" | "yarn" | "bun";
    operation: "add" | "remove" | "install_declared";
    packages: Array<{ spec: string; name: string; version?: string }>;
    development: boolean;
};

function parsePackageSpec(spec: string): { spec: string; name: string; version?: string } | undefined {
    const clean = spec.trim().replace(/^['"]|['"]$/g, "");
    const match = clean.startsWith("@")
        ? clean.match(/^(@[\w.-]+\/[\w.-]+)(?:@(.+))?$/)
        : clean.match(/^([\w.-]+)(?:@(.+))?$/);
    if (!match?.[1]) return undefined;
    return { spec: clean, name: match[1].toLowerCase(), ...(match[2] ? { version: match[2] } : {}) };
}

function parsePackageMutation(command: string): PackageMutation | undefined {
    const normalized = unwrapWindowsPowerShellCommand(command).trim();
    if (/[\r\n;&|]/.test(normalized)) return undefined;
    const tokens = normalized.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const managerToken = tokens[0]?.toLowerCase().replace(/\.cmd$/, "");
    if (!managerToken || !["npm", "pnpm", "yarn", "bun"].includes(managerToken)) return undefined;
    const manager = managerToken as PackageMutation["manager"];
    const verb = tokens[1]?.toLowerCase();
    const addVerbs = manager === "yarn" || manager === "bun" ? ["add"] : ["install", "i", "add"];
    const removeVerbs = ["remove", "uninstall", "rm"];
    if (!verb || (!addVerbs.includes(verb) && !removeVerbs.includes(verb) && verb !== "install" && verb !== "ci")) return undefined;
    const operation: PackageMutation["operation"] = removeVerbs.includes(verb)
        ? "remove" : tokens.slice(2).some((token) => !token.startsWith("-")) ? "add" : "install_declared";
    const flagsWithValues = new Set(["--registry", "--workspace", "--filter", "--config", "--cache"]);
    const packageTokens: string[] = [];
    for (let index = 2; index < tokens.length; index += 1) {
        const token = tokens[index] ?? "";
        if (flagsWithValues.has(token.toLowerCase())) {
            index += 1;
            continue;
        }
        if (!token.startsWith("-")) packageTokens.push(token);
    }
    const packages = packageTokens.flatMap((token) => {
        const parsed = parsePackageSpec(token);
        return parsed ? [parsed] : [];
    });
    if (operation !== "install_declared" && packages.length !== packageTokens.length) return undefined;
    return {
        manager,
        operation,
        packages,
        development: tokens.some((token) => /^(?:-d|--save-dev|--dev)$/i.test(token))
    };
}

function packageMutationRisk(workspace: string, userMessage: string, command: string, requestedWorkdir?: string): string | undefined {
    const mutation = parsePackageMutation(command);
    if (!mutation) return undefined;
    const manifests = findManifestDirectories(workspace, "package.json", 30);
    if (manifests.length > 1 && !requestedWorkdir?.trim()) {
        return `multiple package roots were found (${manifests.map((directory) => path.relative(workspace, directory) || ".").join(", ")}); set run_command.workdir to one inspected target`;
    }
    const resolved = resolveCommandWorkdir(workspace, command, requestedWorkdir);
    const root = path.resolve(workspace, resolved.workdir);
    const relativeRoot = path.relative(workspace, root);
    if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) return `selected workdir '${resolved.workdir}' is outside the workspace`;
    const manifestPath = path.join(root, "package.json");
    if (!fs.existsSync(manifestPath)) return `no package.json exists in the selected workdir '${resolved.workdir}'`;

    const lockManagers = [
        fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : "",
        fs.existsSync(path.join(root, "yarn.lock")) ? "yarn" : "",
        fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb")) ? "bun" : "",
        fs.existsSync(path.join(root, "package-lock.json")) ? "npm" : ""
    ].filter(Boolean);
    if (lockManagers.length === 1 && lockManagers[0] !== mutation.manager) {
        return `package manager '${mutation.manager}' does not match the existing ${lockManagers[0]} lockfile in '${resolved.workdir}'`;
    }

    let declared: Record<string, string> = {};
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        declared = { ...manifest.dependencies, ...manifest.devDependencies };
    } catch {
        return `package.json in '${resolved.workdir}' is invalid; inspect and repair it before changing dependencies`;
    }
    for (const dependency of mutation.packages) {
        const escapedName = dependency.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const explicitlyNamed = new RegExp(`(^|[^\\w@./-])${escapedName}(?=$|[^\\w./-])`, "i").test(userMessage);
        const alreadyDeclared = Object.keys(declared).some((name) => name.toLowerCase() === dependency.name);
        if (mutation.operation === "add" && !explicitlyNamed && !alreadyDeclared) {
            return `package '${dependency.name}' was not explicitly named by the user and is not already declared; inspect requirements or ask a target/scope clarification before installing it`;
        }
        if (mutation.operation === "add" && dependency.version) {
            const requestedSpec = `${dependency.name}@${dependency.version}`.toLowerCase();
            const userRequestedVersion = userMessage.toLowerCase().includes(requestedSpec);
            const declaredVersion = Object.entries(declared).find(([name]) => name.toLowerCase() === dependency.name)?.[1];
            if (!userRequestedVersion && declaredVersion !== dependency.version) {
                return `version '${dependency.version}' for '${dependency.name}' was not requested or established by the manifest; use the unversioned package name so the configured registry resolves it, or inspect authoritative compatibility evidence`;
            }
        }
    }
    return undefined;
}

module.exports = {
    commandFailureGuidance,
    commandInvocationError,
    diagnosticRecoveryGuidance,
    commandInteractiveRisk,
    commandAddsTooling,
    commandCreatesWorkspaceFiles,
    commandMutatesWorkspaceFiles,
    commandWorkdirCandidates,
    commandTimeoutMs,
    normalizeCommandSignature,
    missingCommandTargetError,
    packageLifecycleRoleChanges,
    packageMutationRisk,
    parsePackageMutation,
    packageContentAddsBrowserAutoOpen,
    resolveCommandWorkdir,
    unwrapWindowsPowerShellCommand
};
