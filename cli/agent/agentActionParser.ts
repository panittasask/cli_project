type AgentAction = import("./agentSchema").AgentAction;
type McpToolLike = {
    resolveDirectCall: (toolName: string, payload: Record<string, unknown>) => {
        server: string;
        tool: string;
        arguments: Record<string, unknown>;
    } | undefined;
};

const { normalizeClarificationRequest } = require("../clarification") as {
    normalizeClarificationRequest: (
        question: unknown,
        options: unknown,
        decision: unknown,
        reason?: string
    ) => import("../clarificationTypes").ClarificationRequest | undefined;
};
const { parseAgentAction, parseTaskContract } = require("./agentSchema") as {
    parseAgentAction: (value: unknown) => AgentAction | undefined;
    parseTaskContract: (value: unknown) => import("./agentSchema").AgentTaskContract | undefined;
};

class AgentActionParser {
    constructor(private readonly mcpTool: McpToolLike) {}
    parseAction(content: string | undefined | null): AgentAction | undefined {
        const action = this.parseRawAction(content);
        return action ? parseAgentAction(action) : undefined;
    }

    private parseRawAction(content: string | undefined | null): AgentAction | undefined {
        if (!content) {
            return undefined;
        }

        const raw = content.trim();
        // Local models sometimes wrap an action in prose or emit more than one
        // object. Parse balanced objects independently so one extra object does
        // not make the whole response invalid.
        const parsed = this.extractJsonObjects(raw).find((candidate) => {
            const action = typeof candidate.action === "string" ? candidate.action : "";
            return this.isSupportedAction(action, candidate);
        });

        if (!parsed) {
            return undefined;
        }

        const data = parsed;
        const action = typeof data.action === "string" ? data.action : "";
        const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 300) : undefined;
        const task = this.normalizeTaskContract(data.task);
        const common = { reason, ...(task ? { task } : {}) };

        if (action === "final") {
            const completionStatus = data.completion_status === "already_satisfied"
                || data.completion_status === "no_change_needed"
                || data.completion_status === "incomplete"
                ? data.completion_status
                : "completed";
            const evidence = Array.isArray(data.evidence)
                ? data.evidence.filter((item): item is string => typeof item === "string").slice(0, 8)
                : [];
            return {
                action,
                answer: typeof data.answer === "string" ? data.answer : "",
                completion_status: completionStatus,
                evidence,
                ...common
            };
        }

        if (action === "ask_user") {
            const request = normalizeClarificationRequest(data.question, data.options, data.decision, reason);
            return request ? { action, ...request, ...(task ? { task } : {}) } : undefined;
        }

        if (action === "list_files") {
            const pathValue = typeof data.path === "string" ? data.path : undefined;
            return pathValue ? { action, path: pathValue, ...common } : { action, ...common };
        }

        if (action === "search_files") {
            const query = typeof data.query === "string" ? data.query : "";
            const pathValue = typeof data.path === "string" ? data.path : undefined;
            return pathValue ? { action, query, path: pathValue, ...common } : { action, query, ...common };
        }

        if (action === "search_project") {
            const query = typeof data.query === "string" ? data.query : "";
            const pathValue = typeof data.path === "string" ? data.path : undefined;
            const limit = typeof data.limit === "number" && Number.isFinite(data.limit)
                ? Math.max(1, Math.min(30, Math.floor(data.limit)))
                : undefined;
            return {
                action,
                query,
                ...(pathValue ? { path: pathValue } : {}),
                ...(limit ? { limit } : {}),
                ...common
            };
        }

        if (action === "read_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                ...common
            };
        }

        if (action === "write_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                content: typeof data.content === "string" ? data.content : "",
                ...common
            };
        }

        if (action === "edit_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                old_text: typeof data.old_text === "string" ? data.old_text : "",
                new_text: typeof data.new_text === "string" ? data.new_text : "",
                ...common
            };
        }

        if (action === "delete_file") {
            return {
                action,
                path: typeof data.path === "string" ? data.path : "",
                ...common
            };
        }

        if (action === "run_command") {
            const workdir = typeof data.workdir === "string" ? data.workdir : undefined;
            const mode = data.mode === "probe" ? "probe" : data.mode === "normal" ? "normal" : undefined;
            const timeoutMs = typeof data.timeout_ms === "number" && Number.isFinite(data.timeout_ms)
                ? Math.max(1000, Math.min(30000, Math.floor(data.timeout_ms)))
                : undefined;
            const rawExpectation = data.expect && typeof data.expect === "object" && !Array.isArray(data.expect)
                ? data.expect as Record<string, unknown>
                : undefined;
            const includes = Array.isArray(rawExpectation?.output_includes)
                ? rawExpectation.output_includes.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8)
                : undefined;
            const excludes = Array.isArray(rawExpectation?.output_excludes)
                ? rawExpectation.output_excludes.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8)
                : undefined;
            const expect = rawExpectation ? {
                ...(rawExpectation.exit_code === 0 ? { exit_code: 0 as const } : {}),
                ...(includes && includes.length > 0 ? { output_includes: includes } : {}),
                ...(excludes && excludes.length > 0 ? { output_excludes: excludes } : {})
            } : undefined;
            return {
                action,
                command: typeof data.command === "string" ? data.command : "",
                ...(workdir ? { workdir } : {}),
                ...(mode ? { mode } : {}),
                ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
                ...(expect && Object.keys(expect).length > 0 ? { expect } : {}),
                ...common
            };
        }

        if (action === "refine_task") {
            const refinedTask = this.normalizeTaskContract(data.task);
            const evidence = Array.isArray(data.evidence)
                ? data.evidence.filter((item): item is string => typeof item === "string").slice(0, 8)
                : [];
            return refinedTask && evidence.length > 0
                ? { action, task: refinedTask, evidence, ...common }
                : undefined;
        }

        if (action === "mcp_list_tools") {
            const server = typeof data.server === "string" ? data.server : undefined;
            return server ? { action, server, ...common } : { action, ...common };
        }

        if (action === "mcp_call_tool") {
            return {
                action,
                server: typeof data.server === "string" ? data.server : "",
                tool: typeof data.tool === "string" ? data.tool : "",
                arguments: data.arguments && typeof data.arguments === "object" && !Array.isArray(data.arguments)
                    ? data.arguments as Record<string, unknown>
                    : {},
                ...common
            };
        }

        const directMcpCall = this.mcpTool.resolveDirectCall(action, data);
        if (directMcpCall) {
            return {
                action: "mcp_call_tool",
                server: directMcpCall.server,
                tool: directMcpCall.tool,
                arguments: directMcpCall.arguments,
                ...common
            };
        }

        return undefined;
    }

    explainParseFailure(content: string | undefined | null): string {
        if (!content?.trim()) {
            return "empty model content";
        }

        const objects = this.extractJsonObjects(content.trim());
        if (objects.length === 0) {
            return "no valid JSON object found in model content";
        }

        const actions = objects
            .map((candidate) => typeof candidate.action === "string" ? candidate.action : "")
            .filter(Boolean);
        if (actions.length === 0) {
            return "valid JSON object is missing a string action field";
        }

        const unsupportedActions = actions.filter((action, index) => (
            actions.indexOf(action) === index
            && !objects.some((candidate) => candidate.action === action && this.isSupportedAction(action, candidate))
        ));

        return unsupportedActions.length > 0
            ? `unsupported action: ${unsupportedActions.join(", ")}`
            : "model content did not produce one supported action";
    }

    private extractJsonObjects(raw: string): Array<Record<string, unknown>> {
        const objects: Array<Record<string, unknown>> = [];

        for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
            let depth = 0;
            let inString = false;
            let escaped = false;

            for (let index = start; index < raw.length; index += 1) {
                const character = raw[index];

                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (character === "\\") {
                        escaped = true;
                    } else if (character === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (character === '"') {
                    inString = true;
                } else if (character === "{") {
                    depth += 1;
                } else if (character === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        try {
                            const parsed = JSON.parse(raw.slice(start, index + 1)) as unknown;
                            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                                objects.push(parsed as Record<string, unknown>);
                            }
                        } catch {
                            // Try the next opening brace; a later object may be valid.
                        }
                        break;
                    }
                }
            }
        }

        return objects;
    }

    private isSupportedAction(action: string, data: Record<string, unknown>): boolean {
        if (action === "ask_user") {
            const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 300) : undefined;
            return Boolean(normalizeClarificationRequest(data.question, data.options, data.decision, reason));
        }
        const builtInActions = new Set([
            "final",
            "list_files",
            "search_project",
            "search_files",
            "read_file",
            "write_file",
            "edit_file",
            "delete_file",
            "run_command",
            "refine_task",
            "mcp_list_tools",
            "mcp_call_tool"
        ]);

        return builtInActions.has(action) || Boolean(this.mcpTool.resolveDirectCall(action, data));
    }

    private normalizeTaskContract(value: unknown): import("./agentSchema").AgentTaskContract | undefined {
        return parseTaskContract(value);
    }
}

module.exports = { AgentActionParser };
