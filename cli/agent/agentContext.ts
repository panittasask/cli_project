import type { AgentAction } from "./schema/agentAction.schema";
import type { AgentTaskContract } from "./schema/taskContract.schema";

export type AgentActionHistory = {
    turn: number;
    action: AgentAction["action"];
    success?: boolean;
    observation?: string;
};

export interface AgentContext {
    task?: AgentTaskContract;
    turn: number;
    actions: AgentActionHistory[];
    evidence: string[];
    verification: {
        requirement: "none" | "command" | "runtime";
        satisfied: boolean;
        failure?: string;
    };
    workspace: {
        root: string;
    };
    completion: {
        status: "continue" | "completed" | "blocked" | "needs_user_input" | "failed";
        blockers: string[];
    };
}

function createAgentContext(workspaceRoot: string): AgentContext {
    return {
        turn: 0,
        actions: [],
        evidence: [],
        verification: { requirement: "none", satisfied: true },
        workspace: { root: workspaceRoot },
        completion: { status: "continue", blockers: [] }
    };
}

module.exports = { createAgentContext };
