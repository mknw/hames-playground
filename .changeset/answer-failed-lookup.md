---
"@hames-ai/agents": patch
---

general-next: when a route this turn already ran and its result reports the lookup could not be done (an error, not merely nothing found), the `answer` criterion tells the decisions model to answer with that reported failure instead of dispatching the route again. Fixes a case from end-to-end testing ([#606 (comment)](https://github.com/mknw/hames-playground/pull/606#issuecomment-6447533657)): the decider re-dispatched info-retrieval six times over a child that had already honestly reported the failure.
