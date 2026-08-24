import z = require("zod");

const workflowKinds = ["general", "web_research", "coding", "mcp_creation"] as const;
const verificationKinds = ["none", "command", "runtime", "interaction"] as const;
const evidenceKinds = ["source", "command", "runtime", "interaction", "visual"] as const;

const AgentTaskContractSchema = z.object({
    intent: z.string(),
    task_type: z.enum(workflowKinds),
    continuation: z.boolean(),
    requires_workspace_changes: z.boolean(),
    verification: z.enum(verificationKinds),
    evidence_requirements: z.array(z.enum(evidenceKinds)),
    success_criteria: z.array(z.string())
});

export type AgentTaskContract = z.infer<typeof AgentTaskContractSchema>;

const CommandExpectationSchema = z.object({
    exit_code: z.literal(0).optional(),
    output_includes: z.array(z.string()).optional(),
    output_excludes: z.array(z.string()).optional()
});

export type CommandExpectation = z.infer<typeof CommandExpectationSchema>;

const actionMetadata = {
    reason: z.string().optional(),
    task: AgentTaskContractSchema.optional()
};

const actionReason = {
    reason: z.string().optional()
};

const clarificationOptionSchema = z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional()
});

const AgentActionSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("final"),
        answer: z.string(),
        completion_status: z.enum(["completed", "already_satisfied", "no_change_needed", "incomplete"]).default("completed"),
        evidence: z.array(z.string()).default([]),
        ...actionMetadata
    }),
    z.object({ action: z.literal("list_files"), path: z.string().optional(), ...actionMetadata }),
    z.object({ action: z.literal("search_files"), query: z.string(), path: z.string().optional(), ...actionMetadata }),
    z.object({ action: z.literal("search_project"), query: z.string(), path: z.string().optional(), limit: z.number().optional(), ...actionMetadata }),
    z.object({ action: z.literal("read_file"), path: z.string(), ...actionMetadata }),
    z.object({ action: z.literal("write_file"), path: z.string(), content: z.string(), ...actionMetadata }),
    z.object({ action: z.literal("edit_file"), path: z.string(), old_text: z.string(), new_text: z.string(), ...actionMetadata }),
    z.object({ action: z.literal("delete_file"), path: z.string(), ...actionMetadata }),
    z.object({
        action: z.literal("run_command"),
        command: z.string(),
        workdir: z.string().optional(),
        mode: z.enum(["normal", "probe"]).optional(),
        timeout_ms: z.number().optional(),
        expect: CommandExpectationSchema.optional(),
        ...actionMetadata
    }),
    z.object({ action: z.literal("refine_task"), task: AgentTaskContractSchema, evidence: z.array(z.string()).min(1), ...actionReason }),
    z.object({
        action: z.literal("ask_user"),
        question: z.string(),
        options: z.array(clarificationOptionSchema),
        decision: z.enum(["target", "scope", "compatibility", "destructive", "cost", "external", "preference"]),
        ...actionMetadata
    }),
    z.object({ action: z.literal("mcp_list_tools"), server: z.string().optional(), ...actionMetadata }),
    z.object({ action: z.literal("mcp_call_tool"), server: z.string(), tool: z.string(), arguments: z.record(z.unknown()), ...actionMetadata })
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;

export type AgentToolResult = {
    ok: boolean;
    output: string;
    changed?: boolean;
    assertionPassed?: boolean;
    probeTimedOut?: boolean;
    failureKind?: "inference_port_collision" | "invocation" | "timeout" | "unsafe" | "runtime";
    recommendedCommand?: string;
    recommendedWorkdir?: string;
    recommendedMode?: "probe";
};

function parseTaskContract(value: unknown): AgentTaskContract | undefined {
    const parsed = AgentTaskContractSchema.safeParse(value);
    if (!parsed.success) return undefined;

    const task = parsed.data;
    const evidenceRequirements = Array.from(new Set(task.evidence_requirements)).slice(0, 5);
    const successCriteria = task.success_criteria
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6);

    if (!task.intent.trim() || evidenceRequirements.length === 0 || successCriteria.length === 0) {
        return undefined;
    }

    return {
        ...task,
        intent: task.intent.trim().slice(0, 500),
        evidence_requirements: evidenceRequirements,
        success_criteria: successCriteria
    };
}

function parseAgentAction(value: unknown): AgentAction | undefined {
    const parsed = AgentActionSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

module.exports = {
    AgentTaskContractSchema,
    CommandExpectationSchema,
    AgentActionSchema,
    parseTaskContract,
    parseAgentAction
};
