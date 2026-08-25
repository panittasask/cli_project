import type { AgentAction } from "../agentSchema";
import type { AgentActionParserResult } from "../agentActionParser";

export type ActionAdmissionFailureKind =
    | "transport_error"
    | "timeout"
    | "empty_response"
    | "truncated"
    | "syntax_invalid"
    | "schema_invalid"
    | "semantic_invalid"
    | "unsupported_protocol";

export type ActionAdmissionResult = {
    ok: true;
    action: AgentAction;
    localRepairUsed: boolean;
    syntaxValid: true;
    schemaValid: true;
    semanticValid: true;
} | {
    ok: false;
    kind: ActionAdmissionFailureKind;
    issues: string[];
    recoverable: boolean;
    localRepairUsed: boolean;
    syntaxValid: boolean;
    schemaValid: boolean;
    semanticValid: boolean;
};

type AdmissionParser = { admitContent(content: string | undefined | null): AgentActionParserResult };

export type ActionAdmissionInput = {
    content: string | undefined | null;
    finishReason?: unknown;
    hasToolCall?: boolean;
    requireTaskContract?: boolean;
    allowedActions?: string[];
};

class ActionAdmissionGate {
    constructor(private readonly parser: AdmissionParser) {}

    admit(input: ActionAdmissionInput): ActionAdmissionResult {
        if (isTruncatedFinishReason(input.finishReason)) {
            return failure("truncated", ["provider response ended because the output limit was reached"], true);
        }
        if (!input.content?.trim() && !input.hasToolCall) {
            return failure("empty_response", ["provider returned no content and no tool call"], true);
        }

        const parsed = this.parser.admitContent(input.content);
        if (!parsed.ok) return parsed;
        if (input.requireTaskContract && !parsed.action.task) {
            return failure("semantic_invalid", ["task: required model-owned task contract is missing"], true, parsed.localRepairUsed, true, true, false);
        }
        if (input.allowedActions && !input.allowedActions.includes(parsed.action.action)) {
            return failure("semantic_invalid", [`action: ${parsed.action.action} is not allowed in the current protocol state`], true, parsed.localRepairUsed, true, true, false);
        }
        return parsed;
    }
}

function isTruncatedFinishReason(value: unknown): boolean {
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "length" || normalized === "max_tokens" || normalized === "max_output_tokens" || normalized === "truncated";
}

function failure(
    kind: ActionAdmissionFailureKind,
    issues: string[],
    recoverable: boolean,
    localRepairUsed = false,
    syntaxValid = false,
    schemaValid = false,
    semanticValid = false
): ActionAdmissionResult {
    return { ok: false, kind, issues, recoverable, localRepairUsed, syntaxValid, schemaValid, semanticValid };
}

module.exports = { ActionAdmissionGate, isTruncatedFinishReason };
