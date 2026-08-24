import type { AgentContext } from "../agentContext";

export type CompletionDecision =
    | { status: "continue" }
    | { status: "completed"; message: string }
    | { status: "blocked"; reason: string }
    | { status: "needs_user_input"; question: string };

export interface CompletionCoordinator {
    evaluate(context: AgentContext): CompletionDecision;
}

class DefaultCompletionCoordinator implements CompletionCoordinator {
    evaluate(context: AgentContext): CompletionDecision {
        if (context.completion.blockers.length > 0) {
            return { status: "blocked", reason: context.completion.blockers.join("; ") };
        }
        if (context.verification.requirement !== "none" && !context.verification.satisfied) {
            return { status: "continue" };
        }
        return { status: "continue" };
    }
}

module.exports = { DefaultCompletionCoordinator };
