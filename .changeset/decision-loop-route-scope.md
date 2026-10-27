---
"@hames-ai/harness-patterns": minor
---

**An `actorCritic` route's critic judges the route's share of the request, not the user's whole message.** Inside a `decisionLoop`, the critic is the route's only exit, and it read the user's latest message as its intent: a request spanning several steps ("…save lantern-analysis.md, index it for this chat, and offer to answer questions") had every complete attempt rejected for parts no tool of the route performs, until the route's bound ran out (#606 run 7, scenario 14).

- `decisionLoop` hands an `actorCritic` route's child `data.routeScope`: that route's own agent-map entry (description, `capability`, tools) under `ROUTE_SCOPE_HEADING` (exported), then the rule that the rest of the request is other steps' work and the reply is written after the last step. No other kind of route is handed it; `data.intent` stays unset.
- `actorCritic` appends `data.routeScope`, after a blank line, to its task (`data.intent`, else the user's latest message) and hands that one intent to its actor and its critic. Without a scope the intent is byte-identical to before. `ActorCriticData` gains `routeScope?: string`.
- Under `withPseudonymisedInputs` the scope is child data like the rest: rewritten, or dropped on the fail-closed path.
