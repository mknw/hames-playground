---
"@hames-ai/harness-patterns": minor
---

`decisionLoop` no longer offers a `planner` route straight after its own iteration, nor once a plan exists this turn (#692). A decisions model that favours `think` took it on all six iterations of a recorded run and never answered; the guard removes the label from that decision's spec rather than asking the model nicely. Behaviour change: a loop that relied on replanning within a turn sets `allowReplan: true` on that route. If only `answer` is left the loop ends as `answer` without asking.
