import assert = require("node:assert/strict");
import fs = require("node:fs");
import http = require("node:http");
import os = require("node:os");
import path = require("node:path");
const { runAgentCliHarness } = require("./agent-cli-harness") as {
    runAgentCliHarness: (options: Record<string, unknown>) => Promise<{ output: string; stderr: string; exitCode: number }>;
};

async function mockModel(actions: Array<Record<string, unknown>>): Promise<{ url: string; close: () => Promise<void> }> {
    let actionIndex = 0;
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
            request.resume();
            const action = actions[actionIndex++];
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({
                choices: [{ message: { content: JSON.stringify(action ?? { action: "final", answer: "Unexpected extra turn" }) }, finish_reason: "stop" }],
                usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
            }));
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
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}

async function runScenario(actions: Array<Record<string, unknown>>, prompt: string, setup: (root: string) => void, answers: string[] = []): Promise<{ root: string; output: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agent-e2e-"));
    setup(root);
    const mock = await mockModel(actions);
    try {
        const result = await runAgentCliHarness({ appRoot: root, workspace: root, apiUrl: mock.url, prompt, clarificationAnswers: answers, timeoutMs: 15_000 });
        assert.equal(result.exitCode, 0, result.stderr);
        return { root, output: result.output };
    } finally {
        await mock.close();
    }
}

async function main(): Promise<void> {
    const mutation = await runScenario([
        { action: "list_files", path: ".", reason: "Inspect the workspace first." },
        { action: "write_file", path: "hello.txt", content: "hello e2e\n", reason: "Create the requested file." },
        { action: "final", answer: "สร้าง hello.txt เรียบร้อยแล้ว", reason: "The requested file was created." }
    ], "สร้างไฟล์ hello.txt ที่มีข้อความ hello e2e", () => undefined);
    try {
        assert.equal(fs.readFileSync(path.join(mutation.root, "hello.txt"), "utf8"), "hello e2e\n");
        assert.doesNotMatch(mutation.output, /AI needs clarification/);
        assert.match(mutation.output, /AI: สร้าง hello\.txt เรียบร้อยแล้ว/);
    } finally {
        fs.rmSync(mutation.root, { recursive: true, force: true });
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
    });
    try {
        assert.match(readOnly.output, /Blocked by read-only contract/);
        assert.equal(fs.readFileSync(path.join(readOnly.root, "README.md"), "utf8"), "Original evidence.\n");
    } finally {
        fs.rmSync(readOnly.root, { recursive: true, force: true });
    }

    const scopedMutation = await runScenario([
        { action: "list_files", path: ".", reason: "Inspect discovered project roots." },
        { action: "write_file", path: "src/app.ts", content: "export const value = 'wrong';\n", reason: "Attempt to change an unowned source path." },
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
        assert.match(interactionEvidence.output, /AI: แก้และยืนยัน interaction แล้ว/);
    } finally {
        fs.rmSync(interactionEvidence.root, { recursive: true, force: true });
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
        assert.match(behaviorReplay.output, /Blocked behavior mutation: inspect the target's owning implementation companion/);
        assert.doesNotMatch(behaviorReplay.output, /Repeated equivalent action 2 times.*npm run build/s);
        assert.match(fs.readFileSync(path.join(behaviorReplay.root, "web", "src", "widget.ts"), "utf8"), /FeatureLink/);
        assert.match(behaviorReplay.output, /AI: แก้ dependency ของ interaction และยืนยันผลแล้ว/);
    } finally {
        fs.rmSync(behaviorReplay.root, { recursive: true, force: true });
    }

    const repeatedWork = await runScenario([
        { action: "list_files", path: ".", reason: "Inspect once." },
        { action: "list_files", path: ".", reason: "Inspect again without new evidence." },
        { action: "list_files", path: ".", reason: "Repeat the same inspection." }
    ], "สร้างไฟล์ result.txt หลังตรวจ workspace", () => undefined);
    try {
        assert.match(repeatedWork.output, /AI: Agent stopped early after detecting repeated work without progress/);
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
