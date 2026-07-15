# Local CLI with llama.cpp

This CLI uses the OpenAI-compatible API exposed by `llama-server`.

## One-terminal start

Run:

```powershell
npm run dev
```

This reads paths from `.cli/settings.json`, lists the GGUF files in the configured
model path, asks which model to use, starts `llama-server` in the background,
waits until it is ready, and opens the CLI in the same terminal at the normal
session-selection screen. Exiting the CLI also stops that background server.
Logs are written to `.cli/logs/`.

At session selection, use `D` to delete one saved session or `C` to clear all
saved sessions. Both paths require confirmation. `/clear` inside a session only
starts a clean model context and does not delete saved session data.
After selecting a session, the CLI prints its six most recent saved messages so
the visible terminal history matches the context restored for the next prompt.

The separate two-terminal workflow below remains available when server logs
need to stay visible.

1. Start llama.cpp and select a GGUF model:

   ```powershell
   npm run llama
   ```

2. After the server reports that it is listening on port `8080`, open another
   terminal and start the CLI:

   ```powershell
   npm run dev:cli
   ```

Settings:

```json
{
  "llamaCppPath": "D:\\llama.cpp\\llama-b10012-bin-win-sycl-x64",
  "modelPath": "D:\\Model",
  "defaultModel": "Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf",
  "contextLength": 65536,
  "device": "auto",
  "debug": true,
  "historyMessages": 6,
  "agent": { "maxTurns": 12, "maxDurationMinutes": 10, "maxCompletionTokens": 16000, "repeatLimit": 2 },
  "sampling": {
    "chat": { "temperature": 0.6, "top_p": 0.9, "top_k": 40, "repeat_penalty": 1.08, "max_tokens": 2048 },
    "planner": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 1024 },
    "action": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 4096 }
  }
}
```

Defaults if `.cli/settings.json` is missing:

- llama.cpp directory: `D:\llama.cpp\llama-b10012-bin-win-sycl-x64`
- API URL: `http://127.0.0.1:8080/v1/chat/completions`
- model: `qwen2.5-coder-7b-instruct-q4_k_m.gguf`

Optional overrides:

```powershell
$env:LLAMA_CPP_DIR = "D:\path\to\llama.cpp"
$env:LLAMA_MODEL_DIR = "D:\path\to\models"
$env:LLAMA_DEVICE = "CUDA0"
$env:LLAMA_API_URL = "http://127.0.0.1:8080/v1/chat/completions"
$env:LLAMA_MODEL = "another-model.gguf"
$env:LLAMA_CONTEXT_LENGTH = "65536"
```

With `device` set to `auto`, the launcher asks the configured `llama-server.exe`
which accelerator devices it provides and selects the first one. This lets the
same setting work with CUDA, Vulkan, and SYCL builds. Set `LLAMA_DEVICE` to a
specific ID such as `CUDA0`, `Vulkan0`, or `SYCL0` when an explicit override is
needed.

Sampling values can be overridden per profile with variables such as
`LLAMA_CHAT_TEMPERATURE`, `LLAMA_PLANNER_MAX_TOKENS`, and
`LLAMA_ACTION_TOP_K`. Set `CLI_DEBUG=1` to show the concise agent trace.
Agent loop limits live under `agent` in settings and can be overridden with
`CLI_AGENT_MAX_TURNS`, `CLI_AGENT_MAX_MINUTES`,
`CLI_AGENT_MAX_COMPLETION_TOKENS`, and `CLI_AGENT_REPEAT_LIMIT`.
The HTTP client timeout is kept slightly above the wall-clock budget so the
user-visible Agent guard, rather than a generic five-minute Axios timeout,
explains why a long request stopped.

Launchers apply conservative runtime profiles after device auto-detection:
CUDA uses batch/ubatch `1024/512`, while SYCL and Vulkan use `512/256`.
`LLAMA_BATCH_SIZE` and `LLAMA_UBATCH_SIZE` override these values. Run
`npm run benchmark:hardware` for an opt-in llama-bench run; startup never
benchmarks automatically.

`contextLength` is the context requested from llama.cpp with `-c`; it is not
automatically inferred from text such as `1M` in a model filename. The startup
screen shows the configured value, and `/model` shows both that value and the
active per-slot context reported by llama.cpp. The server may lower the active
value when automatic VRAM fitting requires it.

Inside the CLI, `/debug on` displays each agent action, its short decision
summary, and whether the tool succeeded. The full redacted trace is always
appended to `.cli/logs/agent-trace.jsonl`; model-generated file content and
common secret fields are omitted. This trace is an operational summary, not
the model's private chain-of-thought. `/clear` starts a clean task context while
keeping the saved session history on disk.

Agent mode also writes every raw model message to
`.cli/logs/agent-model-responses.jsonl`, including the requested response
format, finish reason, parsed action, and parse failure reason. This local file
is ignored by Git and can contain model-generated content from the active task.
In an interactive terminal, a status banner immediately above each input prompt
shows the loaded model, current context usage and limit, and active workspace.
It does not use a fixed terminal scroll region, so agent output and final answers
cannot overlap or be hidden by the banner.

Agent requests are classified as general conversation, web research, coding,
or MCP creation before the model acts. Only relevant recent session messages
are summarized into the active task context, so an unrelated question does not
inherit coding or search instructions from an earlier task. Existing files
must be read before an agent write. JSON, TypeScript, and `.gitignore` changes
receive automatic validation, and a failed validation blocks a final success
response.

During a running request, `Ctrl+C` cancels that request without closing the
CLI. Agent turns show remaining wall-clock budget and stop when time, turn,
completion-token, or repeated-action limits are reached. Model-generated writes
show a compact diff preview and save a checkpoint first. Run `/undo` to restore
the most recent checkpoint for the active workspace.

Project-local skills live at `.cli/skills/<name>/SKILL.md` with required `name`
and `description` frontmatter. Run `/skills` to list them, invoke one explicitly
as `$skill-name`, or let metadata relevance select it. Only selected skill
bodies enter model context. The included `$local-cli-maintainer` skill captures
this project's maintenance and verification workflow.

The CLI records token usage returned by llama.cpp for each successful request.
It shows cumulative session tokens, request count, output tokens, and the latest
active context usage after every answer. Use `/usage` to show it again. `/clear`
resets the active context counter while preserving the session totals.

To compare the loaded model without Agent history or tools, start
`llama-server` and run:

```powershell
npm run baseline:model
npm run baseline:agent
```

The first command tests the baseline questions and stores model, server
properties, chat template information exposed by llama.cpp, sampling, and
answers under `.cli/logs/baseline-model-*.json`. The second repeats the same
agent action request five times and records JSON validity, tool selection
stability, and concise-reason coverage under `.cli/logs/baseline-agent-*.json`.

Run `npm test` for the complete offline suite: agent protocol, context/router,
write validators, web relevance, MCP discovery/tool invocation, and TypeScript
type checking. Run `npm run test:web` for an optional live network smoke test.

## Changing models

Run `/model` inside the CLI to see the model currently loaded by llama.cpp and
all `.gguf` files in `D:\Model`.

`llama-server` loads the selected GGUF at startup. To switch it:

1. Stop the terminal running llama.cpp with `Ctrl+C`.
2. Run `npm run llama` again.
3. Select the number of the new model.

The CLI reads the loaded model id from llama.cpp automatically. `/model` is a
status/list command and does not switch the running server's GGUF file.

## MCP servers

Agent mode is an MCP host for project-local stdio servers. Server definitions
live in `.cli/mcp.json`, and server source code should live under
`mcp/servers/<server-name>/`.

Example configuration:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["mcp/servers/example/server.mjs"],
      "cwd": ".",
      "env": {}
    }
  }
}
```

When `/mode agent` starts a task, it connects to configured servers, includes
their tool names, descriptions, and input schemas in the model prompt, and lets
the model use `mcp_list_tools` and `mcp_call_tool` actions. Ask it to create a
new MCP server and it will use the same folder/config convention, then discover
and invoke the new tool before reporting success.

The included `example` server exposes an `echo` tool for connection testing.
Treat `.cli/mcp.json` as trusted code because each entry starts the configured
local command.

The included `web-search` server exposes `search_web` through DuckDuckGo with a
Bing RSS fallback. It rewrites weak queries, filters results with no query
overlap, and retries until it has two relevant URLs or marks the evidence as
insufficient. `open_web_page` reads a selected public result while blocking
local and private network targets. Agent mode is the default; web research must
observe at least two source URLs before returning a final answer.

Test MCP discovery and invocation with:

```powershell
npm run test:mcp
```
