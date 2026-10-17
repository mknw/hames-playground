---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": patch
---

A turn whose every tool call failed and which then `Return`s an answer from context keeps that answer (#614). `compactExecution` thread mode carries the `Return` text as the new optional `CompactExecutionInput.returnText` beside the error history, and `defaultSynthesize` appends it as a final turn. A turn with any successful call is unchanged.
