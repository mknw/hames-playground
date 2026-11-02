---
"@hames-ai/harness-patterns": minor
---

The metrics fold counts `tokenPricedCalls` (priced steps with no time-priced attempt — the scopes cache figures describe), plus `toolCalls` / `toolFailures` folded from `tool_call` / `tool_result` events. The dashboard route uses these to hide cache cards on a purely wall-clock-billed scope and to surface tool-call counts.
