# Local CLI with llama.cpp

This CLI uses the OpenAI-compatible API exposed by `llama-server`.

คู่มือการติดตั้ง Server autostart, การใช้งานจากเครื่อง Office และการเปลี่ยนโมเดล:
[วิธีการใช้งาน.md](./วิธีการใช้งาน.md)

## One-terminal start

Run the cross-platform launcher:

```powershell
npm start
```

If `LLAMA_API_URL` is explicitly set, or settings `apiUrl` points to a non-loopback
host, the launcher verifies that endpoint and opens the CLI without starting or
downloading llama.cpp. An unavailable explicit endpoint is reported as an error
and never silently falls back to a local model.

Without `LLAMA_API_URL`, the launcher reuses a healthy local server on the
configured port. Otherwise it detects the graphics hardware, selects CUDA for
NVIDIA on Windows, SYCL for supported Intel graphics, Vulkan for AMD, Metal for
Apple silicon, or CPU as a fallback. It uses a valid `LLAMA_CPP_DIR` or
`llamaCppPath` first; when neither contains `llama-server`, it downloads the
matching asset from the latest official llama.cpp GitHub release, verifies its
published SHA-256 digest, and caches it under `.cli/runtime/`.

The launcher selects `LLAMA_MODEL`, the configured default model, or the first
GGUF file in `LLAMA_MODEL_DIR`/`modelPath`, starts `llama-server`, waits until it
is healthy, and opens the normal session-selection screen. Exiting the CLI stops
only the server process started by this launcher. A server that was already
running is left running.

Logs are written beneath `.cli/logs/`, grouped by purpose: `agent/`, `server/`, `evaluation/`, `baseline/`, and `benchmark/`.

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

## File attachments

In the interactive CLI, drag one or more files from Windows Explorer into the
`You:` prompt and press Enter. The pasted path(s) are attached automatically.
The attachment reader supports text files such as `.txt`, `.md`, `.csv`, and
`.json`, Word `.doc`/`.docx`, and Excel `.xls`/`.xlsx` (including `.xlsm` and
`.xlsb`). Word and Excel content is converted to text before it is sent to the
model. Large files are truncated to a bounded excerpt per file.

For a typed request, use:

```text
/attach "C:\Reports\sales report.xlsx" | summarize the numbers
/readfile "C:\Notes\meeting.docx" | list the action items
```

The CLI receives file paths from the terminal; it does not upload files to a
separate server. The files must remain readable at the path when Enter is
pressed.

For a server that starts automatically with Windows and does not require a
logged-in terminal, run `npm run server:install` once as described in
`วิธีการใช้งาน.md`. Use `npm run server:status` to inspect the scheduled task,
health, and loaded models, or `npm run server:restart` after configuration and
code updates.

1. Start llama.cpp and select a GGUF model:

   ```powershell
   npm run llama
   ```

   The launcher reads the GPU-only IQ2 runtime values from `llamaRuntime` in
   `.cli/settings.json`: 8,192 context tokens, batch/ubatch 128/64, q4_0 KV
   cache, `fit: off`, and `gpuLayers: all`. Set the corresponding `LLAMA_*`
   environment variable in the same PowerShell session before `npm run llama`
   to override one value for a one-off run.

2. After the server reports that it is listening on port `8080`, open another
   terminal and start the CLI:

   ```powershell
   npm run dev:cli
   ```

Settings are machine-local and ignored by Git. The tracked prototype is
`.cli/settings.example.json`. Run `/settings init` inside the CLI to create
`.cli/settings.json` without overwriting an existing file, or copy the prototype
manually before starting llama.cpp.

### OpenRouter

The same CLI can use OpenRouter's OpenAI-compatible chat endpoint. The endpoint
file has two parts: `.cli/api-endpoints.template.json` is tracked and defines
the allowed structure; `.cli/api-endpoints.json` is local-only and is ignored
by Git. Edit only the local file with your real values:

```json
{
  "provider": "openrouter",
  "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
  "bearerToken": "ใส่ OpenRouter key ที่นี่",
  "httpReferer": "https://your-site.example",
  "xTitle": "CLI Project",
  "model": "openai/gpt-4o",
  "requestDelayMs": 1000,
  "reasoning": {
    "effort": "low"
  }
}
```

The CLI reads the local file at runtime, validates its fields against the
template, and turns `bearerToken` into `Authorization: Bearer ...`.
`httpReferer` and `xTitle` become OpenRouter's `HTTP-Referer` and `X-Title`.
`reasoning.effort` controls the model's thinking budget; `low` is the default
for OpenRouter so reasoning models leave room for the final answer. You can
override it with `minimal`, `medium`, `high`, or `none` when the selected model
supports that level.
`requestDelayMs` spaces request starts by the configured number of milliseconds;
use `1000` for approximately one request per second, or `0` to disable the
delay. The default remains `0` when the field is omitted.
The local file is never committed. You can still use the safer environment
override with `OPENROUTER_API_KEY`; do not place a real key in the tracked
template, source code, or logs.

Prototype contents:

```json
{
  "llamaCppPath": "D:\\llama.cpp\\llama-b10012-bin-win-sycl-x64",
  "modelPath": "D:\\Model",
  "provider": "llama.cpp",
  "defaultModel": "Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf",
  "serverHost": "127.0.0.1",
  "serverPort": 8080,
  "apiUrl": "http://127.0.0.1:8080/v1/chat/completions",
  "routerMode": false,
  "modelsMax": 1,
  "contextLength": 8192,
  "device": "auto",
  "hardwareProfile": "auto",
  "llamaRuntime": {
    "fit": "off",
    "gpuLayers": "all",
    "batchSize": 128,
    "ubatchSize": 64,
    "kvCacheType": "q4_0",
    "reasoningBudget": 2048
  },
  "debug": true,
  "historyMessages": 6,
  "terminal": {
    "llmMessageColor": "blue"
  },
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
    "action": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05, "max_tokens": 4096 }
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
$env:LLAMA_RUNTIME_BACKEND = "sycl" # cuda, sycl, vulkan, metal, or cpu
$env:LLAMA_AUTO_DOWNLOAD = "true"
$env:LLAMA_GPU_NAME = "Intel Arc" # optional detection override
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

`terminal.llmMessageColor` controls the foreground color used for the `AI:`
label and the LLM response body. It accepts `black`, `red`, `green`, `yellow`,
`blue`, `magenta`, `cyan`, `white`, their `bright-*` variants, `default`, or a
standard ANSI foreground code: `30`-`37`, `39`, or `90`-`97`. Codes may be JSON
strings or numbers. For example:

```json
{
  "terminal": {
    "llmMessageColor": "bright-blue"
  }
}
```

Set `NO_COLOR` in the environment to disable all terminal coloring regardless
of this setting. Completed `[step x/y]` messages are followed by a blank line
so consecutive agent actions remain visually separated.

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
For Qwen reasoning models, `llamaRuntime.reasoningBudget` maps to llama.cpp's
thinking-token budget (`LLAMA_ARG_THINK_BUDGET`). A value such as `2048` keeps
tool-call reasoning enabled while preventing a single action from spending
thousands of tokens thinking without emitting JSON; use `-1` for unrestricted
reasoning.
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
| RTX 4070 SUPER | CUDA | 8,192 | 128 / 64 | q4_0 |
| Generic Vulkan | Vulkan | measured per device | 512 / 256 | f16 |

The Arc value was measured on the local Arc 140T 16 GB: changing ubatch from
128 to 256 raised pp512 from 86.02 to 116.65 tokens/second while tg128 remained
stable at 7.63–7.74 tokens/second. The local RTX IQ2 profile uses q4_0 KV
because the card has 12 GB VRAM and the model plus a long KV cache can leave
little room for compute buffers. Intel Arc desktop cards vary between 8 GB and
16 GB; on an 8 GB model, prefer a 7B-class Q4 model or expect partial CPU offload.

Accelerator launches now request `--fit off` and `--gpu-layers all` so llama.cpp
does not silently spill model layers to CPU/RAM. This is an intentional
GPU-only attempt: if model weights, KV cache, and compute buffers do not fit,
startup can fail with CUDA OOM. `LLAMA_BATCH_SIZE`, `LLAMA_UBATCH_SIZE`, and
`LLAMA_KV_CACHE_TYPE` override the runtime profile. Run
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
active per-slot context reported by llama.cpp. With the current GPU-only
configuration, startup can fail with CUDA OOM instead of lowering the value
through automatic fitting.

Inside the CLI, `/debug on` displays each agent action, its short decision
summary, and whether the tool succeeded. The full redacted trace is rotated
daily as `.cli/logs/agent/agent-trace-YYYY-MM-DD.jsonl`; model-generated file content and
common secret fields are omitted. This trace is an operational summary, not
the model's private chain-of-thought. `/clear` starts a clean task context while
keeping the saved session history on disk.

Use `/log` to refresh `.cli/log-viewer.html` from the latest agent traces,
model responses, and saved sessions. The same viewer can be generated outside
the interactive CLI with `npm run logs:view`.

Use `/color` to show the current LLM message color and supported values, or
`/color <name-or-code>` to update `terminal.llmMessageColor` in
`.cli/settings.json` immediately.

Agent mode also writes every raw model message to daily files named
`.cli/logs/agent/agent-model-responses-YYYY-MM-DD.jsonl`, including the requested response
format, finish reason, parsed action, and parse failure reason. This local file
is ignored by Git and can contain model-generated content from the active task.
The generated log viewer presents saved `reasoningContent` in a collapsed
**Thinking** section that can be opened per response. It renders the complete
saved text without a viewer-side preview cut and labels responses whose
`finish_reason` shows that the model itself reached its output limit.
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

Agent mode maintains an incremental project index at
`.cli/cache/project-index-v1.json`. The index records eligible paths, project
roots, manifests, languages, file kinds, imports, exported symbols, and bounded
text excerpts. It uses Git's tracked/unignored file set when available, falls
back to a bounded filesystem walk, and reuses unchanged entries by file size and
modification time. Secret-shaped files, generated output, dependencies, logs,
and cache directories are not persisted. The system prompt receives only a
compact project summary. When a relevant path is unknown, the model calls
`search_project` to receive ranked JSON results and then calls `read_file` for
the authoritative current content. Successful file mutations and commands mark
the index dirty, so the next indexed search refreshes added, changed, and removed
files without rebuilding unchanged records.

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

After inspecting the workspace, the model may use `refine_task` with exact
successful workspace Evidence IDs when those files disprove an initial evidence
requirement. Refinement may adjust verification, evidence, intent, and success
criteria, but cannot change the task type or read-only/write scope. This lets a
console or network task remove an incorrectly inferred visual gate without
weakening genuine UI work.

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
If a reasoning model consumes the limit before emitting any action JSON, the CLI
records a distinct reasoning-only truncation, retries with a compact action-only
instruction and a temporarily expanded output allowance, and permits at most two
consecutive specialized retries. This prevents both blank tool turns and an
unbounded recovery loop. The default action output allowance is 4,096 tokens.

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

`run_command` supports optional output assertions through
`expect.output_includes` and `expect.output_excludes`; an exit code of zero does
not pass when an explicit assertion fails. Normally interactive package
lifecycle commands remain blocked. For a necessary bounded runtime check, the
model can select `mode: "probe"` with a 1–30 second `timeout_ms`; the process
tree is terminated at the deadline and output observed before termination is
retained. A grounded output assertion that passes may verify startup behavior.
A long-running probe without such an assertion is recorded as inconclusive,
not as a project failure and not as proof of an interaction. Browser-opening
flags and direct URL launchers remain blocked in probe mode.

Interactive output separates the colored `AI:` label from the response body for
readability. Diff previews use red removed lines and green added lines when
stdout is a color-capable TTY. `NO_COLOR` or `TERM=dumb` disables ANSI colors,
and persisted traces remain plain JSON without terminal escapes.

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
The agent protocol also supports `completion_status: "incomplete"` when
implementation progress is preserved but a required verifier is unavailable.
If the model repeatedly claims completion after an inconclusive verification
blocker, the host converts the second unsupported final attempt into an honest
incomplete result instead of opening another recovery loop.
An equivalent `refine_task` contract is rejected as a no-op and does not reset
loop history. If the model alternates no-op refinement with an exact command
already known to fail, the second blocked retry ends with an incomplete result;
a real workspace mutation clears that command quarantine so the original check
can be run again against the new state.

User-level skills live at `~/.codex/skills/<name>/SKILL.md` and are available in
every workspace. Project-local skills live at `.cli/skills/<name>/SKILL.md`; a
project-local skill overrides a user-level skill with the same name. Both require
`name` and `description` frontmatter. Run `/skills` to list all available skills,
invoke one explicitly as `$skill-name`, or let metadata relevance select it. Only
selected skill bodies enter model context. The included `$local-cli-maintainer`
skill captures this project's maintenance and verification workflow. Type `$`
followed by any part of a skill name to open inline suggestions. Use Up/Down to
select, Enter to run a slash command, Tab to insert without running, and Escape
to close the menu. Enter inserts skill and model values so they can be reviewed
before submission.

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
answers under `.cli/logs/baseline/baseline-model-*.json`. The second repeats the same
agent action request five times by default and records JSON validity, tool selection
stability, and concise-reason coverage under `.cli/logs/baseline/baseline-agent-*.json`.

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
plus server logs under `.cli/logs/server/`; startup failures and probe timeouts are
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

`LLAMA_API_URL` is the explicit switch to external-API mode. A non-loopback
`apiUrl` in JSON settings also selects external mode. The prototype's loopback
URL is treated as the local endpoint, so it does not prevent `npm start` from
provisioning a local runtime.

The legacy Windows-only launcher remains available as `npm run dev` when its
interactive model picker, router mode, or Windows-specific hardware tuning is
needed.

Type `/model` to load inline model suggestions from the router. Use Up/Down to
select, Enter or Tab to insert, then Enter again to switch. Press Escape before
Enter when you want the status/list view without selecting a suggestion.

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
