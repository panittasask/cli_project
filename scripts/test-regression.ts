import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

const { classifyWorkflow, classifyWorkflowWithHistory, requiresWorkspaceWrite, requiresWorkspaceWriteWithHistory, verificationRequirement, verificationRequirementWithHistory, commandSatisfiesVerification, workflowInstructions } = require("../cli/workflowRouter") as {
    classifyWorkflow: (message: string) => { kind: string };
    classifyWorkflowWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => { kind: string };
    requiresWorkspaceWrite: (message: string) => boolean;
    requiresWorkspaceWriteWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => boolean;
    verificationRequirement: (message: string) => "none" | "command" | "runtime";
    verificationRequirementWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => "none" | "command" | "runtime";
    commandSatisfiesVerification: (command: string, requirement: "none" | "command" | "runtime") => boolean;
    workflowInstructions: (kind: string) => string;
};
const { isContinuationRequest, selectTaskContext } = require("../cli/taskContext") as {
    isContinuationRequest: (message: string) => boolean;
    selectTaskContext: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, workflow: string, max?: number) => Array<{ content: string }>;
};
const { WriteValidator } = require("../cli/writeValidator") as { WriteValidator: new (workspace: string) => {
    validate: (file: string) => { ok: boolean; validator: string };
} };
const { AgentTool } = require("../cli/tools/agentTool") as { AgentTool: new () => {
    buildSystemPrompt: (instructions?: string) => Promise<string>;
    close: () => Promise<void>;
} };
const { buildInitialAgentMessages, getAgentResponseFormat, getAgentRecoveryResponseFormat, getAgentLocalResponseFormat, getInitialAgentResponseFormat } = require("../cli/agentProtocol") as {
    buildInitialAgentMessages: (systemPrompt: string, contextSummary: string, userMessage: string) => Array<{ role: string; content: string }>;
    getAgentResponseFormat: (workflow: string) => {
        schema: {
            oneOf: Array<{ properties: { action: { const: string } } }>;
        };
    };
    getAgentRecoveryResponseFormat: (workflow: string, blockedAction: string) => {
        schema: { oneOf: Array<{ properties: { action: { const: string } } }> };
    };
    getAgentLocalResponseFormat: (workflow: string) => {
        schema: { oneOf: Array<{ properties: { action: { const: string } } }> };
    };
    getInitialAgentResponseFormat: (workflow: string, message: string, requiresWrite?: boolean) => {
        schema: { oneOf: Array<{ properties: { action: { const: string } } }> };
    };
};
const { AgentGuard } = require("../cli/agentGuard") as { AgentGuard: new (settings: { maxTurns: number; maxDurationMs: number; maxCompletionTokens: number; repeatLimit: number }) => {
    recordCompletionTokens: (tokens: number) => void;
    checkBudget: (turn: number) => string | undefined;
    registerAction: (action: Record<string, unknown>) => { status: string };
    resetActionHistory: () => void;
    formatRemaining: () => string;
} };
const { FileCheckpointStore, formatDiffPreview } = require("../cli/fileCheckpoints") as {
    FileCheckpointStore: new (root: string) => {
        checkpoint: (workspace: string, file: string, next: string) => { preview: string };
        undoLatest: (workspace: string) => { ok: boolean };
    };
    formatDiffPreview: (before: string, after: string, label: string) => string;
};
const { SkillLoader } = require("../cli/skillLoader") as { SkillLoader: new () => {
    discover: (workspace: string) => Array<{ name: string; description: string; body: string }>;
    select: (message: string, skills: Array<{ name: string; description: string; body: string }>) => Array<{ name: string }>;
    formatPrompt: (skills: Array<{ name: string; description: string; body: string }>) => string;
} };
const { buildCompactedAgentMessages } = require("../cli/agentCompaction") as {
    buildCompactedAgentMessages: (system: string, request: string, state: Record<string, unknown>) => Array<{ role: string; content: string }>;
};
const { AgentTrace } = require("../cli/agentTrace") as {
    AgentTrace: new (target: { directory: string; basename: string }, taskId?: string) => {
        add: (entry: Record<string, unknown>) => void;
        save: () => void;
    };
};
const { AgentResponseLog } = require("../cli/agentResponseLog") as {
    AgentResponseLog: new (target: { directory: string; basename: string }, taskId?: string) => {
        append: (entry: Record<string, unknown>) => void;
    };
};
const {
    answerDefersRequiredWork,
    evaluateProjectCompletion,
    formatIncompleteTaskAnswer,
    formatProjectCompletionPrompt,
    inferProjectCompletionRequirement,
    inferProjectCompletionRequirementWithHistory,
    projectChecksAffectedByPath,
    projectChecksForCommand
} = require("../cli/projectCompletion") as {
    answerDefersRequiredWork: (answer: string) => boolean;
    evaluateProjectCompletion: (workspace: string, requirement: Record<string, unknown>) => string[];
    formatIncompleteTaskAnswer: (reasons: string[], writtenPaths: string[]) => string;
    formatProjectCompletionPrompt: (requirement: Record<string, unknown>) => string;
    inferProjectCompletionRequirement: (message: string) => ({
        label: string;
        requireGoModule: boolean;
        requireGoJsonApi: boolean;
        requireReactApp: boolean;
        requireAngularApp: boolean;
        forbidReactArtifacts: boolean;
        forbidAngularArtifacts: boolean;
        requireFrontendApiCall: boolean;
        requireSwagger: boolean;
        requiredChecks: string[];
    } | undefined);
    inferProjectCompletionRequirementWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => ({
        label: string;
        requireGoModule: boolean;
        requireReactApp: boolean;
        requireAngularApp: boolean;
        forbidReactArtifacts: boolean;
        forbidAngularArtifacts: boolean;
        requireFrontendApiCall: boolean;
        requiredChecks: string[];
    } | undefined);
    projectChecksAffectedByPath: (filePath: string) => string[];
    projectChecksForCommand: (command: string) => string[];
};
const { commandCreatesWorkspaceFiles, commandTimeoutMs, resolveCommandWorkdir } = require("../cli/commandNormalizer") as {
    commandCreatesWorkspaceFiles: (command: string) => boolean;
    commandTimeoutMs: (command: string) => number;
    resolveCommandWorkdir: (workspace: string, command: string, requestedWorkdir?: string) => { workdir: string; autoSelected: boolean };
};

async function main(): Promise<void> {
    const startScript = fs.readFileSync(path.resolve(__dirname, "start.ps1"), "utf8");
    const standaloneStartScript = fs.readFileSync(path.resolve(__dirname, "start-llama.ps1"), "utf8");
    const deviceScript = fs.readFileSync(path.resolve(__dirname, "llama-device.ps1"), "utf8");
    assert.match(startScript, /Set-Location -LiteralPath \$appRoot/);
    assert.ok(startScript.indexOf("if ($portInUse)") < startScript.indexOf("Resolve-LlamaDevice"));
    assert.match(startScript, /Reusing llama-server already listening on port 8080/);
    assert.match(startScript, /Stopping reused llama\.cpp/);
    assert.match(startScript, /ProcessName -ne "llama-server"/);
    assert.match(deviceScript, /function Get-LlamaSpeculativeProfile/);
    assert.match(deviceScript, /--spec-type", "draft-mtp"/);
    assert.match(startScript, /Get-LlamaSpeculativeProfile/);
    assert.match(standaloneStartScript, /Get-LlamaSpeculativeProfile/);
    assert.equal(classifyWorkflow("นกฮูกคืออะไร").kind, "general");
    assert.equal(classifyWorkflow("เช็คข่าวล่าสุดของ llama.cpp ให้หน่อย").kind, "web_research");
    assert.equal(classifyWorkflow("ช่วยแก้ cli/terminal.ts และรันเทส").kind, "coding");
    assert.equal(classifyWorkflow("สร้างหน้า login พร้อม privacy policy modal").kind, "coding");
    assert.equal(classifyWorkflow("ยังไม่มี ตัว register นะ").kind, "coding");
    assert.equal(classifyWorkflow("ทำเลยเพิ่มปุ่มตัว register ได้เลย").kind, "coding");
    assert.equal(classifyWorkflow("ทำงานเดิมต่อจากสถานะไฟล์ปัจจุบันให้เสร็จ").kind, "coding");
    const swaggerUntilWorking = "ใช้วิธีแก้อื่นจนกว่ามันจะสามารถเปิด swagger ได้";
    assert.equal(classifyWorkflow(swaggerUntilWorking).kind, "coding");
    assert.equal(classifyWorkflow("เช็ค version ล่าสุดของ llama.cpp").kind, "web_research");
    const uiSpacingRequest = "จัดระเบียบ ui ให้มันสวยกว่านี้หน่อยซิ ตัว ยกเลิก กับลงทะเบียนมันติดกันจัดๆเลย";
    assert.equal(classifyWorkflow(uiSpacingRequest).kind, "coding");
    assert.equal(classifyWorkflowWithHistory("ทำงานต่อจากเดิมหน่อย", [
        { role: "user", content: "แก้ไฟล์ login.html ให้มี register" },
        { role: "assistant", content: "ยังแก้ไม่เสร็จ" }
    ], true).kind, "coding");
    assert.equal(classifyWorkflow("สร้าง MCP server เพิ่มให้หน่อย").kind, "mcp_creation");
    assert.equal(requiresWorkspaceWrite("สร้างหน้า login พร้อม privacy policy modal"), true);
    assert.equal(requiresWorkspaceWrite("ทำเลยเพิ่มปุ่มตัว register ได้เลย"), true);
    assert.equal(requiresWorkspaceWrite(uiSpacingRequest), true);
    assert.equal(requiresWorkspaceWrite(swaggerUntilWorking), true);
    assert.equal(requiresWorkspaceWriteWithHistory("ทำงานต่อจากเดิมหน่อย", [
        { role: "user", content: "แก้ไฟล์ login.html ให้มี register" },
        { role: "assistant", content: "ยังแก้ไม่เสร็จ" }
    ], true), true);
    assert.equal(requiresWorkspaceWrite("file ถูกสร้างไว้ที่ไหน"), false);
    assert.equal(verificationRequirement(swaggerUntilWorking), "runtime");
    const fullStackPrompt = "create a golang restfull api with react website show dashboard about employee";
    assert.equal(classifyWorkflow(fullStackPrompt).kind, "coding");
    assert.equal(requiresWorkspaceWrite(fullStackPrompt), true);
    assert.equal(verificationRequirement(fullStackPrompt), "command");
    assert.equal(verificationRequirement("create a Go API with Swagger UI"), "runtime");
    const angularSwitchPrompt = "เปลี่ยนเป็นไปใช้ angular แทนได้ไหมถ้างั้น ลบ react ทิ้งไปก่อนแล้วสร้าง dashboard โดยใช้ angular แทน";
    assert.equal(classifyWorkflow(angularSwitchPrompt).kind, "coding");
    assert.equal(requiresWorkspaceWrite(angularSwitchPrompt), true);
    assert.equal(verificationRequirement(angularSwitchPrompt), "command");
    assert.equal(verificationRequirement("แก้ TypeScript จนกว่า npm test จะผ่าน"), "command");
    assert.equal(verificationRequirement("อธิบายว่า Swagger คืออะไร"), "none");
    assert.equal(verificationRequirementWithHistory("ทำงานต่อให้เสร็จ", [
        { role: "user", content: swaggerUntilWorking },
        { role: "assistant", content: "ยังเปิดไม่ได้" }
    ], true), "runtime");
    assert.equal(commandSatisfiesVerification("go build -o app.exe main.go", "runtime"), false);
    assert.equal(commandSatisfiesVerification("Invoke-WebRequest http://localhost:3000/swagger", "runtime"), true);
    assert.equal(commandSatisfiesVerification("npm test", "command"), true);
    assert.match(workflowInstructions("web_research"), /Never use search_files/);
    const fullStackRequirement = inferProjectCompletionRequirement(fullStackPrompt);
    assert.ok(fullStackRequirement);
    assert.equal(fullStackRequirement.label, "Go API + React app");
    assert.deepEqual(fullStackRequirement.requiredChecks, ["go", "node"]);
    assert.equal(fullStackRequirement.requireFrontendApiCall, true);
    assert.ok(inferProjectCompletionRequirement("สร้าง go lang rest full api และ react web ui ให้เชื่อมต่อกัน"));
    assert.match(formatProjectCompletionPrompt(fullStackRequirement), /frontend API call/);
    assert.equal(answerDefersRequiredWork("I created a basic scaffold. You can expand it with additional functionality."), true);
    assert.equal(answerDefersRequiredWork("Implemented the employee dashboard and both builds pass."), false);
    assert.deepEqual(projectChecksForCommand("go test ./...; npm run build"), ["go", "node"]);
    assert.deepEqual(projectChecksForCommand("ng build"), ["node"]);
    assert.deepEqual(projectChecksAffectedByPath("api/main.go"), ["go"]);
    assert.deepEqual(projectChecksAffectedByPath("frontend/src/App.jsx"), ["node"]);
    assert.ok(inferProjectCompletionRequirementWithHistory("ทำงานต่อให้เสร็จ", [
        { role: "user", content: fullStackPrompt },
        { role: "assistant", content: "ยังไม่เสร็จ" }
    ], true));
    assert.equal(isContinuationRequest(angularSwitchPrompt), true);
    const angularSwitchRequirement = inferProjectCompletionRequirementWithHistory(angularSwitchPrompt, [
        { role: "user", content: fullStackPrompt },
        { role: "assistant", content: "React ยังติดตั้งไม่เสร็จ" }
    ], true);
    assert.ok(angularSwitchRequirement);
    assert.equal(angularSwitchRequirement.label, "Go API + Angular app");
    assert.equal(angularSwitchRequirement.requireGoModule, true);
    assert.equal(angularSwitchRequirement.requireReactApp, false);
    assert.equal(angularSwitchRequirement.requireAngularApp, true);
    assert.equal(angularSwitchRequirement.forbidReactArtifacts, true);
    assert.equal(angularSwitchRequirement.requireFrontendApiCall, true);
    assert.deepEqual(angularSwitchRequirement.requiredChecks, ["go", "node"]);
    const continuedAngularRequirement = inferProjectCompletionRequirementWithHistory("ทำงานต่อให้เสร็จ", [
        { role: "user", content: fullStackPrompt },
        { role: "assistant", content: "React ติดตั้งไม่สำเร็จ" },
        { role: "user", content: angularSwitchPrompt },
        { role: "assistant", content: "Angular CLI timeout" }
    ], true);
    assert.ok(continuedAngularRequirement);
    assert.equal(continuedAngularRequirement.label, "Go API + Angular app");
    assert.equal(continuedAngularRequirement.forbidReactArtifacts, true);
    assert.equal(commandTimeoutMs("npm install"), 180_000);
    assert.equal(commandTimeoutMs("npx @angular/cli new dashboard --routing=true"), 180_000);
    assert.equal(commandTimeoutMs("go build ./..."), 30_000);
    assert.equal(commandCreatesWorkspaceFiles("npx @angular/cli new dashboard --routing=true"), true);
    assert.equal(commandCreatesWorkspaceFiles("npm run build"), false);
    const nestedAngularWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-angular-workdir-"));
    try {
        fs.mkdirSync(path.join(nestedAngularWorkspace, "dashboard"));
        fs.writeFileSync(path.join(nestedAngularWorkspace, "dashboard", "angular.json"), "{}", "utf8");
        assert.deepEqual(resolveCommandWorkdir(nestedAngularWorkspace, "ng build --configuration production"), {
            workdir: "dashboard",
            autoSelected: true
        });
        assert.deepEqual(resolveCommandWorkdir(nestedAngularWorkspace, "go build ./..."), {
            workdir: ".",
            autoSelected: false
        });
        assert.deepEqual(resolveCommandWorkdir(nestedAngularWorkspace, "ng build", "custom"), {
            workdir: "custom",
            autoSelected: false
        });
    } finally {
        fs.rmSync(nestedAngularWorkspace, { recursive: true, force: true });
    }
    assert.match(formatIncompleteTaskAnswer(["node check not passed"], ["main.go"]), /ก่อนงานเสร็จ/);
    const webActions = getAgentResponseFormat("web_research").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(webActions.includes("mcp_call_tool"));
    assert.ok(webActions.includes("read_file"));
    assert.ok(webActions.includes("search_files"));
    const localWebActions = getAgentLocalResponseFormat("web_research").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(localWebActions.includes("read_file"));
    assert.ok(!localWebActions.includes("mcp_call_tool"));
    assert.ok(!localWebActions.includes("mcp_list_tools"));
    const generalActions = getAgentResponseFormat("general").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.deepEqual(generalActions, ["read_file", "edit_file", "write_file", "run_command", "search_files", "list_files", "final"]);
    const ambiguousWorkspaceActions = getInitialAgentResponseFormat("general", "ช่วยเอาสองอันนี้แยกออกจากกัน").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(ambiguousWorkspaceActions.includes("read_file"));
    assert.ok(ambiguousWorkspaceActions.includes("edit_file"));
    assert.ok(ambiguousWorkspaceActions.includes("write_file"));
    assert.ok(ambiguousWorkspaceActions.includes("final"));
    const firstCodingActions = getInitialAgentResponseFormat("coding", "Read README.md first").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.deepEqual(firstCodingActions, ["read_file"]);
    const firstCreateActions = getInitialAgentResponseFormat("coding", "สร้างหน้า login พร้อม privacy policy modal", true).schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(firstCreateActions.includes("write_file"));
    assert.ok(!firstCreateActions.includes("final"));
    const swaggerRepairActions = getInitialAgentResponseFormat("coding", swaggerUntilWorking, true).schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(swaggerRepairActions.includes("edit_file"));
    assert.ok(!swaggerRepairActions.includes("final"));
    const repeatedReadRecoveryActions = getAgentRecoveryResponseFormat("coding", "read_file").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(!repeatedReadRecoveryActions.includes("read_file"));
    assert.ok(repeatedReadRecoveryActions.includes("write_file"));
    assert.ok(repeatedReadRecoveryActions.includes("edit_file"));
    assert.ok(repeatedReadRecoveryActions.includes("final"));
    const continuedMessages = buildInitialAgentMessages("system rules", "User: สร้างหน้า login", "file ถูกสร้างไว้ที่ไหน");
    assert.deepEqual(continuedMessages.map((message) => message.role), ["system", "user"]);
    assert.match(continuedMessages[0]?.content ?? "", /Recent session context \(use only when relevant/);

    const guard = new AgentGuard({ maxTurns: 3, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    assert.equal(guard.registerAction({ action: "read_file", path: "README.md", reason: "one" }).status, "allow");
    assert.equal(guard.registerAction({ action: "read_file", path: "README.md", reason: "two" }).status, "replan");
    assert.equal(guard.registerAction({ action: "read_file", path: "README.md", reason: "three" }).status, "stop");
    assert.match(guard.formatRemaining(), /left$/);
    assert.match(guard.checkBudget(4) ?? "", /turn budget/);
    guard.recordCompletionTokens(100);
    assert.match(guard.checkBudget(2) ?? "", /completion-token budget/);

    const progressGuard = new AgentGuard({ maxTurns: 6, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    assert.equal(progressGuard.registerAction({ action: "list_files", path: ".", reason: "inspect" }).status, "allow");
    assert.equal(progressGuard.registerAction({ action: "list_files", path: ".", reason: "inspect again" }).status, "replan");
    assert.equal(progressGuard.registerAction({ action: "write_file", path: "index.html", content: "done", reason: "make progress" }).status, "allow");
    assert.equal(progressGuard.registerAction({ action: "list_files", path: ".", reason: "verify" }).status, "allow");
    assert.equal(progressGuard.registerAction({ action: "list_files", path: ".", reason: "verify again" }).status, "replan");
    progressGuard.resetActionHistory();
    assert.equal(progressGuard.registerAction({ action: "list_files", path: ".", reason: "new segment" }).status, "allow");
    const semanticGuard = new AgentGuard({ maxTurns: 6, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    assert.equal(semanticGuard.registerAction({
        action: "run_command",
        command: "powershell.exe -NoLogo -NoProfile -Command \"go test ./...\"",
        workdir: "go"
    }).status, "allow");
    assert.equal(semanticGuard.registerAction({ action: "read_file", path: "go/go.mod" }).status, "allow");
    assert.equal(semanticGuard.registerAction({
        action: "run_command",
        command: "go   test   ./...",
        workdir: ".\\go"
    }).status, "replan");
    const repeatedWriteGuard = new AgentGuard({ maxTurns: 6, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    const repeatedWrite = { action: "write_file", path: "same.txt", content: "same" };
    assert.equal(repeatedWriteGuard.registerAction(repeatedWrite).status, "allow");
    assert.equal(repeatedWriteGuard.registerAction(repeatedWrite).status, "replan");
    const compacted = buildCompactedAgentMessages("system", "แก้ login.html", {
        segment: 2,
        maxSegments: 3,
        writtenPaths: ["login.html"],
        validationFailures: [],
        verificationRequirement: "runtime",
        verificationSatisfied: false,
        sourceUrls: [],
        recentEvents: ["edit_file [ok] login.html", "read_file [ok] login.html"],
        mcpCallsDisabled: true
    });
    assert.deepEqual(compacted.map((message) => message.role), ["system", "user"]);
    assert.match(compacted[1]?.content ?? "", /Continuation segment: 2\/3/);
    assert.match(compacted[1]?.content ?? "", /Successful file changes: login\.html/);
    assert.match(compacted[1]?.content ?? "", /MCP calls available: no/);
    assert.match(compacted[1]?.content ?? "", /Required verification: runtime/);
    assert.match(compacted[1]?.content ?? "", /Required verification satisfied after the latest write: no/);

    const sharedLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-shared-task-id-"));
    try {
        const sharedTaskId = "task_shared_regression";
        const trace = new AgentTrace({ directory: sharedLogDirectory, basename: "trace" }, sharedTaskId);
        trace.add({ turn: 1, status: "final", action: "final" });
        trace.save();
        const responses = new AgentResponseLog({ directory: sharedLogDirectory, basename: "responses" }, sharedTaskId);
        responses.append({ turn: 1, maxTurns: 1, requestFormat: {}, rawContent: "{}", parsedAction: "final" });
        const loggedIds = fs.readdirSync(sharedLogDirectory).flatMap((file) =>
            fs.readFileSync(path.join(sharedLogDirectory, file), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line).taskId)
        );
        assert.deepEqual(loggedIds, [sharedTaskId, sharedTaskId]);
    } finally {
        fs.rmSync(sharedLogDirectory, { recursive: true, force: true });
    }
    const agent = new AgentTool();
    try {
        const generalPrompt = await agent.buildSystemPrompt(workflowInstructions("general"));
        const mcpPrompt = await agent.buildSystemPrompt(workflowInstructions("mcp_creation"));
        assert.ok(!generalPrompt.includes("Put servers under mcp/servers"));
        if (process.platform === "win32") assert.match(generalPrompt, /run_command executes Windows PowerShell/);
        assert.match(generalPrompt, /Never assume a localhost server is running/);
        assert.ok(mcpPrompt.includes("Put servers under mcp/servers"));
    } finally {
        await agent.close();
    }

    const history = [
        { role: "user" as const, content: "แก้ server MCP ให้หน่อย" },
        { role: "assistant" as const, content: "แก้ server เรียบร้อยแล้ว" },
        { role: "user" as const, content: "session ของ CLI เก็บที่ไหน" },
        { role: "assistant" as const, content: "เก็บในไฟล์ session" }
    ];
    assert.equal(selectTaskContext("นกฮูกคืออะไร", history, "general", 6).length, 4);
    assert.equal(selectTaskContext("แล้วอันนี้เก็บที่ไหน", history, "general", 6).length, 4);
    assert.equal(isContinuationRequest("ทำงานต่อจากเดิมหน่อย"), true);
    assert.equal(isContinuationRequest("แก้งานต่อจามกเดิมหน่อย"), true);
    assert.equal(isContinuationRequest("ยังไม่มี ตัว register นะ"), true);
    assert.equal(isContinuationRequest("ทำเลยเพิ่มปุ่มตัว register ได้เลย"), true);
    assert.equal(isContinuationRequest("ทำงานเก่าต่อให้หน่อย"), true);
    assert.equal(isContinuationRequest(swaggerUntilWorking), true);
    assert.equal(selectTaskContext("ทำงานต่อจากเดิมหน่อย", history, "general", 6).length, 4);
    const related = selectTaskContext("session อยู่ตรงไหน", history, "coding", 6);
    assert.ok(related.some((message) => message.content.includes("session")));
    assert.ok(related.some((message) => message.content.includes("server MCP")));
    const boundedHistory = selectTaskContext("คำถามใหม่", Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `message ${index + 1}`
    })), "general", 6);
    assert.deepEqual(boundedHistory.map((message) => message.content), ["message 3", "message 4", "message 5", "message 6", "message 7", "message 8"]);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-validator-"));
    try {
        fs.writeFileSync(path.join(temp, "valid.json"), "{\"ok\":true}", "utf8");
        fs.writeFileSync(path.join(temp, "invalid.json"), "{bad", "utf8");
        const validator = new WriteValidator(temp);
        assert.deepEqual(validator.validate("valid.json"), { ok: true, validator: "JSON.parse", output: "Valid JSON: valid.json" });
        assert.equal(validator.validate("invalid.json").ok, false);

        const checkpoints = new FileCheckpointStore(temp);
        const trackedPath = path.join(temp, "tracked.txt");
        fs.writeFileSync(trackedPath, "before\n", "utf8");
        const checkpoint = checkpoints.checkpoint(temp, "tracked.txt", "after\n");
        assert.match(checkpoint.preview, /Diff preview/);
        fs.writeFileSync(trackedPath, "after\n", "utf8");
        assert.equal(checkpoints.undoLatest(temp).ok, true);
        assert.equal(fs.readFileSync(trackedPath, "utf8"), "before\n");
        assert.match(formatDiffPreview("a", "b", "x.txt"), /-1 \+1/);

        const skillDirectory = path.join(temp, ".cli", "skills", "test-helper");
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), "---\nname: test-helper\ndescription: Validate release files and packaging\n---\n\nAlways run the release validator.", "utf8");
        const loader = new SkillLoader();
        const skills = loader.discover(temp);
        assert.equal(skills.length, 1);
        assert.equal(loader.select("Use $test-helper now", skills)[0]?.name, "test-helper");
        assert.match(loader.formatPrompt(skills), /Always run the release validator/);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }

    const completionWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-project-completion-"));
    try {
        const requirement = inferProjectCompletionRequirement(fullStackPrompt);
        assert.ok(requirement);
        assert.ok(evaluateProjectCompletion(completionWorkspace, requirement).includes("Go module manifest (go.mod)"));

        fs.mkdirSync(path.join(completionWorkspace, "api"), { recursive: true });
        fs.mkdirSync(path.join(completionWorkspace, "frontend", "src"), { recursive: true });
        fs.writeFileSync(path.join(completionWorkspace, "api", "go.mod"), "module employee-api\n\ngo 1.23\n", "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "api", "main.go"), [
            "package main",
            "import (\"encoding/json\"; \"net/http\")",
            "func main() { http.HandleFunc(\"/employees\", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode([]string{}) }); http.ListenAndServe(\":8080\", nil) }"
        ].join("\n"), "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "frontend", "package.json"), JSON.stringify({
            scripts: { build: "vite build" },
            dependencies: { react: "latest" },
            devDependencies: { vite: "latest" }
        }), "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "frontend", "src", "App.jsx"), "export function App(){ fetch('/employees'); return <main>Employees</main> }", "utf8");
        assert.deepEqual(evaluateProjectCompletion(completionWorkspace, requirement), []);

        fs.rmSync(path.join(completionWorkspace, "frontend"), { recursive: true, force: true });

        fs.mkdirSync(path.join(completionWorkspace, "dashboard", "src", "app"), { recursive: true });
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "package.json"), JSON.stringify({
            scripts: { build: "ng build" },
            dependencies: { "@angular/core": "latest", "@angular/common": "latest" },
            devDependencies: { "@angular/cli": "latest" }
        }), "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "angular.json"), "{}", "utf8");
        fs.writeFileSync(
            path.join(completionWorkspace, "dashboard", "src", "app", "app.ts"),
            "import { HttpClient } from '@angular/common/http'; export class App { constructor(http: HttpClient) { http.get('/api/employees').subscribe(); } }",
            "utf8"
        );
        assert.deepEqual(evaluateProjectCompletion(completionWorkspace, angularSwitchRequirement), []);
    } finally {
        fs.rmSync(completionWorkspace, { recursive: true, force: true });
    }

    const pipeline = await import("../mcp/servers/web-search/searchPipeline.mjs") as {
        rewriteQueries: (query: string) => string[];
        runSearchPipeline: (query: string, max: number, search: (query: string) => Promise<{ provider: string; results: unknown[] }>) => Promise<{ attempts: unknown[]; resultCount: number; evidenceQuality: string; results: Array<{ url: string }> }>;
    };
    assert.ok(pipeline.rewriteQueries("Meme 67 คืออะไร").length >= 2);
    let attempts = 0;
    const searchResult = await pipeline.runSearchPipeline("Meme 67", 5, async () => {
        attempts += 1;
        return attempts === 1
            ? { provider: "test", results: [{ title: "Unrelated weather", snippet: "rain", url: "https://weather.example/" }] }
            : { provider: "test", results: [
                { title: "Meme 67 origin", snippet: "Meme 67 context", url: "https://one.example/" },
                { title: "Meaning of Meme 67", snippet: "67 meme explained", url: "https://two.example/" }
            ] };
    });
    assert.equal(searchResult.evidenceQuality, "sufficient");
    assert.equal(searchResult.resultCount, 2);
    assert.equal(searchResult.attempts.length, 2);
    assert.ok(searchResult.results.every((result) => !result.url.includes("weather")));

    console.log("Workflow routing, context isolation, validators, and web relevance regression tests passed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
