# Roadmap

## Next

1. Add context budget warnings and automatic history compaction before a request approaches the active llama.cpp context limit.
2. Let an agent resume an interrupted or max-step task from its saved trace without repeating completed tool actions.
3. Detect llama-server exits during generation and offer a controlled restart using the configured executable, model, device, and context settings.
4. Add configurable agent step limits and a completion checklist so verification work is reserved before the tool budget is exhausted.
5. Add end-to-end model profiles for the installed GGUF files, including Qwythos, with JSON-action reliability and tokens-per-second comparisons.

## Later

1. Add a dry-run diff review for multi-file edits before applying them.
2. Add per-workspace command policies for write operations, process execution, Git commits, and pushes.
3. Export session usage and agent traces as a compact diagnostics report.
