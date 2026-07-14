# Local CLI with llama.cpp

This CLI uses the OpenAI-compatible API exposed by `llama-server`.

## One-terminal start

Run:

```powershell
npm run dev
```

This lists the GGUF files in `D:\Model`, asks which model to use, starts
`llama-server` in the background, waits until it is ready, and opens the CLI in
the same terminal at the normal session-selection screen. Exiting the CLI also
stops that background server. Logs are written to `.cli/logs/`.

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

Defaults:

- llama.cpp directory: `D:\llama.cpp\llama-b9908-bin-win-sycl-x64`
- API URL: `http://127.0.0.1:8080/v1/chat/completions`
- model: `qwen2.5-coder-7b-instruct-q4_k_m.gguf`

Optional overrides:

```powershell
$env:LLAMA_CPP_DIR = "D:\path\to\llama.cpp"
$env:LLAMA_API_URL = "http://127.0.0.1:8080/v1/chat/completions"
$env:LLAMA_MODEL = "another-model.gguf"
```

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
