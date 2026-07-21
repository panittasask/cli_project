# Agent implementation rules

## Intent handling

- Never hard-code individual user phrases, greetings, names, languages, or one-off examples to select an intent, workflow, tool, verification requirement, or response format.
- Infer intent semantically from the complete current request and relevant session context. The model's refinement/action decision is the source of truth for ambiguous natural-language requests.
- Deterministic rules may be used only as narrow safety fallbacks (for example: path containment, destructive-action confirmation, schema validation, and explicit slash commands). They must not override a semantic conversational decision merely because it contains a keyword.
- Every intent-routing change must include regression cases for both the reported failure and a nearby genuine workspace task, without encoding the reported phrase as a production special case.
