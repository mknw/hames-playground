---
"@hames-ai/harness-patterns": patch
"@hames-ai/harness-baml": patch
---

`actorCritic` no longer re-runs a tool call only to mark itself done (#784 item 7). An `is_final` action that exactly repeats the previous attempt's single successful call is not dispatched: the attempt log records the repeat with the result already held, and the critic judges that. The actor prompt now states this.
