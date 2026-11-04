---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
"@hames-ai/connectors": minor
---

The agent knows the current date and time in the user's time zone. One breaking change to the generated client: a direct `b.Router` / `b.LoopController` / `b.ControllerThinking` / `b.ActorController` / `b.Planner` / `b.PlannerThinking` / `b.Synthesize` caller that passes an options bag must now pass `null` (or a time block) before it; a cast caller otherwise throws `BamlInvalidArgumentError`. No behaviour change for a run with no clock.

- **harness-patterns.** New `clock` module (`TurnClock`, `validTimeZone`, `formatTimeBlock`, `localDate`) and a `clock` slot on the run frame (`RunFrame.clock`, read by `currentClock()`), supplied once per turn by the host. It replaces on amend, like the other single-value slots. The org-knowledge hook's default `today()` is the clock's local date, not the UTC one; with no clock it keeps the UTC day.
- **harness-baml.** Those seven functions take a trailing optional `current_time`, rendered (when non-null) in per-turn user-role content after the last #122 cache marker, never in a system block. The adapters, the router and the synthesizer pass the frame clock's block (`time-block.server.ts`), rendered once per clock.
- **connectors.** `graph_calendar_today` reads the user's day from the turn's clock and sends offset-carrying bounds (`…T00:00:00+01:00`); its naive bounds were read by Graph as UTC, shifting the day by the user's offset. `graph_calendar_range` reads its dates in the turn's zone ahead of `GRAPH_TIMEZONE`. `graph_mail_attachments`' `since` starts at the date's local midnight in the turn's zone (UTC midnight outside a turn, as before). `localDayBounds` is replaced by `localCalendarDay`.
