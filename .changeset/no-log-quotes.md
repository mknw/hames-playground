---
"@hames-ai/agents": patch
"@hames-ai/connectors": patch
"@hames-ai/harness-patterns": patch
"@hames-ai/harness-baml": patch
---

Remove text taken from real conversations and a real tenant from shipped source. Comments in `general.server.ts`, `sandbox.server.ts`, `json-repair.ts` and `types.baml` no longer quote a user's request, a model's status line or a captured payload; they describe the case instead. In `@hames-ai/connectors`, the `graph_mail_attachments` tool's `person` description now gives a placeholder name as its example (`e.g. "Adele"`), and two comments use placeholder names and a placeholder attachment title. No behaviour changes.
