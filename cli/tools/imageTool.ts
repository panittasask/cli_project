import fs = require("node:fs");
import path = require("node:path");

type ImagePrompt = {
    filePath: string;
    prompt: string;
};

class ImageTool {
    private readonly imageMimeByExt: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp"
    };

    parseImagePrompt(input: string): ImagePrompt | undefined {
        const trimmed = input.trim();

        if (!trimmed.toLowerCase().startsWith("/img ")) {
            return undefined;
        }

        const body = trimmed.slice(5).trim();
        if (body.length === 0) {
            throw new Error("Usage: /img <path-to-image> | <prompt> OR /img \"<path-with-space>\" <prompt>");
        }

        let filePath = "";
        let prompt = "";

        const firstChar = body[0];
        const isQuoted = firstChar === '"' || firstChar === "'";

        if (isQuoted) {
            const quote = firstChar;
            const closingIndex = body.indexOf(quote, 1);

            if (closingIndex <= 1) {
                throw new Error("Invalid quoted path. Close the quote after image path.");
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
            throw new Error("Missing image path. Usage: /img <path-to-image> | <prompt>");
        }

        if ((filePath.startsWith('"') && filePath.endsWith('"')) || (filePath.startsWith("'") && filePath.endsWith("'"))) {
            filePath = filePath.slice(1, -1).trim();
        }

        prompt = prompt || "Please analyze this image and describe key details.";

        return {
            filePath,
            prompt
        };
    }

    toDataUrl(inputPath: string): string {
        const resolved = path.resolve(process.cwd(), inputPath);

        if (!fs.existsSync(resolved)) {
            throw new Error(`Image file not found: ${resolved}`);
        }

        const ext = path.extname(resolved).toLowerCase();
        const mime = this.imageMimeByExt[ext];

        if (!mime) {
            throw new Error("Unsupported image format. Use png, jpg, jpeg, webp, gif, or bmp.");
        }

        const binary = fs.readFileSync(resolved);
        const base64 = binary.toString("base64");

        return `data:${mime};base64,${base64}`;
    }
}

module.exports = {
    ImageTool
};
