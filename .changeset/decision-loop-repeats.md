---
"@hames-ai/harness-patterns": patch
---

**`decisionLoop` counts a repeated result as no progress.** A route's record whose `result` is, character for character, the result of an earlier record of the same route this turn is a repeat: it makes no progress under the #809 repeat rule, so two in a row withhold the route for the rest of the turn, and its step line reads `succeeded, but returned the same result as step N: no new information`. In a recorded document question the retriever, whose query is the user's message every time, returned the same hits six times until the bound. `RouteOutput` gains `repeats` (the iteration repeated), and `repeatOf` is exported from `decisionLoop-records.server`. Records rebuilt on a resume carry it as the live run did.
