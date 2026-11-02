---
"@hames-ai/harness-patterns": minor
---

The metrics fold counts `tokenPricedCalls` (metered steps that are not purely time-priced — attempt-level: a mixed step and an unpriced step both count, so a scope of only purely-time-priced steps hides its cache figures), `timePricedMs` (the summed wall-clock of time-priced attempts, `timeRate.durationMs`), and `toolCalls` / `toolFailures` folded from `tool_call` / `tool_result` events. The dashboard route uses these to merge the estimated cost and the caching saving into one tile, hide cache cards on a purely wall-clock-billed scope, fill the freed slot with the GPU compute-time floor, and surface tool-call counts.
