---
"@hames-ai/harness-patterns": minor
"@hames-ai/sandbox": minor
---

Add `decisionLoop(routes, config)` (#507 S1): a loop over routes in which the systemone `decide` seam picks the next route each time round, until it picks `answer` (a choice that runs nothing, so the synthesizer answers once) or `maxIterations` is reached. Exports `DECISION_LOOP_MAX_ITERATIONS` (6) and the record/stat types.

- Each child runs in its own synthetic context and `viewConfig`, with events of siblings it may not see (`siblingResults`, default none) and the loop's own records physically removed, and with fresh `data` (never `memories`, `memoryContext` or `intent`).
- A route's output is a record built by code from the child's committed events by route kind (`simpleLoop`, `actorCritic`, `retriever`, `planner`), never reading `content_sanitized`. Its `result` and `reasoning` are capped; the loop sanitizes and screens nothing of its own (tool bodies it quotes keep the fence they arrived in). A screen that threw at ingress is typed `screenUnavailable` on `SanitizeReport` and `SanitizeSummary`.
- `formatPlanContext(plan, handoff?)` renders earlier-step results under their own data heading, outside the PLAN section; `planner` reads `data.handoff` and `data.agentMap` into its existing `context` argument. With neither, both are byte-identical to before.
- A non-decision never dispatches a route: an irrecoverable visible error on iteration 1, a stop-as-answer on a later one. A failed route is a failed record and the loop decides again; a child's `error` events are committed as `recoverable`.
- New `PatternCapabilities.tools` (declared by `simpleLoop`, `actorCritic` and `withSandbox`, which now always declares its in-VM tool names and merges over the wrapped pattern's capabilities) and `collectToolNames`.
- Export `unspotlight(text)` from `@hames-ai/harness-patterns/guard`: strips one guard spotlight fence, for readers that excerpt fenced text. `decisionLoop` refuses routes that share a `patternId` (or use the loop's own).
- A `planner` route is offered once per turn: withheld straight after its own iteration and once a plan exists, so a decisions model that favours it cannot spend the bound on planning (#692). `allowReplan: true` on the route opts out (planner routes only; refused elsewhere). With only `answer` left the loop ends without asking.
- `decisionLoop` requires an explicit `patternId` (its records and withheld ids are matched by it across turns) and hides earlier turns' events by the route they were emitted inside, so patterns rebuilt each turn with generated ids cannot leak.
