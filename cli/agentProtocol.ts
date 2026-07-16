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
    edit_file: {
        type: "object",
        properties: { action: { const: "edit_file" }, path: stringProperty, old_text: stringProperty, new_text: stringProperty, reason: stringProperty },
        required: ["action", "path", "old_text", "new_text", "reason"], additionalProperties: false
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
    // General agent requests keep local tools available so the model can use
    // conversational context instead of relying on an exhaustive intent regex.
    // Runtime guards still enforce workspace boundaries and safe mutations.
    general: ["read_file", "edit_file", "write_file", "run_command", "search_files", "list_files", "final"],
    web_research: ["read_file", "edit_file", "write_file", "run_command", "search_files", "list_files", "mcp_call_tool", "mcp_list_tools", "final"],
    coding: ["read_file", "edit_file", "write_file", "run_command", "search_files", "list_files", "final"],
    mcp_creation: ["read_file", "edit_file", "write_file", "run_command", "search_files", "list_files", "mcp_list_tools", "mcp_call_tool", "final"]
};

function getAgentResponseFormat(workflow: WorkflowKind): Record<string, unknown> {
    return formatForActions(workflowActions[workflow]);
}

function getAgentRecoveryResponseFormat(workflow: WorkflowKind, blockedAction: string): Record<string, unknown> {
    const actions = workflowActions[workflow].filter((action) => action !== blockedAction);
    return formatForActions(actions.length > 0 ? actions : ["final"]);
}

function getAgentLocalResponseFormat(workflow: WorkflowKind): Record<string, unknown> {
    const actions = workflowActions[workflow].filter((action) => !action.startsWith("mcp_"));
    return formatForActions(actions.length > 0 ? actions : ["final"]);
}

function getInitialAgentResponseFormat(workflow: WorkflowKind, message: string, requiresWrite = false): Record<string, unknown> {
    if ((workflow === "coding" || workflow === "mcp_creation") && requiresWrite) {
        return formatForActions(["list_files", "search_files", "read_file", "edit_file", "write_file"]);
    }
    if (workflow === "coding" && /(?:^|[\s"'`])(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|ps1|yml|yaml)(?=$|[\s"'`,)])/i.test(message)) {
        return formatForActions(["read_file"]);
    }
    if (workflow === "web_research") {
        return getAgentResponseFormat(workflow);
    }
    return getAgentResponseFormat(workflow);
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

module.exports = { buildInitialAgentMessages, getAgentResponseFormat, getAgentRecoveryResponseFormat, getAgentLocalResponseFormat, getInitialAgentResponseFormat };
