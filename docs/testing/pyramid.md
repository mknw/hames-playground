# The test pyramid, and the one command that runs it

Four layers, each with a named suite, and **each answering a question the layer
below it cannot express**. That last part is the whole design: a layer that is
merely "more of the same, slower" is not worth its wall clock, and a layer whose
gaps are unstated is worse than one that is missing, because its green reads as
a claim it does not make.

| #   | Layer                                                                               | Invoked by                                                   | Needs                                                      | Runs in CI             |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------- |
| 1   | Unit + integration — modules and components in jsdom, coverage floors enforced      | `pnpm test:run --coverage`                                   | nothing (DB-backed tests skip themselves without Postgres) | **yes**, on every push |
| 2   | App-path e2e — whole conversations through the real server action and the SSE route | `pnpm test:e2e`                                              | Postgres                                                   | no                     |
| 3   | Browser e2e — Chromium against a real `vinxi dev`, both themes, screenshots, axe    | `pnpm test:e2e:browser`                                      | Postgres, a browser, a dev-server boot                     | no                     |
| 4   | Live — real inference, real endpoint, real bill                                     | `pnpm eval:harness`, `smoke-verda.ts`, `smoke-verda-load.ts` | a provider key or a GPU endpoint                           | never                  |

Layers 1–3 are **hermetic**: no provider key, no GPU, no bill. Layer 4 is not,
and is coordinated by hand.

Each layer's own README is the authority on what it covers and what it does not
— [`app/e2e/README.md`](../../app/e2e/README.md),
[`app/e2e-browser/README.md`](../../app/e2e-browser/README.md),
[`app/evals/README.md`](../../app/evals/README.md). This file holds the two
things none of them can: how they stay out of each other's way, and how to get
one answer out of all of them.

## `pnpm release:check` — the one command

```bash
pnpm release:check              # layers 1 → 2 → 3, stop at the first failure
pnpm release:check --from e2e   # skip the unit layer while iterating
pnpm release:check --only browser
```

It runs the three hermetic layers **in order, cheapest first**, stops at the
first failure, and writes one go/no-go report to `app/evals/reports/` with
per-layer counts and timings — plus a final section listing the **live steps
still owed**. That section is not a footnote. A GO from this command is a
statement about the hermetic layers only, and a report that omitted what it had
not checked would read as a full pass.

Why it stops rather than running everything: a failure below makes the layers
above un-diagnosable. A browser scenario going red because of the bug is
indistinguishable from one going red because of the bug's blast radius. The
report says which layer stopped it and which were therefore not attempted, so a
partial run is never mistaken for a full one.

Counts come from each runner's own machine-readable output (`--reporter=json`),
never from scraping a log — and a result that will not parse is reported as
**unreadable**, never as a zero. "No tests failed" and "I could not read the
output" are different facts and only one of them is a reason to ship.

## Suite isolation — why there are three databases

All three hermetic layers talk to one Postgres, and two of them drive real turns
as the dev-bypass user and then delete "their" rows by that user id. Until #280
the database name and the user id were each **one literal shared by all three**.

That was survivable while nothing ran concurrently. It stopped being survivable
the moment something did: during #277's fix round a browser run and an app-path
run overlapped, each wiped the other's conversations mid-flight, and the
failures named scenarios rather than the collision — which is the expensive kind
of red, because the first thing anyone does with it is re-run and hope.

Two mechanisms now, and both are deliberate:

|                 | unit              | app-path               | browser                |
| --------------- | ----------------- | ---------------------- | ---------------------- |
| database        | `kgagent_test`    | `kgagent_test_apppath` | `kgagent_test_browser` |
| dev-bypass user | `dev-bypass-user` | `e2e-app-path-user`    | `e2e-browser-user`     |

- **The database is the real fix**: separate rows, separate schema, separate
  `initSchema()` backfill. `provisionDatabase()`
  (`app/src/__tests__/global-setup.ts`) creates each on demand, so separating
  cost one `CREATE DATABASE` per suite on a first run. The provisioning _code_ is
  still shared; only the target is not.
- **The user id is defence in depth**: it keeps the suites apart even when
  someone deliberately points two of them at one database with
  `TEST_DATABASE_URL`, which is a legitimate thing to want when reproducing a
  cross-suite bug. It rides `VITE_DEV_BYPASS_USER_ID`, which
  `app/src/lib/auth/dev-bypass.ts` reads through `import.meta.env` — so one value
  moves both halves of the app, and the browser suite (a separate process) can
  reach it at all. It cannot leak into production: the id is only consulted when
  `isBypassEnabled()` is true, which is gated on `import.meta.env.DEV`.

`app/src/__tests__/suite-isolation.test.ts` pins that the three declared
identities stay distinct, by scanning the declarations — no module sees more than
one of them at runtime, which is precisely the isolation being asserted.

The shared `FAKE_TITLE` ("E2E Fake Conversation") is now harmless: the sidebar and
every query are user-scoped, and the users are distinct, so two suites cannot see
each other's rows to confuse. It is deliberately still one literal — the fake is
shared code, and giving it a per-suite title would be a second mechanism for a
problem the first two already close.

## Determinism is a property of the suites, not of the machine (#280)

A flaky net trains people to re-run instead of trust, so a flake here is treated
as a defect in the test rather than as noise. Ten were found and fixed by
mechanism, not by widening a tolerance — the table below has one row each. The
last two are #285's: they survived #283's sweep because each was reported as
"green alone, red under load", which is the shape that reads as an environment
problem and is not.

| Where                                                                                                | The dependence                                                                                                                                                                                                                                                                                                                                                      | The fix                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `injection-guard-redos.test.ts` (layer 1 — the one in CI)                                            | a WALL-CLOCK ratio: 200k cost ÷ 50k cost < 8. On a loaded box the wall clock counts other processes' CPU, and the ratio reached 6.65 at 5× oversubscription with nothing regressed                                                                                                                                                                                  | `process.cpuUsage()` instead — also the right instrument, since a quadratic rule _burns the event loop_ — plus the minimum of three passes, because interference is one-sided. Same load: 3.75–4.02, indistinguishable from idle                                                                |
| `02-cold-start-spinner`                                                                              | every claim was about a turn STILL RUNNING, established with a `cold-start` DURATION, so each assertion raced the fake's clock                                                                                                                                                                                                                                      | a new `hold` fault: the request is PARKED until the test releases it. "Still running" becomes a fact the test established                                                                                                                                                                       |
| `02-cold-start-spinner` (failure half)                                                               | which request the injected 503 hit depended on whether the previous test had left the box warm                                                                                                                                                                                                                                                                      | `wake: false` — the box always wakes, the harness's first call is always the one refused                                                                                                                                                                                                        |
| `04-mid-turn-reload`                                                                                 | "the turn is in flight" was a duration, then spent on a reload + click + hydrate, three steps whose cost is a property of the machine                                                                                                                                                                                                                               | the same `hold`, released explicitly after the post-reload assertions                                                                                                                                                                                                                           |
| every scenario that picks a tier                                                                     | `toBeChecked()` says the WIDGET moved; the server action persisting the preference was still in flight, so the turn ran on the tier the test thought it was leaving                                                                                                                                                                                                 | `chooseTier()` waits for the persisted `user_prefs` row — the exact thing the next turn reads                                                                                                                                                                                                   |
| the browser suite's first two scenarios                                                              | `vinxi dev` transforms the CLIENT module graph on demand, and on a cold vite cache the first paint took over 20s — the project's expect timeout                                                                                                                                                                                                                     | global setup opens the app in a browser once, against the boot timeout, so every scenario's own budget measures the app rather than the bundler                                                                                                                                                 |
| `uno-theme.test.ts` (layer 1 — in CI)                                                                | `presetIcons` loads a multi-megabyte iconify collection lazily, so whichever icon case ran first paid it inside its own 5s test budget — 5004ms in a full-suite run, passing in isolation                                                                                                                                                                           | the collection is loaded in a `beforeAll` with a hook timeout that says what it is for                                                                                                                                                                                                          |
| `injection-guard-coverage-inventory.test.ts` (layer 1 — in CI, and already RED on `main` under load) | same shape: each `it` dynamically imports an agent, and the first one to do so transforms harness-patterns plus the generated BAML client inside a 5s budget                                                                                                                                                                                                        | every agent module is imported in a `beforeAll`, so each test then measures `createPatterns` and the inventory                                                                                                                                                                                  |
| `floating-panel-controls.test.tsx` (layer 1 — in CI, and the GO blocker)                             | a fixed `setTimeout(30)` after every click. A stage change is a zag transition plus a Solid re-render plus at least one `requestAnimationFrame`; measured, that chain takes 1–10ms idle and up to 20ms at 2× oversubscription, before coverage instrumentation. Red in 2 of 5 full-suite runs, green 3/3 alone                                                      | `settle()` — poll the SAME predicate the step asserts on until it holds, anchored on the POSITIVE fact (the stage-trigger label set, `content.hidden`) so the poll cannot return on the pre-click DOM. What is left is a fuse, not a budget                                                     |
| `05-tier-switch` (layer 2)                                                                           | `compactAndSave` is started DETACHED, so a turn resolves with a describe-role call still on the wire — and the fake is a process-wide singleton whose log is cleared between tests. A call the PREVIOUS test started, recorded after this test's `reset()`, is read as this test's: an anthropic-tier describe failing a private-tier routing assertion. Red 2 of 6 | `settleSummaries()` — wait for the persisted row in which every successful tool result carries a summary, the last thing `compactBulkData` does. The call is recorded before that persist, so a settled row proves the call is in the log rather than in flight, and makes `reset()` a boundary |

Three patterns, and no fourth:

1. **Replace a deadline with a synchronisation point** (`hold` + `expectHeld`,
   `chooseTier`'s row wait). "The turn is still running" stops being a race and
   becomes a fact the test established.
2. **Replace the instrument with one that measures the thing you meant**
   (`process.cpuUsage()` for a claim about burning the event loop).
3. **Move a one-time cost out of an assertion's budget** (the client-bundle
   warm-up, the iconify load, the agent-module imports). A per-test timeout should
   measure the test, not the first caller's share of a fixture.

Widening a tolerance would have hidden every one of them, and in most cases would
have hidden the next real regression of the same size along with it. Four of the
ten are worth noticing for a second reason: they are in the DEFAULT CI suite, so
they could red an unrelated PR — one was already failing on `main` under load,
and `floating-panel-controls` is the one that stood between `release:check` and
an honest printed GO.

## Hermetic means hermetic — the fonts (#285)

Layers 1–3 claim to need no network. Until #285 that was not true of any of
them, and the dependency sat somewhere nobody looks for a determinism problem:
`uno.config.ts` declared five families through `presetWebFonts`'s **google**
provider, which FETCHES `fonts.googleapis.com/css2` while UnoCSS builds its
preflights and inlines the result. Every `vinxi dev` boot paid it, and so did
`uno-theme.test.ts` in layer 1 — the merge gate — because
`generator.generate(input, {})` emits preflights.

It failed in two directions, and the preset picks between them on
`process.env.CI`: unset, the failure is SWALLOWED and the app renders in the
fallback stack, which reds all six committed screenshot baselines with a
font-metrics diff that looks exactly like a visual regression; set — which
`release:check` sets for every layer — it THROWS and `vinxi dev` exits 1 before
serving. #283 raised the budget from 2s to 30s, which removed the flake and left
the dependency.

The five families are now **self-hosted from `@fontsource/*`**, at the exact
weights the Google request named (Inter, Roboto Slab and Fira Code at 400;
Lexend Zetta and Lexend Exa at 200), imported as ordinary CSS from
`src/app.tsx`. `presetWebFonts` stays — it is what registers the theme's font
families — with `provider: 'none'`, which emits no import and fetches nothing.
The 30s budget is gone along with the fetch it was budgeting for.
`uno-fonts.test.ts` pins that the generated CSS names no `fonts.googleapis.com`
or `fonts.gstatic.com` URL, so the dependency cannot come back through a config
edit without a red test.

## What none of this covers

- **The production bundle.** Every browser scenario runs under `vinxi dev`,
  because the dev auth bypass is gated on `import.meta.env.DEV` and a built
  server would 401 every turn. SSR-in-production, minification and the built
  server's module graph are untraversed.
- **The auth gate.** Layers 2 and 3 run _with_ the bypass on, so they say nothing
  about an unauthenticated visitor being refused.
- **Model quality, real latency, the real endpoint.** Layer 4's, and the reason
  `release:check`'s last section exists.
- **Concurrency between suites.** Isolation means a concurrent run cannot
  CORRUPT another; it is not a claim that anything is faster in parallel. One
  Postgres and one dev-server port are still shared resources.
