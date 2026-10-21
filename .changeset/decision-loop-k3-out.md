---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

**Breaking (pre-1.0, so a minor bump): `decisionLoop` no longer sanitises or screens its own route records.** Guards run where content enters or leaves; a record is built by code from the child's committed events (the model's own plan or Return, a stats line, or a tool-result body that already passed its route's guard) and is only capped. This removes the loop's own call into the run frame's guard, and the planner-only `screenOutput` option that narrowed it (`screenOutput` was added by the unreleased #713 change, whose changeset this entry replaces).

- Removed exports: `DECISION_LOOP_OUTPUT_KEY` and `WITHHELD_SCREEN_UNAVAILABLE` (from the package root and from `patterns`), and the route option `screenOutput`. The unguarded-output warning and its test-only `__resetDecisionLoopWarnings` are gone. A `screenOutput` property on a route is no longer read; TypeScript callers get an excess-property error.
- Removed behaviour: a screen outage no longer withholds a route record (S-d), and `RouteOutput.withheldEventIds` is no longer written. Records an older version persisted still carry `withheldEventIds`, and the loop still reads them back as a filter, so those events stay hidden from every later child.
- The `actorCritic` and `retriever` extractors, which quote tool-result bodies, now put each body back under the provenance fence it arrived in (the same tool and namespace, no regex pass, no screen) after the cap, so it reaches the decisions model and the next child's `plan_context` labelled. A body that arrived unfenced stays unfenced. An `actorCritic` batch is one fenced block per accepted result, no longer one JSON array.
- New: `unspotlightParts(text)` from `@hames-ai/harness-patterns/guard`, the sibling of `unspotlight` that also returns the `tool` and `namespace` the header named. `extract(kind, events, max)` (the records module) now takes the cap as a required third argument and returns every text field already capped.
- Migration: delete `DECISION_LOOP_OUTPUT_KEY` from any guard's `tools` and from imports, delete `screenOutput`, and move any screen you relied on for route records onto the routes' own guards (the tools a route reads). A guard around the whole loop no longer has anything of the loop's to guard; the GUIDE sample shows route guards and no orchestrator guard.
- `general-next` drops the key from its orchestrator guard and `screenOutput` from its `think` route; its office and info route guards keep their screens.
