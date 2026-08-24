import type { AgentAction } from "../schema/agentAction.schema";
import type { AgentToolResult } from "../agentSchema";
import type { AgentContext } from "../agentContext";
import type { AgentEventSink } from "../agentEvents";

export type VerificationResult = {
    required: boolean;
    success: boolean;
    reason?: string;
};

export interface VerificationCoordinator {
    observe(action: AgentAction, result: AgentToolResult, context: AgentContext): void;
    verify(context: AgentContext): Promise<VerificationResult>;
}

class DefaultVerificationCoordinator implements VerificationCoordinator {
    constructor(private readonly events: AgentEventSink) {}

    observe(action: AgentAction, result: AgentToolResult, context: AgentContext): void {
        if (action.action !== "run_command" || context.verification.requirement === "none") return;
        this.events.emit({ type: "verification_started" });
        const success = result.ok && result.assertionPassed !== false;
        this.events.emit({ type: "verification_completed", success });
    }

    async verify(context: AgentContext): Promise<VerificationResult> {
        if (context.verification.requirement === "none") {
            return { required: false, success: true };
        }
        return {
            required: true,
            success: context.verification.satisfied,
            ...(context.verification.failure ? { reason: context.verification.failure } : {})
        };
    }
}

module.exports = { DefaultVerificationCoordinator };
