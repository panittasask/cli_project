import assert = require("node:assert/strict");
import type { AgentAction } from "../cli/agent/schema/agentAction.schema";
import type { AgentEventSink } from "../cli/agent/agentEvents";
import type { CompletionCoordinatorServices, FinalAction } from "../cli/agent/completion/completionCoordinator";
import type { VerificationCoordinatorServices } from "../cli/agent/verification/verificationCoordinator";
import type { ProjectCheckProvider } from "../cli/projectTypes";

const { createAgentContext } = require("../cli/agent/agentContext") as {
    createAgentContext: (workspaceRoot: string) => import("../cli/agent/agentContext").AgentContext;
};
const { DefaultVerificationCoordinator } = require("../cli/agent/verification/verificationCoordinator") as {
    DefaultVerificationCoordinator: new (services: VerificationCoordinatorServices) => import("../cli/agent/verification/verificationCoordinator").VerificationCoordinator;
};
const { DefaultCompletionCoordinator } = require("../cli/agent/completion/completionCoordinator") as {
    DefaultCompletionCoordinator: new (
        workspace: string,
        providers: ProjectCheckProvider[],
        services: CompletionCoordinatorServices
    ) => import("../cli/agent/completion/completionCoordinator").CompletionCoordinator;
};

const events: AgentEventSink = { emit: () => undefined };
const verificationServices: VerificationCoordinatorServices = {
    events,
    commandInvocationError: () => false,
    commandMutatesWorkspaceFiles: () => false,
    missingCommandTargetError: () => false,
    commandSatisfiesAcceptance: () => true,
    projectChecksForCommand: () => []
};

function commandAction(command = "npm test"): AgentAction {
    return {
        action: "run_command",
        command,
        workdir: "."
    } as unknown as AgentAction;
}

function commandContext() {
    const context = createAgentContext(".");
    context.policy.acceptance = { evidence: "command", verification: "command", reason: "test" };
    context.verification.requirement = "command";
    context.verification.satisfied = false;
    return context;
}

const successfulContext = commandContext();
const verification = new DefaultVerificationCoordinator(verificationServices);
verification.observeAction(commandAction(), { ok: true, output: "passed", assertionPassed: true }, successfulContext);
assert.equal(successfulContext.verification.attempted, true);
assert.equal(successfulContext.verification.satisfied, true);
assert.equal(verification.evaluate(successfulContext).success, true);

const failedContext = commandContext();
verification.observeAction(commandAction(), { ok: false, output: "test failed", failureKind: "runtime" }, failedContext);
assert.equal(failedContext.verification.attempted, true);
assert.equal(failedContext.verification.satisfied, false);
assert.equal(failedContext.verification.failure, "test failed");
assert.equal(verification.recover(failedContext), true);
assert.equal(failedContext.verification.recoveryAttempts, 1);
assert.equal(failedContext.verification.recoveryActive, true);

const notRequiredContext = createAgentContext(".");
assert.deepEqual(verification.evaluate(notRequiredContext), {
    required: false,
    success: true,
    attempted: false
});

const completionServices: CompletionCoordinatorServices = {
    effectiveCompletionStatus: (status) => status,
    continuationNoWriteCompletionAllowed: () => false,
    noChangeCompletionBlockReason: () => undefined,
    answerLooksLikeBlockingClarification: () => false,
    answerDefersRequiredWork: () => false,
    discoverProjectChecks: () => [],
    evaluateProjectCompletion: () => [],
    requiredProjectChecks: () => [],
    formatIncompleteTaskAnswer: () => "incomplete"
};
const completion = new DefaultCompletionCoordinator(".", [], completionServices);
const completionContext = createAgentContext(".");
completionContext.task = {
    intent: "answer the request",
    task_type: "general",
    continuation: false,
    requires_workspace_changes: false,
    verification: "none",
    evidence_requirements: ["source"],
    success_criteria: ["return an answer"]
};
completionContext.policy.readOnly = true;
completionContext.policy.acceptance = { evidence: "source", verification: "none", reason: "test" };
const finalDecision = completion.evaluateFinal({
    action: "final",
    answer: "done",
    completion_status: "completed",
    evidence: []
} satisfies FinalAction, completionContext);
assert.deepEqual(finalDecision, { status: "accepted", answer: "done" });
assert.equal(completionContext.completion.status, "completed");
assert.equal(completion.evaluate(completionContext).status, "completed");

const workspaceChangeContext = createAgentContext(".");
workspaceChangeContext.task = {
    intent: "change a file",
    task_type: "coding",
    continuation: false,
    requires_workspace_changes: true,
    verification: "none",
    evidence_requirements: ["source"],
    success_criteria: ["the file is changed"]
};
workspaceChangeContext.policy.mustWrite = true;
const workspaceChangeDecision = completion.evaluateFinal({
    action: "final",
    answer: "done",
    completion_status: "completed",
    evidence: []
} satisfies FinalAction, workspaceChangeContext);
assert.equal(workspaceChangeDecision.status, "rejected");

const blockedContext = createAgentContext(".");
blockedContext.completion.blockers = ["validation failed"];
assert.deepEqual(completion.evaluate(blockedContext), {
    status: "blocked",
    reason: "validation failed"
});

const transitionContext = createAgentContext(".");
transitionContext.turn = 1;
transitionContext.actions.push({ turn: 1, action: "read_file", success: true, observation: "ok" });
transitionContext.evidence.push("evidence_1_read_file");
transitionContext.completion.finalRequested = true;
assert.equal(transitionContext.turn, 1);
assert.equal(transitionContext.actions.length, 1);
assert.deepEqual(transitionContext.evidence, ["evidence_1_read_file"]);
assert.equal(transitionContext.completion.finalRequested, true);

console.log("Agent coordinator tests passed.");
