import assert = require("node:assert/strict");
import axios = require("axios");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
const { runAgentCliHarness } = require("./agent-cli-harness") as {
    runAgentCliHarness: (options: Record<string, unknown>) => Promise<{ output: string; stderr: string; exitCode: number }>;
};

async function serverAvailable(apiUrl: string): Promise<boolean> {
    try {
        await axios.get(new URL("/health", apiUrl).toString(), { timeout: 2_000 });
        const response = await axios.get(new URL("/slots", apiUrl).toString(), { timeout: 2_000 });
        const slots = Array.isArray(response.data) ? response.data : [];
        return slots.length > 0 && slots.some((slot: { is_processing?: unknown }) => slot.is_processing !== true);
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const apiUrl = process.env.LLAMA_API_URL?.trim() || "http://127.0.0.1:8080/v1/chat/completions";
    const qualityMode = process.env.LOCAL_EVAL_MODE?.trim().toLowerCase() === "quality";
    if (!(await serverAvailable(apiUrl))) {
        console.log("Live invoice repair skipped: llama.cpp is unavailable or busy.");
        return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-live-invoice-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "invoice.js"), [
        "function calculateInvoiceTotal(items, discountPercent, taxPercent) {",
        "  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);",
        "  const discountedSubtotal = subtotal - discountPercent;",
        "  return discountedSubtotal * (1 + taxPercent);",
        "}",
        "",
        "module.exports = { calculateInvoiceTotal };"
    ].join("\n"), "utf8");
    const verifierSource = [
        "const assert = require('node:assert/strict');",
        "const { calculateInvoiceTotal } = require('../src/invoice');",
        "const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `expected ${expected}, received ${actual}`);",
        "closeTo(calculateInvoiceTotal([{ unitPrice: 100, quantity: 2 }, { unitPrice: 50, quantity: 3 }], 10, 7), 337.05);",
        "closeTo(calculateInvoiceTotal([{ unitPrice: 20, quantity: 2 }], 25, 10), 33);",
        "closeTo(calculateInvoiceTotal([{ unitPrice: 50, quantity: 1 }], 0, 0), 50);",
        "console.log('invoice verification passed');"
    ].join("\n");
    fs.writeFileSync(path.join(workspace, "scripts", "verify.js"), verifierSource, "utf8");
    fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
        name: "invoice-repair",
        private: true,
        scripts: { test: "node scripts/verify.js" }
    }, null, 2), "utf8");

    try {
        const result = await runAgentCliHarness({
            appRoot: root,
            workspace,
            apiUrl,
            prompt: "ยอด invoice คำนวณผิด ช่วยตรวจ source และ test ที่เกี่ยวข้อง แก้ให้ถูกต้อง แล้วรัน test เพื่อยืนยันผล",
            timeoutMs: qualityMode ? 16 * 60_000 : 300_000,
            environment: {
                CLI_AGENT_PROFILE: qualityMode ? "deep" : "standard",
                CLI_AGENT_MAX_TURNS: qualityMode ? "12" : "8",
                CLI_AGENT_MAX_SEGMENTS: "1",
                CLI_AGENT_MAX_MINUTES: qualityMode ? "15" : "4",
                LLAMA_ACTION_MAX_TOKENS: process.env.LLAMA_ACTION_MAX_TOKENS || "512"
            }
        });
        assert.equal(result.exitCode, 0, result.stderr);
        const verifier = path.join(workspace, "scripts", "verify.js");
        assert.equal(fs.readFileSync(verifier, "utf8"), verifierSource, "The deterministic verifier must not be modified.");
        const verification = require("node:child_process").spawnSync(process.execPath, [verifier], { cwd: workspace, encoding: "utf8" });
        assert.equal(verification.status, 0, `${verification.stdout}\n${verification.stderr}`);
        assert.match(result.output, /AI:/);
        console.log("Live invoice repair passed.");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
