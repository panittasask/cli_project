# CLI implementation checklist

Updated: 2026-07-15

## Phase A — Agent Loop Guard & Budget

- [x] Detect repeated action + arguments and force one re-plan
- [x] Stop a repeated action after the re-plan warning
- [x] Enforce configurable maximum turns, wall-clock time, and completion-token budget
- [x] Show remaining wall-clock budget during agent turns
- [x] Let `Ctrl+C` cancel only the active request without closing the CLI

## Phase B — Reversible file changes

- [x] Show a compact diff preview before each model-generated write
- [x] Save a checkpoint before changing an existing file
- [x] Add `/undo` to restore the latest checkpoint in the active workspace
- [x] Restore the checkpoint automatically when direct-edit validation fails

## Phase C — Project-local skills

- [x] Discover `.cli/skills/<name>/SKILL.md`
- [x] Validate required `name` and `description` frontmatter
- [x] Select skills by explicit `$skill-name` or description relevance
- [x] Load only selected skill bodies into the active Agent prompt
- [x] Add `/skills` to show available skills

## Phase D — Hardware profiles

- [x] Record detected backend/device and selected runtime settings
- [x] Add conservative SYCL, CUDA, and Vulkan defaults
- [x] Add an opt-in benchmark command before automatic performance tuning
- [x] Keep explicit environment/config overrides higher priority than profiles

## Verification

- [x] Offline unit/regression tests
- [x] TypeScript typecheck and diff check
- [x] Live local-model action probe (5/5 stable `read_file`)
- [x] Live web-search smoke test (3 relevant sources; page open verified)

## Suggested next round

- [ ] Add `/checkpoints` and allow choosing an older checkpoint instead of only latest
- [ ] Persist per-device benchmark results and recommend the fastest batch profile
- [ ] Add skill references/scripts progressive loading beyond the `SKILL.md` body
- [ ] Add an interactive `/skill new <name>` scaffolding command
- [ ] Add a compact per-turn token budget to the inline spinner
