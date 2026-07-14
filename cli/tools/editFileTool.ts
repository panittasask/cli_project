import fs = require("node:fs");
import path = require("node:path");

type EditFilePrompt = {
    filePath: string;
    instruction: string;
};

class EditFileTool {
    private readonly maxChars = 20000;

    parseEditFilePrompt(input: string): EditFilePrompt | undefined {
        const trimmed = input.trim();

        if (!trimmed.toLowerCase().startsWith("/editfile ")) {
            return undefined;
        }

        const body = trimmed.slice(10).trim();
        if (body.length === 0) {
            throw new Error("Usage: /editfile <path-to-file> | <instruction> OR /editfile \"<path-with-space>\" <instruction>");
        }

        let filePath = "";
        let instruction = "";

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
                instruction = rest.slice(1).trim();
            } else {
                instruction = rest;
            }
        } else {
            const [rawPath, ...instructionParts] = body.split("|");
            filePath = rawPath?.trim() ?? "";
            instruction = instructionParts.join("|").trim();
        }

        if (!filePath) {
            throw new Error("Missing file path. Usage: /editfile <path-to-file> | <instruction>");
        }

        if (!instruction) {
            throw new Error("Missing edit instruction. Usage: /editfile <path-to-file> | <instruction>");
        }

        if ((filePath.startsWith('"') && filePath.endsWith('"')) || (filePath.startsWith("'") && filePath.endsWith("'"))) {
            filePath = filePath.slice(1, -1).trim();
        }

        return {
            filePath,
            instruction
        };
    }

    readTargetFile(inputPath: string): string {
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
            throw new Error("Binary file is not supported with /editfile. Use text/code files.");
        }

        const content = buffer.toString("utf8");
        if (content.length <= this.maxChars) {
            return content;
        }

        return `${content.slice(0, this.maxChars)}\n\n[Truncated to first ${this.maxChars} characters]`;
    }

    writeEditedFile(inputPath: string, content: string): void {
        const resolved = path.resolve(process.cwd(), inputPath);
        fs.writeFileSync(resolved, content, "utf8");
    }
}

module.exports = {
    EditFileTool
};
