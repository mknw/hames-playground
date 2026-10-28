---
"@hames-ai/harness-patterns": minor
---

**`decisionLoop` stops offering a route that keeps making no progress.** In one recorded turn, every read of a route failed, and the route was dispatched six times. Each child honestly reported the failure, its record read `succeeded`, and the turn reached its bound without answering ([#606 (comment)](https://github.com/mknw/hames-playground/pull/606#issuecomment-6447533657), scenario 08; #809).

- A route is withheld from the decision's options for the rest of the turn once two of its records in a row made no progress. A record makes progress when it succeeded and at least one of its own tool results came back `success: true`. `expandPreviousResult` does not count, and a retriever's result counts as its call. For a `planner`, a plan is progress. A failed record, a record with no tool call, and a record whose every call failed (an egress refusal included) make no progress. On an attended turn, a held call is sent again once the person answers; its placeholder is not counted, only the re-sent call's result is. The count is per route and resets when another route's record, or a record of the same route that made progress, comes between.
- This is the planner guard's mechanism (#692): only the option set changes, and the state is the same. `answer` is never withheld. When it is the only option left, the loop ends as `answer` without a decision and without an error. `decision_made.labels` shows which options each decision was offered.
- The rule reads only the run's records, so the next turn offers the route again, and a resume, which rebuilds the records, withholds what the live run did. It binds an `allowReplan` planner too, after two failed plans in a row. It has no configuration.
- `RouteStats` gains `succeededCalls`, which the step line does not show.
