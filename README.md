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
the visible terminal history matches the bounded context restored for each next
prompt. The model decides whether that recent context is relevant; the current
request has priority, and `/clear` is the explicit boundary that excludes it.
Each session also saves its workspace and restores it before accepting input.
`--workspace` overrides and updates the saved value, while `/workspace <path>`
switches and saves it interactively. Legacy sessions without this field, or a
session whose directory is unavailable, prompt for a valid workspace first.

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

Settings are machine-local and ignored by Git. The tracked prototype is
`.cli/settings.example.json`. Run `/settings init` inside the CLI to create
`.cli/settings.json` without overwriting an existing file, or copy the prototype
manually before starting llama.cpp.

Prototype contents:

```json
{
  "llamaCppPath": "D:\\llama.cpp\\llama-b10012-bin-win-sycl-x64",
  "modelPath": "D:\\Model",
  "defaultModel": "Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf",
  "serverHost": "127.0.0.1",
  "serverPort": 8080,
  "apiUrl": "http://127.0.0.1:8080/v1/chat/completions",
  "routerMode": false,
  "modelsMax": 1,
  "contextLength": 16384,
  "device": "auto",
  "hardwareProfile": "auto",
  "debug": true,
  "historyMessages": 6,
  "agent": {
    "profile": "standard",
    "maxTurns": 12,
    "maxSegments": 1,
    "maxDurationMinutes": 8,
    "maxCompletionTokens": 8000,
    "repeatLimit": 2,
    "maxClarifications": 2,
    "requireInspectionBeforeClarification": true,
    "secondClarificationRequiresBlocker": true
  },
  "projectChecks": [
    {
      "manifest": "deno.json",
      "command": "deno test",
      "label": "Deno tests",
      "ecosystem": "deno",
      "affectedExtensions": [".ts"],
      "affectedFiles": ["deno.lock"]
    }
  ],
  "sampling": {
    "chat": { "temperature": 0.6, "top_p": 0.9, "top_k": 40, "repeat_penalty": 1.08, "max_tokens": 2048 },
    "planner": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 1024 },
    "action": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 2048 }
  }
}
```

When `.cli/settings.json` is missing, both the CLI and launcher read the tracked
`.cli/settings.example.json`. Built-in fallbacks are used only if neither file
exists. Important built-in path defaults are:

- llama.cpp directory: `D:\llama.cpp\llama-b10012-bin-win-sycl-x64`
- API URL: `http://127.0.0.1:8080/v1/chat/completions`
- model: `Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf`

Optional overrides:

```powershell
$env:LLAMA_CPP_DIR = "D:\path\to\llama.cpp"
$env:LLAMA_MODEL_DIR = "D:\path\to\models"
$env:LLAMA_DEVICE = "CUDA0"
$env:LLAMA_HARDWARE_PROFILE = "rtx-4070-super"
$env:LLAMA_ARG_HOST = "0.0.0.0"
$env:LLAMA_ARG_PORT = "8080"
$env:LLAMA_ROUTER_MODE = "true"
$env:LLAMA_MODELS_MAX = "1"
$env:LLAMA_API_URL = "http://127.0.0.1:8080/v1/chat/completions"
$env:LLAMA_MODEL = "another-model.gguf"
$env:LLAMA_CONTEXT_LENGTH = "65536"
$env:CLI_AGENT_PROFILE = "deep"
$env:CLI_AGENT_MAX_SEGMENTS = "2"
$env:CLI_AGENT_MAX_CLARIFICATIONS = "2"
```

Run `/settings` to see every effective agent limit and whether its value came
from the environment, `settings.json`, or a default. Run `/settings validate`
to report invalid ranges, types, unsafe provider paths, or malformed JSON. Run `/capabilities` to see
the active mode's local actions, discovered project checks, MCP servers, and
whether a real MCP web-search tool is currently available.

To use one machine as the inference server for other copies of this repo on a
trusted LAN, set `serverHost` to `0.0.0.0` on the server, allow `serverPort`
through that machine's private-network firewall, and set each client's `apiUrl`
to `http://<server-ip>:<serverPort>/v1/chat/completions`. Run `npm run llama` on
the server and `npm run dev:cli` on clients so clients do not launch their own
model server.

For machines at different locations, do not expose port 8080 directly to the
public internet. Install Tailscale on both machines, sign them into the same
tailnet, and keep the server's `serverHost` set to `127.0.0.1`. After starting
`npm run llama`, run this in a second server terminal:

```powershell
npm run serve:tailscale
```

Tailscale prints a tailnet-only IP and DNS name. Set the client machine's
`apiUrl` to `http://<tailscale-ip>:8080/v1/chat/completions` (or use its
MagicDNS name with port `8080`), then run `npm run dev:cli`. Only devices
authorized by that tailnet can reach the Tailscale Serve endpoint.

With `device` set to `auto`, the launcher asks the configured `llama-server.exe`
which accelerator devices it provides and selects the first one. This lets the
same setting work with CUDA, Vulkan, and SYCL builds. Set `LLAMA_DEVICE` to a
specific ID such as `CUDA0`, `Vulkan0`, or `SYCL0` when an explicit override is
needed. The selected llama.cpp build must support that backend: use a SYCL build
for Intel Arc or a CUDA build for the RTX 4070 SUPER, and point
`LLAMA_CPP_DIR` at the matching build when switching cards.

Sampling values can be overridden per profile with variables such as
`LLAMA_CHAT_TEMPERATURE`, `LLAMA_PLANNER_MAX_TOKENS`, and
`LLAMA_ACTION_TOP_K`. Set `CLI_DEBUG=1` to show the concise agent trace.
Agent budgets use `quick`, `standard`, and `deep` profiles. `standard` is the
normal 12-turn, 8-minute profile; `deep` is explicit and bounded to two
12-turn segments and 20 minutes. Values above the selected profile's ceiling
are clamped rather than allowing a task to loop indefinitely. Agent loop limits
live under `agent` in settings and can be overridden within the selected profile with
`CLI_AGENT_MAX_TURNS`, `CLI_AGENT_MAX_SEGMENTS`, `CLI_AGENT_MAX_MINUTES`,
`CLI_AGENT_MAX_COMPLETION_TOKENS`, and `CLI_AGENT_REPEAT_LIMIT`.
The HTTP client timeout is kept slightly above the wall-clock budget so the
user-visible Agent guard, rather than a generic five-minute Axios timeout,
explains why a long request stopped.

Launchers inspect both the backend ID and device description. They automatically
select `intel-arc` for an Intel Arc device and `rtx-4070-super` for that NVIDIA
card; set `hardwareProfile` or `LLAMA_HARDWARE_PROFILE` to force one. Recommended
starting values are:

| Hardware preset | Backend | Context | Batch / ubatch | KV cache |
| --- | --- | ---: | ---: | --- |
| Intel Arc | SYCL | 16,384 | 512 / 256 | q8_0 |
| RTX 4070 SUPER | CUDA | 16,384 | 1024 / 512 | q8_0 |
| Generic Vulkan | Vulkan | measured per device | 512 / 256 | f16 |

The Arc value was measured on the local Arc 140T 16 GB: changing ubatch from
128 to 256 raised pp512 from 86.02 to 116.65 tokens/second while tg128 remained
stable at 7.63–7.74 tokens/second. The RTX preset uses q8 KV because the card has
12 GB VRAM and the selected 14B-class Q4 model plus a long f16 KV cache can leave
little room for compute buffers. Intel Arc desktop cards vary between 8 GB and
16 GB; on an 8 GB model, prefer a 7B-class Q4 model or expect partial CPU offload.

Accelerator launches leave GPU layers on llama.cpp's automatic setting, enable
memory fitting with a 1024 MiB margin, and allow context fitting down to 4,096
tokens. The launchers never force full `-ngl all` offload because that
prevents recovery when model weights, KV cache, and compute buffers do not fit.
`LLAMA_BATCH_SIZE`, `LLAMA_UBATCH_SIZE`, `LLAMA_KV_CACHE_TYPE`,
`LLAMA_FIT_TARGET_MIB`, and `LLAMA_FIT_CONTEXT` override these values. Run
`npm run benchmark:hardware` for an opt-in llama-bench run; startup never
benchmarks automatically.

Both llama.cpp launchers detect model filenames containing a standalone `MTP`
token. When the configured llama.cpp build advertises `draft-mtp` support, the
launcher automatically adds `--spec-type draft-mtp --spec-draft-n-max 6` and
prints the selected speculative-decoding mode. Normal models remain unchanged;
set `LLAMA_MTP=off` to disable MTP temporarily for comparison or troubleshooting.

`npm start` checks port 8080 before probing devices or loading a model. If a
healthy `llama-server` process is already listening, the CLI reuses it instead
of starting another copy. A different process on that port is rejected. The
launcher owns the server for the CLI run, so entering `exit` or `/exit` stops
the server whether it was newly started or reused.

`contextLength` is the context requested from llama.cpp with `-c`; it is not
automatically inferred from text such as `1M` in a model filename. The startup
screen shows the configured value, and `/model` shows both that value and the
active per-slot context reported by llama.cpp. The server may lower the active
value when automatic VRAM fitting requires it.

Inside the CLI, `/debug on` displays each agent action, its short decision
summary, and whether the tool succeeded. The full redacted trace is rotated
daily as `.cli/logs/agent-trace-YYYY-MM-DD.jsonl`; model-generated file content and
common secret fields are omitted. This trace is an operational summary, not
the model's private chain-of-thought. `/clear` starts a clean task context while
keeping the saved session history on disk.

Agent mode also writes every raw model message to daily files named
`.cli/logs/agent-model-responses-YYYY-MM-DD.jsonl`, including the requested response
format, finish reason, parsed action, and parse failure reason. This local file
is ignored by Git and can contain model-generated content from the active task.
In an interactive terminal, a fixed status banner stays on the bottom row and
shows the loaded model, current context usage and limit, and active workspace.
Agent output, spinners, and the input prompt use the reserved scroll region
above it, and the normal terminal region is restored when the CLI exits.

Agent requests are classified as general, web research, coding, or MCP creation
before the model acts. Classification selects specialized instructions but does
not prevent a general request from using local file tools: the model can choose
read, search, write, command, or final actions from the request and relevant
session context. A temporal word such as `current` or `ปัจจุบัน` only selects web
research when it is paired with an online subject such as news, price, weather,
or version. Web research keeps local file tools available as a recovery path.
Existing files must be read before an agent write. JSON, TypeScript, and
`.gitignore` changes receive automatic validation, and a failed validation
blocks a final success response. Source-like mutations must also belong to a
discovered project root. A check from one project cannot validate a file written
outside that project or under a sibling project.

Each task receives an acceptance-evidence contract based on the kind of outcome
the user described, independently of framework or feature names. Source-only
changes may use read-back evidence, command outcomes require a finite project
check, runtime outcomes require a runtime probe, and reported interaction
failures require an automated interaction test. A successful build cannot prove
that an observable user action produced the expected state.

Creation requests for Go APIs, React or Angular applications, and Swagger/OpenAPI also
receive a deterministic project-completion profile. A Go API profile requires a
module manifest, server startup, an HTTP route, structured JSON, and a successful
Go test/build/vet command. A React profile requires a React package, source under
`src/`, a real build script/tool dependency, and a successful frontend check.
Angular profiles similarly require `angular.json`, Angular source and CLI build
setup. Framework replacement requests inherit the existing backend requirement,
reject leftover source/dependencies from the removed framework, and require a
frontend API call through `fetch`, `axios`, or Angular `HttpClient`.
Swagger/OpenAPI creation requires an integration/spec artifact plus a
successful runtime probe. A model response that describes only a starter
scaffold or defers required work is rejected. Every rejected final attempt is
written to the agent trace as `final_blocked`.

Existing files are normally changed with an exact `edit_file` replacement so
the model sends only the old and new snippet instead of reproducing a large
file inside one JSON response. The replacement must match exactly once and gets
the same diff checkpoint, undo support, and validation as a full write. If a
full-file response reaches the completion limit, the truncated response is
omitted from active context and the next turn is constrained to a smaller action.

On Windows, agent verification commands run explicitly in PowerShell and the
model receives matching platform guidance. `run_command.workdir` selects a
relative workspace directory without `Set-Location`; redundant model-generated
`powershell.exe -Command` wrappers are removed before execution. Ordinary checks
have a 30-second timeout, while dependency installation and recognized project
scaffolding receive 180 seconds so a completed install is not reported as a false
timeout. File-content checks should use
`read_file` or `search_files`; the agent must not assume a localhost server is
running. A failed verification command blocks verified success until a relevant
file read/search or an OS-compatible command succeeds.

Package mutations run through a deterministic preflight before execution. The
selected workdir must contain `package.json`, its package manager must match an
existing lockfile, newly added packages must be named by the user or already
declared, and model-invented versions are rejected. An unversioned exact package
name delegates version resolution to the configured package registry.

Explicit read-only requests such as "do not edit" or "ห้ามแก้ไฟล์" remove
mutation actions at the response-schema level and retain a runtime mutation
guard. Read-only requests without a command acceptance criterion cannot run
shell commands. After all explicitly named files have been read, the next model
response is constrained to a final answer.

During a running request, `Ctrl+C` cancels that request without closing the
CLI. `maxTurns` is a soft per-segment limit: unfinished work is compacted into
file, validation, verification, source, and recent-event state, then continues
automatically for up to `maxSegments` (one by default). Equivalent file reads,
listings, searches, normalized commands, and repeated mutations remain counted
across context-compaction segments. Successful writes no longer erase repeat
history by themselves. The third equivalent no-progress action stops the task
early with an incomplete result instead of opening another recovery loop. Wall-clock
and completion-token budgets remain global hard limits across segments. Model-generated writes show a compact
diff preview and save a checkpoint first. Run `/undo` to restore the most recent
checkpoint for the active workspace. After each request, the CLI keeps the
spinner's total duration as a persistent `Completed in` or `Stopped after` line.
If the tool-action limit is reached while any artifact, project check, runtime
probe, or validation remains incomplete, the CLI now returns a deterministic
incomplete status and never asks the model to summarize the task as completed.

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
agent action request five times by default and records JSON validity, tool selection
stability, and concise-reason coverage under `.cli/logs/baseline-agent-*.json`.

Run the bounded local evaluation suite with an isolated llama.cpp server:

```powershell
npm run eval:local -- --model qwen2.5-coder-14b-instruct-q4_k_m.gguf
```

Use `--probes protocol,read,coding,invoice` to select individual probes when reproducing
a failure; the three core probes run by default.

Add `--mode quality` to compare correctness with equal 12-turn/action-token
budgets and a generous 15-minute task limit. Quality mode still records duration
but does not use it as the model-ranking signal. Practical mode remains the
default and uses the normal wall-clock budgets.

The runner selects a free localhost port, waits for both `/health` and
`/v1/models`, runs the agent-protocol, read-only E2E, and focused coding E2E
probes, then terminates the server process tree. It writes one comparison report
plus server logs under `.cli/logs/`; startup failures and probe timeouts are
reported separately from model failures.

Summarize all dated agent traces into task-level success, duration, model-call,
tool-action, error, and no-progress metrics with:

```powershell
npm run report:agent
npm run report:agent -- --json
```

Run `npm test` for the complete offline suite: agent protocol, context/router,
write validators, web relevance, MCP discovery/tool invocation, deterministic
full-CLI E2E scenarios, and TypeScript type checking. Run
`npm run test:live-agent` for an isolated live llama.cpp agent scenario; it skips
safely when the server is unavailable or its slots are busy. Run
`npm run test:web` for an optional live network smoke test.

## Changing models

Run `/model` inside the CLI to see the model currently loaded by llama.cpp and
all `.gguf` files exposed by the server.

Enable `routerMode` on the server to switch models without restarting:

```json
{
  "routerMode": true,
  "modelsMax": 1
}
```

Start the server with `npm run llama`. From any connected CLI, use either the
number shown by `/model` or the full model id:

```text
/model
/model 2
/model Qwen3-14B-Q4_K_M.gguf
```

The CLI unloads the previous model before loading the requested one, syncs the
active model/context, and clears the active task context while preserving saved
session history. `modelsMax: 1` prevents multiple GGUF models from filling GPU
memory. Without router mode, `/model <name>` reports that runtime switching is
unavailable and the original restart-and-select workflow remains available.

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

If a material choice remains ambiguous after the agent inspects available
context, it pauses the same task and shows 2-6 concrete choices. Enter a choice
number or id, type any free-text answer when none of the choices fit, or enter
`/cancel` to stop the task. Clarification wait time does not consume the agent's
wall-clock budget, and the answer is retained in the session task context.
Clarifications carry a decision type such as `target`, `compatibility`, or
`destructive`; reversible preference questions are rejected. The default policy
requires workspace inspection first, allows two questions at most, and permits
a second question only after new command, validation, or missing-target evidence.
These limits are configurable under `agent` as shown above.

Built-in verification discovery covers Node package scripts, Go, Rust, pytest,
.NET, and Maven. Additional finite checks can be registered with `projectChecks`.
`manifest` may be a filename matched in every project root or one exact relative
manifest path. Custom providers are validated, merged with built-in checks, and
deduplicated by manifest and command.

The active workspace's `.cli/mcp.json` takes priority. If it is absent, the CLI
installation's config is used so switching workspaces does not hide built-in
servers. If discovery reports no configured server, MCP actions are disabled
for that request and compacted continuation state preserves that decision; the
agent must use local tools instead of guessing server names.

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
