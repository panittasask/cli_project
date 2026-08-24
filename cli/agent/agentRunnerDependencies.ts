import type { AgentEventSink } from "./agentEvents";
import type { ActionCoordinator } from "./action/actionCoordinator";
import type { TaskCoordinator } from "./task/taskCoordinator";
import type { VerificationCoordinator } from "./verification/verificationCoordinator";
import type { CompletionCoordinator } from "./completion/completionCoordinator";
import type { LLMProvider } from "../model/llmProvider";

export type AgentDependencyGroup = Record<string, unknown>;

export interface AgentLlmServices extends AgentDependencyGroup {
    llmProvider: LLMProvider;
    actionSampling: object;
    model: string;
    activeContextLength: number;
}

export interface AgentToolServices extends AgentDependencyGroup {
    agentTool: object;
    actionCoordinator: ActionCoordinator;
}

export interface AgentTaskServices extends AgentDependencyGroup {
    taskCoordinator: TaskCoordinator;
}

export interface AgentVerificationServices extends AgentDependencyGroup {
    verificationCoordinator: VerificationCoordinator;
}

export interface AgentCompletionServices extends AgentDependencyGroup {
    completionCoordinator: CompletionCoordinator;
}

export interface AgentRunnerDependencies {
    llm: AgentLlmServices;
    tools: AgentToolServices;
    task: AgentTaskServices;
    verification: AgentVerificationServices;
    completion: AgentCompletionServices;
    state: AgentDependencyGroup;
    events: AgentEventSink;
}

module.exports = {};
