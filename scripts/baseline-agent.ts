import axios = require("axios");
import fs = require("node:fs");
import path = require("node:path");
const { loadCliSettings, getSamplingSettings } = require("../cli/config") as {
    loadCliSettings: (root?: string) => Record<string, unknown>;
    getSamplingSettings: (settings: Record<string, unknown>, kind: "action") => Record<string, number>;
};
const { AgentTool } = require("../cli/tools/agentTool") as { AgentTool: new () => {
    buildSystemPrompt: (instructions?: string) => Promise<string>;
    parseAction: (content: string) => { action?: string; reason?: string } | undefined;
    close: () => Promise<void>;
} };
const { getInitialAgentResponseFormat } = require("../cli/agentProtocol") as { getInitialAgentResponseFormat: () => Record<string, unknown> };

const appRoot = path.resolve(__dirname, "..");
const settings = loadCliSettings(appRoot);
const apiUrl = process.env.LLAMA_API_URL?.trim() || "http://127.0.0.1:8080/v1/chat/completions";
const sampling = getSamplingSettings(settings, "action");
const configuredAttempts = Number(process.env.BASELINE_AGENT_ATTEMPTS);
const attempts = Number.isFinite(configuredAttempts)
    ? Math.min(10, Math.max(1, Math.floor(configuredAttempts)))
    : 5;
const configuredRequestTimeoutMs = Number(process.env.BASELINE_REQUEST_TIMEOUT_MS);
const requestTimeoutMs = Number.isFinite(configuredRequestTimeoutMs)
    ? Math.min(600_000, Math.max(10_000, Math.floor(configuredRequestTimeoutMs)))
    : 120_000;

function endpoint(route: string): string {
    return new URL(route, apiUrl).toString();
}

async function main(): Promise<void> {
    const modelsResponse = await axios.get(endpoint("/v1/models"), { timeout: 5000 });
    const model = modelsResponse.data?.data?.[0]?.id;
    if (typeof model !== "string" || !model) {
        throw new Error("llama-server did not report a loaded model at /v1/models");
    }

    const agent = new AgentTool();
    try {
        const prompt = "Read README.md before explaining what this project does.";
        const systemPrompt = await agent.buildSystemPrompt();
        const responseFormat = getInitialAgentResponseFormat();
        const results: Array<{
            attempt: number;
            valid: boolean;
            action?: string;
            reason?: string;
            raw: string;
        }> = [];

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            console.log(`Agent protocol attempt ${attempt}/${attempts}`);
            const response = await axios.post(apiUrl, {
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt }
                ],
                response_format: responseFormat,
                ...sampling
            }, { timeout: requestTimeoutMs });
            const raw = response.data?.choices?.[0]?.message?.content?.trim() ?? "";
            const parsed = agent.parseAction(raw);
            results.push({
                attempt,
                valid: Boolean(parsed),
                ...(parsed?.action ? { action: parsed.action } : {}),
                ...(parsed?.reason ? { reason: parsed.reason } : {}),
                raw
            });
        }

        const actions = results.map((result) => result.action ?? "invalid");
        const report = {
            generatedAt: new Date().toISOString(),
            model,
            prompt,
            sampling,
            attempts,
            requestTimeoutMs,
            validJsonActions: results.filter((result) => result.valid).length,
            readFileActions: results.filter((result) => result.action === "read_file").length,
            reasonsIncluded: results.filter((result) => Boolean(result.reason)).length,
            stableSelection: new Set(actions).size === 1,
            results
        };

        const outputDirectory = path.resolve(appRoot, ".cli", "logs", "baseline");
        fs.mkdirSync(outputDirectory, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outputPath = path.join(outputDirectory, `baseline-agent-${stamp}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

        console.log(JSON.stringify({
            model: report.model,
            validJsonActions: report.validJsonActions,
            readFileActions: report.readFileActions,
            reasonsIncluded: report.reasonsIncluded,
            stableSelection: report.stableSelection
        }, null, 2));
        console.log(`Agent baseline report: ${outputPath}`);

        if (report.validJsonActions !== attempts || report.readFileActions !== attempts) {
            process.exitCode = 2;
        }
    } finally {
        await agent.close();
    }
}

main().catch((error) => {
    const message = axios.isAxiosError(error) ? error.message : error instanceof Error ? error.message : String(error);
    console.error(`Agent baseline failed: ${message}`);
    process.exit(1);
});
