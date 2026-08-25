type JsonSchema = Record<string, unknown>;
type OpenRouterTool = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: JsonSchema;
    };
};

const actionDescriptions: Record<string, string> = {
    final: "Finish the task with an evidence-backed answer.",
    list_files: "List files in the workspace.",
    search_files: "Search exact text in workspace files.",
    search_project: "Search the indexed project semantically.",
    read_file: "Read a workspace file.",
    write_file: "Write content to a workspace file.",
    edit_file: "Replace exact text in a workspace file.",
    delete_file: "Delete a workspace file when the task permits it.",
    run_command: "Run a bounded workspace command or verification.",
    refine_task: "Refine the task contract using successful workspace evidence.",
    ask_user: "Ask the user one concrete blocking clarification.",
    mcp_list_tools: "List tools exposed by a configured MCP server.",
    mcp_call_tool: "Call a configured MCP tool."
};

function buildOpenRouterTools(responseFormat: JsonSchema | undefined): OpenRouterTool[] {
    const schema = responseFormat?.schema;
    const variants = schema && typeof schema === "object" && !Array.isArray(schema)
        ? (schema as { oneOf?: unknown }).oneOf
        : undefined;
    if (!Array.isArray(variants)) return [];
    const tools: OpenRouterTool[] = [];
    for (const variant of variants) {
        if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
        const candidate = variant as JsonSchema;
        const properties = candidate.properties;
        if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
        const actionProperty = (properties as JsonSchema).action;
        const actionName = actionProperty && typeof actionProperty === "object" && !Array.isArray(actionProperty)
            ? (actionProperty as JsonSchema).const
            : undefined;
        if (typeof actionName !== "string" || !actionDescriptions[actionName]) continue;

        const parameterProperties = { ...(properties as JsonSchema) };
        delete parameterProperties.action;
        const required = Array.isArray(candidate.required)
            ? candidate.required.filter((field): field is string => typeof field === "string" && field !== "action")
            : [];
        const parameters: JsonSchema = {
            ...candidate,
            type: "object",
            properties: parameterProperties,
            ...(required.length > 0 ? { required } : {})
        };
        delete parameters.$schema;

        tools.push({
            type: "function",
            function: {
                name: actionName,
                description: actionDescriptions[actionName],
                parameters
            }
        });
    }
    return tools;
}

module.exports = { buildOpenRouterTools };
