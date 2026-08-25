import type { AgentTaskContract } from "./agent/schema/taskContract.schema";
import type { WorkflowKind } from "./agent/schema/verification.schema";

const { AgentActionSchemas, AgentTaskContractSchema } = require("./agent/schema");
const { convertZodToJsonSchema } = require("./agent/schema/jsonSchema") as {
    convertZodToJsonSchema: (schema: import("zod").ZodTypeAny) => Record<string, unknown>;
};

type AgentActionName = "final" | "list_files" | "search_files" | "search_project" | "read_file" | "write_file" | "edit_file" | "delete_file" | "run_command" | "refine_task" | "ask_user" | "mcp_list_tools" | "mcp_call_tool";

const workflowActions: Record<WorkflowKind, AgentActionName[]> = {
    // Keep action availability semantic and broad. The model owns the final
    // intent decision after it receives the task context and project evidence.
    general: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"],
    web_research: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"],
    coding: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"],
    mcp_creation: ["search_project", "read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "refine_task", "mcp_list_tools", "mcp_call_tool", "ask_user", "final"]
};

const jsonSchemaCache = new Map<AgentActionName, Record<string, unknown>>();

function getActionJsonSchema(action: AgentActionName): Record<string, unknown> {
    const cached = jsonSchemaCache.get(action);
    if (cached) return cached;

    const generated = convertZodToJsonSchema(AgentActionSchemas[action]);
    jsonSchemaCache.set(action, generated);
    return generated;
}

function getTaskContractJsonSchema(): Record<string, unknown> {
    return convertZodToJsonSchema(AgentTaskContractSchema);
}

function formatForActions(actions: AgentActionName[]): Record<string, unknown> {
    return {
        type: "json_object",
        schema: { oneOf: actions.map(getActionJsonSchema) }
    };
}

function getAgentActionJsonSchema(): Record<string, unknown> {
    return {
        oneOf: Object.keys(AgentActionSchemas).map((action) => getActionJsonSchema(action as AgentActionName))
    };
}

function getAgentResponseFormat(workflow: WorkflowKind): Record<string, unknown> {
    return formatForActions(workflowActions[workflow]);
}

function getAgentRecoveryResponseFormat(workflow: WorkflowKind, blockedAction: string | string[]): Record<string, unknown> {
    const blocked = new Set(Array.isArray(blockedAction) ? blockedAction : [blockedAction]);
    const actions = workflowActions[workflow].filter((action) => action !== "ask_user" && !blocked.has(action));
    return formatForActions(actions.length > 0 ? actions : ["final"]);
}

function getAgentMutationResponseFormat(blockedAction?: string): Record<string, unknown> {
    const actions: AgentActionName[] = ["edit_file", "write_file", "delete_file"];
    return formatForActions(actions.filter((action) => action !== blockedAction));
}

function getAgentLocalResponseFormat(workflow: WorkflowKind): Record<string, unknown> {
    const actions = workflowActions[workflow].filter((action) => !action.startsWith("mcp_"));
    return formatForActions(actions.length > 0 ? actions : ["final"]);
}

function getAgentReadOnlyResponseFormat(workflow: WorkflowKind, allowCommands = false): Record<string, unknown> {
    const blocked = new Set<AgentActionName>(["edit_file", "write_file", "delete_file", ...(allowCommands ? [] : ["run_command"] as AgentActionName[])]);
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
            oneOf: filtered.length > 0 ? filtered : [getActionJsonSchema("final")]
        }
    };
}

function getAllowedActionNames(responseFormat: Record<string, unknown>): AgentActionName[] {
    const schema = responseFormat.schema as { oneOf?: Array<Record<string, unknown>> } | undefined;
    if (!Array.isArray(schema?.oneOf)) return [];
    return schema.oneOf.flatMap((variant) => {
        const properties = variant.properties as { action?: { const?: unknown } } | undefined;
        const action = properties?.action?.const;
        return typeof action === "string" && action in AgentActionSchemas
            ? [action as AgentActionName]
            : [];
    });
}

function getInitialAgentResponseFormat(): Record<string, unknown> {
    const taskSchema = getTaskContractJsonSchema();
    const variants = workflowActions.general
        .filter((action) => action !== "refine_task")
        .map((action) => {
            const variant = getActionJsonSchema(action);
            const properties = (variant.properties ?? {}) as Record<string, unknown>;
            const required = Array.isArray(variant.required) ? variant.required as string[] : [];
            return {
                ...variant,
                properties: { ...properties, task: taskSchema },
                required: Array.from(new Set([...required, "task"]))
            };
        });

    return { type: "json_object", schema: { oneOf: variants } };
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

module.exports = {
    buildInitialAgentMessages,
    getAgentActionJsonSchema,
    getAgentResponseFormat,
    getAgentRecoveryResponseFormat,
    getAgentMutationResponseFormat,
    getAgentLocalResponseFormat,
    getAgentReadOnlyResponseFormat,
    getAgentFinalResponseFormat,
    getInitialAgentResponseFormat,
    getAllowedActionNames,
    withoutMcpActions
};

export type { AgentTaskContract };
