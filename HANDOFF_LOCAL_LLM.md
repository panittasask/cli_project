# Local LLM Agent Handoff (compact)

Updated: 2026-07-20
Last code commit before this handoff: `9c1a44b`

## Mission and decision boundary

Make the **local** coding agent reliable before considering an API, a language
rewrite, or fine-tuning. The bottleneck is model inference and avoidable model
turns, not TypeScript.

- Keep the CLI in TypeScript.
- Keep Qwythos 9B as default for now.
- Judge models by deterministic, verified correctness first; measure RTX latency
  separately later. Intel Arc speed is not a model-quality score.
- Do not train/fine-tune Qwythos yet. A GGUF Q8 is for inference, not a training
  checkpoint. Only consider a LoRA after the host loop is stable and there are
  roughly 100--300 reviewed trajectories plus a held-out evaluation set.

## Current state

- Default model: `D:\\Model\\Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf`
- Daily setting: 16K context, `standard` profile, max 12 turns / 8 min.
- Tested candidates:
  - Qwythos: passed the FeatureLink integration fixture under equal quality
    budget; failed the invoice percentage-repair fixture.
  - Qwen2.5-Coder 14B Q4: failed both fixtures; do not promote yet.
  - Unevaluated: `D:\\Model\\Qwen3.5-9B-Q4_K_M.gguf` and
    `D:\\Model\\gemma4-coding-Q4_K_M.gguf`.
- Latest key host fix: the invoice evaluator now rejects any mutation of its
  verifier. Both current models still misread percentage tax, so the next useful
  implementation work is a **single bounded diagnostic-repair loop**, not more
  unrestricted review turns.
- Intel Arc preset was measured; RTX 4070 SUPER preset is only a conservative
  starting point until benchmarked using CUDA on that machine.

## First task after moving machines

1. Clone/pull `main`, install Node dependencies (`npm ci`), and copy local-only
   `.cli/settings.json` if paths differ. It is intentionally ignored.
2. Point `modelPath` and `llamaCppPath` at the new machine, then run:

   ```powershell
   npm test
   npm run benchmark:hardware
   ```

3. On RTX, benchmark Qwythos first. Do not copy Arc token/s expectations; record
   the resulting preset before changing defaults.
4. Evaluate one new candidate at a time, quality-first:

   ```powershell
   npm run eval:local -- --model Qwen3.5-9B-Q4_K_M.gguf --mode quality
   npm run eval:local -- --model gemma4-coding-Q4_K_M.gguf --mode quality
   ```

   Compare the JSON reports in `.cli/logs/`. A candidate must beat Qwythos on
   several deterministic fixtures before becoming default.

## Next implementation slice (highest value)

Implement and test the recovery behavior below before expanding tools/models:

1. Protect verifier/test artifacts for every live evaluation fixture.
2. Parse failed-test output into structured fields: expected, received, file,
   line, and first actionable diagnostic.
3. After a verification failure, give the model one focused repair action with
   that diagnostic and the relevant source only.
4. Re-run the same verifier. If still failing, stop as incomplete with evidence;
   do not burn more open-ended turns.
5. Add this as a deterministic regression test, then rerun the Qwythos/Qwen
   quality matrix.

Success criterion: the invoice fixture calculates percentage discount and tax
correctly without touching the verifier; repeated/no-progress work must not rise.

## Commands and references

- Full rationale, metrics, presets, and roadmap:
  [`LLM_AGENT_IMPROVEMENT_PLAN.md`](LLM_AGENT_IMPROVEMENT_PLAN.md)
- Project usage and evaluator notes: [`README.md`](README.md)
- Run unit/regression suite: `npm test`
- Summarize recorded agent traces: `npm run report:agent`
- Quality evaluation: `npm run eval:local -- --model <model.gguf> --mode quality`
- Practical/bounded evaluation: `npm run eval:local -- --model <model.gguf>`
- Hardware benchmark: `npm run benchmark:hardware`

## Guardrails

- Preserve user-local `.cli-sessions.json`; never stage it accidentally.
- Do not add hosted API fallback during this milestone: local failures are
  diagnostic evidence, not a reason to hide host-loop defects.
- Do not raise context/turn limits as a workaround.
- Commit only after `npm test` and `git diff --check`; push `main` when clean.
