---
'@hames-ai/harness-patterns': minor
'@hames-ai/sandbox': patch
---

Give actor/critic verdicts fresh workspace output evidence and record successful output promotion with filenames. The critic receives the output listing and its diff from the pre-turn snapshot; promotion still happens after execution. The new `outputs_promoted` event is always committed and renders only a count into model-facing event views. Exhaustive `EventType` consumers must handle the new member. Workspace wrappers supply the optional, scoped `criticContext` callback through the run frame.

Retain durable side-effect events when a pattern throws, including through `chain`, `routes` and `parallel` child scopes, without committing its partial content or result. Each sandbox execution scope supplies its own observation, leaving non-sync scopes without workspace evidence and restoring the enclosing observation on exit.
