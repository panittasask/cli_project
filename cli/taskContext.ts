type HistoryMessage = { role: "user" | "assistant"; content: string };
type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";

const continuationPattern = /\b(it|that|this|those|these|continue|also|same|previous)\b|(?:อันนี้|อันนั้น|เมื่อกี้|ต่อเลย|เหมือนเดิม|ด้วยนะ|แล้วทีนี้|ที่ถาม)/i;

function tokens(value: string): Set<string> {
    return new Set((value.toLowerCase().match(/[a-z0-9_./-]{3,}|[\u0E00-\u0E7F]{3,}/g) ?? [])
        .filter((token) => !["the", "and", "for", "with", "that", "this", "คือ", "แล้ว", "หน่อย", "ให้มัน"].includes(token)));
}

function overlapScore(left: Set<string>, right: Set<string>): number {
    let score = 0;
    for (const token of left) {
        if (right.has(token)) score += 1;
    }
    return score;
}

function selectTaskContext(
    currentMessage: string,
    history: HistoryMessage[],
    workflow: WorkflowKind,
    maxMessages = 6
): HistoryMessage[] {
    if (history.length === 0 || maxMessages <= 0) return [];

    const recent = history.slice(-maxMessages);
    if (continuationPattern.test(currentMessage)) {
        return recent.slice(-4);
    }

    const currentTokens = tokens(currentMessage);
    const selected = recent.filter((message) => overlapScore(currentTokens, tokens(message.content)) > 0);
    if (selected.length > 0) return selected.slice(-4);

    // Coding tasks often depend on the immediately preceding tool request, but
    // unrelated general questions should start clean instead of inheriting it.
    return workflow === "coding" || workflow === "mcp_creation" ? recent.slice(-2) : [];
}

function summarizeTaskContext(messages: HistoryMessage[]): string {
    if (messages.length === 0) return "";
    return messages.map((message) => {
        const clean = message.content.replace(/\s+/g, " ").trim();
        const excerpt = clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
        return `${message.role === "user" ? "User" : "Assistant"}: ${excerpt}`;
    }).join("\n");
}

module.exports = { selectTaskContext, summarizeTaskContext };
