# The test pyramid, and the one command that runs it

Four layers, each with a named suite, and **each answering a question the layer
below it cannot express**. That last part is the whole design: a layer that is
merely "more of the same, slower" is not worth its wall clock, and a layer whose
gaps are unstated is worse than one that is missing, because its green reads as
a claim it does not make.

| #   | Layer                                                                               | Invoked by                                                   | Needs                                                     | Runs in CI                                |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------- |
| 1   | Unit + integration — modules and components in jsdom, coverage floors enforced      | `pnpm test:run --coverage`                                   | a Postgres, or `CI=1` to skip its DB-backed tests (below) | **yes**; its DB tests on PRs only (below) |
| 2   | App-path e2e — whole conversations through the real server action and the SSE route | `pnpm test:e2e`                                              | Postgres                                                  | no                                        |
| 3   | Browser e2e — Chromium against a real `vinxi dev`, both themes, screenshots, axe    | `pnpm test:e2e:browser`                                      | Postgres, a browser, a dev-server boot                    | no                                        |
| 4   | Live — real inference, real endpoint, real bill                                     | `pnpm eval:harness`, `smoke-verda.ts`, `smoke-verda-load.ts` | a provider key or a GPU endpoint                          | never                                     |

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

|                 | unit              | app-path             | browser              |
| --------------- | ----------------- | -------------------- | -------------------- |
| database        | `hames_test`      | `hames_test_apppath` | `hames_test_browser` |
| dev-bypass user | `dev-bypass-user` | `e2e-app-path-user`  | `e2e-browser-user`   |

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

## Which Postgres a test run may touch

Three databases keep the suites away from each other. They do not keep a run
away from the developer's live server. Every suite's default server was
`localhost:5432`, the compose stack's Postgres. In one session, six agent runs
started `pnpm test:run` without `TEST_DATABASE_URL` and fell back to it. Each was
refused only because its worktree had no password. Orca now copies the
repo-root `.env` into every new worktree, so the next such run could log in,
create or write the `hames_test*` databases on the live server, and share them
with any other lane doing the same.

So every suite resolves its database through one guard before anything
connects: `resolveTestDatabase()` in `app/src/__tests__/test-database.ts`.

| The run has                                          | Unit suite (`pnpm test:run`)                                 | App-path and browser e2e |
| ---------------------------------------------------- | ------------------------------------------------------------ | ------------------------ |
| `TEST_DATABASE_URL`                                  | uses it                                                      | uses it                  |
| `HAMES_TEST_ALLOW_LOCAL_DB` naming **this** checkout | the compose Postgres on `localhost:5432`                     | the same                 |
| neither, and `CI` is set                             | no database: nothing is contacted, the DB-backed suites skip | **refuses**              |
| neither, anywhere else                               | **refuses**                                                  | **refuses**              |

The refusal is an error, not a skip. Its message lists the three ways out. The
opt-in line in it is a placeholder marked owner-only, and the message never
prints the path of the checkout it ran in: its likeliest reader is an agent in a
lane, and a line carrying that lane's own path would be accepted if pasted.

**The owner's one-time change.** Add one line to `app/.env` in your own
checkout. The value is the absolute path of your local checkout directory,
whatever that directory is named. It is not the repository's name. A relative
value is refused, because it would resolve against whichever checkout the run
is in:

```bash
HAMES_TEST_ALLOW_LOCAL_DB='/absolute/path/to/your/hames-playground-checkout'
```

It is a path rather than `1` because a flag would travel. Orca copies
`app/.env` into every new worktree, and a shell export reaches every agent the
shell starts, so a flag would opt every lane back in. A copied path still names
your checkout, and the guard compares it with the checkout the run is in (as
real paths), so in a lane it opts nothing in. The same variable in the
environment works too, and wins over the file.

**A lane, a worktree or an agent** starts a private, throwaway Postgres on a
non-default port and points the run at it:

```bash
docker run --rm -d --name hames-test-pg -p 55439:5432 -e POSTGRES_PASSWORD=test pgvector/pgvector:0.8.0-pg16-bookworm
export TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55439/hames_test
pnpm test:run                # the DB-backed suites run against it
docker stop hames-test-pg    # --rm deletes the container
```

The image is pgvector's postgres:16 (bookworm), not plain `postgres:16`: the
memory DB-backed suites (#419 M4) need the `vector` extension, which ships
only in that image, and every other suite runs on it unchanged. On a plain
postgres image those suites skip instead — and under `TEST_DATABASE_REQUIRED`
that skip is a failure.

Two lanes that each start one need different ports and container names.
`TEST_DATABASE_URL` is one variable for all three suites, so with it set they
share that one database. Their dev-bypass user ids still keep their rows apart
(above).

**No database at all**, as CI's `check` job runs it: `CI=1 pnpm test:run`. The
unit suite's DB-backed tests skip. Their URL then names a Unix socket in a
directory that does not exist, so `pg` fails at once with no TCP connection. It
is never left unset, because `lib/db/client.server.ts` reads an unset
`DATABASE_URL` as the dev database. `pnpm release:check` sets `CI=1` for every
layer. So in a checkout with neither of the first two rows, its unit layer skips
the DB-backed tests and the two e2e layers refuse.

`test-database-guard.test.ts` pins the four rows. `suite-isolation.test.ts` pins
that every suite's default goes through the guard, because a suite that falls
back on its own would go round it.

## The database in CI: pull requests only

The owner's decision (2026-10-03): "postgres to CI yes, but only pre-merge and
not every push." So layer 1 runs in two CI jobs, and the event decides which:

| Job (its check name)              | Runs on                               | Database                                                                              | Layer 1's DB-backed tests | Uploads coverage |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- | ---------------- |
| `typecheck · lint · test · build` | every pull request and push to `main` | none: `CI` is set and `TEST_DATABASE_URL` is not (the third row above)                | skip                      | yes, to Codecov  |
| `test · postgres`                 | pull requests only                    | a `pgvector/pgvector` (postgres:16 bookworm) service, pinned by digest, on port 55439 | run                       | no               |

The second job runs the same `pnpm test:run --coverage` with `TEST_DATABASE_URL`
set to the service, so the guard takes its first row. It is a job of its own
because a service container cannot depend on the event; only a job's `if` can.
It runs the whole suite rather than a list of DB test files, so the next DB
test file is included without anyone having to add it. It runs in parallel with
`check`, so it adds no wall clock to a pull request. Whether a red one blocks
the merge is the `CI-before-merge` ruleset's decision, not the workflow's.

**It fails closed.** A DB-backed test that cannot reach its database reports as
skipped, never as passed: each DB `describe` block opens with
`beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))`, from
`app/src/__tests__/test-database.ts`. This job also sets
`TEST_DATABASE_REQUIRED=1`, which turns that skip into a failure. So the job
cannot go green without running them, whether the service was unreachable, the
database was never created, or a skip condition is simply wrong.
`test-database-guard.test.ts` pins that the job sets it.

**It uploads no coverage.** Codecov compares a pull request's upload with its
base commit on `main`, and a push to `main` never has a database. An upload from
this job would credit every pull request with a rise it did not make, and with
`require_changes` in `codecov.yml`, Codecov would comment on every one of them.
So `check` stays the only `app` upload, and pull requests and `main` are
measured the same way. The higher figure is in this job's log. The floors in
`app/vitest.config.ts` are unchanged and apply to both jobs. They were set
against the run without a database, which is the lower of the two.

Layers 2 and 3 also need a database, and they are still not in CI. That is
deliberate, and pinned: `e2e-not-in-ci.test.ts` and
`browser-e2e-not-in-ci.test.ts` fail if the workflow invokes either suite.

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
| every scenario that picks a tier                                                                     | `toBeChecked()` says the WIDGET moved; the server action persisting the preference was still in flight, so the turn ran on the tier the test thought it was leaving                                                                                                                                                                                                 | `chooseTier()` waits for the persisted `user_prefs` seed row; the switch writes the conversation's own column first, so that row's arrival implies it                                                                                                                                           |
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

The #418 T8 `decision-calibration` scenario, host artifact format and owner-only
live runbook are described in [Decision calibration](decision-calibration.md).
Its hermetic pins do not contact a provider or a database; its live measurement
remains an explicitly owner-triggered layer-4 run.
