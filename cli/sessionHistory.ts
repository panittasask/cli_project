type HistoryMessage = {
    role: "user" | "assistant";
    content: string;
};

function formatSessionHistory(messages: HistoryMessage[], maxMessages = 6): string {
    const recentMessages = maxMessages > 0 ? messages.slice(-maxMessages) : [];
    if (recentMessages.length === 0) {
        return "No previous messages in this session.";
    }

    const heading = `Recent session history (${recentMessages.length} message${recentMessages.length === 1 ? "" : "s"})`;
    const divider = "-".repeat(heading.length);
    const entries = recentMessages.map((message) => {
        const label = message.role === "user" ? "You" : "AI";
        const content = message.content.replace(/\r?\n/g, "\n    ");
        return `${label}: ${content}`;
    });

    return `${heading}\n${divider}\n${entries.join("\n\n")}`;
}

module.exports = {
    formatSessionHistory
};
