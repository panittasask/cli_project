const {
    AgentTaskContractSchema,
    CommandExpectationSchema,
    AgentActionSchema
} = require("./schema");
const { parseTaskContract, parseAgentAction } = require("./schemaParsers");

export type AgentTaskContract = import("./schema/taskContract.schema").AgentTaskContract;
export type CommandExpectation = import("./schema/actions/runCommand.schema").CommandExpectation;
export type AgentAction = import("./schema/agentAction.schema").AgentAction;

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

module.exports = {
    AgentTaskContractSchema,
    CommandExpectationSchema,
    AgentActionSchema,
    parseTaskContract,
    parseAgentAction
};
