---
name: local-cli-maintainer
description: Maintain and extend this TypeScript local AI CLI, including its agent loop, terminal interaction, llama.cpp launch scripts, MCP servers, session handling, validation, and regression tests. Use for changes to cli/, scripts/, mcp/, .cli/settings.json, package scripts, or terminal-agent behavior.
---

# Local CLI Maintainer

## Workflow

1. Inspect the relevant implementation and existing tests before editing.
2. Preserve the active workspace boundary for every file operation.
3. Keep terminal feedback inline and layout-stable; do not introduce fixed ANSI scroll regions.
4. Keep model actions schema-constrained and host validations deterministic.
5. Add or update offline regression coverage for every behavior change.
6. Run `npm test` and `git diff --check` before reporting completion.

Use `npm run test:web` only when the change affects public web search. Use
`npm run baseline:agent` only when a running llama-server is available and the
change affects the model action protocol.

For model-generated file writes, retain diff preview, checkpoint, `/undo`, and
post-write validation behavior. Never report a successful write while its
validator is failing.
