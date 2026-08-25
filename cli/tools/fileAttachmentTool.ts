import fs = require("node:fs");
import path = require("node:path");

const mammoth = require("mammoth") as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
};
const XLSX = require("xlsx") as {
    read: (data: Buffer, options: { type: "buffer" }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: {
        sheet_to_csv: (sheet: unknown, options?: { blankrows?: boolean }) => string;
    };
};
const WordExtractor = require("word-extractor") as new () => {
    extract: (source: Buffer) => Promise<{ getBody: () => string }>;
};

type FileAttachmentRequest = {
    filePaths: string[];
    prompt: string;
};

class FileAttachmentTool {
    private readonly maxCharsPerFile = 12000;

    parseInput(input: string): FileAttachmentRequest | undefined {
        const trimmed = input.trim();
        if (!trimmed) return undefined;

        if (trimmed.toLowerCase() === "/attach" || trimmed.toLowerCase().startsWith("/attach ")) {
            const body = trimmed.slice("/attach".length).trim();
            if (!body) {
                throw new Error("Usage: /attach <file-path> [file-path...] | <prompt>");
            }

            const [rawPaths, ...promptParts] = body.split("|");
            const filePaths = this.parsePathList(rawPaths?.trim() ?? "");
            if (!filePaths || filePaths.length === 0) {
                throw new Error("No existing files were found. Quote paths that contain spaces.");
            }

            return {
                filePaths,
                prompt: promptParts.join("|").trim() || "Please analyze the attached file(s) and answer based on their contents."
            };
        }

        // Explorer and most terminal emulators paste a dropped path as one
        // quoted value. Supporting an exact existing path first also handles
        // paths with spaces when the emulator omits quotes.
        const exactPath = this.resolveExistingFile(this.removeOuterQuotes(trimmed));
        if (exactPath) {
            return {
                filePaths: [exactPath],
                prompt: "Please analyze the attached file and answer based on its contents."
            };
        }

        const pathWithPrompt = this.parseLeadingPathWithPrompt(trimmed);
        if (pathWithPrompt) return pathWithPrompt;

        // Multiple dropped files are commonly pasted as: "a file.txt" "b.xlsx".
        // Only treat the whole input as an attachment when every token is an
        // existing file; ordinary conversational text therefore remains chat.
        if (trimmed.includes("|")) return undefined;
        const droppedPaths = this.parsePathTokens(trimmed);
        if (droppedPaths.length > 1 && droppedPaths.every((candidate) => this.resolveExistingFile(candidate))) {
            return {
                filePaths: droppedPaths.map((candidate) => this.resolveExistingFile(candidate) as string),
                prompt: "Please analyze the attached files and answer based on their contents."
            };
        }

        return undefined;
    }

    async buildPrompt(request: FileAttachmentRequest): Promise<string> {
        const sections: string[] = [];

        for (const filePath of request.filePaths) {
            const content = await this.readFileForPrompt(filePath);
            sections.push(`File path: ${filePath}\nFile content:\n${content}`);
        }

        return `${request.prompt}\n\nAttached files:\n\n${sections.join("\n\n---\n\n")}`;
    }

    async readFileForPrompt(inputPath: string): Promise<string> {
        const resolved = this.resolveExistingFile(inputPath);
        if (!resolved) {
            throw new Error(`File not found: ${path.resolve(process.cwd(), inputPath)}`);
        }

        const buffer = fs.readFileSync(resolved);
        const extension = path.extname(resolved).toLowerCase();
        let content: string;

        if (extension === ".docx") {
            content = await this.readDocx(buffer);
        } else if (extension === ".doc") {
            content = await this.readLegacyWord(buffer);
        } else if ([".xls", ".xlsx", ".xlsm", ".xlsb"].includes(extension)) {
            content = this.readExcel(buffer);
        } else {
            if (buffer.includes(0)) {
                throw new Error(`Binary file is not supported: ${inputPath}. Supported attachments: txt, csv, md, json, doc, docx, xls, xlsx.`);
            }
            content = buffer.toString("utf8");
        }

        return this.truncate(content);
    }

    private async readDocx(buffer: Buffer): Promise<string> {
        try {
            const result = await mammoth.extractRawText({ buffer });
            return result.value;
        } catch (error) {
            // word-extractor understands both OOXML and legacy OLE Word files,
            // so it is a useful fallback for malformed-but-readable .docx data.
            return this.readWordWithExtractor(buffer, error);
        }
    }

    private async readLegacyWord(buffer: Buffer): Promise<string> {
        return this.readWordWithExtractor(buffer);
    }

    private async readWordWithExtractor(buffer: Buffer, previousError?: unknown): Promise<string> {
        try {
            const document = await new WordExtractor().extract(buffer);
            return document.getBody();
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const fallback = previousError instanceof Error ? ` (${previousError.message})` : "";
            throw new Error(`Could not read Word document${fallback}: ${reason}`);
        }
    }

    private readExcel(buffer: Buffer): string {
        try {
            const workbook = XLSX.read(buffer, { type: "buffer" });
            return workbook.SheetNames.map((sheetName) => {
                const sheet = workbook.Sheets[sheetName];
                return `Sheet: ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
            }).join("\n\n---\n\n");
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not read Excel workbook: ${reason}`);
        }
    }

    private truncate(content: string): string {
        if (content.length <= this.maxCharsPerFile) return content;
        return `${content.slice(0, this.maxCharsPerFile)}\n\n[Truncated to first ${this.maxCharsPerFile} characters]`;
    }

    private parsePathList(input: string): string[] | undefined {
        const wholePath = this.resolveExistingFile(this.removeOuterQuotes(input));
        if (wholePath) return [wholePath];

        const tokens = this.parsePathTokens(input);
        const resolved = tokens.map((candidate) => this.resolveExistingFile(candidate));
        return tokens.length > 0 && resolved.every(Boolean) ? resolved as string[] : undefined;
    }

    private parseLeadingPathWithPrompt(input: string): FileAttachmentRequest | undefined {
        const quotedMatch = input.match(/^"([^"\n]+)"\s+(.+)$/) ?? input.match(/^'([^'\n]+)'\s+(.+)$/);
        const unquotedMatch = input.match(/^(\S+)\s+(.+)$/);
        const match = quotedMatch ?? unquotedMatch;
        if (!match?.[1] || !match[2]) return undefined;

        const filePath = this.resolveExistingFile(match[1]);
        if (!filePath) return undefined;

        // A line containing only several dropped paths is handled by the
        // multi-file branch below. Here the remainder must be a real prompt.
        const remainderTokens = this.parsePathTokens(match[2]);
        if (remainderTokens.length > 0 && remainderTokens.every((candidate) => this.resolveExistingFile(candidate))) {
            return undefined;
        }

        return {
            filePaths: [filePath],
            prompt: match[2].trim()
        };
    }

    private parsePathTokens(input: string): string[] {
        const tokens: string[] = [];
        const tokenPattern = /"([^"\n]+)"|'([^'\n]+)'|(\S+)/g;
        for (const match of input.matchAll(tokenPattern)) {
            const token = match[1] ?? match[2] ?? match[3];
            if (token) tokens.push(token);
        }
        return tokens;
    }

    private removeOuterQuotes(input: string): string {
        if (input.length >= 2) {
            const first = input[0];
            const last = input[input.length - 1];
            if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                return input.slice(1, -1).trim();
            }
        }
        return input.trim();
    }

    private resolveExistingFile(inputPath: string): string | undefined {
        if (!inputPath.trim()) return undefined;

        try {
            const resolved = path.resolve(process.cwd(), inputPath);
            return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : undefined;
        } catch {
            return undefined;
        }
    }
}

module.exports = {
    FileAttachmentTool
};
