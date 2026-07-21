type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";
type VerificationRequirement = "none" | "command" | "runtime";
type AcceptanceEvidence = "source" | "command" | "runtime" | "interaction";

type AcceptanceContract = {
    evidence: AcceptanceEvidence;
    verification: VerificationRequirement;
    reason: string;
};

const workspaceMutationPatterns = [
    /\b(create|build|make|generate|scaffold|add|edit|update|modify|configure|fix|refactor|implement|write|replace|switch|organize|rearrange|polish|improve|style|try another (?:way|method))\b[\s\S]*\b(file|folder|code|project|html|css|web\s?page|website|login\s?page|modal|component|button|form|register|ui|ux|layout|spacing|style|frontend|dashboard|react|angular|swagger|openapi|api|endpoint|router|server|framework)\b/i,
    /(สร้าง|เพิ่ม|เขียน|แก้|ปรับ|ตั้งค่า|อัปเดต|ทำ|เปลี่ยน|แทนที่|ลบ|ใช้\s*วิธี(?:แก้|อื่น)|ลอง\s*วิธีอื่น|จัด(?:ระเบียบ)?|ตกแต่ง|ขยับ|เว้นระยะ)[\s\S]*(ไฟล์|โฟลเดอร์|โค้ด|โปรเจกต์|หน้าเว็บ|เว็บไซต์|หน้า\s*(?:login|ล็อกอิน)|โมดัล|ปุ่ม|ฟอร์ม|ลงทะเบียน|รีจิสเตอร์|ยูไอ|\bUI\b|เลย์เอาต์|ระยะห่าง|frontend|dashboard|react|angular|swagger|openapi|api|endpoint|router|server|framework)/i,
    /\b(?:install|uninstall|add|remove|upgrade|update)\b[\s\S]*\b(?:package|dependency|dependencies|library|plugin|react|npm|pnpm|yarn|bun)\b/i,
    /(?:ติดตั้ง|ถอน|ลบ|เพิ่ม|อัปเดต)[\s\S]*(?:แพ็กเกจ|package|dependency|ไลบรารี|ปลั๊กอิน|react|npm|pnpm|yarn|bun)/i,
    /\b(?:install|uninstall|upgrade)\s+(?:--save-dev\s+)?(?:@[\w.-]+\/)?[\w.-]+\b/i,
    /(?:ติดตั้ง|ลง|ถอน)\s*(?:(?:แพ็กเกจ|package|ไลบรารี|dependency)\s*)?(?:@[\w.-]+\/)?[\w.-]+/i
];

const readOnlyPatterns = [
    /\b(?:do not|don't|never)\s+(?:edit|change|modify|write|delete|install|update)\b|\bwithout\s+(?:editing|changing|modifying|writing|deleting|installing|updating)\b|\bread[ -]?only\b|\b(?:just|only)\s+(?:read|inspect|review|explain|summarize)\b/i,
    /(?:ห้าม|อย่า|ไม่ต้อง|ไม่ให้)\s*(?:แก้|เปลี่ยน|เขียน|ลบ|ติดตั้ง|อัปเดต)(?:ไฟล์|โค้ด|โปรเจกต์)?|(?:แค่|เพียง|อย่างเดียว)\s*(?:อ่าน|ตรวจ|ดู|รีวิว|อธิบาย|สรุป)/i
];

const runtimeVerificationPatterns = [
    /\b(swagger|openapi|api|endpoint|server|localhost|url|web\s?page|website)\b[\s\S]*\b(open|opens|run|runs|work|works|working|reachable|responds?)\b/i,
    /\b(open|opens|run|runs|work|works|working|reachable|responds?)\b[\s\S]*\b(swagger|openapi|api|endpoint|server|localhost|url|web\s?page|website)\b/i,
    /(swagger|openapi|api|endpoint|server|localhost|หน้าเว็บ|เว็บไซต์)[\s\S]*(เปิด|รัน|ทำงาน|ใช้งาน|เข้า|ตอบกลับ)[\s\S]*(ได้|สำเร็จ|ผ่าน)/i,
    /(เปิด|รัน|ทำให้)[\s\S]*(swagger|openapi|api|endpoint|server|localhost|หน้าเว็บ|เว็บไซต์)[\s\S]*(ได้|ทำงาน|ใช้งาน)/i
];

const commandVerificationPatterns = [
    /\b(until|pass(?:es|ed)?|test(?:s|ed|ing)?|builds?|compiles?|lint|typecheck|verify|verification)\b/i,
    /(จนกว่า|ให้เสร็จ|ให้ผ่าน|ทดสอบ|รันเทส|คอมไพล์|บิลด์|ตรวจสอบ)[\s\S]*(ผ่าน|สำเร็จ|ได้)?/i,
    /\b(create|build|generate|scaffold|implement|make|replace|switch)\b[\s\S]*\b(golang|go\s*lang|go\s+(?:api|server|backend)|react|angular|full[ -]?stack)\b/i,
    /(สร้าง|เขียน|ทำ|เพิ่ม|เปลี่ยน)[\s\S]*(golang|go\s*lang|ภาษา\s*go|react|angular|ฟูลสแต็ก)/i
];

const scaffoldRuntimeVerificationPatterns = [
    /\b(create|build|generate|implement|add|fix)\b[\s\S]*\b(swagger|openapi)\b/i,
    /\b(swagger|openapi)\b[\s\S]*\b(create|build|generate|implement|add|fix)\b/i,
    /(สร้าง|เพิ่ม|ทำ|แก้)[\s\S]*(swagger|openapi)/i
];

function matchesAny(message: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(message));
}

function requiresWorkspaceWrite(message: string): boolean {
    return matchesAny(message.trim(), workspaceMutationPatterns);
}

function forbidsWorkspaceWrite(message: string): boolean {
    return matchesAny(message.trim(), readOnlyPatterns);
}

function forbidsWorkspaceWriteWithHistory(
    message: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    continuation: boolean
): boolean {
    if (forbidsWorkspaceWrite(message)) return true;
    if (!continuation) return false;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const previous = history[index];
        if (previous?.role === "user") return forbidsWorkspaceWrite(previous.content);
    }
    return false;
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

function verificationRequirement(message: string): VerificationRequirement {
    const clean = message.trim();
    if (matchesAny(clean, scaffoldRuntimeVerificationPatterns)) return "runtime";
    if (matchesAny(clean, runtimeVerificationPatterns)) return "runtime";
    if (matchesAny(clean, commandVerificationPatterns)) return "command";
    return "none";
}

function verificationRequirementWithHistory(
    message: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    continuation: boolean
): VerificationRequirement {
    const direct = verificationRequirement(message);
    if (direct === "runtime" || !continuation) return direct;
    let inheritedCommand = false;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const previous = history[index];
        if (previous?.role !== "user") continue;
        const inherited = verificationRequirement(previous.content);
        if (inherited === "runtime") return "runtime";
        if (inherited === "command") inheritedCommand = true;
    }
    if (direct === "command" || inheritedCommand) return "command";
    return "none";
}

function commandSatisfiesVerification(command: string, requirement: VerificationRequirement): boolean {
    if (requirement === "none") return true;
    const clean = command.toLowerCase();
    if (requirement === "runtime") {
        return /invoke-webrequest|invoke-restmethod|\bcurl(?:\.exe)?\b|\bwget(?:\.exe)?\b|https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)/i.test(clean)
            || /\b(playwright|cypress|selenium|test:e2e|e2e:test)\b/i.test(clean);
    }
    return /\b(test|check|verify|lint|typecheck|tsc|build|compile|go\s+test|go\s+build|cargo\s+test|pytest|unittest|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i.test(clean);
}

// Classify the kind of evidence needed from the user's described outcome, not
// from a framework or feature name. This applies equally to any UI technology.
const interactionActionPattern = /\b(?:click|press|tap|select|submit|toggle|drag|navigate)\b|(?:กด|คลิก|แตะ|เลือก|ส่งฟอร์ม|สลับ|ลาก)/i;
const observedMismatchPattern = /\b(?:does\s+not|doesn't|did\s+not|didn't|won't|nothing|still|instead|remains?|stays?|fails?)\b|(?:ไม่|ไม่ได้|ไม่ไป|ไม่เปลี่ยน|ไม่ทำงาน|ยัง|กลับ|แทน|ค้าง)/i;

function acceptanceContract(message: string): AcceptanceContract {
    const clean = message.trim();
    if (interactionActionPattern.test(clean) && observedMismatchPattern.test(clean)) {
        return {
            evidence: "interaction",
            verification: "runtime",
            reason: "The user reported an observable interaction whose outcome is wrong; compilation alone cannot prove the behavior."
        };
    }
    const verification = verificationRequirement(clean);
    return verification === "runtime"
        ? { evidence: "runtime", verification, reason: "The requested outcome must be observed at runtime." }
        : verification === "command"
            ? { evidence: "command", verification, reason: "A finite project command is the requested acceptance evidence." }
            : { evidence: "source", verification, reason: "No observable runtime or command acceptance criterion was inferred." };
}

function acceptanceContractWithHistory(
    message: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    continuation: boolean
): AcceptanceContract {
    const direct = acceptanceContract(message);
    if (!continuation || direct.evidence === "interaction" || direct.evidence === "runtime") return direct;
    let inherited = direct;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const previous = history[index];
        if (previous?.role !== "user") continue;
        const candidate = acceptanceContract(previous.content);
        if (candidate.evidence === "interaction") return candidate;
        if (candidate.evidence === "runtime") inherited = candidate;
        else if (candidate.evidence === "command" && inherited.evidence === "source") inherited = candidate;
    }
    return inherited;
}

function commandSatisfiesAcceptance(command: string, contract: AcceptanceContract): boolean {
    if (contract.evidence === "source") return true;
    if (contract.evidence === "interaction") {
        return /\b(playwright|cypress|selenium|webdriver|test:e2e|e2e:test|e2e)\b/i.test(command);
    }
    return commandSatisfiesVerification(command, contract.verification);
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
- If the request needs external or current information, use a discovered web-search MCP tool; never substitute a local-file search for that research.
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
- For external or current information, use a discovered web-search MCP tool and cite the returned source URLs.
- Do not search local files for general knowledge or use them as a substitute for web research.`;
}

module.exports = {
    forbidsWorkspaceWrite,
    forbidsWorkspaceWriteWithHistory,
    requiresWorkspaceWrite,
    requiresWorkspaceWriteWithHistory,
    verificationRequirement,
    verificationRequirementWithHistory,
    commandSatisfiesVerification,
    acceptanceContract,
    acceptanceContractWithHistory,
    commandSatisfiesAcceptance,
    workflowInstructions
};
