import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

const { forbidsWorkspaceWrite, requiresWorkspaceWrite, requiresWorkspaceWriteWithHistory, verificationRequirement, verificationRequirementWithHistory, commandSatisfiesVerification, acceptanceContract, acceptanceContractWithHistory, commandSatisfiesAcceptance, workflowInstructions } = require("../cli/workflowRouter") as {
    forbidsWorkspaceWrite: (message: string) => boolean;
    requiresWorkspaceWrite: (message: string) => boolean;
    requiresWorkspaceWriteWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => boolean;
    verificationRequirement: (message: string) => "none" | "command" | "runtime";
    verificationRequirementWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => "none" | "command" | "runtime";
    commandSatisfiesVerification: (command: string, requirement: "none" | "command" | "runtime") => boolean;
    acceptanceContract: (message: string) => { evidence: "source" | "command" | "runtime" | "interaction"; verification: "none" | "command" | "runtime"; reason: string };
    acceptanceContractWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => { evidence: string; verification: string; reason: string };
    commandSatisfiesAcceptance: (command: string, contract: { evidence: "source" | "command" | "runtime" | "interaction"; verification: "none" | "command" | "runtime"; reason: string }) => boolean;
    workflowInstructions: (kind: string) => string;
};
const { isContinuationRequest, selectTaskContext } = require("../cli/taskContext") as {
    isContinuationRequest: (message: string) => boolean;
    selectTaskContext: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, workflow: string, max?: number) => Array<{ content: string }>;
};
const { searchReturnedNoResults } = require("../cli/webResearch") as {
    searchReturnedNoResults: (output: string) => boolean;
};
const { WriteValidator } = require("../cli/writeValidator") as { WriteValidator: new (workspace: string) => {
    validate: (file: string) => { ok: boolean; validator: string; output: string };
    validateProjectFor: (file: string) => { ok: boolean; validator: string } | undefined;
    projectRootFor: (file: string) => string;
} };
const { AgentTool } = require("../cli/tools/agentTool") as { AgentTool: new () => {
    buildSystemPrompt: (instructions?: string) => Promise<string>;
    diagnosticSourceContext: (errorOutput: string, command?: string, requestedWorkdir?: string) => string | undefined;
    parseAction: (content: string) => Record<string, unknown> | undefined;
    close: () => Promise<void>;
} };
const {
    answerLooksLikeBlockingClarification,
    clarificationBlockReason,
    clarificationObservation,
    formatClarificationRequest,
    normalizeClarificationRequest,
    relevantClarificationInspections,
    resolveClarificationAnswer
} = require("../cli/clarification") as {
    answerLooksLikeBlockingClarification: (answer: string) => boolean;
    clarificationBlockReason: (input: {
        workspaceMutationRequired: boolean;
        successfulInspections: number;
        answeredClarifications: number;
        hasNewBlocker: boolean;
        decision: "target" | "scope" | "compatibility" | "destructive" | "cost" | "external" | "preference";
        knownProjectRoots: number;
        asksNewVersusExisting: boolean;
        maxClarifications: number;
        requireInspection: boolean;
        secondRequiresBlocker: boolean;
    }) => string | undefined;
    clarificationObservation: (request: Record<string, any>, answer: Record<string, any>) => Record<string, unknown>;
    formatClarificationRequest: (request: Record<string, any>) => string;
    normalizeClarificationRequest: (question: unknown, options: unknown, decision: unknown, reason?: string) => Record<string, any> | undefined;
    relevantClarificationInspections: (input: { decision: string; question: string; inspections: Array<Record<string, unknown>> }) => Array<Record<string, unknown>>;
    resolveClarificationAnswer: (request: Record<string, any>, input: string) => Record<string, any> | undefined;
};
const { buildInitialAgentMessages, getAgentResponseFormat, getAgentRecoveryResponseFormat, getAgentMutationResponseFormat, getAgentLocalResponseFormat, getAgentReadOnlyResponseFormat, getInitialAgentResponseFormat } = require("../cli/agentProtocol") as {
    buildInitialAgentMessages: (systemPrompt: string, contextSummary: string, userMessage: string) => Array<{ role: string; content: string }>;
    getAgentResponseFormat: (workflow: string) => {
        schema: {
            oneOf: Array<{ properties: { action: { const: string }; [key: string]: any } }>;
        };
    };
    getAgentRecoveryResponseFormat: (workflow: string, blockedAction: string | string[]) => {
        schema: { oneOf: Array<{ properties: { action: { const: string } } }> };
    };
    getAgentMutationResponseFormat: (blockedAction?: string) => {
        schema: { oneOf: Array<{ properties: { action: { const: string } } }> };
    };
    getAgentLocalResponseFormat: (workflow: string) => {
        schema: { oneOf: Array<{ properties: { action: { const: string } } }> };
    };
    getAgentReadOnlyResponseFormat: (workflow: string, allowCommands?: boolean) => {
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
    recordFileProgress: () => void;
    pause: () => void;
    resume: () => void;
    formatRemaining: () => string;
} };
const { FileCheckpointStore, formatDiffPreview } = require("../cli/fileCheckpoints") as {
    FileCheckpointStore: new (root: string) => {
        checkpoint: (workspace: string, file: string, next: string) => { preview: string };
        undoLatest: (workspace: string, checkpointId?: string) => { ok: boolean };
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
    discoverProjectChecks,
    discoverProjectRoots,
    evaluateProjectCompletion,
    formatIncompleteTaskAnswer,
    formatProjectCompletionPrompt,
    formatProjectChecksPrompt,
    inferProjectCompletionRequirement,
    inferProjectCompletionRequirementWithHistory,
    projectChecksAffectedByPath,
    projectChecksAffectedByWorkdir,
    projectChecksForCommand,
    projectRootForPath,
    unownedProjectMutationReason,
    requiredProjectChecks,
    protectedProjectDeletionReason
} = require("../cli/projectCompletion") as {
    answerDefersRequiredWork: (answer: string) => boolean;
    discoverProjectChecks: (workspace: string, providers?: Array<Record<string, unknown>>) => Array<{
        id: string; label: string; command: string; workdir: string; manifestPath: string; ecosystem: string;
        affectedExtensions: string[]; affectedFiles: string[];
    }>;
    discoverProjectRoots: (workspace: string, providers?: Array<Record<string, unknown>>) => string[];
    evaluateProjectCompletion: (workspace: string, requirement: Record<string, unknown>) => string[];
    formatIncompleteTaskAnswer: (reasons: string[], writtenPaths: string[]) => string;
    formatProjectCompletionPrompt: (requirement: Record<string, unknown>, checks?: Array<Record<string, unknown>>) => string;
    formatProjectChecksPrompt: (checks: Array<Record<string, unknown>>) => string;
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
    } | undefined);
    inferProjectCompletionRequirementWithHistory: (message: string, history: Array<{ role: "user" | "assistant"; content: string }>, continuation: boolean) => ({
        label: string;
        requireGoModule: boolean;
        requireReactApp: boolean;
        requireAngularApp: boolean;
        forbidReactArtifacts: boolean;
        forbidAngularArtifacts: boolean;
        requireFrontendApiCall: boolean;
    } | undefined);
    projectChecksAffectedByPath: (filePath: string, checks: Array<Record<string, unknown>>) => string[];
    projectChecksAffectedByWorkdir: (workdir: string | undefined, checks: Array<Record<string, unknown>>) => string[];
    projectChecksForCommand: (command: string, checks: Array<Record<string, unknown>>, workdir?: string) => string[];
    projectRootForPath: (filePath: string, checks: Array<Record<string, unknown>>) => string | undefined;
    unownedProjectMutationReason: (filePath: string, checks: Array<Record<string, unknown>>) => string | undefined;
    requiredProjectChecks: (requirement: Record<string, unknown>, checks: Array<Record<string, unknown>>) => Array<{ id: string }>;
    protectedProjectDeletionReason: (workspace: string, filePath: string, request: string) => string | undefined;
};
const { commandAddsTooling, commandCreatesWorkspaceFiles, commandMutatesWorkspaceFiles, commandFailureGuidance, commandInteractiveRisk, commandInvocationError, commandTimeoutMs, diagnosticRecoveryGuidance, missingCommandTargetError, packageContentAddsBrowserAutoOpen, packageLifecycleRoleChanges, packageMutationRisk, parsePackageMutation, resolveCommandWorkdir } = require("../cli/commandNormalizer") as {
    commandAddsTooling: (command: string) => boolean;
    commandCreatesWorkspaceFiles: (command: string) => boolean;
    commandMutatesWorkspaceFiles: (command: string) => boolean;
    commandFailureGuidance: (workspace: string, command: string, errorOutput: string) => string;
    commandInteractiveRisk: (command: string, workspace: string, workdir?: string) => string | undefined;
    commandInvocationError: (errorOutput: string) => boolean;
    commandTimeoutMs: (command: string) => number;
    diagnosticRecoveryGuidance: (errorOutput: string) => string | undefined;
    missingCommandTargetError: (errorOutput: string) => boolean;
    packageContentAddsBrowserAutoOpen: (filePath: string, content: string) => boolean;
    packageLifecycleRoleChanges: (beforeContent: string, afterContent: string) => string[];
    packageMutationRisk: (workspace: string, userMessage: string, command: string, requestedWorkdir?: string) => string | undefined;
    parsePackageMutation: (command: string) => Record<string, any> | undefined;
    resolveCommandWorkdir: (workspace: string, command: string, requestedWorkdir?: string) => { workdir: string; autoSelected: boolean };
};

async function main(): Promise<void> {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
    const startScript = fs.readFileSync(path.resolve(__dirname, "start.ps1"), "utf8");
    const standaloneStartScript = fs.readFileSync(path.resolve(__dirname, "start-llama.ps1"), "utf8");
    const terminalScript = fs.readFileSync(path.resolve(__dirname, "..", "cli", "terminal.ts"), "utf8");
    const deviceScript = fs.readFileSync(path.resolve(__dirname, "llama-device.ps1"), "utf8");
    const serviceScript = fs.readFileSync(path.resolve(__dirname, "start-llama-service.ps1"), "utf8");
    const installServiceScript = fs.readFileSync(path.resolve(__dirname, "install-llama-autostart.ps1"), "utf8");
    const serverModelScript = fs.readFileSync(path.resolve(__dirname, "server-model.ts"), "utf8");
    assert.match(startScript, /Set-Location -LiteralPath \$appRoot/);
    assert.ok(startScript.indexOf("if ($portInUse)") < startScript.indexOf("Resolve-LlamaDevice"));
    assert.match(startScript, /Reusing llama-server already listening on port \$parsedServerPort/);
    assert.match(startScript, /Stopping reused llama\.cpp/);
    assert.match(startScript, /ProcessName -ne "llama-server"/);
    assert.match(startScript, /elseif \(\$settings\.serverHost\)/);
    assert.match(startScript, /elseif \(\$settings\.serverPort\)/);
    assert.match(startScript, /"--host", \$serverHost, "--port", \$parsedServerPort\.ToString\(\)/);
    assert.match(standaloneStartScript, /"--host", \$serverHost, "--port", \$parsedServerPort\.ToString\(\)/);
    assert.match(startScript, /"--models-preset"/);
    assert.match(startScript, /"--models-max"/);
    assert.match(standaloneStartScript, /"--models-preset"/);
    assert.match(standaloneStartScript, /"--models-max"/);
    assert.match(terminalScript, /Current model: unavailable \(configured fallback:/);
    assert.match(terminalScript, /model: serverModelSynced \? model : "server unavailable"/);
    assert.equal(packageJson.scripts["serve:tailscale"], "tailscale serve --bg --tcp=8080 tcp://127.0.0.1:8080");
    assert.match(packageJson.scripts["server:install"], /install-llama-autostart\.ps1/);
    assert.match(packageJson.scripts["server:status"], /status-llama-autostart\.ps1/);
    assert.match(packageJson.scripts["server:restart"], /restart-llama-autostart\.ps1/);
    assert.equal(packageJson.scripts["server:model"], "tsx scripts/server-model.ts");
    assert.match(packageJson.scripts["server:uninstall"], /uninstall-llama-autostart\.ps1/);
    assert.match(serverModelScript, /resolveRouterModel\(models, selection\)/);
    assert.match(serverModelScript, /persistedSettings\.defaultModel = defaultModel/);
    assert.match(serviceScript, /LLAMA_ROUTER_MODE = "true"/);
    assert.match(serviceScript, /llama-autostart\.log/);
    assert.match(installServiceScript, /New-ScheduledTaskTrigger -AtStartup/);
    assert.match(installServiceScript, /-UserId "SYSTEM"/);
    assert.ok(fs.existsSync(path.resolve(__dirname, "..", "วิธีการใช้งาน.md")));
    assert.match(deviceScript, /function Get-LlamaSpeculativeProfile/);
    assert.match(deviceScript, /function New-LlamaRouterPreset/);
    assert.match(deviceScript, /load-on-startup/);
    assert.match(deviceScript, /function Get-LlamaMemoryProfile/);
    assert.match(deviceScript, /function Resolve-LlamaHardwareProfile/);
    assert.match(deviceScript, /"intel-arc" \{ @\{ BatchSize = 512; UBatchSize = 256 \} \}/);
    assert.match(deviceScript, /"rtx-4070-super" \{ @\{ BatchSize = 1024; UBatchSize = 512 \} \}/);
    assert.match(deviceScript, /"SYCL" \{ @\{ BatchSize = 256; UBatchSize = 128 \} \}/);
    assert.match(deviceScript, /"--fit", "on", "-fitc", \$fitContext\.ToString\(\), "-fitt", \$fitTarget\.ToString\(\)/);
    assert.match(deviceScript, /"-ctk", \$cacheType, "-ctv", \$cacheType/);
    assert.doesNotMatch(startScript, /"-ngl", "all"/);
    assert.doesNotMatch(standaloneStartScript, /"-ngl", "all"/);
    assert.match(startScript, /Get-LlamaMemoryProfile/);
    assert.match(standaloneStartScript, /Get-LlamaMemoryProfile/);
    assert.match(deviceScript, /--spec-type", "draft-mtp"/);
    assert.match(startScript, /Get-LlamaSpeculativeProfile/);
    assert.match(standaloneStartScript, /Get-LlamaSpeculativeProfile/);
    assert.equal(searchReturnedNoResults('{"attempts":[{"resultCount":5}],"resultCount":0,"evidenceQuality":"insufficient","results":[]}'), true);
    assert.equal(searchReturnedNoResults('{"resultCount":2,"evidenceQuality":"sufficient","results":[{"url":"https://example.com"}]}'), false);
    const swaggerUntilWorking = "ใช้วิธีแก้อื่นจนกว่ามันจะสามารถเปิด swagger ได้";
    const uiSpacingRequest = "จัดระเบียบ ui ให้มันสวยกว่านี้หน่อยซิ ตัว ยกเลิก กับลงทะเบียนมันติดกันจัดๆเลย";
    assert.equal(requiresWorkspaceWrite("install package ของ react ให้หน่อย"), true);
    assert.equal(requiresWorkspaceWrite("install zod ให้หน่อย"), true);
    assert.equal(requiresWorkspaceWrite("ติดตั้งแพ็กเกจของ react ให้หน่อย"), true);
    assert.equal(requiresWorkspaceWrite("แก้ไฟล์ package.json โดยตั้งค่า packageMode"), true);
    assert.equal(forbidsWorkspaceWrite("อ่าน README.md แล้วสรุป ห้ามแก้ไฟล์"), true);
    assert.equal(forbidsWorkspaceWrite("Read README.md without editing files"), true);
    assert.equal(forbidsWorkspaceWrite("แก้ README.md ให้ชัดขึ้น"), false);
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
    assert.equal(requiresWorkspaceWrite(fullStackPrompt), true);
    assert.equal(verificationRequirement(fullStackPrompt), "command");
    assert.equal(verificationRequirement("create a Go API with Swagger UI"), "runtime");
    const angularSwitchPrompt = "เปลี่ยนเป็นไปใช้ angular แทนได้ไหมถ้างั้น ลบ react ทิ้งไปก่อนแล้วสร้าง dashboard โดยใช้ angular แทน";
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
    const failedInteraction = acceptanceContract("กด Employee List แล้วหน้ายังค้างอยู่ที่ Dashboard");
    assert.equal(failedInteraction.evidence, "interaction");
    assert.equal(failedInteraction.verification, "runtime");
    assert.equal(commandSatisfiesAcceptance("npm run build", failedInteraction), false);
    assert.equal(commandSatisfiesAcceptance("npm run test:e2e", failedInteraction), true);
    assert.equal(acceptanceContract("ปรับชื่อหัวข้อใน README").evidence, "source");
    assert.equal(acceptanceContractWithHistory("ทำงานต่อให้เสร็จ", [
        { role: "user", content: "When I submit the form it still stays on the same screen" },
        { role: "assistant", content: "I will fix it" }
    ], true).evidence, "interaction");
    assert.match(workflowInstructions("web_research"), /Never use search_files/);
    const fullStackRequirement = inferProjectCompletionRequirement(fullStackPrompt);
    assert.ok(fullStackRequirement);
    assert.equal(fullStackRequirement.label, "Go API + React app");
    assert.equal(fullStackRequirement.requireFrontendApiCall, true);
    assert.ok(inferProjectCompletionRequirement("สร้าง go lang rest full api และ react web ui ให้เชื่อมต่อกัน"));
    assert.match(formatProjectCompletionPrompt(fullStackRequirement), /frontend API call/);
    assert.equal(answerDefersRequiredWork("I created a basic scaffold. You can expand it with additional functionality."), true);
    assert.equal(answerDefersRequiredWork("Implemented the employee dashboard and both builds pass."), false);
    const dynamicChecksWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-dynamic-checks-"));
    try {
        fs.mkdirSync(path.join(dynamicChecksWorkspace, "api"), { recursive: true });
        fs.mkdirSync(path.join(dynamicChecksWorkspace, "frontend", "src"), { recursive: true });
        fs.mkdirSync(path.join(dynamicChecksWorkspace, "worker", "src"), { recursive: true });
        fs.writeFileSync(path.join(dynamicChecksWorkspace, "api", "go.mod"), "module api\n\ngo 1.23\n", "utf8");
        fs.writeFileSync(path.join(dynamicChecksWorkspace, "frontend", "package.json"), JSON.stringify({
            name: "dashboard",
            scripts: { build: "vite build", lint: "eslint ." },
            dependencies: { react: "latest" }
        }), "utf8");
        fs.writeFileSync(path.join(dynamicChecksWorkspace, "worker", "Cargo.toml"), "[package]\nname = \"worker\"\nversion = \"0.1.0\"\n", "utf8");
        fs.mkdirSync(path.join(dynamicChecksWorkspace, "edge"), { recursive: true });
        fs.writeFileSync(path.join(dynamicChecksWorkspace, "edge", "deno.json"), "{}", "utf8");
        fs.mkdirSync(path.join(dynamicChecksWorkspace, "docs"), { recursive: true });
        fs.writeFileSync(path.join(dynamicChecksWorkspace, "docs", "package.json"), JSON.stringify({ name: "docs" }), "utf8");
        const dynamicChecks = discoverProjectChecks(dynamicChecksWorkspace);
        assert.deepEqual(dynamicChecks.map((check) => check.command).sort(), ["cargo test", "go test ./...", "npm run build"]);
        const goCheck = dynamicChecks.find((check) => check.ecosystem === "go");
        const reactCheck = dynamicChecks.find((check) => check.ecosystem === "react");
        assert.ok(goCheck);
        assert.ok(reactCheck);
        assert.deepEqual(projectChecksForCommand("go test ./...; npm run build", dynamicChecks).sort(), [goCheck.id, reactCheck.id].sort());
        assert.deepEqual(projectChecksForCommand("npm run build", dynamicChecks, "frontend"), [reactCheck.id]);
        assert.deepEqual(projectChecksForCommand("npm run build", dynamicChecks, "api"), []);
        assert.deepEqual(projectChecksAffectedByPath("api/main.go", dynamicChecks), [goCheck.id]);
        assert.deepEqual(projectChecksAffectedByPath("frontend/src/App.jsx", dynamicChecks), [reactCheck.id]);
        assert.deepEqual(projectChecksAffectedByWorkdir("frontend", dynamicChecks), [reactCheck.id]);
        assert.equal(projectRootForPath("frontend/src/App.jsx", dynamicChecks), "frontend");
        assert.equal(projectRootForPath("src/App.jsx", dynamicChecks), undefined);
        assert.match(unownedProjectMutationReason("src/App.jsx", dynamicChecks) ?? "", /not owned by a discovered project root/);
        assert.equal(unownedProjectMutationReason("NOTES.md", dynamicChecks), undefined);
        assert.deepEqual(requiredProjectChecks(fullStackRequirement, dynamicChecks).map((check) => check.id).sort(), [goCheck.id, reactCheck.id].sort());
        assert.match(formatProjectChecksPrompt(dynamicChecks), /npm run build/);
        assert.match(formatProjectChecksPrompt(dynamicChecks), /workdir `frontend`/);
        const extendedChecks = discoverProjectChecks(dynamicChecksWorkspace, [{
            manifest: "deno.json",
            command: "deno test",
            label: "Deno tests",
            ecosystem: "deno",
            affectedExtensions: [".ts"],
            affectedFiles: ["deno.lock"]
        }]);
        const denoCheck = extendedChecks.find((check) => check.ecosystem === "deno");
        assert.ok(denoCheck);
        assert.equal(denoCheck.command, "deno test");
        assert.equal(denoCheck.workdir, "edge");
        assert.deepEqual(discoverProjectRoots(dynamicChecksWorkspace, [{ manifest: "deno.json", command: "deno test" }]), ["api", "docs", "edge", "frontend", "worker"]);
    } finally {
        fs.rmSync(dynamicChecksWorkspace, { recursive: true, force: true });
    }
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
    const continuedAngularRequirement = inferProjectCompletionRequirementWithHistory("ทำงานต่อให้เสร็จ", [
        { role: "user", content: fullStackPrompt },
        { role: "assistant", content: "React ติดตั้งไม่สำเร็จ" },
        { role: "user", content: angularSwitchPrompt },
        { role: "assistant", content: "Angular CLI timeout" }
    ], true);
    assert.ok(continuedAngularRequirement);
    assert.equal(continuedAngularRequirement.label, "Go API + Angular app");
    assert.equal(continuedAngularRequirement.forbidReactArtifacts, true);
    const titleSeededRequirement = inferProjectCompletionRequirementWithHistory("ทำงานต่อให้เสร็จ", [
        { role: "user", content: "Build task: golang api and react" },
        { role: "user", content: angularSwitchPrompt }
    ], true);
    assert.ok(titleSeededRequirement);
    assert.equal(titleSeededRequirement.requireGoModule, true);
    assert.equal(titleSeededRequirement.requireAngularApp, true);
    assert.equal(titleSeededRequirement.requireReactApp, false);
    assert.equal(commandTimeoutMs("npm install"), 180_000);
    assert.equal(commandTimeoutMs("npx @angular/cli new dashboard --routing=true"), 180_000);
    assert.equal(commandTimeoutMs("go build ./..."), 30_000);
    assert.equal(commandInteractiveRisk("go build -o employee-api.exe", process.cwd()), undefined);
    assert.match(diagnosticRecoveryGuidance("TS2304: Cannot find name 'Widget'.") ?? "", /Add or import an existing definition/);
    assert.match(diagnosticRecoveryGuidance("NG8001: 'x-view' is not a known element") ?? "", /Do not suppress/);
    assert.equal(commandInvocationError("Error: Unknown argument: prod"), true);
    assert.equal(commandInvocationError('Cannot find "lint" target for the specified project.'), true);
    assert.equal(missingCommandTargetError('Cannot find "quality" target for the specified project.'), true);
    assert.equal(missingCommandTargetError('\u001b[31mCannot find\u001b[0m "quality" target for the specified project.'), true);
    assert.equal(commandAddsTooling("tool add optional-checker"), true);
    assert.equal(commandAddsTooling("npm install optional-checker --save-dev"), true);
    assert.equal(commandAddsTooling("bun add @tanstack/react-query"), true);
    assert.equal(commandAddsTooling("npm install"), false);
    assert.match(diagnosticRecoveryGuidance("Error: Unknown argument: prod") ?? "", /command invocation itself/);
    assert.equal(commandCreatesWorkspaceFiles("npx @angular/cli new dashboard --routing=true"), true);
    assert.equal(commandCreatesWorkspaceFiles("npm run build"), false);
    assert.equal(commandMutatesWorkspaceFiles("npm install"), true);
    assert.equal(commandMutatesWorkspaceFiles("pnpm remove unused-package"), true);
    assert.equal(commandMutatesWorkspaceFiles("bun add zod"), true);
    assert.equal(commandMutatesWorkspaceFiles("npm run build"), false);
    assert.deepEqual(packageLifecycleRoleChanges(
        JSON.stringify({ scripts: { start: "tool serve", build: "tool build" } }),
        JSON.stringify({ scripts: { start: "tool build", build: "tool build" } })
    ), ["start"]);
    assert.deepEqual(packageLifecycleRoleChanges(
        JSON.stringify({ scripts: { start: "tool serve --port 3000" } }),
        JSON.stringify({ scripts: { start: "tool serve --port 4000" } })
    ), []);
    const nestedAngularWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-angular-workdir-"));
    try {
        fs.mkdirSync(path.join(nestedAngularWorkspace, "dashboard"));
        fs.writeFileSync(path.join(nestedAngularWorkspace, "dashboard", "angular.json"), JSON.stringify({ projects: { dashboard: {} } }), "utf8");
        fs.writeFileSync(path.join(nestedAngularWorkspace, "dashboard", "package.json"), JSON.stringify({
            scripts: { start: "ng serve --open", build: "ng build", test: "ng test --watch" },
            devDependencies: { "karma-chrome-launcher": "latest" }
        }), "utf8");
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
        assert.deepEqual(resolveCommandWorkdir(nestedAngularWorkspace, "npm install"), {
            workdir: "dashboard",
            autoSelected: true
        });
        assert.deepEqual(resolveCommandWorkdir(nestedAngularWorkspace, "bun add zod"), {
            workdir: "dashboard",
            autoSelected: true
        });
        assert.match(
            commandFailureGuidance(nestedAngularWorkspace, "ng build", "This command is not available when running the Angular CLI outside a workspace."),
            /Project workdir candidates inferred from manifests\/configuration: dashboard/
        );
        fs.writeFileSync(path.join(nestedAngularWorkspace, "package.json"), JSON.stringify({ scripts: { build: "ng build" } }), "utf8");
        assert.deepEqual(resolveCommandWorkdir(nestedAngularWorkspace, "ng build --configuration production"), {
            workdir: "dashboard",
            autoSelected: true
        });
        assert.match(
            commandFailureGuidance(nestedAngularWorkspace, "ng build", "project definition could not be found"),
            /dashboard: scripts=\[start, build, test\], structural-config=\[angular\.json\]/
        );
        assert.match(
            commandFailureGuidance(nestedAngularWorkspace, "npm install", "spawnSync powershell.exe ETIMEDOUT"),
            /child process may have continued/
        );
        assert.match(
            commandFailureGuidance(nestedAngularWorkspace, "go build", "go.mod file not found"),
            /set run_command\.workdir/
        );
        assert.match(commandInteractiveRisk("ng serve --open", nestedAngularWorkspace, "dashboard") ?? "", /browser launching/);
        assert.match(commandInteractiveRisk("npm start", nestedAngularWorkspace, "dashboard") ?? "", /package lifecycle 'start'/);
        assert.match(commandInteractiveRisk("npm test", nestedAngularWorkspace, "dashboard") ?? "", /browser runner 'karma-chrome-launcher'/);
        assert.match(commandInteractiveRisk("ng test --watch=false", nestedAngularWorkspace, "dashboard") ?? "", /browser runner 'karma-chrome-launcher'/);
        assert.equal(commandInteractiveRisk("ng build", nestedAngularWorkspace, "dashboard"), undefined);
        assert.equal(packageContentAddsBrowserAutoOpen("package.json", JSON.stringify({ scripts: { start: "ng serve --open" } })), true);
    assert.equal(packageContentAddsBrowserAutoOpen("package.json", JSON.stringify({ scripts: { start: "ng serve" } })), false);
    assert.equal(packageContentAddsBrowserAutoOpen("package.json", JSON.stringify({ scripts: { build: "go build -o app.exe" } })), false);
    assert.deepEqual(parsePackageMutation("pnpm add @tanstack/react-query@5 -D"), {
        manager: "pnpm",
        operation: "add",
        packages: [{ spec: "@tanstack/react-query@5", name: "@tanstack/react-query", version: "5" }],
        development: true
    });
    const packagePreflightWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-package-preflight-"));
    try {
        fs.mkdirSync(path.join(packagePreflightWorkspace, "web"), { recursive: true });
        fs.writeFileSync(path.join(packagePreflightWorkspace, "web", "package.json"), JSON.stringify({ name: "web", dependencies: { react: "^19.0.0" } }), "utf8");
        fs.writeFileSync(path.join(packagePreflightWorkspace, "web", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
        assert.equal(packageMutationRisk(packagePreflightWorkspace, "install zod ให้หน่อย", "pnpm add zod", "web"), undefined);
        assert.match(packageMutationRisk(packagePreflightWorkspace, "install package ของ react ให้หน่อย", "pnpm add react-router-dom", "web") ?? "", /not explicitly named/);
        assert.match(packageMutationRisk(packagePreflightWorkspace, "install zod ให้หน่อย", "npm install zod", "web") ?? "", /does not match/);
        assert.match(packageMutationRisk(packagePreflightWorkspace, "install zod ให้หน่อย", "pnpm add zod@4", "web") ?? "", /was not requested/);
        assert.equal(packageMutationRisk(packagePreflightWorkspace, "install zod@4 ให้หน่อย", "pnpm add zod@4", "web"), undefined);
        assert.match(packageMutationRisk(packagePreflightWorkspace, "install zod", "pnpm add zod", "..") ?? "", /outside the workspace/);
    } finally {
        fs.rmSync(packagePreflightWorkspace, { recursive: true, force: true });
    }
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
    assert.deepEqual(generalActions, ["read_file", "edit_file", "write_file", "delete_file", "run_command", "search_files", "list_files", "mcp_call_tool", "mcp_list_tools", "ask_user", "final"]);
    const codingActions = getAgentResponseFormat("coding").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.deepEqual(codingActions, generalActions);
    const readOnlyActions = getAgentReadOnlyResponseFormat("coding").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(readOnlyActions.includes("read_file"));
    assert.ok(!readOnlyActions.includes("run_command"));
    assert.ok(readOnlyActions.includes("final"));
    assert.ok(!readOnlyActions.includes("edit_file"));
    assert.ok(!readOnlyActions.includes("write_file"));
    assert.ok(!readOnlyActions.includes("delete_file"));
    assert.ok(getAgentReadOnlyResponseFormat("coding", true).schema.oneOf.some((variant) => variant.properties.action.const === "run_command"));
    const ambiguousWorkspaceActions = getInitialAgentResponseFormat("general", "ช่วยเอาสองอันนี้แยกออกจากกัน").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(ambiguousWorkspaceActions.includes("read_file"));
    assert.ok(ambiguousWorkspaceActions.includes("edit_file"));
    assert.ok(ambiguousWorkspaceActions.includes("write_file"));
    assert.ok(ambiguousWorkspaceActions.includes("ask_user"));
    assert.ok(ambiguousWorkspaceActions.includes("final"));
    const firstCodingActions = getInitialAgentResponseFormat("coding", "Read README.md first").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.deepEqual(firstCodingActions, ["read_file"]);
    const firstCreateActions = getInitialAgentResponseFormat("coding", "สร้างหน้า login พร้อม privacy policy modal", true).schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(firstCreateActions.includes("write_file"));
    assert.ok(firstCreateActions.includes("delete_file"));
    assert.ok(!firstCreateActions.includes("ask_user"));
    assert.ok(!firstCreateActions.includes("final"));
    const swaggerRepairActions = getInitialAgentResponseFormat("coding", swaggerUntilWorking, true).schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(swaggerRepairActions.includes("edit_file"));
    assert.ok(!swaggerRepairActions.includes("ask_user"));
    assert.ok(!swaggerRepairActions.includes("final"));
    const repeatedReadRecoveryActions = getAgentRecoveryResponseFormat("coding", "read_file").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(!repeatedReadRecoveryActions.includes("read_file"));
    assert.ok(repeatedReadRecoveryActions.includes("write_file"));
    assert.ok(repeatedReadRecoveryActions.includes("edit_file"));
    assert.ok(repeatedReadRecoveryActions.includes("final"));
    assert.ok(!repeatedReadRecoveryActions.includes("ask_user"));
    const forcedDiagnosticActions = getAgentRecoveryResponseFormat("coding", ["run_command", "final"]).schema.oneOf.map((variant) => variant.properties.action.const);
    assert.ok(!forcedDiagnosticActions.includes("run_command"));
    assert.ok(!forcedDiagnosticActions.includes("final"));
    assert.ok(forcedDiagnosticActions.includes("read_file"));
    assert.ok(forcedDiagnosticActions.includes("delete_file"));
    assert.ok(!forcedDiagnosticActions.includes("ask_user"));
    const forcedMutationActions = getAgentMutationResponseFormat("edit_file").schema.oneOf.map((variant) => variant.properties.action.const);
    assert.deepEqual(forcedMutationActions, ["write_file", "delete_file"]);
    const askUserSchema = getAgentResponseFormat("coding").schema.oneOf.find((variant) => variant.properties.action.const === "ask_user");
    assert.equal(askUserSchema?.properties.options.minItems, 2);
    assert.equal(askUserSchema?.properties.options.maxItems, 6);
    const clarification = normalizeClarificationRequest("ติดตั้งที่โปรเจกต์ไหน?", [
        { id: "frontend", label: "Frontend", description: "React application" },
        { id: "admin", label: "Admin", description: "Administration application" }
    ], "target", "พบ React project มากกว่าหนึ่งตัว");
    assert.ok(clarification);
    assert.match(formatClarificationRequest(clarification), /Type a number, option id, or any other answer/);
    const selectedClarification = resolveClarificationAnswer(clarification, "2");
    assert.equal(selectedClarification?.kind, "option");
    assert.equal(selectedClarification?.option.id, "admin");
    const customClarification = resolveClarificationAnswer(clarification, "packages/customer-portal");
    assert.equal(customClarification?.kind, "custom");
    assert.equal(customClarification?.text, "packages/customer-portal");
    assert.equal(resolveClarificationAnswer(clarification, "9"), undefined);
    const cancelledClarification = resolveClarificationAnswer(clarification, "/cancel");
    assert.equal(cancelledClarification?.kind, "cancel");
    assert.equal(clarificationObservation(clarification, selectedClarification).status, "answered");
    assert.equal(answerLooksLikeBlockingClarification("ต้องการติดตั้งที่โปรเจกต์ไหน?"), true);
    assert.equal(answerLooksLikeBlockingClarification("ติดตั้งที่ frontend เรียบร้อยแล้ว"), false);
    assert.equal(relevantClarificationInspections({
        decision: "compatibility",
        question: "ต้องการใช้ zod version ไหน?",
        inspections: [{ action: "read_file", path: "README.md" }]
    }).length, 0);
    assert.equal(relevantClarificationInspections({
        decision: "compatibility",
        question: "ต้องการใช้ zod version ไหน?",
        inspections: [{ action: "read_file", path: "web/package.json" }]
    }).length, 1);
    assert.equal(relevantClarificationInspections({
        decision: "target",
        question: "ติดตั้งที่โปรเจกต์ไหน?",
        inspections: [{ action: "list_files", path: "." }]
    }).length, 1);
    assert.match(clarificationBlockReason({
        workspaceMutationRequired: true,
        successfulInspections: 0,
        answeredClarifications: 0,
        hasNewBlocker: false,
        decision: "target",
        knownProjectRoots: 2,
        asksNewVersusExisting: false,
        maxClarifications: 2,
        requireInspection: true,
        secondRequiresBlocker: true
    }) ?? "", /Inspect the workspace before asking/);
    assert.equal(clarificationBlockReason({
        workspaceMutationRequired: true,
        successfulInspections: 1,
        answeredClarifications: 0,
        hasNewBlocker: false,
        decision: "target",
        knownProjectRoots: 2,
        asksNewVersusExisting: false,
        maxClarifications: 2,
        requireInspection: true,
        secondRequiresBlocker: true
    }), undefined);
    assert.match(clarificationBlockReason({
        workspaceMutationRequired: true,
        successfulInspections: 1,
        answeredClarifications: 1,
        hasNewBlocker: false,
        decision: "scope",
        knownProjectRoots: 1,
        asksNewVersusExisting: false,
        maxClarifications: 2,
        requireInspection: true,
        secondRequiresBlocker: true
    }) ?? "", /already has a clarification answer/);
    assert.equal(clarificationBlockReason({
        workspaceMutationRequired: true,
        successfulInspections: 1,
        answeredClarifications: 1,
        hasNewBlocker: true,
        decision: "compatibility",
        knownProjectRoots: 1,
        asksNewVersusExisting: false,
        maxClarifications: 2,
        requireInspection: true,
        secondRequiresBlocker: true
    }), undefined);
    assert.match(clarificationBlockReason({
        workspaceMutationRequired: true,
        successfulInspections: 2,
        answeredClarifications: 2,
        hasNewBlocker: true,
        decision: "compatibility",
        knownProjectRoots: 1,
        asksNewVersusExisting: false,
        maxClarifications: 2,
        requireInspection: true,
        secondRequiresBlocker: true
    }) ?? "", /clarification limit \(2\)/);
    assert.match(clarificationBlockReason({
        workspaceMutationRequired: true,
        successfulInspections: 1,
        answeredClarifications: 0,
        hasNewBlocker: false,
        decision: "target",
        knownProjectRoots: 1,
        asksNewVersusExisting: true,
        maxClarifications: 2,
        requireInspection: true,
        secondRequiresBlocker: true
    }) ?? "", /One project root is already known/);
    assert.match(clarificationBlockReason({
        workspaceMutationRequired: true,
        successfulInspections: 1,
        answeredClarifications: 0,
        hasNewBlocker: false,
        decision: "preference",
        knownProjectRoots: 1,
        asksNewVersusExisting: false,
        maxClarifications: 2,
        requireInspection: true,
        secondRequiresBlocker: true
    }) ?? "", /Preference questions are non-blocking/);
    const continuedMessages = buildInitialAgentMessages("system rules", "User: สร้างหน้า login", "file ถูกสร้างไว้ที่ไหน");
    assert.deepEqual(continuedMessages.map((message) => message.role), ["system", "user"]);
    assert.match(continuedMessages[0]?.content ?? "", /Recent session context \(use only when relevant/);

    const guard = new AgentGuard({ maxTurns: 3, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    assert.equal(guard.registerAction({ action: "read_file", path: "README.md", reason: "one" }).status, "allow");
    assert.equal(guard.registerAction({ action: "read_file", path: "README.md", reason: "two" }).status, "replan");
    assert.equal(guard.registerAction({ action: "read_file", path: "README.md", reason: "three" }).status, "stop");
    assert.match(guard.formatRemaining(), /left$/);
    guard.pause();
    guard.resume();
    assert.match(guard.checkBudget(4) ?? "", /step budget/);
    guard.recordCompletionTokens(100);
    assert.match(guard.checkBudget(2) ?? "", /completion-token budget/);

    const progressGuard = new AgentGuard({ maxTurns: 6, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    assert.equal(progressGuard.registerAction({ action: "list_files", path: ".", reason: "inspect" }).status, "allow");
    assert.equal(progressGuard.registerAction({ action: "list_files", path: ".", reason: "inspect again" }).status, "replan");
    assert.equal(progressGuard.registerAction({ action: "write_file", path: "index.html", content: "done", reason: "make progress" }).status, "allow");
    progressGuard.resetActionHistory();
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
    const recoveryReadGuard = new AgentGuard({ maxTurns: 6, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    assert.equal(recoveryReadGuard.registerAction({ action: "read_file", path: "src/app.ts" }).status, "allow");
    assert.equal(recoveryReadGuard.registerAction({ action: "edit_file", path: "src/app.ts", old_text: "x", new_text: "y" }).status, "allow");
    assert.equal(recoveryReadGuard.registerAction({ action: "read_file", path: "src/app.ts" }).status, "allow");
    assert.equal(recoveryReadGuard.registerAction({ action: "read_file", path: "src/app.ts" }).status, "replan");
    const repeatedWriteGuard = new AgentGuard({ maxTurns: 6, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    const repeatedWrite = { action: "write_file", path: "same.txt", content: "same" };
    assert.equal(repeatedWriteGuard.registerAction(repeatedWrite).status, "allow");
    assert.equal(repeatedWriteGuard.registerAction(repeatedWrite).status, "replan");
    const verificationEpochGuard = new AgentGuard({ maxTurns: 8, maxDurationMs: 60_000, maxCompletionTokens: 100, repeatLimit: 2 });
    const buildAction = { action: "run_command", command: "npm run build", workdir: "web" };
    assert.equal(verificationEpochGuard.registerAction(buildAction).status, "allow");
    assert.equal(verificationEpochGuard.registerAction(buildAction).status, "replan");
    verificationEpochGuard.recordFileProgress();
    assert.equal(verificationEpochGuard.registerAction(buildAction).status, "allow");
    assert.equal(verificationEpochGuard.registerAction({ action: "delete_file", path: "web/src/app.ts" }).status, "allow");
    verificationEpochGuard.recordFileProgress();
    assert.equal(verificationEpochGuard.registerAction({ action: "delete_file", path: "web/src/app.ts" }).status, "allow");
    assert.equal(verificationEpochGuard.registerAction({ action: "delete_file", path: "web/src/app.ts" }).status, "replan");
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
        assert.match(generalPrompt, /Use ask_user only when required information/);
        assert.match(generalPrompt, /Uncertainty by itself is not a blocker/);
        assert.match(generalPrompt, /Never ask whether to create a new project/);
        const parsedClarification = agent.parseAction(JSON.stringify({
            action: "ask_user",
            decision: "target",
            question: "Which project?",
            options: [
                { id: "web", label: "Web", description: "Install in the web app" },
                { id: "admin", label: "Admin", description: "Install in the admin app" }
            ],
            reason: "Two project roots were discovered"
        }));
        assert.equal(parsedClarification?.action, "ask_user");
        assert.equal((parsedClarification?.options as Array<Record<string, unknown>>)[0]?.id, "web");
        assert.ok(mcpPrompt.includes("Put servers under mcp/servers"));
        const diagnosticWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-diagnostic-context-"));
        const previousCwd = process.cwd();
        try {
            fs.mkdirSync(path.join(diagnosticWorkspace, "frontend", "src"), { recursive: true });
            fs.writeFileSync(path.join(diagnosticWorkspace, "frontend", "src", "routes.ts"), "const route = Widget;", "utf8");
            fs.writeFileSync(path.join(diagnosticWorkspace, "frontend", "src", "widget.ts"), "export class Widget {}", "utf8");
            process.chdir(diagnosticWorkspace);
            assert.match(
                agent.diagnosticSourceContext("src/routes.ts(1,15): error TS2304: Cannot find name 'Widget'.") ?? "",
                /used in frontend\/src\/routes\.ts.*found in frontend\/src\/widget\.ts.*import \{ Widget \} from '\.\/widget'/
            );
        } finally {
            process.chdir(previousCwd);
            fs.rmSync(diagnosticWorkspace, { recursive: true, force: true });
        }
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
        fs.mkdirSync(path.join(temp, "package-project"), { recursive: true });
        fs.writeFileSync(path.join(temp, "package-project", "package.json"), JSON.stringify({ name: "wrong", dependencies: { a: "2" } }), "utf8");
        fs.writeFileSync(path.join(temp, "package-project", "package-lock.json"), JSON.stringify({ packages: { "": { name: "right", dependencies: { a: "1" } } } }), "utf8");
        assert.equal(validator.validate("package-project/package.json").validator, "package-lock metadata");
        assert.equal(validator.validate("package-project/package.json").ok, false);
        fs.mkdirSync(path.join(temp, "nested", "src"), { recursive: true });
        fs.writeFileSync(path.join(temp, "nested", "package.json"), "{}", "utf8");
        fs.writeFileSync(path.join(temp, "nested", "src", "app.ts"), "export {};", "utf8");
        fs.writeFileSync(path.join(temp, "nested", "src", "app.html"), "<button>Save</button>", "utf8");
        assert.equal(validator.projectRootFor("nested/src/app.ts"), path.join(temp, "nested"));
        assert.equal(validator.validateProjectFor("valid.json"), undefined);
        fs.writeFileSync(path.join(temp, "orphan.ts"), "export {};", "utf8");
        const orphanValidation = validator.validate("orphan.ts");
        assert.equal(orphanValidation.ok, true);
        assert.equal(orphanValidation.validator, "TypeScript read-back");
        fs.mkdirSync(path.join(temp, "go-project"), { recursive: true });
        fs.writeFileSync(path.join(temp, "go-project", "go.mod"), "module example.test/app\n\ngo 1.23\n\nrequire github.com/gorilla/mux v1.8.1\n", "utf8");
        fs.writeFileSync(path.join(temp, "go-project", "main.go"), "package main\nfunc main() {}\n", "utf8");
        assert.equal(validator.validate("go-project/go.mod").validator, "Go module usage");
        fs.writeFileSync(path.join(temp, "go-project", "main.go"), "package main\nimport _ \"github.com/gorilla/mux\"\nfunc main() {}\n", "utf8");
        const goModuleValidation = validator.validate("go-project/go.mod");
        if (goModuleValidation.ok) assert.equal(goModuleValidation.validator, "Go module");
        else assert.match(goModuleValidation.output, /(?:go.*not recognized|spawnSync go ENOENT)/i);

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
            "import { HttpClient } from '@angular/common/http'; export class App { employees=[]; constructor(http: HttpClient) { http.get('/api/employees').subscribe(data => this.employees = data as never[]); } }",
            "utf8"
        );
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "main.ts"), "bootstrapApplication(App, appConfig);", "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.config.ts"), "providers: [provideHttpClient()]", "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.html"), "<p>{{ employees.length }}</p>", "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "package-lock.json"), JSON.stringify({
            lockfileVersion: 3,
            packages: {
                "": {
                    dependencies: { "@angular/core": "latest", "@angular/common": "latest" },
                    devDependencies: { "@angular/cli": "latest" }
                }
            }
        }), "utf8");
        assert.match(protectedProjectDeletionReason(completionWorkspace, "dashboard/package-lock.json", "ทำงานต่อให้เสร็จ") ?? "", /preserve active project lockfile/);
        assert.equal(protectedProjectDeletionReason(completionWorkspace, "dashboard/package-lock.json", "ลบ package-lock.json ได้เลย"), undefined);
        assert.deepEqual(evaluateProjectCompletion(completionWorkspace, angularSwitchRequirement), []);
        fs.writeFileSync(path.join(completionWorkspace, "api", "main.go"), [
            "package main",
            "import (\"encoding/json\"; \"net/http\")",
            "type Employee struct { Name string `json:\"name\"` }",
            "func main() { http.HandleFunc(\"/employees\", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode([]Employee{}) }); http.ListenAndServe(\":8080\", nil) }"
        ].join("\n"), "utf8");
        fs.writeFileSync(
            path.join(completionWorkspace, "dashboard", "src", "app", "app.ts"),
            "import { HttpClient } from '@angular/common/http'; export class App { constructor(http: HttpClient) { http.get('http://localhost:8080/api/employees'); } }",
            "utf8"
        );
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.html"), "<router-outlet></router-outlet><p>{{ employee.position }}</p>", "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.routes.ts"), "export const routes = [{ path: 'employees', component: App }];", "utf8");
        const contractIssues = evaluateProjectCompletion(completionWorkspace, angularSwitchRequirement);
        assert.ok(contractIssues.some((reason) => reason.includes("cross-origin API access")));
        assert.ok(contractIssues.some((reason) => reason.includes("position")));
        assert.ok(contractIssues.some((reason) => reason.includes("default frontend route")));
        fs.writeFileSync(path.join(completionWorkspace, "api", "main.go"), [
            "package main",
            "import (\"encoding/json\"; \"net/http\")",
            "func main() { http.HandleFunc(\"/employees\", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode([]string{}) }); http.ListenAndServe(\":8080\", nil) }"
        ].join("\n"), "utf8");
        fs.writeFileSync(
            path.join(completionWorkspace, "dashboard", "src", "app", "app.ts"),
            "import { HttpClient } from '@angular/common/http'; export class App { employees=[]; constructor(http: HttpClient) { http.get('/api/employees').subscribe(data => this.employees = data as never[]); } }",
            "utf8"
        );
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.html"), "<p>{{ employees.length }}</p>", "utf8");
        fs.rmSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.routes.ts"));
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "package.json"), JSON.stringify({
            scripts: { build: "ng build" },
            dependencies: { "@angular/core": "guessed", "@angular/common": "latest" },
            devDependencies: { "@angular/cli": "latest" }
        }), "utf8");
        assert.ok(evaluateProjectCompletion(completionWorkspace, angularSwitchRequirement)
            .some((reason) => reason.includes("copy those lockfile values exactly")));
        fs.mkdirSync(path.join(completionWorkspace, "orphan"), { recursive: true });
        fs.writeFileSync(path.join(completionWorkspace, "orphan", "package-lock.json"), "{}", "utf8");
        assert.ok(evaluateProjectCompletion(completionWorkspace, angularSwitchRequirement)
            .some((reason) => reason.includes("orphan lockfile")));
        fs.writeFileSync(path.join(completionWorkspace, "angular.json"), "{}", "utf8");
        assert.ok(evaluateProjectCompletion(completionWorkspace, angularSwitchRequirement)
            .some((reason) => reason.includes("orphan workspace configuration")));
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.config.ts"), "providers: []", "utf8");
        fs.writeFileSync(path.join(completionWorkspace, "dashboard", "src", "app", "app.html"), "<p>employees works!</p>", "utf8");
        const runtimeIssues = evaluateProjectCompletion(completionWorkspace, angularSwitchRequirement);
        assert.ok(runtimeIssues.some((reason) => reason.includes("HTTP client provider")));
        assert.ok(runtimeIssues.some((reason) => reason.includes("placeholder frontend content")));
    } finally {
        fs.rmSync(completionWorkspace, { recursive: true, force: true });
    }

    const pipeline = await import("../mcp/servers/web-search/searchPipeline.mjs") as {
        tokenize: (value: string) => string[];
        rewriteQueries: (query: string) => string[];
        scoreResult: (query: string, result: { title?: string; snippet?: string; url?: string }) => number;
        runSearchPipeline: (query: string, max: number, search: (query: string) => Promise<{ provider: string; results: unknown[] }>) => Promise<{ attempts: unknown[]; resultCount: number; evidenceQuality: string; results: Array<{ url: string }> }>;
    };
    const htmlSearch = await import("../mcp/servers/web-search/htmlSearch.mjs") as {
        extractBingSearchResults: (html: string, maxResults: number) => Array<{ title: string; snippet: string; url: string; source: string }>;
        extractDuckDuckGoSearchResults: (html: string, maxResults: number) => Array<{ title: string; snippet: string; url: string; source: string }>;
    };
    const scrapedResults = htmlSearch.extractBingSearchResults(`
        <li class="b_algo"><h2><a href="https://example.com/qwen2.5-coder">Qwen2.5-Coder</a></h2><div class="b_caption"><p>Model &amp; tooling overview.</p></div></li>
        <li class="b_algo"><h2><a href="https://docs.example.com/guide">Documentation</a></h2><div class="b_caption"><p>Usage guide.</p></div></li>
    `, 5);
    assert.deepEqual(scrapedResults.map((result) => result.url), ["https://example.com/qwen2.5-coder", "https://docs.example.com/guide"]);
    assert.equal(scrapedResults[0]?.snippet, "Model & tooling overview.");
    const duckResults = htmlSearch.extractDuckDuckGoSearchResults('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fgguf">GGUF Models</a><a class="result__snippet">Browse local models.</a></div>', 5);
    assert.deepEqual(duckResults.map((result) => result.url), ["https://example.com/gguf"]);
    assert.ok(pipeline.tokenize("Qwen2.5-Coder").includes("qwen2.5-coder"));
    assert.ok(pipeline.rewriteQueries("Meme 67 คืออะไร").length >= 2);
    assert.ok(!pipeline.rewriteQueries("best local AI models for GGUF").some((query) => /meaning origin context/i.test(query)));
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
    const technicalSearchResult = await pipeline.runSearchPipeline("qwen2.5-coder", 2, async () => ({
        provider: "test",
        results: [
            { title: "Qwen2.5-Coder model", snippet: "Technical model overview", url: "https://example.com/qwen2.5-coder" },
            { title: "Qwen2.5-Coder documentation", snippet: "Model documentation", url: "https://docs.example.com/qwen2.5-coder" }
        ]
    }));
    assert.equal(technicalSearchResult.resultCount, 2);
    assert.equal(pipeline.scoreResult("best local AI models for GGUF meaning origin context", {
        title: "BEST Definition & Meaning",
        snippet: "The meaning of best.",
        url: "https://dictionary.example.com/best"
    }), 0);

    console.log("Workflow routing, context isolation, validators, and web relevance regression tests passed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
