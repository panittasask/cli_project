import assert = require("node:assert/strict");
import fs = require("node:fs");
import http = require("node:http");
import os = require("node:os");
import path = require("node:path");
const { runAgentCliHarness } = require("./agent-cli-harness") as {
    runAgentCliHarness: (options: Record<string, unknown>) => Promise<{ output: string; stderr: string; exitCode: number }>;
};

async function slotAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        const request = http.get("http://127.0.0.1:8080/slots", { timeout: 3_000 }, (response) => {
            let body = "";
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => {
                try {
                    const slots = JSON.parse(body) as Array<{ is_processing?: boolean }>;
                    resolve(Array.isArray(slots) && slots.some((slot) => slot.is_processing !== true));
                } catch { resolve(false); }
            });
        });
        request.on("timeout", () => { request.destroy(); resolve(false); });
        request.on("error", () => resolve(false));
    });
}

async function main(): Promise<void> {
    if (!(await slotAvailable())) {
        console.log("Live behavior replay skipped: llama.cpp is unavailable or busy.");
        return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-live-behavior-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "web", "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "web", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "web", "src", "widget.html"), [
        "<nav>",
        "  <button featureLink=\"details\">Details</button>",
        "</nav>"
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(workspace, "web", "src", "widget.ts"), [
        "import { Component } from '@framework/core';",
        "",
        "@Component({",
        "  selector: 'app-widget',",
        "  templateUrl: './widget.html'",
        "})",
        "export class Widget {}"
    ].join("\n"), "utf8");
    const verifier = [
        "const fs = require('node:fs');",
        "const source = fs.readFileSync('src/widget.ts', 'utf8');",
        "if (!/FeatureLink/.test(source) || !/imports\\s*:/.test(source)) {",
        "  console.error('FeatureLink must be imported and registered in the owning component imports.');",
        "  process.exit(1);",
        "}"
    ].join("\n");
    fs.writeFileSync(path.join(workspace, "web", "scripts", "verify-build.js"), verifier, "utf8");
    fs.writeFileSync(path.join(workspace, "web", "scripts", "verify-interaction.js"), verifier, "utf8");
    fs.writeFileSync(path.join(workspace, "web", "package.json"), JSON.stringify({
        name: "behavior-replay",
        scripts: {
            build: "node scripts/verify-build.js",
            "test:e2e": "node scripts/verify-interaction.js"
        }
    }, null, 2), "utf8");

    try {
        const result = await runAgentCliHarness({
            appRoot: root,
            workspace,
            apiUrl: "http://127.0.0.1:8080/v1/chat/completions",
            prompt: "แก้ปัญหาที่กด Details แล้วหน้าไม่เปลี่ยน ตรวจ implementation ที่เกี่ยวข้อง แก้ให้เสร็จ และรัน interaction test ยืนยันผล",
            timeoutMs: 300_000,
            environment: {
                CLI_AGENT_MAX_TURNS: "30",
                CLI_AGENT_MAX_SEGMENTS: "1",
                CLI_AGENT_MAX_MINUTES: "4",
                LLAMA_ACTION_MAX_TOKENS: "1024"
            }
        });
        assert.equal(result.exitCode, 0, result.stderr);
        const source = fs.readFileSync(path.join(workspace, "web", "src", "widget.ts"), "utf8");
        assert.match(source, /FeatureLink/);
        assert.match(source, /imports\s*:/);
        assert.doesNotMatch(result.output, /stopped early after detecting repeated work/i);
        console.log("Live behavior replay passed.");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
