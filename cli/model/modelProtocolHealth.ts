export type ModelProtocolHealthSnapshot = {
    protocolFailures: number;
    transportFailures: number;
    toolExecutionFailures: number;
    verificationFailures: number;
    failureThresholdReached: boolean;
};

class ModelProtocolHealth {
    // Telemetry only: bounded protocol regeneration is the actual stop mechanism.
    // Tool and verification failures remain separate counters and do not affect this threshold.
    private protocolFailures = 0;
    private transportFailures = 0;
    private toolExecutionFailures = 0;
    private verificationFailures = 0;
    private failureThresholdReached = false;

    constructor(
        private readonly protocolFailureThreshold = 2,
        private readonly transportFailureThreshold = 2
    ) {}

    recordProtocolFailure(): ModelProtocolHealthSnapshot {
        this.protocolFailures += 1;
        this.failureThresholdReached = this.protocolFailures >= this.protocolFailureThreshold
            || this.transportFailures >= this.transportFailureThreshold;
        return this.snapshot();
    }

    recordTransportFailure(): ModelProtocolHealthSnapshot {
        this.transportFailures += 1;
        this.failureThresholdReached = this.protocolFailures >= this.protocolFailureThreshold
            || this.transportFailures >= this.transportFailureThreshold;
        return this.snapshot();
    }

    recordToolExecutionFailure(): ModelProtocolHealthSnapshot {
        this.toolExecutionFailures += 1;
        return this.snapshot();
    }

    recordVerificationFailure(): ModelProtocolHealthSnapshot {
        this.verificationFailures += 1;
        return this.snapshot();
    }

    recordValidAction(): ModelProtocolHealthSnapshot {
        this.protocolFailures = 0;
        this.transportFailures = 0;
        this.failureThresholdReached = false;
        return this.snapshot();
    }

    snapshot(): ModelProtocolHealthSnapshot {
        return {
            protocolFailures: this.protocolFailures,
            transportFailures: this.transportFailures,
            toolExecutionFailures: this.toolExecutionFailures,
            verificationFailures: this.verificationFailures,
            failureThresholdReached: this.failureThresholdReached
        };
    }
}

module.exports = { ModelProtocolHealth };
