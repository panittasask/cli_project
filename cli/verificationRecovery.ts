type VerificationRecoveryInput = {
    boundedRun: boolean;
    baseLimitReached: boolean;
    unresolvedVerificationFailure?: string;
};

const MIN_RECOVERY_TURNS = 4;
const MAX_RECOVERY_TURNS = 8;

function verificationRecoveryTurnAllowance(maxTurnsPerSegment: number): number {
    if (!Number.isFinite(maxTurnsPerSegment) || maxTurnsPerSegment <= 0) return 0;
    return Math.max(MIN_RECOVERY_TURNS, Math.min(MAX_RECOVERY_TURNS, Math.floor(maxTurnsPerSegment)));
}

function shouldActivateVerificationRecovery(input: VerificationRecoveryInput): boolean {
    return input.boundedRun
        && input.baseLimitReached
        && Boolean(input.unresolvedVerificationFailure?.trim());
}

module.exports = {
    shouldActivateVerificationRecovery,
    verificationRecoveryTurnAllowance
};
