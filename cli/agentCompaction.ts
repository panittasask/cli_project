type CompactState = {
    segment: number;
    maxSegments: number;
    writtenPaths: string[];
    validationFailures: string[];
    unresolvedVerificationFailure?: string;
    verificationRequirement?: "none" | "command" | "runtime";
    verificationSatisfied?: boolean;
    sourceUrls: string[];
    recentEvents: string[];
    mcpCallsDisabled?: boolean;
};

function buildCompactedAgentMessages(
    systemContent: string,
    originalRequest: string,
    state: CompactState
): Array<{ role: "system" | "user"; content: string }> {
    const lines = [
        `Original user request: ${originalRequest}`,
        `Continuation segment: ${state.segment}/${state.maxSegments}`,
        `Successful file changes: ${state.writtenPaths.join(", ") || "none"}`,
        `Validation failures: ${state.validationFailures.join(", ") || "none"}`,
        `Unresolved verification failure: ${state.unresolvedVerificationFailure || "none"}`,
        `Required verification: ${state.verificationRequirement || "none"}`,
        `Required verification satisfied after the latest write: ${state.verificationSatisfied === true ? "yes" : "no"}`,
        `Collected source URLs: ${state.sourceUrls.join(", ") || "none"}`,
        `MCP calls available: ${state.mcpCallsDisabled ? "no - use local file tools and do not invent server names" : "yes"}`,
        "Recent agent events:",
        ...(state.recentEvents.slice(-10).length > 0 ? state.recentEvents.slice(-10) : ["none"]),
        "Continue the task from this compact state. Re-read any file whose exact current content is needed. Do not repeat completed work or claim unverified success."
    ];
    return [
        { role: "system", content: systemContent },
        { role: "user", content: lines.join("\n") }
    ];
}

module.exports = { buildCompactedAgentMessages };
