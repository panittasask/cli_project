type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";

const stringProperty = { type: "string" };
const taskContractProperty = {
    type: "object",
    properties: {
        intent: stringProperty,
        task_type: { enum: ["general", "web_research", "coding", "mcp_creation"] },
        continuation: { type: "boolean" },
        requires_workspace_changes: { type: "boolean" },
        verification: { enum: ["none", "command", "runtime", "interaction"] },
        evidence_requirements: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: { enum: ["source", "command", "runtime", "interaction", "visual"] }
        },
        success_criteria: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: stringProperty
        }
    },
    required: ["intent", "task_type", "continuation", "requires_workspace_changes", "verification", "evidence_requirements", "success_criteria"],
    additionalProperties: false
};
const commandExpectationProperty = {
    type: "object",
    properties: {
        exit_code: { const: 0 },
        output_includes: {
            type: "array",
            maxItems: 8,
            uniqueItems: true,
            items: stringProperty
        },
        output_excludes: {
            type: "array",
            maxItems: 8,
            uniqueItems: true,
            items: stringProperty
        }
    },
    additionalProperties: false
};
const variants: Record<string, Record<string, unknown>> = {
    final: {
        type: "object",
        properties: {
            action: { const: "final" },
            answer: stringProperty,
            completion_status: { enum: ["completed", "already_satisfied", "no_change_needed", "incomplete"] },
            evidence: { type: "array", maxItems: 8, items: stringProperty },
            reason: stringProperty
        },
        required: ["action", "answer"], additionalProperties: false
    },
    list_files: {
        type: "object",
        properties: { action: { const: "list_files" }, path: stringProperty, reason: stringProperty },
        required: ["action", "reason"], additionalProperties: false
    },
    search_files: {
        type: "object",
        properties: { action: { const: "search_files" }, query: stringProperty, path: stringProperty, reason: stringProperty },
        required: ["action", "query", "reason"], additionalProperties: false
    },
    search_project: {
        type: "object",
        properties: {
            action: { const: "search_project" },
            query: stringProperty,
            path: stringProperty,
            limit: { type: "integer", minimum: 1, maximum: 30 },
            reason: stringProperty
        },
        required: ["action", "query", "reason"], additionalProperties: false
    },
    read_file: {
        type: "object",
        properties: { action: { const: "read_file" }, path: stringProperty, reason: stringProperty },
        required: ["action", "path", "reason"], additionalProperties: false
    },
    write_file: {
        type: "object",
        properties: { action: { const: "write_file" }, path: stringProperty, content: stringProperty, reason: stringProperty },
        required: ["action", "path", "content", "reason"], additionalProperties: false
    },
    edit_file: {
        type: "object",
        properties: { action: { const: "edit_file" }, path: stringProperty, old_text: stringProperty, new_text: stringProperty, reason: stringProperty },
        required: ["action", "path", "old_text", "new_text", "reason"], additionalProperties: false
    },
    delete_file: {
        type: "object",
        properties: { action: { const: "delete_file" }, path: stringProperty, reason: stringProperty },
        required: ["action", "path", "reason"], additionalProperties: false
    },
    run_command: {
        type: "object",
        properties: {
            action: { const: "run_command" },
            command: stringProperty,
            workdir: stringProperty,
            mode: { enum: ["normal", "probe"] },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 30000 },
            expect: commandExpectationProperty,
            reason: stringProperty
        },
        required: ["action", "command", "reason"], additionalProperties: false
    },
    refine_task: {
        type: "object",
        properties: {
            action: { const: "refine_task" },
            task: taskContractProperty,
            evidence: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                uniqueItems: true,
                items: stringProperty
            },
            reason: stringProperty
        },
        required: ["action", "task", "evidence", "reason"],
        additionalProperties: false
    },
    ask_user: {
        type: "object",
        properties: {
            action: { const: "ask_user" },
            question: stringProperty,
            decision: { enum: ["target", "scope", "compatibility", "destructive", "cost", "external", "preference"] },
            options: {
                type: "array",
                minItems: 2,
                maxItems: 6,
                items: {
                    type: "object",
                    properties: { id: stringProperty, label: stringProperty, description: stringProperty },
                    required: ["id", "label", "description"],
                    additionalProperties: false
                }
            },
            reason: stringProperty
        },
        required: ["action", "question", "decision", "options", "reason"],
        additionalProperties: false
    },
    mcp_list_tools: {
        type: "object",
        properties: { action: { const: "mcp_list_tools" }, server: stringProperty, reason: stringProperty },
        required: ["action", "reason"], additionalProperties: false
    },
    mcp_call_tool: {
        type: "object",
        properties: { action: { const: "mcp_call_tool" }, server: stringProperty, tool: stringProperty, arguments: { type: "object" }, reason: stringProperty },
        required: ["action", "server", "tool", "arguments", "reason"], additionalProperties: false
    }
};

const workflowActions: Record<WorkflowKind, string[]> = {
    // General requests retain every non-destructive capability. The model can
    // therefore refine ambiguous natural language semantically (for example,
    // choosing web search for an external fact) instead of being constrained
    // by a keyword classifier before its first action.
    general: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"],
    web_research: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"],
    // A coding-shaped request can still require external evidence (for
    // example, researching a dependency or a model).  Do not let a lexical
    // workflow hint remove the model's ability to select a discovered tool.
    coding: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"],
    mcp_creation: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_list_tools", "mcp_call_tool", "ask_user", "final"]
};

function getAgentResponseFormat(workflow: WorkflowKind): Record<string, unknown> {
    return formatForActions(workflowActions[workflow]);
}

function getAgentRecoveryResponseFormat(workflow: WorkflowKind, blockedAction: string | string[]): Record<string, unknown> {
    const blocked = new Set(Array.isArray(blockedAction) ? blockedAction : [blockedAction]);
    // Recovery is for autonomous diagnosis/correction. Asking the user how to
    // handle a tool error commonly creates a question -> rejected retry loop.
    const actions = workflowActions[workflow].filter((action) => action !== "ask_user" && !blocked.has(action));
    return formatForActions(actions.length > 0 ? actions : ["final"]);
}

function getAgentMutationResponseFormat(blockedAction?: string): Record<string, unknown> {
    const actions = ["edit_file", "write_file", "delete_file"].filter((action) => action !== blockedAction);
    return formatForActions(actions.length > 0 ? actions : ["write_file"]);
}

function getAgentLocalResponseFormat(workflow: WorkflowKind): Record<string, unknown> {
    const actions = workflowActions[workflow].filter((action) => !action.startsWith("mcp_"));
    return formatForActions(actions.length > 0 ? actions : ["final"]);
}

function getAgentReadOnlyResponseFormat(workflow: WorkflowKind, allowCommands = false): Record<string, unknown> {
    const blocked = new Set(["edit_file", "write_file", "delete_file", ...(allowCommands ? [] : ["run_command"])]);
    const actions = workflowActions[workflow].filter((action) => !blocked.has(action));
    return formatForActions(actions.length > 0 ? actions : ["final"]);
}

function getAgentFinalResponseFormat(): Record<string, unknown> {
    return formatForActions(["final"]);
}

function withoutMcpActions(responseFormat: Record<string, unknown>): Record<string, unknown> {
    const schema = responseFormat.schema as { oneOf?: Array<Record<string, unknown>> } | undefined;
    const oneOf = schema?.oneOf;
    if (!Array.isArray(oneOf)) return responseFormat;
    const filtered = oneOf.filter((variant) => {
        const properties = variant.properties as { action?: { const?: unknown } } | undefined;
        return !String(properties?.action?.const ?? "").startsWith("mcp_");
    });
    return {
        ...responseFormat,
        schema: {
            ...schema,
            oneOf: filtered.length > 0 ? filtered : [variants.final]
        }
    };
}

function getInitialAgentResponseFormat(): Record<string, unknown> {
    return {
        type: "json_object",
        schema: {
            oneOf: workflowActions.general.filter((action) => action !== "refine_task").map((action) => {
                const variant = variants[action]!;
                const properties = variant.properties as Record<string, unknown>;
                const required = variant.required as string[];
                return {
                    ...variant,
                    properties: { ...properties, task: taskContractProperty },
                    required: [...required, "task"]
                };
            })
        }
    };
}

function buildInitialAgentMessages(systemPrompt: string, contextSummary: string, userMessage: string): Array<{ role: "system" | "user"; content: string }> {
    const contextBlock = contextSummary
        ? `\n\nRecent session context (use only when relevant; the current user request has priority):\n${contextSummary}`
        : "";
    return [
        { role: "system", content: `${systemPrompt}${contextBlock}` },
        { role: "user", content: userMessage }
    ];
}

function formatForActions(actions: string[]): Record<string, unknown> {
    return {
        type: "json_object",
        schema: { oneOf: actions.map((action) => variants[action]) }
    };
}

module.exports = { buildInitialAgentMessages, getAgentResponseFormat, getAgentRecoveryResponseFormat, getAgentMutationResponseFormat, getAgentLocalResponseFormat, getAgentReadOnlyResponseFormat, getAgentFinalResponseFormat, getInitialAgentResponseFormat, withoutMcpActions };
