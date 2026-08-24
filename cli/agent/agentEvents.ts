export type AgentEvent =
    | { type: "task_started"; task: string }
    | { type: "status"; message: string }
    | { type: "log"; message: string }
    | { type: "tool_started"; tool: string }
    | { type: "tool_completed"; tool: string; success: boolean }
    | { type: "verification_started" }
    | { type: "verification_completed"; success: boolean }
    | { type: "recovery_started"; message: string }
    | { type: "input_suspended" }
    | { type: "input_resumed" }
    | { type: "retrying"; message: string }
    | { type: "final"; message: string };

export interface AgentEventSink {
    emit(event: AgentEvent): void;
}

class NullAgentEventSink implements AgentEventSink {
    emit(_event: AgentEvent): void {
        // Intentionally empty for tests and non-terminal consumers.
    }
}

module.exports = { NullAgentEventSink };
