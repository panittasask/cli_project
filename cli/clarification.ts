type ClarificationOption = import("./clarificationTypes").ClarificationOption;
type ClarificationRequest = import("./clarificationTypes").ClarificationRequest;
type ClarificationAnswer = import("./clarificationTypes").ClarificationAnswer;
type ClarificationInspection = { action: "list_files" | "search_files" | "read_file"; path?: string; query?: string };

function normalizeClarificationRequest(
    question: unknown,
    options: unknown,
    decision: unknown,
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
    const normalizedDecision = typeof decision === "string" ? decision.trim().toLowerCase() : "";
    if (!["target", "scope", "compatibility", "destructive", "cost", "external", "preference"].includes(normalizedDecision)) return undefined;
    return {
        question: question.trim().slice(0, 500),
        options: uniqueOptions,
        decision: normalizedDecision as ClarificationRequest["decision"],
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

function relevantClarificationInspections(input: {
    decision: ClarificationRequest["decision"];
    question: string;
    inspections: ClarificationInspection[];
}): ClarificationInspection[] {
    const manifestOrConfig = /(?:^|[\\/])(?:package\.json|go\.mod|cargo\.toml|pyproject\.toml|pom\.xml|[^\\/]+\.(?:sln|csproj)|[^\\/]*(?:lock|config|workspace|project)[^\\/]*)$/i;
    const questionTerms = input.question.toLowerCase().match(/[\p{L}\p{N}_@.-]{3,}/gu) ?? [];
    return input.inspections.filter((inspection) => {
        const evidence = `${inspection.path ?? ""} ${inspection.query ?? ""}`.toLowerCase();
        const overlapsQuestion = questionTerms.some((term) => evidence.includes(term));
        if (input.decision === "preference") return false;
        if (input.decision === "target") {
            return inspection.action === "list_files" || manifestOrConfig.test(inspection.path ?? "") || overlapsQuestion;
        }
        if (input.decision === "compatibility") {
            return manifestOrConfig.test(inspection.path ?? "")
                || /(?:dependency|dependencies|version|peer|package|lock|runtime|engine)/i.test(inspection.query ?? "")
                || overlapsQuestion;
        }
        if (input.decision === "destructive") {
            return inspection.action === "read_file" || inspection.action === "list_files" || overlapsQuestion;
        }
        if (input.decision === "scope") {
            return manifestOrConfig.test(inspection.path ?? "")
                || /(?:readme|requirements?|routes?|src|app|workspace|project)/i.test(evidence)
                || overlapsQuestion;
        }
        return true;
    });
}

function clarificationBlockReason(input: {
    workspaceMutationRequired: boolean;
    successfulInspections: number;
    answeredClarifications: number;
    hasNewBlocker: boolean;
    decision: ClarificationRequest["decision"];
    knownProjectRoots: number;
    asksNewVersusExisting: boolean;
    maxClarifications: number;
    requireInspection: boolean;
    secondRequiresBlocker: boolean;
}): string | undefined {
    if (input.decision === "preference") {
        return "Preference questions are non-blocking. Follow observed project conventions and choose a conservative reversible default.";
    }
    if (input.maxClarifications === 0) {
        return "Clarifications are disabled by the effective agent settings. Continue only with safe, reversible actions supported by workspace evidence.";
    }
    if (input.requireInspection && input.workspaceMutationRequired && input.successfulInspections === 0) {
        return "Inspect the workspace before asking. Use list_files, search_files, or read_file to resolve project structure and existing conventions first.";
    }
    if (input.asksNewVersusExisting && input.knownProjectRoots === 1) {
        return "One project root is already known. Use that existing project unless the user explicitly requested a separate project.";
    }
    if (input.answeredClarifications >= input.maxClarifications) {
        return `The configured clarification limit (${input.maxClarifications}) has been reached. Use prior answers and workspace evidence, or stop safely if the remaining action is irreversible.`;
    }
    if (input.secondRequiresBlocker && input.answeredClarifications > 0 && !input.hasNewBlocker) {
        return "The task already has a clarification answer and no new execution blocker. Continue with the observed conventions and a safe reversible default instead of asking another preference question.";
    }
    return undefined;
}

module.exports = {
    answerLooksLikeBlockingClarification,
    clarificationBlockReason,
    clarificationObservation,
    clarificationTranscriptLine,
    formatClarificationRequest,
    normalizeClarificationRequest,
    relevantClarificationInspections,
    resolveClarificationAnswer
};
