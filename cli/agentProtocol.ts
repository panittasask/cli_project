type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";

const stringProperty = { type: "string" };
const variants: Record<string, Record<string, unknown>> = {
    final: {
        type: "object",
        properties: { action: { const: "final" }, answer: stringProperty, reason: stringProperty },
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
    run_command: {
        type: "object",
        properties: { action: { const: "run_command" }, command: stringProperty, reason: stringProperty },
        required: ["action", "command", "reason"], additionalProperties: false
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
    general: ["final"],
    web_research: ["mcp_call_tool", "mcp_list_tools", "final"],
    coding: ["read_file", "write_file", "run_command", "search_files", "list_files", "final"],
    mcp_creation: ["read_file", "write_file", "run_command", "search_files", "list_files", "mcp_list_tools", "mcp_call_tool", "final"]
};

function getAgentResponseFormat(workflow: WorkflowKind): Record<string, unknown> {
    return formatForActions(workflowActions[workflow]);
}

function getInitialAgentResponseFormat(workflow: WorkflowKind, message: string): Record<string, unknown> {
    if (workflow === "coding" && /(?:^|[\s"'`])(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|ps1|yml|yaml)(?=$|[\s"'`,)])/i.test(message)) {
        return formatForActions(["read_file"]);
    }
    if (workflow === "web_research") {
        return formatForActions(["mcp_call_tool", "mcp_list_tools"]);
    }
    return getAgentResponseFormat(workflow);
}

function formatForActions(actions: string[]): Record<string, unknown> {
    return {
        type: "json_object",
        schema: { oneOf: actions.map((action) => variants[action]) }
    };
}

module.exports = { getAgentResponseFormat, getInitialAgentResponseFormat };
