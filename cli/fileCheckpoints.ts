import fs = require("node:fs");
import path = require("node:path");

type Checkpoint = { id: string; workspace: string; relativePath: string; existed: boolean; content: string; createdAt: number };

class FileCheckpointStore {
    private readonly storePath: string;
    constructor(private readonly root: string) {
        this.storePath = path.join(root, ".cli", "checkpoints.json");
    }

    checkpoint(workspace: string, inputPath: string, nextContent: string): { id: string; preview: string } {
        const absolute = this.resolve(workspace, inputPath);
        const existed = fs.existsSync(absolute);
        const content = existed ? fs.readFileSync(absolute, "utf8") : "";
        const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const entries = this.load();
        entries.push({ id, workspace: path.resolve(workspace), relativePath: path.relative(workspace, absolute), existed, content, createdAt: Date.now() });
        this.save(entries.slice(-30));
        return { id, preview: formatDiffPreview(content, nextContent, inputPath) };
    }

    undoLatest(workspace: string): { ok: boolean; message: string } {
        const entries = this.load();
        const normalized = path.resolve(workspace).toLowerCase();
        const index = entries.findLastIndex((entry) => entry.workspace.toLowerCase() === normalized);
        if (index < 0) return { ok: false, message: "No checkpoint is available for this workspace." };
        const [entry] = entries.splice(index, 1);
        if (!entry) return { ok: false, message: "Checkpoint could not be loaded." };
        const absolute = this.resolve(entry.workspace, entry.relativePath);
        if (entry.existed) {
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, entry.content, "utf8");
        } else if (fs.existsSync(absolute)) {
            fs.rmSync(absolute);
        }
        this.save(entries);
        return { ok: true, message: `Restored ${entry.relativePath} from checkpoint ${entry.id}.` };
    }

    private resolve(workspace: string, inputPath: string): string {
        const absolute = path.resolve(workspace, inputPath);
        const relative = path.relative(workspace, absolute);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside workspace: ${inputPath}`);
        return absolute;
    }
    private load(): Checkpoint[] {
        try { const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf8")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    private save(entries: Checkpoint[]): void {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        fs.writeFileSync(this.storePath, JSON.stringify(entries, null, 2), "utf8");
    }
}

function formatDiffPreview(before: string, after: string, label: string, maxLines = 12): string {
    const oldLines = before.split(/\r?\n/);
    const newLines = after.split(/\r?\n/);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;
    while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) { oldEnd -= 1; newEnd -= 1; }
    const removed = oldLines.slice(prefix, oldEnd + 1).map((line) => `- ${line}`);
    const added = newLines.slice(prefix, newEnd + 1).map((line) => `+ ${line}`);
    const changed = [...removed, ...added];
    const visible = changed.slice(0, maxLines);
    const suffix = changed.length > maxLines ? `\n… ${changed.length - maxLines} more changed lines` : "";
    return `Diff preview: ${label} (-${removed.length} +${added.length})\n${visible.join("\n") || "(no content change)"}${suffix}`;
}

module.exports = { FileCheckpointStore, formatDiffPreview };
