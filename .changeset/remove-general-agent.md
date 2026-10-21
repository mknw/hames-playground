---
"@hames-ai/agents": minor
---

**Breaking:** remove the `general` agent. `generalAgent` and the
`@hames-ai/agents/agents/general.server` module are gone, and the package now ships five
agent definitions instead of six. `general` was a planner followed by one loop over every
tool the gateway listed, with no injection guard, so it was the one agent that could read
fetched web content and write the shared memory graph in the same turn.

Migration: register `generalNextAgent` (it needs `deps.withSandbox` and
`deps.createRedisBackend`) wherever you registered `generalAgent`, and keep resolving the
old `general` id to it so stored conversations and scheduled routines still open (the
reference host does this in one map entry). No other agent takes the whole tool surface:
each takes a namespace slice, and `general-next` is handed only the read tools of the
memory namespace.
