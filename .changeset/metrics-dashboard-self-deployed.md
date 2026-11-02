---
"@hames-ai/harness-patterns": minor
---

The metrics fold counts `tokenPricedCalls` (metered steps that are not purely time-priced — attempt-level: a mixed step and an unpriced step both count, so a scope of only purely-time-priced steps hides its cache figures), plus `toolCalls` / `toolFailures` folded from `tool_call` / `tool_result` events. The dashboard route uses these to hide cache cards on a purely wall-clock-billed scope and to surface tool-call counts.
