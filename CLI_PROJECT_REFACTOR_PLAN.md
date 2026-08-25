# CLI Project Refactor Plan

เอกสารนี้สรุปจุดที่ควรปรับโครงสร้างของโปรเจกต์ `cli_project` โดยเน้น **refactor architecture โดยไม่เปลี่ยน behavior เดิมของระบบ**

เป้าหมายหลักคือทำให้ core ของ coding agent:
- อ่านง่ายขึ้น
- ทดสอบง่ายขึ้น
- แยก responsibility ชัดขึ้น
- เพิ่ม provider / tool / workflow ในอนาคตได้ง่าย
- ลดความเสี่ยงจาก file ขนาดใหญ่และ logic ที่ผูกกันหลายส่วน

---

# 1. แยก `terminal.ts`

## ปัญหาปัจจุบัน

`terminal.ts` ทำหน้าที่หลายอย่างเกินไป เช่น:

- CLI input/output
- session management
- agent loop
- model management
- task clarification
- verification flow
- checkpoint / undo
- MCP integration
- settings
- logging
- task context
- project completion
- recovery

ผลคือไฟล์กลายเป็น orchestration หลักที่รู้รายละเอียดเกือบทุก subsystem

ปัญหาที่จะตามมา:

- แก้ feature หนึ่งอาจกระทบอีก feature
- test agent loop แยกจาก terminal ได้ยาก
- reuse agent engine จาก UI อื่นได้ยาก
- เพิ่ม HTTP API / desktop UI / mobile client ในอนาคตลำบาก
- code review ยากขึ้น

---

## แนวทางที่ควรแยก

โครงสร้างตัวอย่าง:

```text
cli/
├─ terminal/
│  ├─ terminal.ts
│  ├─ terminalRenderer.ts
│  ├─ commandController.ts
│  └─ inputHandler.ts
│
├─ agent/
│  ├─ agentRunner.ts
│  ├─ agentContext.ts
│  ├─ agentState.ts
│  ├─ agentGuard.ts
│  └─ agentRecovery.ts
│
├─ session/
│  ├─ sessionController.ts
│  ├─ sessionStore.ts
│  └─ checkpointManager.ts
│
├─ model/
│  ├─ modelController.ts
│  └─ llmProvider.ts
│
└─ verification/
   ├─ verificationRunner.ts
   ├─ completionPolicy.ts
   └─ taskEvidence.ts
```

---

## หน้าที่ของ `terminal.ts` หลัง refactor

ควรเหลือเพียงหน้าที่ระดับ application entrypoint เช่น:

```ts
async function startCli() {
  const app = createApplication();

  await app.initialize();

  while (app.isRunning()) {
    const input = await app.readInput();
    await app.handleInput(input);
  }
}
```

`terminal.ts` ไม่ควรรู้ implementation detail ของ:

- project index
- file tools
- MCP
- verification
- completion gate
- model retry
- checkpoint internals

---

# 2. สร้าง `AgentRunner`

ควรแยก agent execution loop ออกจาก terminal อย่างชัดเจน

## ตัวอย่าง interface

```ts
export interface AgentRunRequest {
  task: string;
  sessionId?: string;
  workspacePath: string;
}

export interface AgentRunResult {
  status: "completed" | "blocked" | "failed" | "needs_user_input";
  message?: string;
  error?: Error;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

ตัว `AgentRunner` รับผิดชอบ:

```text
User Task
   ↓
Task Contract
   ↓
LLM Request
   ↓
Agent Action
   ↓
Tool Execution
   ↓
Evidence
   ↓
Verification
   ↓
Next Action / Final
```

---

## สิ่งที่ไม่ควรอยู่ใน AgentRunner

AgentRunner ไม่ควรทำ:

- `console.log`
- readline
- spinner
- terminal formatting
- CLI command parsing
- model selection UI

ควรคืน event หรือ result ให้ caller เป็นคน render

---

# 3. ใช้ Event จาก AgentRunner

แทนการให้ agent core พิมพ์ terminal โดยตรง

ตัวอย่าง:

```ts
export type AgentEvent =
  | {
      type: "thinking";
      message: string;
    }
  | {
      type: "tool_start";
      tool: string;
    }
  | {
      type: "tool_result";
      tool: string;
      success: boolean;
    }
  | {
      type: "verification";
      status: string;
    }
  | {
      type: "final";
      message: string;
    };
```

จากนั้น CLI subscribe event:

```ts
agentRunner.onEvent((event) => {
  terminalRenderer.render(event);
});
```

ข้อดี:

- core ไม่ผูกกับ terminal
- ทำ GUI ได้
- ทำ WebSocket API ได้
- ทำ mobile client ได้
- test event sequence ได้
- logging แยกออกจาก business logic

---

# 4. แยก `agentTool.ts`

## ปัญหาปัจจุบัน

`agentTool.ts` รับผิดชอบหลายประเภทเกินไป เช่น:

- filesystem
- project search
- command execution
- PowerShell handling
- runtime probe
- package safety
- MCP
- JSON handling
- formatting
- agent system prompt
- workspace safety

ควรแยกตามประเภท tool

---

## โครงสร้างที่แนะนำ

```text
cli/tools/
├─ tool.ts
├─ toolRegistry.ts
│
├─ file/
│  ├─ readFileTool.ts
│  ├─ writeFileTool.ts
│  ├─ editFileTool.ts
│  └─ deleteFileTool.ts
│
├─ search/
│  └─ searchProjectTool.ts
│
├─ command/
│  ├─ runCommandTool.ts
│  ├─ commandNormalizer.ts
│  └─ commandSafety.ts
│
├─ mcp/
│  └─ mcpCallTool.ts
│
└─ runtime/
   └─ runtimeProbeTool.ts
```

---

# 5. ใช้ `Tool` Interface กลาง

ตัวอย่าง:

```ts
export interface ToolContext {
  workspacePath: string;
  sessionId?: string;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;

  execute(
    input: TInput,
    context: ToolContext
  ): Promise<ToolResult<TOutput>>;
}
```

เช่น:

```ts
export class ReadFileTool implements Tool<ReadFileInput, string> {
  readonly name = "read_file";

  async execute(
    input: ReadFileInput,
    context: ToolContext
  ): Promise<ToolResult<string>> {
    // existing behavior
  }
}
```

---

# 6. สร้าง `ToolRegistry`

แทน switch ขนาดใหญ่

```ts
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${name}`,
      };
    }

    return tool.execute(input, context);
  }
}
```

AgentRunner จะรู้เพียง:

```ts
await toolRegistry.execute(
  action.name,
  action.input,
  context
);
```

ไม่ต้องรู้ว่า tool แต่ละตัวทำงานยังไง

---

# 7. แยก Workspace Safety ออกจาก Tool

filesystem tools ไม่ควรเขียน logic workspace boundary ซ้ำเอง

ควรมี:

```text
WorkspaceGuard
```

ตัวอย่าง:

```ts
export interface WorkspaceGuard {
  resolveSafePath(
    workspacePath: string,
    requestedPath: string
  ): string;
}
```

ใช้ร่วมกันใน:

- read file
- write file
- edit file
- delete file
- search
- command cwd

---

# 8. รวม Agent Type และ Schema ให้มี Source of Truth เดียว

## ปัญหา

ตอนนี้ TypeScript type และ JSON schema มีโอกาสแยกกันอยู่คนละไฟล์

ตัวอย่างความเสี่ยง:

```text
AgentAction TypeScript
        ≠
AgentAction JSON Schema
```

ถ้าเพิ่ม field ในฝั่งหนึ่งแต่ลืมอีกฝั่ง จะเกิด runtime mismatch

---

## แนวทางแนะนำ: ใช้ Zod เป็น Source of Truth

เนื่องจาก project มี `zod` อยู่แล้ว

ตัวอย่าง:

```ts
import { z } from "zod";

export const AgentTaskContractSchema = z.object({
  task: z.string(),
  intent: z.string(),
  task_type: z.string(),
  requires_workspace_changes: z.boolean(),
  success_criteria: z.array(z.string()),
});

export type AgentTaskContract =
  z.infer<typeof AgentTaskContractSchema>;
```

---

## Agent Action

```ts
export const AgentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read_file"),
    path: z.string(),
  }),

  z.object({
    action: z.literal("search_project"),
    query: z.string(),
  }),

  z.object({
    action: z.literal("run_command"),
    command: z.string(),
  }),

  z.object({
    action: z.literal("final"),
    message: z.string(),
  }),
]);

export type AgentAction =
  z.infer<typeof AgentActionSchema>;
```

เมื่อ LLM ตอบกลับ:

```ts
const parsed = AgentActionSchema.safeParse(rawAction);

if (!parsed.success) {
  // invalid agent response
}
```

---

# 9. แยก Schema ตาม Domain

แนะนำ:

```text
cli/agent/schema/
├─ agentAction.schema.ts
├─ taskContract.schema.ts
├─ verification.schema.ts
└─ evidence.schema.ts
```

ไม่ควรรวม schema ทั้งระบบไว้ในไฟล์เดียวจนโตเกินไป

---

# 10. ลด Regex-Based Workflow Routing

## ปัญหา

`workflowRouter.ts` มี regex สำหรับ infer เช่น:

- workspace mutation
- read only
- runtime verification
- command verification

Regex deterministic fallback ยังมีประโยชน์

แต่ไม่ควรกลายเป็น source of truth ของ intent

ตัวอย่างสิ่งที่ควรหลีกเลี่ยงในระยะยาว:

```ts
if (/fix|change|แก้|ปรับ/.test(input)) {
  requiresWorkspaceChanges = true;
}
```

เพราะ phrase ของ user มีรูปแบบไม่จำกัด

---

# 11. ใช้ Task Contract เป็น Source of Truth มากขึ้น

flow ที่แนะนำ:

```text
User Prompt
    ↓
LLM Task Analysis
    ↓
Task Contract
    ↓
Deterministic Validation
    ↓
Agent Execution
```

ตัว deterministic layer ควรตรวจเรื่อง:

```text
Safety
Permission
Workspace Boundary
Contract Consistency
Verification Requirements
```

ไม่จำเป็นต้องพยายามเข้าใจความหมายของ user ทุกอย่างด้วย regex

---

# 12. Regex ยังควรเก็บไว้ตรงไหน

ยังควรใช้ในกรณี:

### Safety

```text
rm -rf
format
shutdown
dangerous package command
```

### Path Validation

```text
../
absolute path outside workspace
```

### Shell Normalization

```text
PowerShell
cmd.exe
bash
```

### Deterministic fallback

กรณี model ไม่สามารถสร้าง task contract ได้

แต่ไม่ควรใช้ regex เป็น semantic router หลัก

---

# 13. สร้าง `LLMProvider`

Agent engine ไม่ควรรู้ว่า inference มาจาก llama.cpp โดยตรง

สร้าง abstraction:

```ts
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
}

export interface LLMProvider {
  chat(request: LLMRequest): Promise<LLMResponse>;
}
```

---

# 14. `LlamaCppProvider`

ย้าย code ที่ยิง llama.cpp มาไว้:

```text
cli/model/providers/llamaCppProvider.ts
```

ตัวอย่าง:

```ts
export class LlamaCppProvider implements LLMProvider {
  constructor(
    private readonly baseUrl: string
  ) {}

  async chat(
    request: LLMRequest
  ): Promise<LLMResponse> {
    // existing llama.cpp request logic
  }
}
```

---

# 15. Provider ที่เพิ่มได้ในอนาคต

เมื่อแยกแล้วจะรองรับ:

```text
LLMProvider
│
├─ LlamaCppProvider
├─ LMStudioProvider
├─ OllamaProvider
├─ OpenAIProvider
├─ AnthropicProvider
└─ CustomProvider
```

AgentRunner จะเรียกเพียง:

```ts
await this.llmProvider.chat(request);
```

ไม่ต้องรู้ provider จริง

---

# 16. ห้ามย้าย Behavior พร้อม Refactor ถ้าไม่จำเป็น

สำคัญมาก:

refactor รอบแรกควรเน้น:

```text
Move code
Extract class
Extract function
Extract interface
```

หลีกเลี่ยง:

```text
เปลี่ยน algorithm
เปลี่ยน completion policy
เปลี่ยน regex
เปลี่ยน verification rule
เปลี่ยน prompt
เปลี่ยน tool behavior
```

เพราะถ้าย้าย architecture พร้อมเปลี่ยน behavior จะหาสาเหตุ regression ยาก

---

# 17. Refactor ทีละช่วง

## Phase 1 — Types / Schemas

ทำก่อนเพราะความเสี่ยงต่ำ

- [ ] รวม `AgentAction` type/schema
- [ ] รวม `AgentTaskContract` type/schema
- [ ] ใช้ Zod validation
- [ ] ลบ duplicate type
- [ ] test parsing ของ agent response

---

## Phase 2 — Tool Layer

- [ ] สร้าง `Tool` interface
- [ ] สร้าง `ToolRegistry`
- [ ] ย้าย `read_file`
- [ ] ย้าย `write_file`
- [ ] ย้าย `edit_file`
- [ ] ย้าย `delete_file`
- [ ] ย้าย `search_project`
- [ ] ย้าย `run_command`
- [ ] ย้าย `mcp_call_tool`
- [ ] สร้าง `WorkspaceGuard`
- [ ] ให้ `agentTool.ts` เหลือ facade ชั่วคราว

---

## Phase 3 — AgentRunner

- [ ] extract agent loop จาก `terminal.ts`
- [ ] AgentRunner ไม่ใช้ console
- [ ] AgentRunner ไม่ใช้ readline
- [ ] AgentRunner รับ `LLMProvider`
- [ ] AgentRunner รับ `ToolRegistry`
- [ ] AgentRunner คืน `AgentRunResult`
- [ ] เพิ่ม AgentEvent

---

## Phase 4 — Terminal

- [ ] extract renderer
- [ ] extract command parser
- [ ] extract session controller
- [ ] extract model controller
- [ ] terminal.ts เหลือ application orchestration

---

## Phase 5 — LLM Provider

- [ ] สร้าง `LLMProvider`
- [ ] ย้าย llama.cpp client เข้า `LlamaCppProvider`
- [ ] config model endpoint แยกจาก AgentRunner
- [ ] ทดสอบ remote llama.cpp
- [ ] ทดสอบ local llama.cpp

---

# 18. Architecture เป้าหมาย

```text
                    ┌─────────────────┐
                    │       CLI       │
                    │ Terminal / UI   │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   Application   │
                    │   Controller    │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   AgentRunner   │
                    └───────┬─────────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
   ┌─────────────┐    ┌─────────────┐   ┌─────────────┐
   │ LLMProvider │    │ ToolRegistry│   │ Verification│
   └──────┬──────┘    └──────┬──────┘   └─────────────┘
          │                  │
          ▼                  ▼
   ┌─────────────┐     ┌──────────────┐
   │ llama.cpp   │     │ File Tools   │
   │ Ollama      │     │ Search Tools │
   │ LM Studio   │     │ Command Tool │
   │ OpenAI      │     │ MCP Tools    │
   └─────────────┘     └──────────────┘
```

---

# 19. Dependency Direction

ควรพยายามให้ dependency วิ่งทิศเดียว:

```text
Terminal
   ↓
Application
   ↓
AgentRunner
   ↓
Interfaces
   ↓
Infrastructure
```

ไม่ควรเป็น:

```text
AgentRunner
   ↓
Terminal
```

หรือ

```text
Tool
   ↓
Terminal renderer
```

หรือ

```text
LLM Provider
   ↓
Session UI
```

---

# 20. ตัวอย่าง Constructor ของ AgentRunner

```ts
export class DefaultAgentRunner implements AgentRunner {
  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
    private readonly verifier: VerificationRunner,
    private readonly completionPolicy: CompletionPolicy,
  ) {}

  async run(
    request: AgentRunRequest
  ): Promise<AgentRunResult> {
    // agent loop
  }
}
```

ทำให้ test สามารถ inject fake implementation ได้:

```ts
const runner = new DefaultAgentRunner(
  fakeLLM,
  fakeTools,
  fakeVerifier,
  fakeCompletionPolicy,
);
```

---

# 21. Unit Test ที่ควรเพิ่มหลัง Refactor

## AgentRunner

- [ ] model คืน `read_file`
- [ ] model คืน `edit_file`
- [ ] model คืน invalid JSON
- [ ] model เรียก tool ซ้ำ
- [ ] model ไม่มี progress
- [ ] verification fail
- [ ] verification recovery
- [ ] final blocked
- [ ] completion success

## ToolRegistry

- [ ] registered tool
- [ ] unknown tool
- [ ] tool execution error

## WorkspaceGuard

- [ ] relative path ปกติ
- [ ] `../` ออกนอก workspace
- [ ] absolute path นอก workspace
- [ ] nested path

## Agent Schema

- [ ] valid action
- [ ] invalid action
- [ ] missing required property
- [ ] unsupported action type

---

# 22. Integration Test ที่ควรมี

ตัวอย่าง task:

```text
อ่าน package.json
```

expected:

```text
search/read
final
ไม่มี mutation
```

---

```text
แก้ข้อความใน README
```

expected:

```text
read
edit
verify
final
```

---

```text
แก้ error TypeScript
```

expected:

```text
search
read
edit
run command
verification
final
```

---

```text
กดปุ่มแล้วไม่ navigate
```

expected:

```text
ห้ามสรุป success จาก build ผ่านเพียงอย่างเดียว
ต้องพยายามหา runtime / interaction evidence ตาม policy เดิม
```

---

# 23. Naming ที่ควรใช้ให้ชัด

แนะนำแยกคำเหล่านี้:

### Tool

operation ที่ agent ขอให้ host execute

```text
read_file
edit_file
run_command
```

### AgentAction

คำสั่ง JSON ที่ model คืนมา

### AgentRunner

ตัวควบคุม loop ของ agent

### LLMProvider

ตัวเชื่อมกับ inference backend

### VerificationRunner

ตัวตรวจผลลัพธ์ task

### CompletionPolicy

กฎว่าตอนไหน task จบได้

### TaskEvidence

หลักฐานที่ใช้ยืนยัน success criteria

### WorkflowRouter

ใช้สำหรับ deterministic workflow classification เท่าที่จำเป็น

---

# 24. สิ่งที่ยังไม่จำเป็นต้องทำตอนนี้

ยังไม่จำเป็นต้องรีบเพิ่ม:

- multi-agent
- planner agent แยก model
- vector database
- distributed worker
- plugin marketplace
- GUI
- cloud sync
- complex RAG

เพราะ architecture core ควรนิ่งก่อน

ของที่มีอยู่ตอนนี้เพียงพอสำหรับพัฒนา coding agent ต่อแล้ว

---

# 25. Priority

ถ้าจะทำทีละอย่าง:

```text
Priority 1
Agent type/schema source เดียว

Priority 2
แยก agentTool.ts → ToolRegistry + Tools

Priority 3
แยก AgentRunner ออกจาก terminal.ts

Priority 4
แยก terminal controllers/rendering

Priority 5
LLMProvider abstraction

Priority 6
ลด semantic regex routing

Priority 7
เพิ่ม integration test
```

---

# 26. Definition of Done ของ Refactor รอบนี้

ถือว่า refactor สำเร็จเมื่อ:

- [ ] `terminal.ts` ไม่มี agent business logic ขนาดใหญ่
- [ ] `agentTool.ts` ไม่เป็น God Object
- [ ] Agent type/schema ไม่มี duplicate source
- [ ] AgentRunner run ได้โดยไม่ต้องมี terminal
- [ ] llama.cpp ถูกเรียกผ่าน `LLMProvider`
- [ ] Tools เพิ่มใหม่ได้โดย register โดยไม่แก้ AgentRunner
- [ ] behavior เดิมยังผ่าน test
- [ ] verification/completion logic เดิมไม่เปลี่ยน
- [ ] workspace safety เดิมยังทำงาน
- [ ] MCP เดิมยังทำงาน
- [ ] checkpoint/undo เดิมยังทำงาน
- [ ] session เดิมยังทำงาน

---

# สรุป

เป้าหมายของ refactor นี้ไม่ใช่เปลี่ยนแนวทางของโปรเจกต์

architecture ปัจจุบันมี direction ที่ถูกแล้ว:

```text
LLM
 ↓
Agent Protocol
 ↓
Host-Controlled Tools
 ↓
Evidence
 ↓
Verification
 ↓
Completion
```

สิ่งที่ต้องทำคือแยก responsibility ของ implementation ให้ทันกับ feature ที่เพิ่มขึ้นมา

หลัง refactor core ควรกลายเป็น:

```text
CLI = Interface

AgentRunner = Agent Engine

LLMProvider = Model Backend

ToolRegistry = Host Capabilities

Verification = Quality Gate
```

เมื่อได้โครงสร้างนี้แล้ว การเพิ่ม llama.cpp server เครื่องอื่น, Ollama, LM Studio, OpenAI หรือ frontend แบบอื่น จะไม่จำเป็นต้องแก้ agent core จำนวนมาก
