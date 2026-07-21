type RouterTool = "readfile" | "editfile" | "none";
type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";

type RouterDecision = {
    needsTool: boolean;
    tool: RouterTool;
    filePath: string;
    needsMoreContext: boolean;
    contextFiles: string[];
    contextReason: string;
};

class ToolRouter {
    buildWorkflowMessages(message: string, recentContext: Array<{ role: "user" | "assistant"; content: string }> = []): Array<{ role: "system" | "user"; content: string }> {
        const context = recentContext.slice(-6).map((entry) => `${entry.role}: ${entry.content}`).join("\n");
        return [
            { role: "system", content: `Classify the user's task from its intended outcome and relevant conversation context. Do not infer intent from isolated keywords, spelling, or product names.
Choose one workflow: general (conversation or freely chosen tools), web_research (needs external/current evidence), coding (primary outcome is local workspace work), mcp_creation (primary outcome is an MCP server or registration change).
This classification must not remove otherwise safe tools. Return only JSON: {"workflow":"general|web_research|coding|mcp_creation","reason":"short semantic rationale"}` },
            { role: "user", content: `${context ? `Recent context:\n${context}\n\n` : ""}Current request:\n${message}` }
        ];
    }

    parseWorkflowDecision(content: string | undefined | null): { kind: WorkflowKind; reason: string } | undefined {
        if (!content) return undefined;
        const raw = content.trim();
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start === -1 || end <= start) return undefined;
        try {
            const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
            const workflow = typeof data.workflow === "string" ? data.workflow : "";
            if (!["general", "web_research", "coding", "mcp_creation"].includes(workflow)) return undefined;
            return { kind: workflow as WorkflowKind, reason: typeof data.reason === "string" ? data.reason.trim() : "LLM workflow decision." };
        } catch {
            return undefined;
        }
    }

    buildRouterMessages(message: string): Array<{ role: "system" | "user"; content: string }> {
        return [
            {
                role: "system",
                content: `You are a tool router for a CLI assistant.
Decide whether the user's message needs a file tool.

Available tools:
- "readfile": user wants to read, view, explain, summarize, or ask about a file.
- "editfile": user wants to change, fix, refactor, add to, or rewrite a file.
- "none": normal question or chat that does not require any file tool.

Project context behavior:
- If the task likely needs project-level understanding, request extra context files.
- Common context files: package.json, tsconfig.json, README.md, cli/terminal.ts.
- Only request files that are relevant to answer the user better.

Rules:
- If the message references a file path, capture it in "file_path".
- A file path may contain spaces and may be absolute (e.g. C:\\dir\\file.ts) or relative (e.g. ./src/app.ts).
- If no file is involved, use "none" and leave "file_path" empty.
- Return ONLY valid JSON. No markdown. No code fences. No explanations.

JSON Schema:
{
"needs_tool": boolean,
"tool": "readfile" | "editfile" | "none",
"file_path": string,
"needs_more_context": boolean,
"context_files": string[],
"context_reason": string
}`
            },
            {
                role: "user",
                content: message
            }
        ];
    }

    parseDecision(content: string | undefined | null): RouterDecision | undefined {
        if (!content) {
            return undefined;
        }

        const raw = content.trim();
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");

        if (start === -1 || end === -1 || end <= start) {
            return undefined;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw.slice(start, end + 1));
        } catch {
            return undefined;
        }

        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }

        const data = parsed as Record<string, unknown>;
        const toolValue = typeof data.tool === "string" ? data.tool.toLowerCase() : "none";
        const tool: RouterTool = toolValue === "readfile" || toolValue === "editfile" ? toolValue : "none";
        const filePath = typeof data.file_path === "string" ? data.file_path.trim() : "";
        const needsTool = data.needs_tool === true && tool !== "none";
        const needsMoreContext = data.needs_more_context === true;
        const contextFiles = Array.isArray(data.context_files)
            ? data.context_files.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0)
            : [];
        const contextReason = typeof data.context_reason === "string" ? data.context_reason.trim() : "";

        return {
            needsTool,
            tool,
            filePath,
            needsMoreContext,
            contextFiles,
            contextReason
        };
    }
}

module.exports = {
    ToolRouter
};
