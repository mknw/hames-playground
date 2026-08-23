# ADR-0005: harness-patterns replaces `lib/baml-agent/`, which is not to be recreated

**Date**: 2026-01-18 — the date the decision was taken
**Status**: accepted

Two agent frameworks existed side by side: the original `app/src/lib/baml-agent/`
module with its `orchestrator.server.ts` / `patterns.server.ts` /
`planners.server.ts` trio, and `app/src/lib/harness-patterns/`, which had grown a
`UnifiedContext` architecture — one serialisable event stream as the source of
truth, per-pattern isolated scopes that commit on completion, and `EventView` for
querying it. `baml-agent/` was deleted rather than kept as a deprecated path,
along with its API route, its docs directory and the UI components that only it
fed, because two frameworks answering the same question is how the answer stops
being knowable.

The "must not be recreated" half is the part worth recording: the shape
`baml-agent/` had — BAML calls wrapped in per-operation planner functions behind
a monolithic orchestrator — is the obvious thing to reach for again, and reaching
for it re-splits the session state that `UnifiedContext` exists to unify.

## Considered options

- **Keep `baml-agent/` deprecated but present.** Rejected: a live import path is
  a live framework. It would have kept two event models and two serialisation
  formats alive with no consumer able to tell which was current.
- **Port `baml-agent/`'s orchestrator onto `UnifiedContext`.** Rejected: the
  orchestrator's value was its high-level entry points, and those re-express
  cleanly as `harness(...patterns)` composition. There was nothing left to port.

## Consequences

- All agentic work goes through harness-patterns. New agents are an
  `AgentConfig` in `app/src/lib/harness-client/agents/` registered in
  `registry.server.ts` — there is one place to add one.
- The deletion took `/api/agent/[sessionId]`, `docs/baml_agent/` and
  `EventDetailOverlay` with it; anything reaching for those in old branches or
  old notes is reaching for a framework that no longer exists.
- BAML functions are passed **directly** to patterns rather than through wrapper
  planners — which is why they must be bound (`b.Neo4jController.bind(b)`) to
  preserve `this`. The `.bind(b)` requirement is a direct consequence of dropping
  the wrapper layer.

## Sources

Back-filled. Rationale mined from commit `a5e57b9` (2026-01-18, `refactor: Remove
deprecated baml-agent module and legacy harness files`), which enumerates the
removals and states the supersession by "the harness-patterns framework with
UnifiedContext architecture"; and commit `49df929` (same day,
`feat(harness-patterns): Add UnifiedContext architecture with scoped patterns`),
which is what made the replacement viable. The standing disposition — including
the explicit "Do not recreate it." — is the "Agent framework" bullet under
**Design Decisions** in `CLAUDE.md`; the current architecture is documented in
`app/src/lib/harness-patterns/README.md`.
