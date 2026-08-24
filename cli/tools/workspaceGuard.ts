import path = require("node:path");

class WorkspaceGuard {
    resolveSafePath(workspacePath: string, requestedPath: string): string {
        const workspace = path.resolve(workspacePath);
        const resolved = path.resolve(workspace, requestedPath);
        const relative = path.relative(workspace, resolved);

        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Path is outside workspace: ${requestedPath}`);
        }

        return resolved;
    }
}

module.exports = { WorkspaceGuard };
