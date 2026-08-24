import type { AgentEvent, AgentEventSink } from "./agent/agentEvents";

export type TerminalSpinner = {
    update: (message: string) => void;
    log: (message: string) => void;
    suspend: () => void;
    resume: () => void;
};

class TerminalAgentEventSink implements AgentEventSink {
    constructor(private readonly getSpinner: () => TerminalSpinner | undefined) {}

    emit(event: AgentEvent): void {
        const spinner = this.getSpinner();
        if (!spinner) return;

        switch (event.type) {
            case "status":
            case "retrying":
                spinner.update(event.type === "retrying" ? event.message : event.message);
                break;
            case "log":
            case "recovery_started":
                spinner.log(event.type === "recovery_started" ? `[recovery] ${event.message}` : event.message);
                break;
            case "input_suspended":
                spinner.suspend();
                break;
            case "input_resumed":
                spinner.resume();
                break;
            case "tool_started":
                spinner.update(`Executing ${event.tool}...`);
                break;
            case "tool_completed":
                spinner.update(event.success ? `Completed ${event.tool}; reviewing result...` : `${event.tool} failed; planning recovery...`);
                break;
            case "verification_started":
                spinner.update("Verifying...");
                break;
            case "verification_completed":
                spinner.update(event.success ? "Verification passed." : "Verification failed; planning recovery...");
                break;
            case "task_started":
            case "final":
                break;
        }
    }
}

module.exports = { TerminalAgentEventSink };
