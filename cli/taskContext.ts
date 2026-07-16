type HistoryMessage = { role: "user" | "assistant"; content: string };
type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";

const continuationPattern = /\b(it|that|this|those|these|continue|resume|carry on|also|same|previous|another (?:way|method)|until (?:it )?(?:works|passes|opens|runs))\b|(?:อันนี้|อันนั้น|เมื่อกี้|ต่อเลย|ทำ(?:งาน)?\s*ต่อ|ทำงาน\s*เก่า\s*ต่อ|ทำเลย|ยังไม่มี|ต่อ(?:จาก|จามก?)\s*(?:งาน)?เดิม|งาน\s*(?:เดิม|เก่า)|จากเดิม|เหมือนเดิม|ด้วยนะ|แล้วทีนี้|ที่ถาม|ใช้\s*วิธี(?:แก้|อื่น)|ลอง\s*วิธีอื่น|จนกว่า|ให้(?:มัน)?\s*(?:ทำงาน|ใช้งาน|เปิด|รัน)\s*ได้|ให้เสร็จ)/i;

function isContinuationRequest(message: string): boolean {
    return continuationPattern.test(message.trim());
}

function selectTaskContext(
    _currentMessage: string,
    history: HistoryMessage[],
    _workflow: WorkflowKind,
    maxMessages = 6
): HistoryMessage[] {
    if (history.length === 0 || maxMessages <= 0) return [];
    // A small recent window is always supplied. The main model decides whether
    // it is relevant; /clear is the explicit boundary that removes old context.
    return history.slice(-maxMessages);
}

function summarizeTaskContext(messages: HistoryMessage[]): string {
    if (messages.length === 0) return "";
    return messages.map((message) => {
        const clean = message.content.replace(/\s+/g, " ").trim();
        const excerpt = clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
        return `${message.role === "user" ? "User" : "Assistant"}: ${excerpt}`;
    }).join("\n");
}

module.exports = { isContinuationRequest, selectTaskContext, summarizeTaskContext };
