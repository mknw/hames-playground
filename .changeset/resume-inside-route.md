---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": patch
---

**A pause can be resumed inside a route (decision-loop-agent.md slice 6).** After an answer, the run continues inside the pattern that paused, from the held call, instead of re-entering the paused top-level pattern from its start.

- New capability `resumable` (`PatternCapabilities.resumable`): `decisionLoop`, `simpleLoop` (when it records its rounds under an explicit `patternId`), `withReferences`, `withInjectionGuard`, `withEgressGate` and `withPseudonymisedInputs` declare it; `actorCritic`, `withSandbox`, `parallel`, `routes` and `chain` do not. A wrapper that spreads the pattern it wraps does not inherit it (`ownResumable`).
- Each request records a `continuation`, the resumable path from the top-level pattern to the gate. `checkResume` follows it through the current composition before any `resolve`; an absent, changed or non-resumable path is `chain-changed`. A pause below a top-level pattern that is not resumable keeps the 0.x re-entry from its start.
- On re-entry `decisionLoop` rebuilds its records, latest plan and roster inputs from its children's brackets and re-enters the paused route with no decide call; `simpleLoop` rebuilds its turn log, turn count and recovery streak through the one projection its live rounds use; `withReferences` re-attaches its recorded selection without calling the selector. No earlier tool is dispatched again.
- `decisionLoop` children's `pattern_enter` carries `iteration`, and a paused child's `pattern_exit` says `paused` and carries `wallMs`.
- New `gatedTools` (on `decisionLoop`, and as a capability): construction refuses a gated name in any allowlist whose path from the root is not resumable all the way down, or in a loop that does not record its history (`refuseUnresumableGates`, also run by the harness entry points); `simpleLoop` refuses a batch that holds one before dispatching any of its calls.
- `withReferences` now records its `reference_attached` selection by default, and that event serializes as counts only, never its candidates' summaries or the selector's reasoning. A `loop_recovery` for an unparseable answer carries the `feedback` the next round was given; a skipped batch call's `tool_result` carries `skipped: true`.
- A host's own wrapper joins the path with `wrapperResumable` and `resumableStep`.
