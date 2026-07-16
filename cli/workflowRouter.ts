type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";

type WorkflowDecision = {
    kind: WorkflowKind;
    reason: string;
};

const webPatterns = [
    /\b(search (?:the )?web|look up online|browse|online search)\b/i,
    /\b(latest|current|today)\b[\s\S]*\b(news|price|weather|version|release|online)\b/i,
    /\b(news|price|weather|version|release)\b[\s\S]*\b(latest|current|today|online)\b/i,
    /(ค้น(?:หา)?(?:เว็บ|เน็ต|ออนไลน์)|เช็ค(?:เว็บ|ออนไลน์)|ดูข่าว)/i,
    /(ล่าสุด|ปัจจุบัน|วันนี้|ตอนนี้)[\s\S]*(เวอร์ชัน|version|ข่าว|ราคา|อากาศ|ข้อมูลออนไลน์)/i,
    /(เวอร์ชัน|version|ข่าว|ราคา|อากาศ)[\s\S]*(ล่าสุด|ปัจจุบัน|วันนี้|ตอนนี้)/i
];

const mcpPatterns = [
    /\b(mcp|model context protocol)\b.*\b(create|build|add|server|tool|plugin)\b/i,
    /\b(create|build|add)\b.*\b(mcp|model context protocol)\b/i,
    /(สร้าง|เพิ่ม|ทำ).*\bMCP\b/i
];

const codingPatterns = [
    /\b(file|folder|code|repo|project|workspace|typescript|javascript|json|readme|git|npm|test|build|config|function|class|bug|refactor|button|form|register|ui|ux|layout|spacing|style)\b/i,
    /\b(html|css|web\s?page|website|login\s?page|modal|component)\b/i,
    /(ไฟล์|โฟลเดอร์|โค้ด|โปรเจกต์|เวิร์กสเปซ|คอนฟิก|แก้บั๊ก|รีแฟกเตอร์|รันเทส|ทดสอบ|คอมไพล์|ปุ่ม|ฟอร์ม|ลงทะเบียน|รีจิสเตอร์)/i,
    /(หน้าเว็บ|เว็บไซต์|หน้า\s*(?:login|ล็อกอิน)|โมดัล)/i,
    /(?:^|\s)[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|ps1|yml|yaml)(?:\s|$)/i
];

const workspaceMutationPatterns = [
    /\b(create|build|make|generate|scaffold|add|edit|update|modify|fix|refactor|implement|write|organize|rearrange|polish|improve|style)\b[\s\S]*\b(file|folder|code|project|html|css|web\s?page|website|login\s?page|modal|component|button|form|register|ui|ux|layout|spacing|style)\b/i,
    /(สร้าง|เพิ่ม|เขียน|แก้|ปรับ|อัปเดต|ทำ|จัด(?:ระเบียบ)?|ตกแต่ง|ขยับ|เว้นระยะ)[\s\S]*(ไฟล์|โฟลเดอร์|โค้ด|โปรเจกต์|หน้าเว็บ|เว็บไซต์|หน้า\s*(?:login|ล็อกอิน)|โมดัล|ปุ่ม|ฟอร์ม|ลงทะเบียน|รีจิสเตอร์|ยูไอ|\bUI\b|เลย์เอาต์|ระยะห่าง)/i
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
    return { kind: "general", reason: "No specialized web or MCP workflow was detected; decide from the request and session context whether local file tools are needed." };
}

function classifyWorkflowWithHistory(
    message: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    continuation: boolean
): WorkflowDecision {
    const direct = classifyWorkflow(message);
    if (direct.kind !== "general" || !continuation) return direct;

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const previous = history[index];
        if (previous?.role !== "user") continue;
        const inherited = classifyWorkflow(previous.content);
        if (inherited.kind !== "general") {
            return {
                kind: inherited.kind,
                reason: `Continuation of previous ${inherited.kind} request.`
            };
        }
    }

    return direct;
}

function requiresWorkspaceWrite(message: string): boolean {
    return matchesAny(message.trim(), workspaceMutationPatterns);
}

function requiresWorkspaceWriteWithHistory(
    message: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    continuation: boolean
): boolean {
    if (requiresWorkspaceWrite(message)) return true;
    if (!continuation) return false;

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const previous = history[index];
        if (previous?.role === "user") return requiresWorkspaceWrite(previous.content);
    }
    return false;
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
    return `Workflow: general agent request.
- Decide from the current request and relevant session context whether local workspace tools are needed.
- For ordinary conversation, return final without calling tools.
- For workspace inspection or changes, use list_files, search_files, read_file, write_file, or run_command as needed.
- Do not search local files for general knowledge or use them as a substitute for web research.`;
}

module.exports = { classifyWorkflow, classifyWorkflowWithHistory, requiresWorkspaceWrite, requiresWorkspaceWriteWithHistory, workflowInstructions };
