const { AgentTaskContractSchema, AgentActionSchema } = require("./schema");
type AgentTaskContract = import("./schema/taskContract.schema").AgentTaskContract;
type AgentAction = import("./schema/agentAction.schema").AgentAction;

function parseTaskContract(value: unknown): AgentTaskContract | undefined {
    const parsed = AgentTaskContractSchema.safeParse(value);
    if (!parsed.success) return undefined;

    const task = parsed.data;
    const evidenceRequirements = Array.from(new Set(task.evidence_requirements)).slice(0, 5);
    const successCriteria = task.success_criteria
        .map((item: string) => item.trim())
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

module.exports = { parseTaskContract, parseAgentAction };
