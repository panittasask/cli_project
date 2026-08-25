import type { AgentAction } from "./agentSchema";

type McpToolLike = {
    resolveDirectCall: (toolName: string, payload: Record<string, unknown>) => {
        server: string;
        tool: string;
        arguments: Record<string, unknown>;
    } | undefined;
};

type AgentActionParserOptions = {
    tolerateUnescapedControlCharacters?: boolean;
    repairMalformedJson?: boolean;
};

export type AgentActionParserFailureKind = "empty_response" | "syntax_invalid" | "schema_invalid" | "semantic_invalid";
export type AgentActionParserResult = {
    ok: true;
    action: AgentAction;
    localRepairUsed: boolean;
    syntaxValid: true;
    schemaValid: true;
    semanticValid: true;
} | {
    ok: false;
    kind: AgentActionParserFailureKind;
    issues: string[];
    recoverable: boolean;
    localRepairUsed: boolean;
    syntaxValid: boolean;
    schemaValid: boolean;
    semanticValid: boolean;
};

type JsonCandidate = { value: Record<string, unknown>; repaired: boolean };

const { jsonrepair } = require("jsonrepair") as { jsonrepair: (input: string) => string };
const { AgentActionSchema } = require("./agentSchema") as {
    AgentActionSchema: import("zod").ZodType<AgentAction>;
};
const { normalizeClarificationRequest } = require("../clarification") as {
    normalizeClarificationRequest: (
        question: unknown,
        options: unknown,
        decision: unknown,
        reason?: string
    ) => import("../clarificationTypes").ClarificationRequest | undefined;
};

class AgentActionParser {
    private readonly options: Required<AgentActionParserOptions>;

    constructor(
        private readonly mcpTool: McpToolLike,
        options: AgentActionParserOptions = {}
    ) {
        this.options = {
            tolerateUnescapedControlCharacters: true,
            repairMalformedJson: true,
            ...options
        };
    }

    parseAction(content: string | undefined | null): AgentAction | undefined {
        const result = this.admitContent(content);
        return result.ok ? result.action : undefined;
    }

    admitContent(content: string | undefined | null): AgentActionParserResult {
        if (!content?.trim()) {
            return this.failure("empty_response", ["model content is empty"], false, false, false, false);
        }

        const candidates = this.extractJsonObjects(content.trim());
        if (candidates.length === 0) {
            return this.failure("syntax_invalid", ["no valid JSON object found in model content"], true, false, false, false);
        }

        const failures: Array<{ issues: string[]; semantic: boolean; repaired: boolean }> = [];
        const admitted = new Map<string, { action: AgentAction; repaired: boolean }>();
        for (const candidate of candidates) {
            const normalizedCandidate = this.normalizeDirectMcpCandidate(candidate.value);
            const parsed = AgentActionSchema.safeParse(normalizedCandidate);
            if (!parsed.success) {
                failures.push({
                    issues: parsed.error.issues.map((issue) => {
                        const location = issue.path.length > 0 ? issue.path.join(".") : "action";
                        return `${location}: ${issue.message}`;
                    }),
                    semantic: parsed.error.issues.some((issue) => issue.code === "too_small" || issue.code === "custom"),
                    repaired: candidate.repaired
                });
                continue;
            }

            const action = this.normalizeAdmittedAction(parsed.data);
            if (!action) {
                failures.push({
                    issues: ["ask_user: clarification fields are not semantically usable"],
                    semantic: true,
                    repaired: candidate.repaired
                });
                continue;
            }

            const signature = JSON.stringify(action);
            const existing = admitted.get(signature);
            admitted.set(signature, {
                action,
                repaired: existing ? existing.repaired && candidate.repaired : candidate.repaired
            });
        }

        if (admitted.size === 1) {
            const result = admitted.values().next().value as { action: AgentAction; repaired: boolean };
            return {
                ok: true,
                action: result.action,
                localRepairUsed: result.repaired,
                syntaxValid: true,
                schemaValid: true,
                semanticValid: true
            };
        }
        if (admitted.size > 1) {
            return this.failure(
                "semantic_invalid",
                ["model content contains multiple distinct schema-valid action objects"],
                true,
                true,
                true,
                false,
                Array.from(admitted.values()).some((candidate) => candidate.repaired)
            );
        }

        const semantic = failures.some((failure) => failure.semantic);
        const issues = Array.from(new Set(failures.flatMap((failure) => failure.issues))).slice(0, 12);
        return this.failure(
            semantic ? "semantic_invalid" : "schema_invalid",
            issues.length > 0 ? issues : ["model content did not produce one supported action"],
            true,
            true,
            false,
            false,
            failures.some((failure) => failure.repaired)
        );
    }

    explainParseFailure(content: string | undefined | null): string {
        const result = this.admitContent(content);
        return result.ok ? "" : `${result.kind}: ${result.issues.join("; ")}`;
    }

    private extractJsonObjects(raw: string): JsonCandidate[] {
        const objects: JsonCandidate[] = [];
        const fenced = this.stripOptionalMarkdownFence(raw);
        this.pushCandidate(objects, this.parseJsonCandidate(fenced.value, fenced.changed));

        for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let index = start; index < raw.length; index += 1) {
                const character = raw[index];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (character === "\\") escaped = true;
                    else if (character === '"') inString = false;
                    continue;
                }
                if (character === '"') inString = true;
                else if (character === "{") depth += 1;
                else if (character === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        const isolated = raw.slice(start, index + 1);
                        this.pushCandidate(objects, this.parseJsonCandidate(isolated, isolated !== raw));
                        break;
                    }
                }
            }
        }
        return objects;
    }

    private pushCandidate(target: JsonCandidate[], candidate: JsonCandidate | undefined): void {
        if (!candidate) return;
        const signature = JSON.stringify(candidate.value);
        if (!target.some((existing) => JSON.stringify(existing.value) === signature)) target.push(candidate);
    }

    private parseJsonCandidate(candidate: string, normalized = false): JsonCandidate | undefined {
        try {
            return this.objectCandidate(JSON.parse(candidate) as unknown, normalized);
        } catch {
            const repairs: string[] = [];
            if (this.options.tolerateUnescapedControlCharacters) repairs.push(this.escapeUnescapedControlCharacters(candidate));
            if (this.options.repairMalformedJson) {
                try {
                    const repaired = jsonrepair(candidate);
                    if (!this.repairOnlyCompletesTruncatedJson(candidate, repaired)) repairs.push(repaired);
                } catch {
                    // Syntax remains invalid; semantic recovery belongs to protocol regeneration.
                }
            }
            for (const repaired of repairs) {
                if (repaired === candidate) continue;
                try {
                    const result = this.objectCandidate(JSON.parse(repaired) as unknown, true);
                    if (result) return result;
                } catch {
                    // Try the next deterministic syntax repair.
                }
            }
            return undefined;
        }
    }

    private objectCandidate(value: unknown, repaired: boolean): JsonCandidate | undefined {
        return value && typeof value === "object" && !Array.isArray(value)
            ? { value: value as Record<string, unknown>, repaired }
            : undefined;
    }

    private repairOnlyCompletesTruncatedJson(candidate: string, repaired: string): boolean {
        const original = candidate.trimEnd();
        const normalized = repaired.trimEnd();
        if (!normalized.startsWith(original) || normalized.length === original.length) return false;
        const appended = normalized.slice(original.length);
        // Appending only delimiters can turn a cut-off command or file body into an
        // executable partial action. Leave that case to bounded model regeneration.
        return /^[\s"'}\]]+$/.test(appended);
    }

    private stripOptionalMarkdownFence(value: string): { value: string; changed: boolean } {
        const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        const stripped = match?.[1]?.trim();
        return stripped === undefined ? { value, changed: false } : { value: stripped, changed: true };
    }

    private normalizeDirectMcpCandidate(candidate: Record<string, unknown>): Record<string, unknown> {
        const action = candidate.action;
        if (AgentActionSchema.safeParse(candidate).success || typeof action !== "string" || !action) return candidate;
        const direct = this.mcpTool.resolveDirectCall(action, candidate);
        if (!direct) return candidate;
        return {
            action: "mcp_call_tool",
            server: direct.server,
            tool: direct.tool,
            arguments: direct.arguments,
            ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
            ...(candidate.task !== undefined ? { task: candidate.task } : {})
        };
    }

    private normalizeAdmittedAction(action: AgentAction): AgentAction | undefined {
        const reason = typeof action.reason === "string" ? action.reason.trim().slice(0, 300) : undefined;
        if (action.action !== "ask_user") return { ...action, ...(reason ? { reason } : {}) } as AgentAction;
        const request = normalizeClarificationRequest(action.question, action.options, action.decision, reason);
        return request ? { action: "ask_user", ...request, ...(action.task ? { task: action.task } : {}) } : undefined;
    }

    private escapeUnescapedControlCharacters(candidate: string): string {
        let repaired = "";
        let inString = false;
        let escaped = false;
        for (const character of candidate) {
            if (!inString) {
                repaired += character;
                if (character === '"') inString = true;
                continue;
            }
            if (escaped) {
                repaired += character;
                escaped = false;
                continue;
            }
            if (character === "\\") {
                repaired += character;
                escaped = true;
                continue;
            }
            if (character === '"') {
                repaired += character;
                inString = false;
                continue;
            }
            const code = character.charCodeAt(0);
            repaired += code < 0x20
                ? code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`
                : character;
        }
        return repaired;
    }

    private failure(
        kind: AgentActionParserFailureKind,
        issues: string[],
        recoverable: boolean,
        syntaxValid: boolean,
        schemaValid: boolean,
        semanticValid: boolean,
        localRepairUsed = false
    ): AgentActionParserResult {
        return { ok: false, kind, issues, recoverable, localRepairUsed, syntaxValid, schemaValid, semanticValid };
    }
}

module.exports = { AgentActionParser };
