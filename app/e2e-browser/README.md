# Browser e2e — a real browser, driving the real app

Run this **whenever anything a user can see changes** — a chat component, the
header strip, the progress bar, the theme tokens, the SSE client, the sidebar —
to find out whether what a person actually looks at still works.

```bash
# from app/
pnpm test:e2e:browser                          # the whole suite
pnpm test:e2e:browser e2e-browser/scenarios/02-cold-start-spinner.browser.ts
E2E_BROWSER_SERVER_LOG=1 pnpm test:e2e:browser # stream the dev server's output
```

## Why it exists

Because the failures that kept reaching the owner all had the same shape: a turn
that is **fine on the wire and wrong on the screen**. A spinner that never
clears. A conversation that visually never starts. A reload that looks like it
destroyed everything. Every one of those passed the layers below.

That is not those layers being bad at their jobs, it is them being the wrong
instrument:

| layer                                        | what it drives                                                       | what it cannot see                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/__tests__/` (CI)                        | components in jsdom, with a fake app underneath                      | that the app the component talks to behaves that way; that anything is _painted_ |
| `app/e2e/`                                   | whole conversations through the real server action and the SSE route | anything a browser does — no DOM, no reload, no click, no cascade                |
| **`app/e2e-browser/`** (this one)            | Chromium → `vinxi dev` → the real turn runner → a fake endpoint      | model quality, real latency, other browsers                                      |
| `app/evals/`, `E2E_LIVE=verda pnpm test:e2e` | one BAML call / whole turns against real infrastructure              | —                                                                                |

So the unit of work here is a **person at a keyboard**, and the assertions are
about what they see: a bubble appeared, a spinner cleared, a row showed up in
the list, a control was not invisible. Nothing here grades prose, and nothing
here asserts on a CSS class.

## What this is not

**It is not part of the test suite, and it never runs in CI.** It needs a
Postgres, a ~95 MB browser download and a `vinxi dev` boot, and its wall clock
is a developer's machine rather than a hermetic image. A CI job that picked it
up would add minutes to every push and go red on someone else's docker.

That separation is structural, not just conventional:

|                                    |                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app/vitest.config.ts`             | `test.include` and `coverage.include` are both rooted at `src/**`. `e2e-browser/` is outside both.                      |
| `e2e-browser/playwright.config.ts` | a different RUNNER, `testDir` rooted at `scenarios/`, `testMatch` on `*.browser.ts`. Vitest cannot execute these files. |
| `.github/workflows/ci.yml`         | runs typecheck · lint · format · test · build. None invoke it, and no step installs a browser.                          |
| `package.json`                     | `test:e2e:browser` is standalone. No `pre*` hook chains it. `@playwright/test` is a devDependency.                      |
| `src/**`                           | imports nothing from `e2e-browser/`. The allowed direction is e2e-browser → src.                                        |

[`src/__tests__/browser-e2e-not-in-ci.test.ts`](../src/__tests__/browser-e2e-not-in-ci.test.ts)
pins every row of that table — plus both gates on the one seam this suite needed
in `src/` — and is itself an ordinary test, so the guard runs in the job it
protects. **If you widen a vitest glob, add a `pretest` hook, name a scenario
`*.test.ts`, or import an e2e-browser module from `src/`, that test goes red.**
Do not fix it by loosening the guard. Four such mutations were checked against
it on 2026-08-26; they are listed in the PR body.

The suite _is_ covered by `pnpm typecheck`, `pnpm lint` and `prettier` —
`tsconfig.json` includes `e2e-browser`, and eslint applies the `src` rule block
to it — so it cannot rot into unbuildable code unnoticed. Same arrangement as
`app/e2e/` and `app/evals/`.

## What it needs

- **Postgres** on `localhost:5432` (`docker compose up -d postgres` from the
  repo root). The suite provisions and uses its OWN throwaway database,
  `kgagent_test_browser`, through the same `provisionDatabase()` the unit suite
  calls — shared code, its own target. It also runs as its own dev-bypass user,
  `e2e-browser-user`. Both were shared literals until #280, and both are why a
  concurrent app-path run used to delete this suite's rows mid-scenario; see
  [`docs/testing/pyramid.md`](../../docs/testing/pyramid.md). Your dev rows are
  never touched, and global setup **refuses to run** if the server it started
  turns out to be persisting somewhere else.
- **A browser**, once: `pnpm exec playwright install chromium`.
- **Nothing else.** No credential, no Docker gateway, no GPU, no bill. Both the
  inference endpoint and the MCP gateway are the fakes `app/e2e/` already owns.

`baml_client/` is generated by global setup (`pnpm dev`'s own `predev` hook,
which spawning vinxi directly skips), so a fresh worktree needs no extra step.

## How a run is put together

Three processes, which is the thing that makes this layer different from every
other one in the repo.

```
Playwright runner ──── control plane (HTTP) ────┐
   │  fake OpenAI endpoint  :ephemeral          │  arm faults, read
   │  fake MCP gateway      :ephemeral          │  what was served
   │                                             │
   └── spawns ── vinxi dev :3446 ───────────────┘
                    │  VERDA_INFERENCE_ENDPOINT → fake
                    │  E2E_FAKE_INFERENCE_URL   → fake
                    │  MCP_GATEWAY_URL          → fake
                    │  DATABASE_URL             → kgagent_test_browser
                    └── Chromium ── http://127.0.0.1:3446
```

**The dev server, not a build.** The auth here is the dev bypass (`SD-15`), and
`isBypassEnabled()`'s first gate is `import.meta.env.DEV`, which a production
build statically replaces with `false` — a built server would 401 every turn.
Covering the production bundle needs a real Entra session, and that is a
different suite.

**The fakes are `app/e2e/`'s, imported rather than copied.** Same
OpenAI-compatible endpoint answering each BAML function with the smallest reply
that parses into its declared output type, same minimal MCP server. A second
implementation would be a second thing to keep in step with `baml_src/`, and the
first time the two drifted this layer would be testing a protocol the layer
below had already moved off.

**Faults travel over HTTP**, because Playwright runs tests in worker processes
and the fakes live in the runner's. `backend.arm(...)`, `backend.down()`,
`backend.calls()` are the same vocabulary `app/e2e/` calls directly.

Two verbs exist only here: `backend.held()` and `backend.release()`, the halves of
the `hold` fault. A browser scenario whose claim is "the turn is still running"
cannot establish that with a duration — the assertion races the duration and the
loser is whichever machine is busier, which is what both #280 flakes were. With
the request PARKED the turn cannot advance, so the claim becomes a fact the test
established. `expectHeld(...)` is the wait.

### How the app reaches the fake — and the one thing that had to change in `src/`

Two halves, and only the second is new.

**The self-hosted tier uses the shipped seam, unmodified.** `VerdaQwen` declares
`base_url env.VERDA_INFERENCE_ENDPOINT` and BAML resolves `env.*` at call time,
so pointing that variable at the fake is what a developer does to run the
deployment locally.

**The Anthropic chains have no such seam**, and the anthropic position of the
header switch runs every role on them. `app/e2e/` solves this with a test-only
`ClientRegistry` installed on the `b` it imported. **This suite cannot**: the app
is a different process and there is no handle to install anything on. Without a
redirect, those calls would leave the machine on the developer's own key, from a
suite advertised as hermetic.

> Until the 2026-08-26 tier widening this was true of a _verda_-tier turn too —
> `router` / `describe` / `screen` / `planner` and the title call stayed on
> Anthropic in both switch positions. Every role is on the tier now, so the
> redirect is reachable only from the anthropic position. It did not become
> optional: scenario 3 uses that position, and so does half of the preflight.

So there is one dev-only module in `src/`:
[`lib/inference/dev-fake-inference.server.ts`](../src/lib/inference/dev-fake-inference.server.ts),
called from `src/middleware.ts` (the app's server-boot hook, and the only thing
guaranteed to run before the first BAML call). Its shape is copied deliberately
from `lib/auth/dev-bypass.ts`, the precedent this repo already has for "a test
needs the real server to behave differently":

1. `import.meta.env.DEV` — a compile-time constant Vite replaces with `false`,
   so the branch, the BAML import behind it and the redirect itself are dead
   code in a production build. **There is no production configuration that turns
   it on**, which is exactly the property a `base_url env.ANTHROPIC_BASE_URL` in
   `baml_src/clients.baml` would not have had — the switch ADR-0001 deleted and
   `SD-12` records.
2. `E2E_FAKE_INFERENCE_URL` — the explicit opt-in, read from `process.env`
   because the module is server-only and nothing in the browser bundle may learn
   the value.

Production tier resolution is untouched and still consulted: a per-call `client`
override (how `clientOverrideFor` routes the self-hosted tier) still wins over
the registry primary, so which tier a turn takes is still decided by
`resolveInferenceTier()` reading the user's stored preference. All that changes
is where the resulting HTTP request lands. That split is also what makes the
routing assertions honest — the fake records the `model` on every request, so
`Qwen/Qwen3.8-27B-FP8` versus `e2e-fake-anthropic-tier` is direct evidence of
the route a call took.

**Fail-closed, twice.** `ANTHROPIC_API_KEY` is overwritten with a sentinel, so
the worst case of a failed redirect is a loud 401 rather than a bill. And global
setup runs **two** real turns against the real server before any scenario and
**refuses to run** unless both land: one on the default tier (which proves the
self-hosted seam is carrying calls, and creates the schema for the next), then
one forced onto the **anthropic** tier, which has to produce at least one call
carrying `e2e-fake-anthropic-tier`. Two turns rather than one because of the
widening above: "something arrived" was never enough, and since every role is
self-hosted on the private tier there is no longer any Anthropic-chain call on a
default-tier turn to observe. The tier is forced by writing the same
`user_prefs` row the header switch writes, and `wipeUserRows()` deletes it
again, so scenarios still start from the default a preview user gets.

**Something else on the port is refused, not driven.** `startDevServer` TCP-probes
the port before spawning and throws naming the collision. Without that the boot
probe was satisfied by whatever answered `/api/health` first and the run failed
two steps later, blaming the redirect for a stale vinxi.

## Knobs

| Env var                       | Default                  | What it does                                                                                                        |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `E2E_BROWSER_PORT`            | `3446`                   | The dev server's port. Deliberately not 3444 — a developer's own `pnpm dev` must not be driven by this suite.       |
| `E2E_BROWSER_COLD_MS`         | `8000`                   | How long scenario 2's fake box withholds its first self-hosted answer.                                              |
| `E2E_BROWSER_TURN_TIMEOUT_MS` | `90000`                  | How long a scenario waits for a turn to land in the transcript.                                                     |
| `E2E_BROWSER_BOOT_TIMEOUT_MS` | `180000`                 | How long global setup waits for `/api/health`. A cold vite start with `baml-generate` behind it is not fast.        |
| `E2E_BROWSER_SERVER_LOG`      | unset                    | Stream the dev server's stdout/stderr into the run. The first thing to reach for when a scenario fails oddly.       |
| `TEST_DATABASE_URL`           | `…/kgagent_test_browser` | This suite's OWN throwaway database. Point two suites at one and their dev-bypass identities still keep them apart. |
| `BAML_LOG`                    | `warn`                   | Passed through to the dev server.                                                                                   |

Two values are **not** knobs and are set unconditionally on the server under
test, both in `global-setup.ts`:

- `VERDA_SCALEDOWN_SECONDS=2`. The cold-start notice only fires when nothing says
  the box is up, and a completed self-hosted call marks it warm for the whole
  scale-down window — with the shipped default (300s), the suite's own preflight
  would leave the box "warm" for the entire run and scenario 2 could never reach
  the feature. See `lib/env.ts`. The cost is stated there too: this suite says
  nothing about the shipped window itself, only about what happens on either side
  of it.
- `VERDA_WAKE_ATTEMPT_TIMEOUT_MS=600000`. The wake is a POLL, so its shipped 30s
  per-attempt bound would put a clock back into the one scenario #280 took the
  clocks out of: scenario 2 parks the wake and then makes browser assertions
  against a turn that provably cannot advance, and a machine slow enough to spend
  30s on them would watch the poll abandon the parked request and send a second —
  turning `held.length === 1` red for the load on the box rather than for
  anything about the app. Ten minutes outlasts any scenario's hold, so one parked
  wake stays one parked wake. What the poll RETRIES is pinned a layer down, in
  `app/e2e/scenarios/08-cold-start-ux` and `verda-wake.test.ts`.

## The scenarios

| File                               | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-send-and-reply.browser.ts`     | A message typed into the composer gets an answer **painted** in the transcript, the composer comes back, and the conversation appears in the sidebar under the title the server pushed down the same stream.                                                                                                                                                                                                                                                                                                                                                                                         |
| `02-cold-start-spinner.browser.ts` | **The reason this layer exists.** A cold self-hosted box shows the warming spinner with its headline and estimate, the progress bar is suppressed in its favour, and the notice RETRACTS — asserted with the turn provably still running (the box's requests are PARKED by the `hold` fault and released by name, Stop still visible), because otherwise the teardown unmount discharges it. Then the failure twin: a box that will not serve ends the turn as a VISIBLE error with no spinner left behind.                                                                                          |
| `03-tier-switch.browser.ts`        | Clicking the header switch moves the controller and synthesizer calls — read off the `model` the fake recorded, per position — without forking the conversation, and the position survives a reload because it lives on the server. The MAPPING (which roles move) belongs to `app/e2e/scenarios/05`; what is only checkable here is that a click reaches it.                                                                                                                                                                                                                                        |
| `04-mid-turn-reload.browser.ts`    | Reloading with a turn in flight keeps the conversation in the list, rebuilds its history from Postgres on reopen, and does not cancel the run whose reader went away — both turns are there afterwards.                                                                                                                                                                                                                                                                                                                                                                                              |
| `05-multi-turn.browser.ts`         | Three turns, all still on screen, alternating question/answer in document order — plus one wire assertion that turn 3 was handed turn 1, so this is a conversation and not a list.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `06-theme-sanity.browser.ts`       | In dark AND light: the tier label and the Send button are not invisible on their own (composited) background, and two icon spans actually paint a glyph — the shape an unregistered `i-mdi-*` leaves behind.                                                                                                                                                                                                                                                                                                                                                                                         |
| `07-visual-regression.browser.ts`  | Per-theme SCREENSHOT comparison over three surfaces (header strip · sidebar with rows · the chat column) against committed baselines. The instrument for the family of regressions where every name is still there and the pixels are wrong — an icon that stopped painting, a colour that reads in dark and vanishes in light, a layout that collapsed. Volatile regions are REMOVED from the page before the shot, never tolerated by a wider threshold — a tolerance wide enough to absorb an unstable region is wide enough to absorb a real regression of the same size.                        |
| `08-accessibility.browser.ts`      | An axe-core pass over the SAME three surfaces in both themes, gated on `serious`/`critical` only, as an EQUALITY against a recorded known-open list — so a new violation fails and a fixed one fails too. What is deliberately not gated is enumerated in the file.                                                                                                                                                                                                                                                                                                                                  |
| `09-boot-never-blank.browser.ts`   | Samples what is PAINTED continuously from before navigation until the app is up, and fails if the route area ever showed neither a loading surface nor the app's own chrome for longer than a frame budget. The one scenario here that asserts on an interval rather than on an end state — #295 was invisible to every `open()`-based scenario, which all sat through the blank window and passed.                                                                                                                                                                                                  |
| `10-share-link.browser.ts`         | A conversation acquires a URL, survives a reload of it, and is turned into a share link that a SECOND browser context opens: the transcript is painted, the read-only banner names it, and the composer / New Chat / share / agent picker / dashboard link are ABSENT rather than disabled. Then the revocation half — the same link renders the not-found page and says nothing that admits a conversation is behind it. The one claim it cannot make (this suite runs with the dev bypass, so no context is truly anonymous) is named in the file, with the two layer-1 pins that make it instead. |

### What is NOT covered

A suite's coverage claim is only worth what its gaps are, so this list is meant
to be complete. Add to it when you add a scenario that leaves something out.

- **The production bundle.** Everything here runs under `vinxi dev`, because the
  dev auth bypass is gated on `import.meta.env.DEV`. So SSR-in-production,
  minification and the built server's own module graph are untraversed.
- **The auth gate itself.** This suite runs _with_ the bypass on (`SD-15`), so
  it says nothing about an unauthenticated visitor being refused, and nothing
  about the sign-in pages.
- **One browser.** Chromium, headless. Cross-engine rendering is a different
  question with a different cost, and none of the findings here vary by engine.
- **Model quality and real latency.** The fake cannot vary; the evals and
  `E2E_LIVE=verda` own those.
- **Concurrency.** One worker, one user, one conversation at a time.
  `e2e/scenarios/03-concurrent-cold` owns overlapping turns, at the app layer.
- **Every panel that is not the chat column.** The graph canvas, the Data Stash,
  the terminal, the observability panel and the dashboard are all unvisited.
  Scenarios 6–8 are what look at pixels: three surfaces (`lib/surfaces.ts`) plus
  scenario 6's three individual elements. The observability panel is left out of
  the screenshot comparison for a concrete reason rather than a budget one —
  every pattern instance carries a random id suffix (`router-pab3iw`), so a
  baseline of it needs a stable identifier for a pattern instance first, and
  masking it would leave a screenshot of magenta rectangles asserting nothing.
- **The accessibility debt scenario 8 RECORDS rather than fixes.** Its
  `KNOWN_OPEN` list is the app's existing serious/critical violations, each with
  why it has not had a change of its own yet — `button-name` (icon-only buttons),
  `color-contrast` (a palette decision) and `scrollable-region-focusable` (a
  `tabindex` with real tab-order consequences). The gate's job is to stop that
  list growing, not to make it look empty. Two entries have left it: `<title>`
  (`src/entry-server.tsx`) and the composer's `aria-label` (`ChatInput.tsx`),
  both because the EQUALITY made deleting their lines mandatory once they were
  fixed.
- **Visual baselines are per-PLATFORM, and never compared in CI.** Font
  rasterisation differs between macOS and Linux, so `baselines/` carries a
  `{platform}` suffix and a contributor on another OS records their own set on
  first run. Nothing cross-checks the two.
- **The approval gate and the triggered runner.** Same gap `app/e2e/` records:
  only the `interactive` turn mode runs here.

### Adding one

Write a `*.browser.ts` under `scenarios/`. Three rules:

- **Import `test` and `expect` from `../lib/fixtures`,** never from
  `@playwright/test` directly. The fixture is what resets the fake and wipes the
  suite's rows before each test; a scenario that skipped it would inherit
  whatever fault the previous file armed.
- **Find things by role, label or `data-testid`** — never by class, colour or
  DOM shape. This layer exists because component tests can pass against markup
  no human could use; a scenario reaching for `.flex.gap-3 > div:nth-child(2)`
  would reintroduce exactly that. If you cannot find something by its accessible
  name, that is a finding about the app.
- **Assert on evidence, not on inputs.** Which tier a call took is the `model`
  the fake recorded, not the preference the test clicked. Whether a run survived
  a reload is what the endpoint served afterwards, not that a row says `done` —
  it may have said `done` since the previous turn. (That one is not
  hypothetical: it is how the first draft of scenario 4 passed while the server
  had never started the turn it was supposedly reloading through.)

And check your assertion can fail: mutate the source, watch it go red, and say
which checks you verified that way. A green test that would stay green with the
feature removed manufactures a coverage number.

**Do not establish "the turn is still running" with a duration.** Arm the `hold`
fault (`e2e/lib/fake-llm.ts`) and wait for the request to PARK with
`expectHeld(...)`. A `cold-start` duration turns every following assertion into a
race against the machine, which is what both #280 browser flakes were made of.
Same rule for the tier switch: use `chooseTier(page, tier)`, which waits for the
SERVER to hold the preference — `toBeChecked()` only says the widget moved.

**Adding a visual surface** means adding it to `lib/surfaces.ts`, which scenarios
7 and 8 both read: one list, so the screenshot comparison and the axe pass always
look at the same thing. Then record its baseline with
`pnpm test:e2e:browser --update-snapshots`, in a commit of its own, having looked
at the image first — a baseline recorded in the same commit as the change that
moved it is a baseline nobody reviewed.
