import type { AgentAction, AgentToolResult } from "../agentSchema";

export type ActionToolPort = {
    parseAction: (content: string | undefined | null) => AgentAction | undefined;
    explainParseFailure: (content: string | undefined | null) => string;
    execute: (action: AgentAction) => Promise<AgentToolResult>;
    formatActionStatus: (action: AgentAction, turn: number, maxTurns: number) => string;
    formatObservation: (action: AgentAction, result: AgentToolResult) => string;
};

export interface ActionCoordinator {
    parse(content: string | undefined | null): AgentAction | undefined;
    explainParseFailure(content: string | undefined | null): string;
    execute(action: AgentAction): Promise<AgentToolResult>;
    formatStatus(action: AgentAction, turn: number, maxTurns: number): string;
    formatObservation(action: AgentAction, result: AgentToolResult): string;
}

class DefaultActionCoordinator implements ActionCoordinator {
    constructor(private readonly tools: ActionToolPort) {}

    parse(content: string | undefined | null): AgentAction | undefined {
        return this.tools.parseAction(content);
    }

    explainParseFailure(content: string | undefined | null): string {
        return this.tools.explainParseFailure(content);
    }

    execute(action: AgentAction): Promise<AgentToolResult> {
        return this.tools.execute(action);
    }

    formatStatus(action: AgentAction, turn: number, maxTurns: number): string {
        return this.tools.formatActionStatus(action, turn, maxTurns);
    }

    formatObservation(action: AgentAction, result: AgentToolResult): string {
        return this.tools.formatObservation(action, result);
    }
}

module.exports = { DefaultActionCoordinator };
