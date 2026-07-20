import assert = require("node:assert/strict");
import axios = require("axios");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
const { runAgentCliHarness } = require("./agent-cli-harness") as {
    runAgentCliHarness: (options: Record<string, unknown>) => Promise<{ output: string; stderr: string; exitCode: number }>;
};

async function main(): Promise<void> {
    const apiUrl = process.env.LLAMA_API_URL?.trim() || "http://127.0.0.1:8080/v1/chat/completions";
    const qualityMode = process.env.LOCAL_EVAL_MODE?.trim().toLowerCase() === "quality";
    try {
        await axios.get(new URL("/health", apiUrl).toString(), { timeout: 2000 });
    } catch {
        console.log(`Live agent E2E skipped: llama.cpp is unavailable at ${apiUrl}`);
        return;
    }
    try {
        const slots = await axios.get(new URL("/slots", apiUrl).toString(), { timeout: 2000 });
        const entries = Array.isArray(slots.data) ? slots.data : [];
        if (entries.some((slot: { is_processing?: unknown }) => slot.is_processing === true)) {
            console.log("Live agent E2E skipped: all llama.cpp slots are currently busy.");
            return;
        }
    } catch {
        // Older or locked-down servers may not expose /slots; the health check
        // above is still enough to attempt the isolated live scenario.
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-live-agent-"));
    const readme = "# Live Agent Fixture\n\nThis workspace verifies that the agent reads evidence before answering.\n";
    fs.writeFileSync(path.join(root, "README.md"), readme, "utf8");
    try {
        const result = await runAgentCliHarness({
            appRoot: root,
            workspace: root,
            apiUrl,
            prompt: "อ่าน README.md แล้วสรุปสั้นๆ ว่า workspace นี้ใช้ทดสอบอะไร ห้ามแก้ไฟล์",
            timeoutMs: qualityMode ? 16 * 60_000 : 150_000,
            environment: {
                CLI_AGENT_PROFILE: qualityMode ? "deep" : "standard",
                CLI_AGENT_MAX_TURNS: qualityMode ? "12" : "4",
                CLI_AGENT_MAX_SEGMENTS: "1",
                CLI_AGENT_MAX_MINUTES: qualityMode ? "15" : "2",
                LLAMA_ACTION_MAX_TOKENS: process.env.LLAMA_ACTION_MAX_TOKENS || "512"
            }
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.output, /Reading file: README\.md/i);
        assert.match(result.output, /AI:/);
        assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), readme);
        console.log("Live llama.cpp agent E2E passed.");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
