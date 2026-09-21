# ADR-0006: Rails-style pre/post checks are the wrong shape for guards

**Date**: 2026-09-21 — the date the decision was taken
**Status**: accepted

`guardrail(pattern, { rails })` wrapped a pattern in input/execution/output
rails plus a redis-backed circuit breaker, and it was the obvious place to put a
prompt-injection defence. It cannot be one: both loop patterns build the
controller's turn log from tool results **directly**, so a check that runs
before or after a pattern sees content only after the model has, and a
`RailResult` can block, warn or retry but never REWRITE what the model already
read. The only seam where untrusted content can be neutralized before a model
sees it is the tool chokepoint — `mcp-client.server.ts`'s `callTool`, where
`withInjectionGuard` already acts — so the runner, its three rails, the breaker
and the sibling `hook()` were deleted rather than repaired, and a rails runner
is not to be re-proposed.

## Considered options

- **Repair the runner instead.** Rejected on the audit's own numbers (issue
  [#242](https://github.com/mknw/hames-playground/issues/242#issuecomment-5760395572),
  run by mutation rather than by reading): exactly one of eight phase/action
  combinations was honoured; the `'execution'` phase was never dispatched, so
  the shipped `pathAllowlistRail` never ran; input rails read
  `scope.data.input`, a field `PatternScope` does not declare and nothing
  assigns, so `piiScanRail` always scanned `''`; an output rail's `'block'` and
  `'redact'` verdicts were dropped on the floor with no event; and
  `hook.trigger` was a label nothing dispatched on. **Zero production callers** —
  no shipped agent was relying on any of it. Repairing all of that would have
  produced a working version of the wrong shape.
- **Keep it as a composition example.** Rejected: its own `@example` recommended
  the dead rail, so a reader who followed the documentation got silent
  non-protection from the one rail that looks like a sandbox path guard. That
  matters more, not less, once these primitives ship as a library an outside
  developer installs (#225).

## Consequences

- Guards are declared on a **run-level guard manifest** and act at chokepoints;
  reactions to guard events subscribe **by event type** rather than by wrapping
  a pattern. Design: issue #242, "Guardrails — converged design".
- `guardrail` and `hook` stop being patterns. Their `DEFAULT_ERROR_SEVERITY`
  entries, both barrel exports, the combinator listings, the SPEC sections and
  the GLOSSARY line naming them went with the modules, and
  `withInjectionGuard`'s header no longer argues against a sibling that exists.
- An architecture review that proposes a rails runner is re-litigating this
  record. The move is to supersede it, not to reintroduce one.

## Sources

Recorded the day after the decision. Rationale mined from issue **#242**: the
rail audit (`issuecomment-5760395572`), which is the evidence cited above, and
the converged design (`issuecomment-5768168881`, "Guardrails — converged
design", §1 "Delete and record"), which is the owner ruling of 2026-09-21 that
this record and its deletion PR carry out.
