export type ModelProtocolHealthSnapshot = {
    protocolFailures: number;
    transportFailures: number;
    toolExecutionFailures: number;
    verificationFailures: number;
    circuitBreakerTripped: boolean;
};

class ModelProtocolHealth {
    private protocolFailures = 0;
    private transportFailures = 0;
    private toolExecutionFailures = 0;
    private verificationFailures = 0;
    private circuitBreakerTripped = false;

    constructor(
        private readonly protocolFailureThreshold = 2,
        private readonly transportFailureThreshold = 2
    ) {}

    recordProtocolFailure(): ModelProtocolHealthSnapshot {
        this.protocolFailures += 1;
        this.circuitBreakerTripped = this.protocolFailures >= this.protocolFailureThreshold
            || this.transportFailures >= this.transportFailureThreshold;
        return this.snapshot();
    }

    recordTransportFailure(): ModelProtocolHealthSnapshot {
        this.transportFailures += 1;
        this.circuitBreakerTripped = this.protocolFailures >= this.protocolFailureThreshold
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
        this.circuitBreakerTripped = false;
        return this.snapshot();
    }

    snapshot(): ModelProtocolHealthSnapshot {
        return {
            protocolFailures: this.protocolFailures,
            transportFailures: this.transportFailures,
            toolExecutionFailures: this.toolExecutionFailures,
            verificationFailures: this.verificationFailures,
            circuitBreakerTripped: this.circuitBreakerTripped
        };
    }
}

module.exports = { ModelProtocolHealth };
