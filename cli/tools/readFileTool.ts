import fs = require("node:fs");
import path = require("node:path");

type ReadFilePrompt = {
    filePath: string;
    prompt: string;
};

class ReadFileTool {
    private readonly maxChars = 12000;

    parseReadFilePrompt(input: string): ReadFilePrompt | undefined {
        const trimmed = input.trim();

        if (!trimmed.toLowerCase().startsWith("/readfile ")) {
            return undefined;
        }

        const body = trimmed.slice(10).trim();
        if (body.length === 0) {
            throw new Error("Usage: /readfile <path-to-file> | <prompt> OR /readfile \"<path-with-space>\" <prompt>");
        }

        let filePath = "";
        let prompt = "";

        const firstChar = body[0];
        const isQuoted = firstChar === '"' || firstChar === "'";

        if (isQuoted) {
            const quote = firstChar;
            const closingIndex = body.indexOf(quote, 1);

            if (closingIndex <= 1) {
                throw new Error("Invalid quoted path. Close the quote after file path.");
            }

            filePath = body.slice(1, closingIndex).trim();
            const rest = body.slice(closingIndex + 1).trim();

            if (rest.startsWith("|")) {
                prompt = rest.slice(1).trim();
            } else {
                prompt = rest;
            }
        } else {
            const [rawPath, ...promptParts] = body.split("|");
            filePath = rawPath?.trim() ?? "";
            prompt = promptParts.join("|").trim();
        }

        if (!filePath) {
            throw new Error("Missing file path. Usage: /readfile <path-to-file> | <prompt>");
        }

        if ((filePath.startsWith('"') && filePath.endsWith('"')) || (filePath.startsWith("'") && filePath.endsWith("'"))) {
            filePath = filePath.slice(1, -1).trim();
        }

        return {
            filePath,
            prompt: prompt || "Please analyze this file and explain important parts."
        };
    }

    readFileForPrompt(inputPath: string): string {
        const resolved = path.resolve(process.cwd(), inputPath);

        if (!fs.existsSync(resolved)) {
            throw new Error(`File not found: ${resolved}`);
        }

        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            throw new Error(`Not a file: ${resolved}`);
        }

        const buffer = fs.readFileSync(resolved);
        if (buffer.includes(0)) {
            throw new Error("Binary file is not supported with /readfile. Use text/code files.");
        }

        const content = buffer.toString("utf8");
        if (content.length <= this.maxChars) {
            return content;
        }

        return `${content.slice(0, this.maxChars)}\n\n[Truncated to first ${this.maxChars} characters]`;
    }
}

module.exports = {
    ReadFileTool
};
