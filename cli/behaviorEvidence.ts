import fs = require("node:fs");
import path = require("node:path");

const implementationExtensions = [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"];
const declarationExtensions = new Set([".html", ".htm", ".css", ".scss", ".sass", ".less"]);

function behaviorCompanionFiles(workspace: string, inputPath: string): string[] {
    const root = path.resolve(workspace);
    const target = path.resolve(root, inputPath);
    const relativeTarget = path.relative(root, target);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) return [];
    const extension = path.extname(target).toLowerCase();
    if (!declarationExtensions.has(extension)) return [];

    const base = target.slice(0, -extension.length);
    return implementationExtensions
        .map((candidateExtension) => `${base}${candidateExtension}`)
        .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
        .map((candidate) => path.relative(root, candidate).replace(/\\/g, "/"));
}

function missingBehaviorCompanionInspections(
    workspace: string,
    inputPath: string,
    readPaths: Set<string>
): string[] {
    return behaviorCompanionFiles(workspace, inputPath).filter((candidate) => (
        !readPaths.has(path.resolve(workspace, candidate).toLowerCase())
    ));
}

module.exports = { behaviorCompanionFiles, missingBehaviorCompanionInspections };
