---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": patch
---

`compactExecution` (#507 W4): the user's message is read past a `viewConfig.fromPatterns` scope (it is a `harness`-level event, so a scoped synthesizer received an empty `userMessage` and `intent`), and a new optional `threadTurns` widens only the scoped `thread` read, so a follow-up turn keeps the previous turn's committed `decisionLoop` records while the error read keeps its own window and an earlier turn's failed or withheld record is not carried forward. `threadTurns` must be an integer >= 1 and is refused at construction unless `mode` is `'thread'` and `viewConfig.fromPatterns` is set; the user message is read only from `harness`. `general-next` sets `threadTurns: 2`. The records stay sanitized and fenced, and a record withheld by a screen outage stays marker-only.
