# Local LLM Agent Improvement Plan

Updated: 2026-07-20

## Goal

Make the local LLM agent dependable for a clearly defined core workload, fast enough
for daily use, and honest when a task is outside its reliable range. The immediate
goal is not full autonomy. It is to complete common tasks with fewer model calls,
less repeated work, and verifiable results.

## Current baseline

The main bottleneck is model inference and the number of model turns, not the
TypeScript runtime. The recorded MTP benchmark improved generation from an average
of 7.887 to 10.479 tokens/second (about 32.9%), while individual agent turns can
still take tens of seconds or minutes.

The 2026-07-16 through 2026-07-17 traces are a small, difficult sample rather
than a complete quality score, but they expose the most important failure patterns:

- 14 tasks produced 521 inferred model calls and 419 tool actions.
- 7 tasks recorded a successful final response (50%).
- Successful tasks used a median of 19 model calls.
- 68 events were classified as repeated or no-progress work.
- The longest task continued for about 59 minutes.
- Frequent failures were repeated edits, unchanged edits treated as failures,
  persistent validation errors, wrong paths/workdirs, and blocked recovery
  questions.
- The original local settings permitted up to 50 turns per segment, 3 segments,
  and 60 minutes. That allowed an unproductive task to reach 150 model turns, far
  above the new standard profile of 12 turns and 8 minutes.

Existing strengths to preserve include response schemas, repeat guards, workspace
boundaries, checkpoints, write validation, project-check discovery, trace logging,
workflow routing, task-context selection, and deterministic completion gates.

## Implementation progress

Completed in the first 2026-07-20 milestone:

- Added `npm run report:agent` for per-task and aggregate trace metrics.
- Added bounded `quick`, `standard`, and `deep` agent budget profiles.
- Changed identical writes and already-applied edits into idempotent success rather
  than recovery errors, without creating empty checkpoints.
- Added ranked nearby-file suggestions when a requested path is missing.
- Added auto-detected `intel-arc` and `rtx-4070-super` launcher presets with
  profile-specific batch, ubatch, and KV cache settings.
- Benchmarked the Arc 140T 16 GB preset. `512/256` reached 116.65 pp512 and
  7.74 tg128 tokens/second, outperforming `512/128` at 86.02 pp512 and 7.63
  tg128, so `512/256` became the measured Arc default.
- Reset the local daily-use profile to 16K context, standard agent budget, and a
  2,048-token action cap.
- Benchmarked the installed Qwen2.5-Coder-14B Q4 candidate on Arc 140T at
  58.78 pp512 and 5.03 tg128 tokens/second. It is slower than Qwythos 9B Q8 at
  116.65 pp512 and 7.74 tg128. A bounded live evaluation subsequently rejected
  Qwen's trial promotion, so Qwythos remains the local default.

Hardware follow-up: the current machine exposes only SYCL llama.cpp builds and
does not expose `nvidia-smi`, so the RTX 4070 SUPER profile is a conservative
starting preset rather than a local measurement. Run the same model and
`npm run benchmark:hardware` with a CUDA build before promoting or changing its
values.

## Current model/provider decision

The current product path is local-first. Do not rewrite the TypeScript CLI and do
not add a remote API adapter during this milestone. Making the less-capable local
path reliable first validates the agent loop without hiding orchestration problems
behind a stronger hosted model:

1. Use Qwythos 9B as the current local default at 16K context. It passed two of
   three preliminary bounded probes and is faster on the current Arc; its MTP
   benchmark reached 10.479 generation tokens/second.
2. Retain `qwen2.5-coder-14b-instruct-q4_k_m.gguf` as a coding candidate, not the
   default. It fits the 16 GB Arc profile and has stable protocol output, but it
   must beat Qwythos on verified tasks before another promotion.
3. Do not promote the installed Qwen2.5-Coder-7B: the existing direct-model
   baseline failed basic general-knowledge probes. Treat the installed Qwen3.5 9B
   and custom `gemma4-coding` quant as unevaluated until their templates,
   provenance, schema reliability, and code tests are checked.
4. Keep remote API integration in the backlog. It is not a fallback for local
   failures during development and is not part of the current acceptance gate.

Qwen Coder is accepted as the daily default only when repeated Tier A/B
evaluations show better verified success per minute than Qwythos. Speed alone does
not decide it.

### Preliminary local evaluation — 2026-07-20

The new `npm run eval:local` runner owns an isolated llama.cpp server, waits for
model readiness and idle slots, bounds every probe, records infrastructure and
model failures separately, and cleans up the process tree. The first comparable
run produced:

| Probe | Qwen2.5-Coder 14B Q4 | Qwythos 9B Q8 + MTP |
| --- | --- | --- |
| Agent protocol, 3 repeats | Pass, 66.8 s | Pass, 49.0 s |
| Read-only Agent E2E | Fail at 150.6 s | Pass, 81.3 s |
| Focused coding E2E | Fail at 300.5 s | Fail at 300.6 s |

Both models reached the 4-minute coding budget near turn 11 of 12 without verified
completion. This is not enough evidence for a permanent model ranking, but it is
enough to reject Qwen's immediate promotion and to prioritize agent-loop and
recovery improvements over another model change.

### Quality-normalized coding rerun — 2026-07-20

Because the Arc makes the 14B model materially slower, the focused coding probe
was rerun in `--mode quality`: both models received the same 12-turn limit, 512
action tokens per call, 16K context, and a generous 15-minute wall-clock guard.
Duration was recorded but was not part of the score.

- Qwen2.5-Coder 14B failed the final deterministic verifier. It imported
  `FeatureLink` but never registered it in `@Component.imports`, and invented a
  field decorator and DOM-handler implementation outside the requested contract.
- Qwythos 9B passed. It imported `FeatureLink`, registered
  `imports: [FeatureLink]`, ran the build and interaction checks, and produced a
  verified completion.

This single fixture is not a complete intelligence benchmark, but it removes the
wall-clock confound from the earlier result and strengthens the decision to keep
Qwythos as the current default. Add more deterministic fixtures before treating
the ranking as general across frameworks and task types.

### Invoice-repair quality fixture — 2026-07-20

The second deterministic fixture uses three invoice totals to require correct
percentage treatment of both discount and tax. Its verifier is immutable during
evaluation and is executed directly by the harness after the agent exits.

- Qwen2.5-Coder 14B changed the discount calculation but left tax as a whole-number
  multiplier. An earlier attempt also edited the verifier expectation, which is
  now explicitly detected as a test-integrity failure.
- Qwythos 9B changed the discount calculation but likewise left tax as a
  whole-number multiplier; the untouched verifier reported 2520 instead of 337.05.

Both models failed the fixture under the equal quality budget. The next host-loop
improvement should protect verification artifacts and turn a numeric failed-test
diagnostic into one bounded, targeted repair attempt rather than more open-ended
reviewing.

## Operating principle

Use the LLM for decisions that require interpretation or code generation. Use the
host for deterministic work such as project discovery, path resolution, state
tracking, idempotency, diagnostic parsing, verification selection, and retry
policy.

Every model call must do at least one of the following:

1. Acquire new evidence.
2. Change the workspace state.
3. Resolve a known diagnostic.
4. Verify an outcome.
5. Produce the final answer.

If a call does none of these, the host should recover or stop without spending
another unrestricted model turn.

## Supported task tiers

Reliability should be reported by task tier rather than presenting every request as
equally autonomous.

| Tier | Workload | Initial target |
| --- | --- | --- |
| A | General answers and explicit file read/explanation | >=95% verified success, <=2 model calls |
| B | Focused one-file edit with an existing check | >=85% verified success, <=5 model calls |
| C | Multi-file change inside one known project | >=70% verified success, <=10 model calls |
| D | New application, framework migration, or cross-project work | Best effort with explicit progress and incomplete-state reporting |

These are initial engineering targets and must be recalibrated after the evaluation
suite has enough runs. A false claim of verified success has a target of zero in
every tier.

## Metrics to record

Record one summary row per task, not only per-turn JSONL entries:

- task tier and workflow
- model, template, quantization, context length, and runtime profile
- verified success, incomplete, cancelled, or failed outcome
- model-call count and tool-call count
- prompt, cached-prompt, and completion tokens
- time to first token, prompt-processing time, generation rate, tool time, and total time
- repeated/no-progress action count
- parse/schema failures
- validation and command retry count
- clarification count
- final verification evidence

The primary product metrics are verified task success rate, median model calls per
successful task, and median total time per successful task. Tokens/second is a
diagnostic metric; it is not sufficient by itself.

## Phase 0 — Establish a repeatable evaluation gate

### Fix

- Turn the incidents already visible in traces into named regression scenarios.
- Separate host-logic tests from live-model evaluations so deterministic failures
  can be reproduced without loading a model.
- Add a task summary generator for existing trace and model-response logs.
- Make live-model runners own the server lifecycle: wait for model readiness,
  bound each probe and the whole matrix, and always clean up child processes.
- Record the active settings and actual llama.cpp slot/context properties with each
  live run.

### Add

- A versioned evaluation set covering Thai and English requests:
  - direct question
  - named-file explanation
  - one exact edit
  - missing path recovery
  - wrong workdir recovery
  - TypeScript/Angular diagnostic repair
  - no-op edit
  - failed verification followed by a relevant fix
  - multi-file feature
  - explicitly impossible or ambiguous task
- A model matrix runner using identical prompts, sampling, context, and hardware.
- A compact report comparing success, calls, duration, tokens, and repeat rate.

### Exit gate

- The same scenario can be rerun and compared across model/runtime changes.
- A server startup failure or timed-out probe becomes a bounded infrastructure
  result rather than a hanging run or an incorrect model-quality score.
- Any claimed improvement includes quality and latency results, not subjective
  transcript inspection alone.

## Phase 1 — Stop wasted turns and make recovery deterministic

This phase has the highest priority because it improves both speed and success rate.

### Fix settings and budgets

- Replace the current 150-turn effective ceiling with explicit profiles:
  - `quick`: read/chat tasks with a small call and time budget
  - `standard`: default coding profile near the tracked 12-turn/8-minute limits
  - `deep`: opt-in only, with a bounded continuation budget
- Reserve at least one call and enough wall-clock time for final verification.
- Use a smaller action output cap; ordinary JSON actions should not have a 4,096
  token allowance.
- Default agent context to a measured 8K or 16K profile. Use 32K/64K only for tasks
  that demonstrate a real need for it.

### Fix action semantics

- Treat "requested content already exists" as an idempotent `no_change` success,
  not as an error that invites the same edit again.
- Attach a file hash/version to reads and edits so stale edit attempts are detected
  before mutation.
- When a path is missing, return ranked nearby matches and the discovered project
  roots in a structured observation.
- When a command lacks or uses the wrong workdir, select the owning project from
  inspected files/manifests deterministically when there is exactly one valid
  choice.
- Quarantine an unchanged failing action for the rest of the task, not only until a
  later write resets generic progress.

### Fix diagnostic recovery

- Parse compiler output into `tool`, `code`, `file`, `line`, `message`, and
  `suggested inspection` fields.
- Keep an unresolved-diagnostics ledger. A diagnostic is cleared only by a relevant
  file change followed by a passing check.
- Reject edits unrelated to the first actionable diagnostic before applying them.
- After two failed corrections to the same diagnostic, force a fresh inspection of
  the referenced source and its imports/configuration; after the bounded recovery,
  stop as incomplete with evidence.

### Exit gate

- No-op edits do not consume another recovery loop.
- Wrong-path and wrong-workdir scenarios recover without asking the user unless
  multiple genuinely valid targets remain.
- Repeated/no-progress actions are below 5% of live evaluation actions.

## Phase 2 — Reduce the number of model calls

At roughly 8–10 generated tokens/second, removing a model call is usually more
valuable than micro-optimizing Node.js code.

### Add host-managed task state

- Maintain a short goal ledger containing requested outcomes, discovered project
  root, required artifacts, pending diagnostics, writes, and remaining checks.
- Include only the changed portion of this ledger in the next prompt.
- Mark completed items deterministically from successful tool observations.
- Prevent the model from recreating an artifact that the ledger and filesystem
  already confirm.

### Add batched operations

- Support one bounded `inspect` action that can read several explicitly listed
  small files and searches in one host execution.
- Support a bounded patch set for related files with preflight validation and one
  checkpoint group.
- Automatically run the known affected finite check after a mutation batch when
  there is exactly one safe discovered check.
- Feed the complete batch result back in one compact observation.

### Reduce prompt overhead

- Generate the response schema from the current state so impossible or irrelevant
  actions are absent.
- Send concise tool descriptions and only the relevant recovery rule.
- Summarize large command output around the first actionable error while retaining
  the full output in the trace.
- Avoid resending unchanged capability lists, project maps, and instructions when
  llama.cpp prompt-prefix caching can reuse them.

### Exit gate

- Median model calls fall by at least 40% on the fixed evaluation set without a
  reduction in verified success.
- A normal focused edit completes in no more than five model calls at the target
  success rate.

## Phase 3 — Select and align the model with the agent protocol

### Evaluate before changing prompts

- Compare every installed candidate on direct-answer quality, JSON/schema
  reliability, tool choice, diagnostic repair, code correctness, and generation
  speed.
- Verify that each GGUF is an instruct/chat model and that llama.cpp applies its
  intended chat template.
- Compare the tracked Qwen coder profile with the locally selected Qwythos profile
  under the same context and sampling settings.
- Test English-only system instructions while preserving the user's original Thai
  request; keep this only if the evaluation set improves.

### Tune by workflow

- Keep deterministic routing in the host rather than spending a model call on it.
- Use low-temperature action sampling and a separately tuned conversational
  profile.
- Add at most one short, failure-specific example when the current state needs it;
  do not place a large universal few-shot block in every request.
- Prefer the model with the best verified-success-per-minute result, not simply the
  highest parameter count or tokens/second.

### Defer remote API integration

- Do not implement provider selection, credentials, billing limits, or automatic
  failover while the local evaluation gate is still failing.
- Keep the internal chat-completions boundary reasonably provider-neutral, but do
  not spend current work on behavior that llama.cpp does not need.
- Treat every local-model failure as evidence about the model, prompt, tool
  protocol, host recovery, or runtime. Do not mask it by escalating to a hosted
  model.
- Revisit API support only after the local Tier A/B targets are met repeatedly. If
  it is added later, it must remain explicit, secret-safe, cost-bounded, and
  privacy-aware.

### Defer fine-tuning

Do not start LoRA/fine-tuning until the host workflow is stable and there is a
clean, reviewed dataset of at least a few hundred successful and failed decisions.
Otherwise the model will learn around orchestration bugs that should have been
fixed deterministically.

### Exit gate

- One default model/profile is selected for agent work from a reproducible report.
- Repeated runs of the same Tier A/B scenario have stable action selection and no
  schema failures.
- The exit gate is achieved using local inference; no remote model is required to
  pass it.

## Phase 4 — Improve actual and perceived inference speed

### Preserve and extend proven runtime work

- Keep MTP/speculative decoding enabled where supported; the existing benchmark
  measured about a 32.9% generation improvement.
- Benchmark 8K, 16K, 32K, and 64K context profiles rather than using 64K globally.
- Persist benchmark results per model, device, batch, ubatch, context, and KV-cache
  mode.
- Keep named starting presets for Intel Arc and RTX 4070 SUPER, but promote a
  different value only after the same model/prompt benchmark wins repeatedly on
  the actual card.
- Select the fastest stable hardware profile automatically, while retaining manual
  overrides.

### Add measurements and delivery improvements

- Capture prompt-evaluation rate separately from generation rate.
- Measure llama.cpp prompt-prefix/KV caching with the repeated agent system prefix.
- Benchmark HTTP keep-alive against the current `Connection: close` behavior.
- Add streaming for chat and final answers to reduce perceived waiting time.
- Show `waiting for model`, `running tool`, and `verifying` as separate timing
  states.

### Exit gate

- The chosen runtime profile is stable across repeated runs and does not trade away
  task success.
- Median total time per successful task improves by at least 30% from the Phase 0
  baseline, with the improvement attributed to measured causes.

## Phase 5 — Add higher-value tools only after the loop is stable

### Add

- Symbol/definition/reference lookup for TypeScript and other supported languages.
- Framework-aware project maps for Angular, React, Go, .NET, and Rust.
- Structured test/build diagnostics instead of raw terminal text alone.
- Resume from a saved task ledger and trace without repeating completed actions.
- A `/doctor` or diagnostics export showing model/runtime/settings/evaluation health.
- Per-workspace capability profiles so unsupported stacks are reported as best
  effort rather than silently guessed.

### Avoid for now

- Rewriting the CLI in Python or Rust solely for response latency.
- Increasing turn, token, or context limits to hide recovery failures.
- Loading the whole repository into every prompt.
- Adding multiple planner/critic model calls before the single-agent loop is
  efficient.
- Fine-tuning on unreviewed traces.
- Expanding autonomous Git or external side effects before core task reliability is
  measured and stable.

## Recommended implementation order

1. Add task-level metrics and the fixed evaluation set.
2. Introduce quick/standard/deep profiles and remove the 150-turn normal path.
3. Fix no-op, missing-path, workdir, and persistent-diagnostic recovery semantics.
4. Add the host-managed goal/diagnostic ledger.
5. Batch inspection, related patches, and deterministic verification.
6. Shrink state-specific schemas, observations, and action token limits.
7. Fix live-model server readiness, probe timeouts, cleanup, and matrix reporting.
8. Run the Qwen Coder/Qwythos model-template-sampling matrix and select the local
   default from verified success per minute.
9. Tune context, MTP, caching, batch settings, connection reuse, and streaming for
   the winning local model on Arc and RTX 4070 SUPER.
10. Add AST/framework-aware tools and resumable tasks.
11. Reconsider remote API support only after the local Tier A/B exit gates pass.

## Definition of "good enough"

The agent is ready for regular use when the fixed evaluation report demonstrates:

- Tier A and B targets are met across repeated runs.
- No verified-success claim is emitted without matching evidence.
- Median model calls are at least 40% below the Phase 0 baseline.
- Repeated/no-progress actions are below 5%.
- A stuck task stops with a precise incomplete report within the standard budget.
- The user can see whether time was spent in inference, tools, or verification.
- Model or runtime changes can be accepted or rejected using one reproducible
  command and report.
