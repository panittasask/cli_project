type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";

type WorkflowDecision = {
    kind: WorkflowKind;
    reason: string;
};

const webPatterns = [
    /\b(latest|current|today|news|price|weather|search (?:the )?web|look up|online)\b/i,
    /(ล่าสุด|ปัจจุบัน|วันนี้|ตอนนี้.*(?:เวอร์ชัน|version)|ข่าว|ราคา|อากาศ|ค้น(?:หา)?(?:เว็บ|เน็ต|ออนไลน์))/i
];

const mcpPatterns = [
    /\b(mcp|model context protocol)\b.*\b(create|build|add|server|tool|plugin)\b/i,
    /\b(create|build|add)\b.*\b(mcp|model context protocol)\b/i,
    /(สร้าง|เพิ่ม|ทำ).*\bMCP\b/i
];

const codingPatterns = [
    /\b(file|folder|code|repo|project|workspace|typescript|javascript|json|readme|git|npm|test|build|config|function|class|bug|refactor)\b/i,
    /(ไฟล์|โฟลเดอร์|โค้ด|โปรเจกต์|เวิร์กสเปซ|คอนฟิก|แก้บั๊ก|รีแฟกเตอร์|รันเทส|ทดสอบ|คอมไพล์)/i,
    /(?:^|\s)[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|ps1|yml|yaml)(?:\s|$)/i
];

function matchesAny(message: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(message));
}

function classifyWorkflow(message: string): WorkflowDecision {
    const clean = message.trim();
    if (matchesAny(clean, mcpPatterns)) {
        return { kind: "mcp_creation", reason: "The request explicitly concerns MCP implementation." };
    }
    if (matchesAny(clean, webPatterns)) {
        return { kind: "web_research", reason: "The request needs current or external information." };
    }
    if (matchesAny(clean, codingPatterns)) {
        return { kind: "coding", reason: "The request concerns project files, code, or verification." };
    }
    return { kind: "general", reason: "The request can be answered as a normal conversation." };
}

function workflowInstructions(kind: WorkflowKind): string {
    if (kind === "web_research") {
        return `Workflow: web research.
- Use the discovered web-search MCP tool before answering.
- Never use search_files as a substitute for internet search.
- Prefer at least two relevant sources. If evidence is weak, refine the query and search again.
- Cite exact URLs returned by successful search or page-open observations.`;
    }
    if (kind === "coding") {
        return `Workflow: coding and local files.
- Inspect relevant files before changing an existing file.
- Use search_files only for text inside this workspace.
- Every write is validated automatically; fix validation failures before returning final.
- Report only checks that actually succeeded.`;
    }
    if (kind === "mcp_creation") {
        return `Workflow: MCP creation.
- Inspect the existing MCP config and server conventions first.
- Put servers under mcp/servers/<server-name> and register them in .cli/mcp.json.
- Discover the completed server with mcp_list_tools and call at least one relevant tool with mcp_call_tool before claiming success.
- Never claim an MCP server works until both checks succeed.`;
    }
    return `Workflow: general conversation.
- Answer naturally without using project or MCP tools unless the request clearly requires evidence.
- Do not search local files for general knowledge or web questions.
- Return final as soon as the question can be answered accurately.`;
}

module.exports = { classifyWorkflow, workflowInstructions };
