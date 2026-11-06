---
"@hames-ai/harness-patterns": patch
"@hames-ai/harness-baml": patch
"@hames-ai/agents": patch
---

**One resolved intent per turn (#1006).** A chain that runs `compactIntent` before a `decisionLoop` now has the loop read the brief off the `intent_compacted` event THIS turn emitted (never a `scope.data` value carried across turns): it heads the decisions model's state as `Resolved intent (this turn): "…"` and is written into every route child's `data.intent`. A skipped (first-turn) event threads nothing, so a first turn is unchanged. The `retriever` treats a present, non-empty `data.intent` as its query and skips its `RetrieveQuery` rewrite; absent or empty, the previous ladder applies. `actorCritic`'s critic receives the earlier conversation as the same labelled data block the actor reads, after the task and route scope. Data fencing in the intent path is tightened (`formatPlanContext`'s conversation block; `CompactIntent`'s history and `createCompactIntentAdapter` in `@hames-ai/harness-baml`). In `@hames-ai/agents`, `general-next` runs `compactIntent` first; its synthesizer keeps the user's own message as `intent`.
