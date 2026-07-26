type ModelResponseLogEntry = {
    reasoningContent?: unknown;
    finishReason?: unknown;
};

function escapeHtml(value: unknown): string {
    return String(value ?? "").replace(/[&<>]/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;"
    })[character] ?? character);
}

function formatThinkingDetails(response: ModelResponseLogEntry): string {
    const thinking = typeof response.reasoningContent === "string" ? response.reasoningContent : "";
    if (!thinking.trim()) return "";
    const truncated = response.finishReason === "length";
    const status = truncated
        ? '<span class="tag bad">truncated by model limit</span>'
        : '<span class="tag">complete response</span>';
    return `<details class="thinking"><summary>Thinking · ${thinking.length} characters ${status}</summary><pre>${escapeHtml(thinking)}</pre></details>`;
}

module.exports = {
    escapeHtml,
    formatThinkingDetails
};
