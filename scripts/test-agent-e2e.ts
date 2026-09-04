import assert = require("node:assert/strict");
import fs = require("node:fs");
import http = require("node:http");
import os = require("node:os");
import path = require("node:path");
const { runAgentCliHarness } = require("./agent-cli-harness") as {
    runAgentCliHarness: (options: Record<string, unknown>) => Promise<{ output: string; stderr: string; exitCode: number }>;
};

async function mockModel(actions: Array<Record<string, unknown>>): Promise<{ url: string; requestedMaxTokens: number[]; close: () => Promise<void> }> {
    let actionIndex = 0;
    const requestedMaxTokens: number[] = [];
    const server = http.createServer((request, response) => {
        if (request.method === "GET" && request.url === "/v1/models") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ id: "mock-agent-model" }] }));
            return;
        }
        if (request.method === "GET" && request.url === "/props") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 }, total_slots: 1 }));
            return;
        }
        if (request.method === "POST" && request.url === "/v1/chat/completions") {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk) => { body += chunk; });
            request.on("end", () => {
                const payload = JSON.parse(body) as { max_tokens?: number };
                requestedMaxTokens.push(Number(payload.max_tokens ?? 0));
                const scripted = actions[actionIndex++];
                const explicit = scripted?.__modelResponse as {
                    content?: string;
                    reasoning_content?: string;
                    finish_reason?: string;
                    completion_tokens?: number;
                } | undefined;
                const content = explicit
                    ? explicit.content ?? ""
                    : JSON.stringify(scripted ?? { action: "final", answer: "Unexpected extra turn" });
                const completionTokens = explicit?.completion_tokens ?? 20;
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({
                    choices: [{
                        message: {
                            content,
                            ...(explicit?.reasoning_content ? { reasoning_content: explicit.reasoning_content } : {})
                        },
                        finish_reason: explicit?.finish_reason ?? "stop"
                    }],
                    usage: { prompt_tokens: 50, completion_tokens: completionTokens, total_tokens: 50 + completionTokens }
                }));
            });
            return;
        }
        response.statusCode = 404;
        response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port.");
    return {
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        requestedMaxTokens,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}

async function runScenario(
    actions: Array<Record<string, unknown>>,
    prompt: string,
    setup: (root: string) => void,
    answers: string[] = [],
    task?: Record<string, unknown>,
    environment: Record<string, string> = {}
): Promise<{ root: string; output: string; requestedMaxTokens: number[] }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agent-e2e-"));
    setup(root);
    const mutatesWorkspace = actions.some((action) => ["write_file", "edit_file", "delete_file"].includes(String(action.action)));
    const interaction = actions.some((action) => (
        action.action === "run_command" && /\b(?:test:e2e|e2e:test|playwright|cypress)\b/i.test(String(action.command))
    ));
    const firstTask = task ?? {
        intent: "Complete the requested workspace task",
        task_type: mutatesWorkspace ? "coding" : "general",
        continuation: false,
        requires_workspace_changes: mutatesWorkspace,
        verification: interaction ? "interaction" : "none",
        evidence_requirements: [interaction ? "interaction" : "source"],
        success_criteria: ["The requested observable result is complete"]
    };
    let taskAttached = false;
    const scriptedActions = actions.map((action) => {
        if (action.__modelResponse || taskAttached) return action;
        if (action.task) {
            taskAttached = true;
            return action;
        }
        taskAttached = true;
        return { ...action, task: firstTask };
    });
    const mock = await mockModel(scriptedActions);
    try {
        const result = await runAgentCliHarness({
            appRoot: root,
            workspace: root,
            apiUrl: mock.url,
            prompt,
            clarificationAnswers: answers,
            timeoutMs: 15_000,
            environment
        });
        assert.equal(result.exitCode, 0, result.stderr);
        return { root, output: result.output, requestedMaxTokens: mock.requestedMaxTokens };
    } finally {
        await mock.close();
    }
}

function readResponseRecords(root: string): Array<Record<string, any>> {
    const responseLogDirectory = path.join(root, ".cli", "logs", "agent");
    if (!fs.existsSync(responseLogDirectory)) return [];
    return fs.readdirSync(responseLogDirectory)
        .filter((name) => name.startsWith("agent-model-responses") && name.endsWith(".jsonl"))
        .flatMap((name) => fs.readFileSync(path.join(responseLogDirectory, name), "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, any>));
}

async function main(): Promise<void> {
    const startupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agent-workspace-switch-"));
    const restoredWorkspace = path.join(startupRoot, "restored-workspace");
    fs.mkdirSync(restoredWorkspace, { recursive: true });
    const workspaceSwitchModel = await mockModel([
        {
            action: "write_file",
            path: "result.txt",
            content: "written in restored workspace\n",
            reason: "Write the requested result in the restored session workspace.",
            task: {
                intent: "Write a result in the active restored workspace",
                task_type: "coding",
                continuation: false,
                requires_workspace_changes: true,
                verification: "none",
                evidence_requirements: ["source"],
                success_criteria: ["result.txt exists in the restored workspace"]
            }
        },
        {
            action: "final",
            answer: "The result was written in the restored workspace.",
            reason: "The write and read-back validation succeeded."
        }
    ]);
    try {
        const switched = await runAgentCliHarness({
            appRoot: startupRoot,
            workspace: restoredWorkspace,
            apiUrl: workspaceSwitchModel.url,
            prompt: "สร้าง result.txt ใน workspace ปัจจุบัน",
            passWorkspaceArgument: false,
            timeoutMs: 15_000
        });
        assert.equal(switched.exitCode, 0, switched.stderr);
        assert.equal(
            fs.readFileSync(path.join(restoredWorkspace, "result.txt"), "utf8"),
            "written in restored workspace\n"
        );
        assert.equal(fs.existsSync(path.join(startupRoot, "result.txt")), false);
        assert.match(switched.output, /AI:\s+The result was written in the restored workspace/);
        const writeExecution = readResponseRecords(startupRoot).find((record) => (
            record.kind === "action_execution" && record.parsedAction === "write_file"
        ));
        assert.equal(writeExecution?.toolExecutionStatus, "ok");
    } finally {
        await workspaceSwitchModel.close();
        fs.rmSync(startupRoot, { recursive: true, force: true });
    }

    const reasoningOnlyRecovery = await runScenario([
        {
            __modelResponse: {
                content: "",
                reasoning_content: "I should inspect the requested evidence before returning one action.",
                finish_reason: "length",
                completion_tokens: 4096
            }
        },
        { action: "read_file", path: "README.md", reason: "Inspect the requested evidence." },
        { action: "final", answer: "Recovered after reasoning-only truncation.", reason: "The requested evidence was inspected." }
    ], "อ่าน README.md แล้วสรุป", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "Recovery evidence.\n", "utf8");
    });
    try {
        assert.match(reasoningOnlyRecovery.output, /Regenerating clean action \(attempt 1\/1\) after truncated/);
        assert.match(reasoningOnlyRecovery.output, /AI:\s+Recovered after reasoning-only truncation/);
        assert.deepEqual(reasoningOnlyRecovery.requestedMaxTokens, [4096, 4096, 4096]);
        assert.deepEqual(reasoningOnlyRecovery.requestedMaxTokens, [4096, 4096, 4096]);
    } finally {
        fs.rmSync(reasoningOnlyRecovery.root, { recursive: true, force: true });
    }

    const repeatedReasoningOnly = await runScenario(Array.from({ length: 3 }, () => ({
        __modelResponse: {
            content: "",
            reasoning_content: "The model continued reasoning without producing its action object.",
            finish_reason: "length",
            completion_tokens: 4096
        }
    })), "ตรวจ workspace แล้วตอบผล", () => undefined, [], undefined, { CLI_AGENT_MAX_COMPLETION_TOKENS: "20000" });
    try {
        assert.match(repeatedReasoningOnly.output, /repeatedly returned invalid tool\/action output/);
        assert.deepEqual(repeatedReasoningOnly.requestedMaxTokens, [4096, 4096]);
    } finally {
        fs.rmSync(repeatedReasoningOnly.root, { recursive: true, force: true });
    }

    const repeatedProtocolFailure = await runScenario(Array.from({ length: 8 }, () => ({
        __modelResponse: {
            content: JSON.stringify({ action: "list_files", path: ".", reason: "Inspect the workspace." }),
            finish_reason: "stop"
        }
    })), "ตรวจ workspace แล้วทำงานต่อ", () => undefined);
    try {
        assert.match(repeatedProtocolFailure.output, /repeatedly returned invalid tool\/action output/);
        assert.equal(repeatedProtocolFailure.requestedMaxTokens.length, 2);
        assert.doesNotMatch(repeatedProtocolFailure.output, /Unexpected extra turn/);
    } finally {
        fs.rmSync(repeatedProtocolFailure.root, { recursive: true, force: true });
    }

    const invalidEditNeverExecutes = await runScenario([
        {
            __modelResponse: {
                content: JSON.stringify({ action: "edit_file", path: "", old_text: "", new_text: "corrupted" }),
                finish_reason: "stop"
            }
        },
        {
            __modelResponse: {
                content: JSON.stringify({ action: "edit_file", path: "", old_text: "", new_text: "corrupted" }),
                finish_reason: "stop"
            }
        },
        {
            __modelResponse: {
                content: JSON.stringify({ action: "edit_file", path: "", old_text: "", new_text: "corrupted" }),
                finish_reason: "stop"
            }
        }
    ], "แก้ไฟล์ตามโครงสร้างเดิม", (root) => {
        fs.writeFileSync(path.join(root, "status.txt"), "original\n", "utf8");
    });
    try {
        assert.match(invalidEditNeverExecutes.output, /repeatedly returned invalid tool\/action output/);
        assert.equal(fs.readFileSync(path.join(invalidEditNeverExecutes.root, "status.txt"), "utf8"), "original\n");
        assert.deepEqual(invalidEditNeverExecutes.requestedMaxTokens, [4096, 4096]);
        assert.equal(readResponseRecords(invalidEditNeverExecutes.root)
            .filter((record) => record.kind === "action_execution" && record.parsedAction === "edit_file").length, 0);
    } finally {
        fs.rmSync(invalidEditNeverExecutes.root, { recursive: true, force: true });
    }

    const validFastPath = await runScenario([
        { action: "final", answer: "Fast path completed.", reason: "The requested result is already complete." }
    ], "ตอบผลลัพธ์ที่พร้อมใช้งานแล้ว", () => undefined);
    try {
        assert.equal(validFastPath.requestedMaxTokens.length, 1);
        assert.doesNotMatch(validFastPath.output, /Regenerating clean action/);
        assert.match(validFastPath.output, /AI:\s+Fast path completed/);
    } finally {
        fs.rmSync(validFastPath.root, { recursive: true, force: true });
    }

    const cleanRegeneration = await runScenario([
        {
            __modelResponse: {
                content: JSON.stringify({ action: "read_file", reason: "Inspect the requested file." }),
                finish_reason: "stop"
            }
        },
        { action: "read_file", path: "README.md", reason: "Inspect the requested file with a complete action." },
        { action: "final", answer: "Recovered with one clean protocol regeneration.", reason: "The requested file was inspected." }
    ], "อ่าน README.md แล้วสรุป", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "Reliable regeneration fixture.\n", "utf8");
    });
    try {
        assert.match(cleanRegeneration.output, /Protocol regeneration produced a valid action/);
        assert.match(cleanRegeneration.output, /AI:\s+Recovered with one clean protocol regeneration/);
        assert.deepEqual(cleanRegeneration.requestedMaxTokens, [4096, 4096, 4096]);
    } finally {
        fs.rmSync(cleanRegeneration.root, { recursive: true, force: true });
    }

    const finalSummaryRegeneration = await runScenario([
        { action: "read_file", path: "README.md", reason: "Inspect the requested file before summarizing." },
        {
            __modelResponse: {
                content: '{"action":"final","answer":',
                finish_reason: "stop"
            }
        },
        { action: "final", answer: "Recovered the final summary after the malformed response.", reason: "The file inspection completed successfully." }
    ], "อ่าน README.md แล้วสรุป", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "Final summary regeneration fixture.\n", "utf8");
    }, [], undefined, { CLI_AGENT_MAX_TURNS: "1" });
    try {
        assert.match(finalSummaryRegeneration.output, /Regenerating clean final summary \(attempt 1\/1\)/);
        assert.match(finalSummaryRegeneration.output, /Final-summary regeneration produced a valid final action/);
        assert.match(finalSummaryRegeneration.output, /AI:\s+Recovered the final summary after the malformed response/);
        const finalRecords = readResponseRecords(finalSummaryRegeneration.root);
        assert.equal(finalRecords.filter((record) => record.kind === "final_summary_protocol_regeneration").length, 1);
        assert.equal(finalRecords.filter((record) => record.kind === "action_execution" && record.parsedAction !== "read_file").length, 0);
    } finally {
        fs.rmSync(finalSummaryRegeneration.root, { recursive: true, force: true });
    }

    const disallowedRegeneration = await runScenario([
        {
            action: "read_file",
            path: "README.md",
            reason: "Inspect the requested file.",
            task: {
                intent: "Inspect a file without changing the workspace",
                task_type: "general",
                continuation: false,
                requires_workspace_changes: false,
                verification: "none",
                evidence_requirements: ["source"],
                success_criteria: ["The requested file is inspected"]
            }
        },
        {
            __modelResponse: {
                content: JSON.stringify({ action: "read_file" }),
                finish_reason: "stop"
            }
        },
        {
            __modelResponse: {
                content: JSON.stringify({ action: "delete_file", path: "README.md" }),
                finish_reason: "stop"
            }
        }
    ], "อ่าน README.md โดยห้ามแก้ไฟล์", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "Keep this file.\n", "utf8");
    });
    try {
        assert.match(disallowedRegeneration.output, /repeatedly returned invalid tool\/action output/);
        assert.equal(fs.readFileSync(path.join(disallowedRegeneration.root, "README.md"), "utf8"), "Keep this file.\n");
        const disallowedRecords = readResponseRecords(disallowedRegeneration.root);
        const regenerationRecord = disallowedRecords.find((record) => record.kind === "protocol_regeneration");
        assert.equal(regenerationRecord?.admission?.kind, "semantic_invalid");
        assert.ok(Array.isArray(regenerationRecord?.allowedActions));
        assert.equal(regenerationRecord?.allowedActions?.includes("delete_file"), false);
        assert.equal(disallowedRecords.filter((record) => record.kind === "action_execution" && record.parsedAction === "delete_file").length, 0);
    } finally {
        fs.rmSync(disallowedRegeneration.root, { recursive: true, force: true });
    }

    const incidentRegression = await runScenario([
        { action: "list_files", path: ".", reason: "Inspect the workspace." },
        { action: "read_file", path: "main.go", reason: "Inspect the target source." },
        { action: "run_command", command: "node -e \"process.exit(0)\"", reason: "Run the build-equivalent check." },
        { action: "run_command", command: "node -e \"console.error('RUNTIME_FAILURE');process.exit(1)\"", reason: "Run the runtime-equivalent check." },
        {
            __modelResponse: {
                content: "{\"action\":\"edit_file\",\"path\":\"main.go\",\"new_text\":\"fixed\\n\",}",
                finish_reason: "stop"
            }
        },
        { action: "edit_file", path: "main.go", old_text: "broken\n", new_text: "fixed\n", reason: "Apply one complete regenerated edit." },
        { action: "final", answer: "The malformed edit was rejected and one regenerated edit completed.", reason: "The admitted edit changed the target once." }
    ], "ตรวจโครงสร้าง รันเช็ก แล้วแก้ main.go", (root) => {
        fs.writeFileSync(path.join(root, "main.go"), "broken\n", "utf8");
    });
    try {
        assert.equal(fs.readFileSync(path.join(incidentRegression.root, "main.go"), "utf8"), "fixed\n");
        assert.match(incidentRegression.output, /Protocol regeneration produced a valid action/);
        assert.doesNotMatch(incidentRegression.output, /Missing file path/);
        const responseRecords = readResponseRecords(incidentRegression.root);
        assert.ok(responseRecords.some((record) => record.admission?.localRepairUsed === true && record.admission?.schemaValid === false));
        assert.equal(responseRecords.filter((record) => record.kind === "protocol_regeneration").length, 1);
        assert.equal(responseRecords.filter((record) => record.kind === "action_execution" && record.parsedAction === "edit_file").length, 1);
        assert.ok(responseRecords.some((record) => record.parseError && /schema_invalid/.test(String(record.parseError))));
    } finally {
        fs.rmSync(incidentRegression.root, { recursive: true, force: true });
    }

    const repeatedFailedCommand = await runScenario([
        {
            action: "run_command",
            command: "node -e \"console.error('ORIGINAL_FAILURE_E2E_7');process.exit(7)\"",
            reason: "Run the first diagnostic command."
        },
        {
            action: "run_command",
            command: "node -e \"console.error('ORIGINAL_FAILURE_E2E_7');process.exit(7)\"",
            reason: "Retry the unchanged failed command."
        },
        {
            action: "run_command",
            command: "node -e \"process.exit(0)\"",
            reason: "Use a corrected command."
        },
        {
            action: "final",
            answer: "Recovered with a corrected command.",
            reason: "The corrected command succeeded."
        }
    ], "ตรวจด้วย command แล้วแก้คำสั่งถ้ารันไม่ผ่าน", () => undefined, [], {
        intent: "Run the requested command verification and correct a failed command",
        task_type: "coding",
        continuation: false,
        requires_workspace_changes: false,
        verification: "command",
        evidence_requirements: ["command"],
        success_criteria: ["A corrected command completes successfully"]
    });
    try {
        if (!/Blocked repeated failed command: this exact command already failed/.test(repeatedFailedCommand.output)) {
            throw new Error(`Repeated-command scenario tail:\n${repeatedFailedCommand.output.slice(-8000)}`);
        }
        assert.match(repeatedFailedCommand.output, /Original failure from the first attempt:/);
        assert.match(repeatedFailedCommand.output, /ORIGINAL_FAILURE_E2E_7/);
        assert.ok(/AI:\s+Recovered with a corrected command|Agent stopped safely because the selected model repeatedly returned invalid tool\/action output/.test(repeatedFailedCommand.output));
    } finally {
        fs.rmSync(repeatedFailedCommand.root, { recursive: true, force: true });
    }

    const alternatingFailedCommandLoop = await runScenario([
        { action: "read_file", path: "README.md", reason: "Inspect the workspace before verification." },
        {
            action: "run_command",
            command: "node -e \"process.exit(7)\"",
            reason: "Run the initial verification."
        },
        {
            action: "refine_task",
            task: {
                intent: "Verify the existing workspace",
                task_type: "general",
                continuation: false,
                requires_workspace_changes: false,
                verification: "command",
                evidence_requirements: ["source", "command"],
                success_criteria: ["The declared verification succeeds"]
            },
            evidence: ["evidence_1_read_file"],
            reason: "Retry the unchanged task contract after the command failure."
        },
        {
            action: "run_command",
            command: "node -e \"process.exit(7)\"",
            reason: "Retry the unchanged failed command."
        },
        {
            action: "refine_task",
            task: {
                intent: "Verify the existing workspace",
                task_type: "general",
                continuation: false,
                requires_workspace_changes: false,
                verification: "command",
                evidence_requirements: ["command", "source"],
                success_criteria: ["The declared verification succeeds"]
            },
            evidence: ["evidence_1_read_file"],
            reason: "Alternate back to the equivalent task contract."
        },
        {
            action: "run_command",
            command: "node -e \"process.exit(7)\"",
            reason: "Retry the unchanged failed command again."
        }
    ], "ตรวจ workspace ด้วยคำสั่งที่กำหนด", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "Verification fixture.\n", "utf8");
    }, [], {
        intent: "Verify the existing workspace",
        task_type: "general",
        continuation: false,
        requires_workspace_changes: false,
        verification: "command",
        evidence_requirements: ["source", "command"],
        success_criteria: ["The declared verification succeeds"]
    });
    try {
        assert.match(alternatingFailedCommandLoop.output, /equivalent to the current contract and makes no refinement/);
        assert.match(alternatingFailedCommandLoop.output, /AI:\s+Status: incomplete/);
        assert.match(alternatingFailedCommandLoop.output, /repeatedly retried an exact command/i);
        assert.doesNotMatch(alternatingFailedCommandLoop.output, /Unexpected extra turn/);
    } finally {
        fs.rmSync(alternatingFailedCommandLoop.root, { recursive: true, force: true });
    }

    const retryAfterWorkspaceChange = await runScenario([
        { action: "read_file", path: "status.txt", reason: "Inspect the failing state." },
        {
            action: "run_command",
            command: "node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('status.txt','utf8')==='fixed'?0:1)\"",
            reason: "Verify the current state."
        },
        {
            action: "edit_file",
            path: "status.txt",
            old_text: "broken",
            new_text: "fixed",
            reason: "Correct the workspace state."
        },
        {
            action: "run_command",
            command: "node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('status.txt','utf8')==='fixed'?0:1)\"",
            reason: "Retry the same verification after the source correction."
        },
        {
            action: "final",
            answer: "The workspace correction passed the original verification.",
            reason: "The corrected workspace now passes."
        }
    ], "แก้ status แล้วตรวจด้วยคำสั่งเดิมอีกครั้ง", (root) => {
        fs.writeFileSync(path.join(root, "status.txt"), "broken", "utf8");
    });
    try {
        assert.equal(fs.readFileSync(path.join(retryAfterWorkspaceChange.root, "status.txt"), "utf8"), "fixed");
        assert.doesNotMatch(retryAfterWorkspaceChange.output, /Blocked repeated failed command/);
        assert.match(retryAfterWorkspaceChange.output, /AI:\s+The workspace correction passed the original verification/);
    } finally {
        fs.rmSync(retryAfterWorkspaceChange.root, { recursive: true, force: true });
    }

    const repeatedFinalRecovery = await runScenario([
        { action: "final", answer: "Not verified yet.", reason: "Attempt completion before verification." },
        { action: "run_command", command: "npm test", reason: "Run the required finite verification after the completion was blocked." },
        { action: "final", answer: "Verification now passes.", reason: "The required command succeeded." }
    ], "รัน test ให้ผ่านก่อนสรุปผล", (root) => {
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
            name: "final-recovery",
            scripts: { test: "node -e \"process.exit(0)\"" }
        }), "utf8");
    }, [], {
        intent: "Verify the existing workspace",
        task_type: "general",
        continuation: false,
        requires_workspace_changes: false,
        verification: "command",
        evidence_requirements: ["command"],
        success_criteria: ["The declared test command succeeds"]
    });
    try {
        assert.doesNotMatch(repeatedFinalRecovery.output, /final_loop_stop|Agent stopped after the same completion blocker/);
        assert.match(repeatedFinalRecovery.output, /AI:\s+Verification now passes/);
    } finally {
        fs.rmSync(repeatedFinalRecovery.root, { recursive: true, force: true });
    }

    const verificationImpasse = await runScenario([
        { action: "read_file", path: "ui-state.txt", reason: "Inspect the current implementation state." },
        {
            action: "edit_file",
            path: "ui-state.txt",
            old_text: "state=old",
            new_text: "state=updated",
            reason: "Apply the requested implementation change."
        },
        {
            action: "run_command",
            command: "node -e \"process.exit(3)\"",
            mode: "probe",
            timeout_ms: 5000,
            reason: "Attempt the available runtime verification."
        },
        {
            action: "final",
            answer: "The implementation is complete.",
            completion_status: "completed",
            reason: "Attempt to report completion despite the unresolved verifier."
        },
        { action: "list_files", reason: "Inspect the preserved workspace after the blocker." },
        {
            action: "final",
            answer: "The implementation is complete.",
            completion_status: "completed",
            reason: "Repeat the unsupported completion claim."
        }
    ], "แก้ implementation แล้วตรวจ interaction ให้ยืนยันได้", (root) => {
        fs.writeFileSync(path.join(root, "ui-state.txt"), "state=old", "utf8");
    }, [], {
        intent: "Change an implementation and verify its observable interaction",
        task_type: "coding",
        continuation: false,
        requires_workspace_changes: true,
        verification: "interaction",
        evidence_requirements: ["source", "interaction"],
        success_criteria: ["The observable interaction is verified"]
    });
    try {
        assert.equal(fs.readFileSync(path.join(verificationImpasse.root, "ui-state.txt"), "utf8"), "state=updated");
        assert.match(verificationImpasse.output, /completion_status.*incomplete/);
        assert.match(verificationImpasse.output, /AI:\s+Status: incomplete/);
        assert.match(verificationImpasse.output, /stopped recovery instead of continuing an unproductive verification loop/i);
        assert.doesNotMatch(verificationImpasse.output, /Unexpected extra turn/);
    } finally {
        fs.rmSync(verificationImpasse.root, { recursive: true, force: true });
    }

    const sourceOnlyContractMismatch = await runScenario([
        { action: "read_file", path: "README.md", reason: "Inspect the requested source evidence." },
        {
            action: "final",
            answer: "The source inspection is complete.",
            evidence: ["evidence_1_read_file"],
            reason: "The explicit source evidence requirement is satisfied."
        }
    ], "ตรวจข้อมูลใน README แล้วสรุป", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "Source-only evidence.\n", "utf8");
    }, [], {
        intent: "Inspect the documented workspace state",
        task_type: "general",
        continuation: false,
        requires_workspace_changes: false,
        verification: "runtime",
        evidence_requirements: ["source"],
        success_criteria: ["The answer is grounded in inspected source"]
    });
    try {
        assert.doesNotMatch(sourceOnlyContractMismatch.output, /required runtime verification has not succeeded/);
        assert.match(sourceOnlyContractMismatch.output, /AI:\s+The source inspection is complete/);
    } finally {
        fs.rmSync(sourceOnlyContractMismatch.root, { recursive: true, force: true });
    }

    const mutation = await runScenario([
        { action: "list_files", path: ".", reason: "Inspect the workspace first." },
        { action: "write_file", path: "hello.txt", content: "hello e2e\n", reason: "Create the requested file." },
        { action: "final", answer: "สร้าง hello.txt เรียบร้อยแล้ว", reason: "The requested file was created." }
    ], "สร้างไฟล์ hello.txt ที่มีข้อความ hello e2e", () => undefined);
    try {
        assert.equal(fs.readFileSync(path.join(mutation.root, "hello.txt"), "utf8"), "hello e2e\n");
        assert.doesNotMatch(mutation.output, /AI needs clarification/);
        assert.match(mutation.output, /AI:\s+สร้าง hello\.txt เรียบร้อยแล้ว/);
    } finally {
        fs.rmSync(mutation.root, { recursive: true, force: true });
    }

    const alreadySatisfied = await runScenario([
        { action: "read_file", path: "status.txt", reason: "Inspect the requested target." },
        { action: "edit_file", path: "status.txt", old_text: "status=old", new_text: "status=ready", reason: "Apply the requested state if needed." },
        { action: "final", answer: "status.txt อยู่ในสถานะ ready อยู่แล้ว จึงไม่ต้องเขียนซ้ำ", reason: "The requested state is already verified." }
    ], "ตั้ง status.txt ให้เป็น status=ready", (root) => {
        fs.writeFileSync(path.join(root, "status.txt"), "status=ready", "utf8");
    });
    try {
        assert.equal(fs.readFileSync(path.join(alreadySatisfied.root, "status.txt"), "utf8"), "status=ready");
        assert.match(alreadySatisfied.output, /AI:\s+status\.txt อยู่ในสถานะ ready อยู่แล้ว/);
        assert.equal(fs.existsSync(path.join(alreadySatisfied.root, ".cli", "checkpoints.json")), false);
    } finally {
        fs.rmSync(alreadySatisfied.root, { recursive: true, force: true });
    }

    const clarification = await runScenario([
        { action: "read_file", path: "README.md", reason: "Inspect general documentation." },
        {
            action: "ask_user",
            decision: "compatibility",
            question: "เลือกค่า packageMode แบบใด?",
            options: [
                { id: "stable", label: "Stable", description: "Use stable compatibility." },
                { id: "experimental", label: "Experimental", description: "Use experimental compatibility." }
            ],
            reason: "The compatibility mode changes package behavior."
        },
        { action: "read_file", path: "package.json", reason: "Inspect the relevant package configuration." },
        {
            action: "ask_user",
            decision: "compatibility",
            question: "เลือกค่า packageMode แบบใด?",
            options: [
                { id: "stable", label: "Stable", description: "Use stable compatibility." },
                { id: "experimental", label: "Experimental", description: "Use experimental compatibility." }
            ],
            reason: "The package manifest does not define the required mode."
        },
        { action: "edit_file", path: "package.json", old_text: "{\"name\":\"e2e\"}", new_text: "{\"name\":\"e2e\",\"packageMode\":\"stable\"}", reason: "Apply the selected mode." },
        { action: "final", answer: "ตั้งค่า packageMode เป็น stable แล้ว", reason: "The selected configuration was applied." }
    ], "แก้ไฟล์ package.json โดยตั้งค่า packageMode ให้เหมาะสม ถ้าต้องตัดสินใจเรื่อง compatibility ให้ถามก่อน", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "General notes only.\n", "utf8");
        fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"e2e\"}", "utf8");
    }, ["1"]);
    try {
        assert.match(clarification.output, /Clarification blocked: Inspect the workspace before asking/);
        assert.match(clarification.output, /AI needs clarification/);
        assert.match(fs.readFileSync(path.join(clarification.root, "package.json"), "utf8"), /"packageMode":"stable"/);
    } finally {
        fs.rmSync(clarification.root, { recursive: true, force: true });
    }

    const readOnly = await runScenario([
        { action: "read_file", path: "README.md", reason: "Read the requested evidence." },
        { action: "edit_file", path: "README.md", old_text: "Original evidence.\n", new_text: "Changed evidence.\n", reason: "Attempt an unauthorized improvement." },
        { action: "final", answer: "README ใช้เป็นหลักฐานสำหรับทดสอบ read-only", reason: "Answer from the inspected evidence." }
    ], "อ่าน README.md แล้วสรุป ห้ามแก้ไฟล์", (root) => {
        fs.writeFileSync(path.join(root, "README.md"), "Original evidence.\n", "utf8");
    }, [], {
        intent: "Summarize README without changing files",
        task_type: "coding",
        continuation: false,
        requires_workspace_changes: false,
        verification: "none",
        evidence_requirements: ["source"],
        success_criteria: ["The summary is grounded in README evidence"]
    });
    try {
        assert.match(readOnly.output, /Blocked by the model-owned read-only task contract|repeatedly returned invalid tool\/action output|AI:\s+README/);
        assert.equal(fs.readFileSync(path.join(readOnly.root, "README.md"), "utf8"), "Original evidence.\n");
    } finally {
        fs.rmSync(readOnly.root, { recursive: true, force: true });
    }

    const satisfiedContinuation = await runScenario([
        { action: "read_file", path: "src/index.ts", reason: "Inspect the implementation left by the previous task." },
        {
            action: "run_command",
            command: "npm start",
            mode: "probe",
            timeout_ms: 10000,
            expect: { exit_code: 0, output_includes: ["verification-ready"] },
            reason: "Exercise the self-contained runtime entrypoint."
        },
        {
            action: "final",
            answer: "The continued task is complete and the current project check passes.",
            completion_status: "completed",
            evidence: ["evidence_1_read_file", "evidence_2_run_command"],
            reason: "Current workspace and verification evidence prove no further edit is needed."
        }
    ], "Resume the unfinished implementation and finish its verification.", (root) => {
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ready = true;\n", "utf8");
        fs.writeFileSync(path.join(root, "verify.js"), "console.log('verification-ready');\n", "utf8");
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
            name: "continuation-fixture",
            scripts: { start: "node verify.js" }
        }), "utf8");
    }, [], {
        intent: "Continue and verify the unfinished implementation",
        task_type: "coding",
        continuation: true,
        requires_workspace_changes: true,
        verification: "runtime",
        evidence_requirements: ["source", "runtime"],
        success_criteria: ["The self-contained runtime entrypoint completes successfully"]
    });
    try {
        assert.match(satisfiedContinuation.output, /The continued task is complete/);
        assert.doesNotMatch(satisfiedContinuation.output, /requires a successful file write/);
        assert.equal(fs.readFileSync(path.join(satisfiedContinuation.root, "src", "index.ts"), "utf8"), "export const ready = true;\n");
    } finally {
        fs.rmSync(satisfiedContinuation.root, { recursive: true, force: true });
    }

    const verifierOnlyContinuationEvidence = await runScenario([
        { action: "read_file", path: "src/index.ts", reason: "Inspect the implementation left by the previous task." },
        {
            action: "run_command",
            command: "npm start",
            mode: "probe",
            timeout_ms: 10000,
            expect: { exit_code: 0, output_includes: ["verification-ready"] },
            reason: "Exercise the self-contained runtime entrypoint."
        },
        {
            action: "final",
            answer: "The existing implementation is complete and the runtime check passes.",
            completion_status: "completed",
            // The host already has the successful read evidence in context;
            // the final response only needs to cite successful evidence.
            evidence: ["evidence_2_run_command"],
            reason: "The current workspace and runtime verification prove no edit is needed."
        }
    ], "Resume the existing implementation and finish its verification.", (root) => {
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ready = true;\n", "utf8");
        fs.writeFileSync(path.join(root, "verify.js"), "console.log('verification-ready');\n", "utf8");
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
            name: "continuation-verifier-only-evidence",
            scripts: { start: "node verify.js" }
        }), "utf8");
    }, [], {
        intent: "Continue and verify the existing implementation",
        task_type: "coding",
        continuation: true,
        requires_workspace_changes: true,
        verification: "runtime",
        evidence_requirements: ["source", "runtime"],
        success_criteria: ["The self-contained runtime entrypoint completes successfully"]
    });
    try {
        assert.match(verifierOnlyContinuationEvidence.output, /The existing implementation is complete/);
        assert.doesNotMatch(verifierOnlyContinuationEvidence.output, /requires a successful file write/);
    } finally {
        fs.rmSync(verifierOnlyContinuationEvidence.root, { recursive: true, force: true });
    }

    const continuationBuildIsNotRuntime = await runScenario([
        { action: "read_file", path: "src/index.ts", reason: "Inspect the implementation left by the previous task." },
        { action: "run_command", command: "npm test", reason: "Run the manifest-defined typecheck." },
        {
            action: "final",
            answer: "The typecheck passed, so the continuation is complete.",
            completion_status: "already_satisfied",
            evidence: ["evidence_1_read_file", "evidence_2_run_command"],
            reason: "Attempt to finish from command evidence alone."
        },
        {
            action: "run_command",
            command: "npm start",
            mode: "probe",
            timeout_ms: 10000,
            expect: { exit_code: 0, output_includes: ["runtime-ready"] },
            reason: "Exercise the manifest-defined runtime lifecycle."
        },
        {
            action: "final",
            answer: "The continuation is complete after both source inspection and runtime verification.",
            completion_status: "already_satisfied",
            evidence: ["evidence_1_read_file", "evidence_4_run_command"],
            reason: "The existing implementation now has the required runtime evidence."
        }
    ], "Continue the unfinished runtime verification.", (root) => {
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ready = true;\n", "utf8");
        fs.writeFileSync(path.join(root, "verify.js"), "console.log('runtime-ready');\n", "utf8");
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
            name: "continuation-runtime-gate",
            scripts: {
                test: "node -e \"process.exit(0)\"",
                start: "node verify.js"
            }
        }), "utf8");
    }, [], {
        intent: "Continue the unfinished runtime verification",
        task_type: "coding",
        continuation: true,
        requires_workspace_changes: true,
        verification: "runtime",
        evidence_requirements: ["source", "runtime"],
        success_criteria: ["The manifest-defined runtime lifecycle completes successfully"]
    });
    try {
        assert.match(continuationBuildIsNotRuntime.output, /Final blocked: required runtime verification has not succeeded for this continuation/);
        assert.match(continuationBuildIsNotRuntime.output, /AI:\s+The continuation is complete after both source inspection and runtime verification/);
    } finally {
        fs.rmSync(continuationBuildIsNotRuntime.root, { recursive: true, force: true });
    }

    const scopedMutation = await runScenario([
        {
            action: "list_files",
            path: ".",
            reason: "Inspect discovered project roots.",
            task: {
                intent: "Create the requested source file in the correct project root",
                task_type: "coding",
                continuation: false,
                requires_workspace_changes: true,
                verification: "command",
                evidence_requirements: ["source", "command"],
                success_criteria: ["The source file is created in the owning project and its build succeeds"]
            }
        },
        { action: "edit_file", path: "src/app.ts", old_text: "missing", new_text: "export const value = 'wrong';\n", reason: "Attempt to change an unowned source path." },
        { action: "write_file", path: "web/src/app.ts", content: "export const value = 'correct';\n", reason: "Change source inside the discovered project." },
        { action: "run_command", command: "npm run build", workdir: "web", reason: "Verify the project that owns the changed file." },
        { action: "final", answer: "แก้ไฟล์ในโปรเจกต์ web และตรวจสอบแล้ว", reason: "The owning project check succeeded." }
    ], "สร้าง app.ts ใน source ของโปรเจกต์ที่มีอยู่ แล้วตรวจสอบโปรเจกต์นั้น", (root) => {
        fs.mkdirSync(path.join(root, "web", "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "web", "package.json"), JSON.stringify({
            name: "web",
            scripts: { build: "node -e \"process.exit(0)\"" }
        }), "utf8");
    });
    try {
        assert.match(scopedMutation.output, /Blocked unscoped project mutation/);
        assert.equal(fs.existsSync(path.join(scopedMutation.root, "src", "app.ts")), false);
        assert.equal(fs.readFileSync(path.join(scopedMutation.root, "web", "src", "app.ts"), "utf8"), "export const value = 'correct';\n");
    } finally {
        fs.rmSync(scopedMutation.root, { recursive: true, force: true });
    }

    const interactionEvidence = await runScenario([
        { action: "read_file", path: "web/src/widget.ts", reason: "Inspect the existing implementation." },
        { action: "edit_file", path: "web/src/widget.ts", old_text: "export const state = 'old';", new_text: "export const state = 'new';", reason: "Correct the observable behavior." },
        { action: "run_command", command: "npm run build", workdir: "web", reason: "Compile the changed project." },
        { action: "final", answer: "แก้แล้วและ build ผ่าน", reason: "Compilation succeeded." },
        { action: "run_command", command: "npm run test:e2e", workdir: "web", reason: "Exercise and assert the observable interaction." },
        { action: "final", answer: "แก้และยืนยัน interaction แล้ว", reason: "The interaction test succeeded." }
    ], "แก้ปัญหาที่กดปุ่มแล้วสถานะยังไม่เปลี่ยน และยืนยันผลให้ด้วย", (root) => {
        fs.mkdirSync(path.join(root, "web", "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "web", "src", "widget.ts"), "export const state = 'old';", "utf8");
        fs.writeFileSync(path.join(root, "web", "package.json"), JSON.stringify({
            name: "web",
            scripts: {
                build: "node -e \"process.exit(0)\"",
                "test:e2e": "node -e \"process.exit(0)\""
            }
        }), "utf8");
    });
    try {
        assert.match(interactionEvidence.output, /Final blocked: required runtime verification has not succeeded/);
        assert.match(interactionEvidence.output, /AI:\s+แก้และยืนยัน interaction แล้ว/);
    } finally {
        fs.rmSync(interactionEvidence.root, { recursive: true, force: true });
    }

    const refinedConsoleRuntime = await runScenario([
        { action: "read_file", path: "app.txt", reason: "Inspect the console program evidence." },
        {
            action: "refine_task",
            task: {
                intent: "Repair and verify a console network program",
                task_type: "coding",
                continuation: false,
                requires_workspace_changes: true,
                verification: "runtime",
                evidence_requirements: ["source", "runtime"],
                success_criteria: ["The finite runtime probe emits its success marker without an error marker"]
            },
            evidence: ["evidence_1_read_file"],
            reason: "The inspected workspace contains a console program and no rendered visual outcome."
        },
        { action: "edit_file", path: "app.txt", old_text: "status=broken", new_text: "status=fixed", reason: "Repair the console program state." },
        {
            action: "run_command",
            command: "node -e \"console.log('http://127.0.0.1 runtime-ready')\"",
            mode: "probe",
            timeout_ms: 5000,
            expect: {
                exit_code: 0,
                output_includes: ["runtime-ready"],
                output_excludes: ["runtime-failed"]
            },
            reason: "Run a bounded runtime probe with explicit output assertions."
        },
        { action: "final", answer: "แก้ console runtime และตรวจสอบแล้ว", reason: "The refined runtime contract is satisfied." }
    ], "แก้ console program ที่ runtime ล้มเหลวและตรวจสอบให้ด้วย", (root) => {
        fs.writeFileSync(path.join(root, "app.txt"), "status=broken", "utf8");
    }, [], {
        intent: "Repair runtime behavior and its rendered visual result",
        task_type: "coding",
        continuation: false,
        requires_workspace_changes: true,
        verification: "interaction",
        evidence_requirements: ["interaction", "visual"],
        success_criteria: ["The runtime behavior and visual output are correct"]
    });
    try {
        assert.equal(fs.readFileSync(path.join(refinedConsoleRuntime.root, "app.txt"), "utf8"), "status=fixed");
        assert.match(refinedConsoleRuntime.output, /Task contract refined: Repair and verify a console network program/);
        assert.doesNotMatch(refinedConsoleRuntime.output, /visual presentation work has no successful styling mutation/);
        assert.match(refinedConsoleRuntime.output, /AI:\s+แก้ console runtime และตรวจสอบแล้ว/);
    } finally {
        fs.rmSync(refinedConsoleRuntime.root, { recursive: true, force: true });
    }

    const behaviorReplay = await runScenario([
        { action: "read_file", path: "web/src/widget.html", reason: "Inspect the rendered interaction declaration." },
        { action: "run_command", command: "npm run build", workdir: "web", reason: "Establish the current project baseline." },
        { action: "edit_file", path: "web/src/widget.html", old_text: "<button featureLink=\"details\">Details</button>", new_text: "<button featureLink=\"/details\">Details</button>", reason: "Attempt a presentation-only repair." },
        { action: "read_file", path: "web/src/widget.ts", reason: "Inspect the owning implementation and its imports." },
        { action: "edit_file", path: "web/src/widget.ts", old_text: "import { Component } from '@framework/core';\nexport const imports: string[] = [];", new_text: "import { Component } from '@framework/core';\nexport const imports: string[] = ['FeatureLink'];", reason: "Register the behavior dependency in the owning implementation." },
        { action: "run_command", command: "npm run build", workdir: "web", reason: "Verify the project after the source change." },
        { action: "run_command", command: "npm run test:e2e", workdir: "web", reason: "Exercise the interaction and assert its outcome." },
        { action: "final", answer: "แก้ dependency ของ interaction และยืนยันผลแล้ว", reason: "Post-change build and interaction evidence succeeded." }
    ], "แก้ interaction ที่กด Details แล้วผลลัพธ์ยังไม่เปลี่ยน พร้อมยืนยันการทำงาน", (root) => {
        fs.mkdirSync(path.join(root, "web", "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "web", "src", "widget.html"), "<button featureLink=\"details\">Details</button>", "utf8");
        fs.writeFileSync(path.join(root, "web", "src", "widget.ts"), "import { Component } from '@framework/core';\nexport const imports: string[] = [];", "utf8");
        fs.writeFileSync(path.join(root, "web", "package.json"), JSON.stringify({
            name: "web",
            scripts: {
                build: "node -e \"process.exit(0)\"",
                "test:e2e": "node -e \"process.exit(0)\""
            }
        }), "utf8");
    });
    try {
        assert.doesNotMatch(behaviorReplay.output, /Repeated equivalent action 2 times.*npm run build/s);
        assert.match(fs.readFileSync(path.join(behaviorReplay.root, "web", "src", "widget.ts"), "utf8"), /FeatureLink/);
        assert.match(behaviorReplay.output, /AI:\s+แก้ dependency ของ interaction และยืนยันผลแล้ว/);
    } finally {
        fs.rmSync(behaviorReplay.root, { recursive: true, force: true });
    }

    const visualRouting = await runScenario([
        { action: "read_file", path: "web/src/table.ts", reason: "Inspect the navigation behavior." },
        { action: "edit_file", path: "web/src/table.ts", old_text: "export const route = '/';", new_text: "export const route = '/employees';", reason: "Correct the destination." },
        { action: "run_command", command: "npm run build", workdir: "web", reason: "Compile the route change." },
        { action: "final", answer: "Routing and table presentation are complete.", reason: "The build succeeded." },
        { action: "read_file", path: "web/src/table.scss", reason: "Inspect the table styling owner." },
        { action: "edit_file", path: "web/src/table.scss", old_text: ".table {}", new_text: ".table { display: grid; gap: 1rem; }", reason: "Implement the required table presentation." },
        { action: "run_command", command: "npm run build", workdir: "web", reason: "Compile the styling change." },
        { action: "run_command", command: "npm run test:e2e", workdir: "web", reason: "Exercise navigation and assert the rendered outcome." },
        { action: "final", answer: "Routing and table presentation were implemented and interaction-tested.", reason: "Both project and interaction checks succeeded." }
    ], "Correct the navigation outcome and the rendered table presentation.", (root) => {
        fs.mkdirSync(path.join(root, "web", "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "web", "src", "table.ts"), "export const route = '/';", "utf8");
        fs.writeFileSync(path.join(root, "web", "src", "table.scss"), ".table {}", "utf8");
        fs.writeFileSync(path.join(root, "web", "package.json"), JSON.stringify({
            name: "web",
            scripts: {
                build: "node -e \"process.exit(0)\"",
                "test:e2e": "node -e \"process.exit(0)\""
            }
        }), "utf8");
    }, [], {
        intent: "Correct navigation behavior and rendered table styling",
        task_type: "coding",
        continuation: false,
        requires_workspace_changes: true,
        verification: "command",
        evidence_requirements: ["command", "interaction", "visual"],
        success_criteria: ["Navigation reaches the requested destination", "The rendered table has an intentional layout"]
    });
    try {
        assert.match(visualRouting.output, /Final blocked: visual presentation work has no successful styling mutation/);
        assert.match(visualRouting.output, /AI:\s+Routing and table presentation were implemented and interaction-tested/);
        assert.match(fs.readFileSync(path.join(visualRouting.root, "web", "src", "table.scss"), "utf8"), /display: grid/);
    } finally {
        fs.rmSync(visualRouting.root, { recursive: true, force: true });
    }

    const repeatedWork = await runScenario([
        { action: "list_files", path: ".", reason: "Inspect once." },
        { action: "list_files", path: ".", reason: "Inspect again without new evidence." },
        { action: "list_files", path: ".", reason: "Repeat the same inspection." }
    ], "สร้างไฟล์ result.txt หลังตรวจ workspace", () => undefined);
    try {
        assert.equal(fs.existsSync(path.join(repeatedWork.root, "result.txt")), false);
    } finally {
        fs.rmSync(repeatedWork.root, { recursive: true, force: true });
    }
    console.log("Deterministic agent CLI E2E scenarios passed.");
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
