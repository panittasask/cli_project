type ClarificationOption = import("./clarificationTypes").ClarificationOption;
type ClarificationRequest = import("./clarificationTypes").ClarificationRequest;
type ClarificationAnswer = import("./clarificationTypes").ClarificationAnswer;

function normalizeClarificationRequest(
    question: unknown,
    options: unknown,
    reason?: string
): ClarificationRequest | undefined {
    if (typeof question !== "string" || !question.trim() || !Array.isArray(options)) return undefined;
    const normalizedOptions = options.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const record = candidate as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim().slice(0, 80) : "";
        const label = typeof record.label === "string" ? record.label.trim().slice(0, 160) : "";
        const description = typeof record.description === "string" ? record.description.trim().slice(0, 300) : "";
        if (!id || !label) return [];
        return [{ id, label, ...(description ? { description } : {}) }];
    });
    const uniqueOptions = normalizedOptions.filter((option, index) => (
        normalizedOptions.findIndex((candidate) => candidate.id.toLowerCase() === option.id.toLowerCase()) === index
    )).slice(0, 6);
    if (uniqueOptions.length < 2) return undefined;
    return {
        question: question.trim().slice(0, 500),
        options: uniqueOptions,
        ...(reason ? { reason } : {})
    };
}

function formatClarificationRequest(request: ClarificationRequest): string {
    const choices = request.options.map((option, index) => (
        `${index + 1}. ${option.label}${option.description ? `\n   ${option.description}` : ""}`
    ));
    return [
        "AI needs clarification:",
        request.question,
        "",
        ...choices,
        "",
        "Type a number, option id, or any other answer. Type /cancel to stop this task."
    ].join("\n");
}

function resolveClarificationAnswer(request: ClarificationRequest, rawInput: string): ClarificationAnswer | undefined {
    const input = rawInput.trim();
    if (!input) return undefined;
    if (/^\/?cancel$/i.test(input)) return { kind: "cancel", input };

    const numericChoice = /^\d+$/.test(input) ? Number(input) : Number.NaN;
    if (Number.isInteger(numericChoice)) {
        const option = request.options[numericChoice - 1];
        return option ? { kind: "option", input, option } : undefined;
    }

    const option = request.options.find((candidate) => (
        candidate.id.toLowerCase() === input.toLowerCase()
        || candidate.label.toLowerCase() === input.toLowerCase()
    ));
    return option
        ? { kind: "option", input, option }
        : { kind: "custom", input, text: input.slice(0, 1000) };
}

function clarificationObservation(request: ClarificationRequest, answer: ClarificationAnswer): Record<string, unknown> {
    if (answer.kind === "option") {
        return {
            action: "ask_user",
            status: "answered",
            question: request.question,
            answer: { kind: "option", id: answer.option.id, label: answer.option.label }
        };
    }
    if (answer.kind === "custom") {
        return {
            action: "ask_user",
            status: "answered",
            question: request.question,
            answer: { kind: "custom", text: answer.text }
        };
    }
    return { action: "ask_user", status: "cancelled", question: request.question };
}

function clarificationTranscriptLine(request: ClarificationRequest, answer: ClarificationAnswer): string {
    const value = answer.kind === "option"
        ? `${answer.option.label} [${answer.option.id}]${answer.option.description ? ` — ${answer.option.description}` : ""}`
        : answer.kind === "custom" ? answer.text : "cancelled";
    return `${request.question} => ${value}`;
}

function answerLooksLikeBlockingClarification(answer: string): boolean {
    const clean = answer.trim();
    if (!/[?？]\s*$/.test(clean)) return false;
    return /\b(?:which|choose|specify|clarify|do you want|would you like|what (?:package|project|option|version|kind|type))\b|(?:ต้องการ|เลือก|ระบุ|หมายถึง|ขอรายละเอียด|แบบไหน|อันไหน|ตัวไหน|โปรเจกต์ไหน|แพ็กเกจไหน)/i.test(clean);
}

module.exports = {
    answerLooksLikeBlockingClarification,
    clarificationObservation,
    clarificationTranscriptLine,
    formatClarificationRequest,
    normalizeClarificationRequest,
    resolveClarificationAnswer
};
