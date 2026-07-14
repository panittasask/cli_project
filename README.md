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
  "llamaCppPath": "D:\\llama.cpp\\llama-b9908-bin-win-sycl-x64",
  "modelPath": "D:\\Model",
  "defaultModel": "Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf",
  "contextLength": 65536,
  "device": "CUDA0",
  "debug": true,
  "historyMessages": 6,
  "sampling": {
    "chat": { "temperature": 0.6, "top_p": 0.9, "top_k": 40, "repeat_penalty": 1.08, "max_tokens": 2048 },
    "planner": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 1024 },
    "action": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 4096 }
  }
}
```

Defaults if `.cli/settings.json` is missing:

- llama.cpp directory: `D:\llama.cpp\llama-b9908-bin-win-sycl-x64`
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

Sampling values can be overridden per profile with variables such as
`LLAMA_CHAT_TEMPERATURE`, `LLAMA_PLANNER_MAX_TOKENS`, and
`LLAMA_ACTION_TOP_K`. Set `CLI_DEBUG=1` to show the concise agent trace.

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

The included `web-search` server exposes `search_web` through DuckDuckGo. Agent
mode is the default, so external or time-sensitive questions can invoke it
automatically. The agent must cite returned URLs and must not claim it searched
unless the MCP call succeeded.

Test MCP discovery and invocation with:

```powershell
npm run test:mcp
```
