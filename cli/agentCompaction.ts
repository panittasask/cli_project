type CompactState = {
    segment: number;
    maxSegments: number;
    writtenPaths: string[];
    validationFailures: string[];
    unresolvedVerificationFailure?: string;
    sourceUrls: string[];
    recentEvents: string[];
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
        `Collected source URLs: ${state.sourceUrls.join(", ") || "none"}`,
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
