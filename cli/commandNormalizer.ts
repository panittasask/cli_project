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
    const isDependencyInstall = /\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:install|i|ci|add|uninstall|remove)\b/.test(normalized);
    const isProjectScaffold = /\b(?:npx(?:\.cmd)?\s+)?(?:ng|@angular\/cli)\s+new\b|\bnpx(?:\.cmd)?\s+(?:create-[\w-]+|@angular\/cli\s+new)\b|\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+create\b/.test(normalized);
    return isDependencyInstall || isProjectScaffold ? 180_000 : 30_000;
}

function commandCreatesWorkspaceFiles(command: string): boolean {
    const normalized = normalizeCommandSignature(command);
    return /\b(?:npx(?:\.cmd)?\s+)?(?:ng|@angular\/cli)\s+new\b|\bnpx(?:\.cmd)?\s+(?:create-[\w-]+|@angular\/cli\s+new)\b|\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+create\b/.test(normalized);
}

function isAngularWorkspaceCommand(command: string): boolean {
    const normalized = normalizeCommandSignature(command);
    return /^(?:npx(?:\.cmd)?\s+(?:@angular\/cli\s+)?|)(?:ng(?:\.cmd)?|@angular\/cli)\s+(?:build|test|lint|serve|extract-i18n)\b/.test(normalized);
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
            if (!entry.isDirectory() || ignoredWorkspaceDirectories.has(entry.name.toLowerCase())) continue;
            visit(path.join(directory, entry.name));
            if (directories.length >= limit) return;
        }
    };

    visit(root);
    return directories;
}

function resolveCommandWorkdir(workspace: string, command: string, requestedWorkdir?: string): { workdir: string; autoSelected: boolean } {
    if (requestedWorkdir?.trim()) {
        return { workdir: requestedWorkdir.trim(), autoSelected: false };
    }

    if (!isAngularWorkspaceCommand(command)) {
        return { workdir: ".", autoSelected: false };
    }

    const matches = findManifestDirectories(workspace, "angular.json");
    const match = matches[0];
    if (matches.length !== 1 || !match) {
        return { workdir: ".", autoSelected: false };
    }

    const relative = path.relative(workspace, match) || ".";
    return { workdir: relative, autoSelected: relative !== "." };
}

module.exports = {
    commandCreatesWorkspaceFiles,
    commandTimeoutMs,
    normalizeCommandSignature,
    resolveCommandWorkdir,
    unwrapWindowsPowerShellCommand
};
