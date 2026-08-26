# App-path e2e — whole conversations, through the real server actions

Run this **whenever anything under the chat path changes** — a BAML client, the
turn runner, the session store, the SSE route, the inference-tier switch — to
find out whether a real conversation still works end to end.

```bash
# from app/
pnpm test:e2e                      # hermetic: fake endpoint, no credentials, no bill
E2E_LIVE=verda pnpm test:e2e       # the real self-hosted deployment (pre-release only)
```

Everything between the browser and the model is the real thing. The suite calls
`processMessageWithAgent` (the server action the chat form calls) and
`POST /api/events` (the route the streaming UI posts to); those call
`runTurnAndPersist`, which resolves the user's inference tier, opens the request
/ settings / tier scopes, builds the agent's patterns, runs
router → route → simpleLoop → compactExecution, and writes the whole event
stream to Postgres. Only two things are substituted: the inference endpoint and
the MCP gateway.

## Why it exists

The gap it closes is the one #263 fell into. `ActorController` was rendering a
`system` block after a user block, which Anthropic silently rewrites and vLLM
rejects with a 400 — so on the self-hosted route the actor's **first** attempt
passed and every **retry** died. Nothing was red. The unit suite tests pieces,
the evals (`app/evals/`) test one BAML call at a time against a live client, and
neither runs a conversation. A client swap could therefore break chat without a
single failing test.

So the unit of work here is a **conversation**, and the assertions are about
what survives it: the answer reached the user, the row is terminal, the second
turn saw the first, the switched roles moved and the pinned ones did not.

## What this is not

**It is not part of the test suite, and it never runs in CI.** It needs a
database, one scenario deliberately sits through a ninety-second cold start, and
its opt-in live mode calls a metered GPU box. A CI job that picked it up would
add minutes to every push and go red on someone else's docker.

That separation is structural, not just conventional:

|                            |                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `app/vitest.config.ts`     | `test.include` and `coverage.include` are both rooted at `src/**`. `e2e/` is outside both.                                       |
| `e2e/vitest.config.ts`     | a separate config, `include` rooted at `e2e/scenarios/**/*.e2e.ts`. No file here is named `*.test.ts`, so a widened glob misses. |
| `.github/workflows/ci.yml` | runs typecheck · lint · format · test · build. None of them invoke `test:e2e`.                                                   |
| `package.json`             | `test:e2e` is standalone. No `pre*` hook chains it.                                                                              |
| `src/**`                   | imports nothing from `e2e/`. The allowed direction is e2e → src.                                                                 |

[`src/__tests__/e2e-not-in-ci.test.ts`](../src/__tests__/e2e-not-in-ci.test.ts)
pins every row of that table and is itself an ordinary test, so the guard runs
in the job it protects. **If you widen a vitest glob, add a `pretest` hook, or
import an e2e module from `src/`, that test goes red.** Do not fix it by
loosening the guard. (Both mutations were checked against it on 2026-08-26.)

The suite _is_ covered by `pnpm typecheck`, `pnpm lint` and `prettier` —
`tsconfig.json` includes `e2e`, and eslint applies the `src` rule block to it —
so it cannot rot into unbuildable code unnoticed. Same arrangement as
`app/evals/`.

## The two modes

### Hermetic (default)

No credential, no network, no bill. Two fakes start in-process:

- **`lib/fake-llm.ts`** — an OpenAI-compatible endpoint (`POST /v1/chat/completions`,
  `GET /v1/models`) that answers each BAML function with the smallest reply that
  parses into its declared output type. Nothing here generates or grades prose:
  a scenario asserts that the app path worked, never that a model was good.
- **`lib/fake-gateway.ts`** — a minimal MCP streamable-HTTP server advertising
  `get_neo4j_schema`, `read_neo4j_cypher`, `search` and `fetch`, so tool results
  are deterministic and Docker is not a dependency.

The one piece of real infrastructure is **Postgres**, and it is the throwaway
`kgagent_test` database the unit suite already provisions — same
`global-setup.ts`, same `DATA_ENCRYPTION_KEY`. Dev rows are never touched. The
suite runs as the dev-bypass user and deletes its own rows before and after each
scenario file.

### Live (`E2E_LIVE=verda`)

The same scenarios against the real self-hosted deployment. Credentials are read
from `app/.env` (explicitly, and **only** in this mode). The MCP gateway stays
faked — this mode measures the inference route, and letting it also depend on a
developer's Neo4j would make a red result uninterpretable.

Burst discipline is structural rather than a knob: one process, one file at a
time, at most two turns in flight. The deployment is a single replica, where
concurrency is queueing rather than scaling (measured 2026-08-25,
`smoke-verda-load.ts`), and the box pays one cold start for the whole run rather
than one per file.

**What it bills, stated rather than implied.** The switch moves exactly the
roles in `VERDA_CLIENT_BY_ROLE`, which after the two 2026-08-26 owner decisions
is every role — the injection screen included. So a live run in the self-hosted
position bills Anthropic nothing, which is a smaller claim than it sounds: no
scenario triggers a screen call anyway, because no agent in this repo enables
the opt-in LLM screen. The bill moved rather than shrank: `router`, `planner`, the title and
every describe call now land on the single-replica self-hosted box, which is
more traffic through it than the pre-widening shape and the reason the burst
discipline above matters more than it did. What _is_ avoidable is running each
scenario a second time with the switch in the anthropic position, which would
put all of that on the metered API for no live-route information. So the
per-tier legs of scenarios 1, 2 and 7 collapse to the self-hosted tier here,
via the single `TIERS` in `lib/mode.ts`.

Scenarios that inject faults (6's four injected shapes) or simulate a cold start
(4's timing assertions) are **skipped**, not faked — there is no responsible way to cause a
mid-stream disconnect on the real endpoint, and faking one there would only test
the fake. Assertions that read the fake's recorded model ids are skipped for the
same reason, with `it.runIf` rather than an early `return`, so a skipped check
reports as skipped instead of passing while asserting nothing.

## How a hermetic run reaches the fake

Two halves, because the two tiers have different seams — and the difference is
deliberate.

**The verda tier uses the shipped seam, unmodified.** `VerdaQwen` declares
`base_url env.VERDA_INFERENCE_ENDPOINT`, and BAML resolves `env.*` from
`process.env` at call time, so pointing that variable at the fake is what a
developer does when they run the deployment locally. `assertVerdaConfigured()`
still runs, `chat_template_kwargs` and `max_tokens` still go on the wire.

**The anthropic tier uses a test-only `ClientRegistry`, and no new env switch.**
There is no `base_url` seam on the Anthropic chains, and adding one is the
option this suite refuses: `base_url env.ANTHROPIC_BASE_URL` in
`baml_src/clients.baml` would be a production configuration that re-points
production prompts at an arbitrary host — the switch ADR-0001 deleted on
2026-08-24, and the posture `SD-12` records. `app/evals/` refused the same
widening for the same reason. So the redirect lives entirely in the test
process: `lib/baml-route.ts` installs a client registry whose primary is the
fake, and a per-call `client` override (which is how `clientOverrideFor` routes
the verda tier) still wins over it. Production resolution is untouched and still
consulted — which tier a turn takes is decided by `resolveInferenceTier()`
reading the user's stored preference, exactly as in the app.

That split is also what makes the routing assertions honest: the fake records
the `model` field on every request, so `Qwen/Qwen3.8-27B-FP8` versus
`e2e-fake-anthropic-tier` is direct evidence of the route a call took. No
scenario asserts on the preference it just set.

**Fail-closed.** A registry that silently failed to install would leave every
anthropic-tier call going to the real provider with the developer's own key —
billing a "hermetic" suite and sending it prompts. Two things prevent that: the
boot overwrites `ANTHROPIC_API_KEY` with a sentinel, so the worst case is a loud
401; and a preflight makes one real BAML call and **refuses to run** unless the
fake recorded it.

## Knobs

| Env var                  | Default                        | What it does                                                                                                              |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `E2E_LIVE`               | unset                          | `verda` runs against the real endpoint. Unset (or `0`/`false`) is hermetic. Any other value throws.                       |
| `E2E_COLD_START_MS`      | `90000`                        | How long scenarios 4 and 8 withhold the first self-hosted response. `180000` for the full pre-release shape.              |
| `E2E_CONCURRENT_COLD_MS` | `3000`                         | Scenario 3's shorter cold start — that scenario owns interleaving, not duration.                                          |
| `E2E_TURN_TIMEOUT_MS`    | `max(cold + 120s, 300s)`       | The suite's own bound on a single turn. A breach names itself, so a harness-side kill is distinguishable from an app one. |
| `TEST_DATABASE_URL`      | `…localhost:5432/kgagent_test` | The throwaway database, shared with the unit suite.                                                                       |
| `BAML_LOG`               | `warn`                         | `info` to see rendered prompts and raw replies while debugging a scenario.                                                |

## The scenarios

| File                               | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-fake-fidelity.e2e.ts`          | The fake still recognises all thirteen BAML functions. Renders each offline through `b.request.*` and asserts it classifies as itself, and pins the marker list against the names the **generated client** declares, so a fourteenth function is red here. No app path, no sockets.                                                                                                                                                                                                                     |
| `01-fresh-conversation.e2e.ts`     | One message, one answer, per tier — through the server action **and** the SSE route. Row is `done`, titled, carries an assistant message and a tool result.                                                                                                                                                                                                                                                                                                                                             |
| `02-multi-turn.e2e.ts`             | Turns 2 and 3 take the `continueSession` branch. All three user messages in one blob; turn 3's prompt still contains turn 1.                                                                                                                                                                                                                                                                                                                                                                            |
| `03-concurrent-cold.e2e.ts`        | Two conversations overlapping on a cold endpoint. Both complete, neither picks up the other's message, and each keeps the tier its turn started under.                                                                                                                                                                                                                                                                                                                                                  |
| `04-cold-start-survival.e2e.ts`    | A 90-second withheld first response does not kill the turn — through the server action and through the SSE route, which holds a stream open across the whole wait.                                                                                                                                                                                                                                                                                                                                      |
| `05-tier-switch.e2e.ts`            | Flipping the header switch between turns moves both switched roles this chain uses (`LoopController` **and** `Synthesize`) and does not fork the conversation; and the cheap side-roles (`Router`, the title, the post-turn describe) follow the switch in BOTH directions, which is the only check that would catch a missing spread at one of the six describe call sites. `screen` is pinned by source scan instead — no agent enables the LLM screen, so no turn here makes one (`SA-M5` / `SD-4`). |
| `06-failure-honesty.e2e.ts`        | A 400, a refused connection and a mid-stream drop each end the turn **visibly** — never a `done` row with a fabricated answer, never a row stuck at `running`, never a silent close. Plus the other mechanism: a turn that **throws** (a pattern build that fails) sends an SSE `error` frame and flips its row out of `running`.                                                                                                                                                                       |
| `07-wire-shape-and-planner.e2e.ts` | What a three-turn conversation actually puts on the wire is legal for vLLM (the #263 shape, checked at runtime rather than at template-render time), plus a second agent chain — `general`'s planner → simpleLoop — and the planner FOLLOWING the tier in both switch positions (it joined `VERDA_CLIENT_BY_ROLE` on 2026-08-26; this row said the opposite until the screen change swept it).                                                                                                          |
| `08-cold-start-ux.e2e.ts`          | The cold-start notice (D-c) reaches the user **during** the wait rather than alongside the answer, carries a positive estimate that says where it came from, precedes anything the self-hosted model said, and is absent on the anthropic tier. Uses `frame.at`, which is why `readSse` stamps arrival times. Hermetic only — by the time it runs, a live box has been warm for several files.                                                                                                          |

### What is NOT covered

A suite's coverage claim is only worth what its gaps are, so this list is meant
to be complete. Add to it when you add a scenario that leaves something out.

- **`ActorController` and `Critic`** — exercised nowhere. The only agents using
  `actorCritic` are the two sandbox agents, which need a container runtime, so
  the pattern whose **retry** path #263 actually broke is still covered only by
  `prompt-role-order.test.ts` and the evals. Closing it needs a sandbox fake,
  which is larger than this suite.
- **Two of the three turn modes.** `turn.server.ts` documents `interactive`,
  `triggered` and `approval`; only `interactive` runs here. So
  `resumeHarness` behind an approval gate, and the triggered runner's
  pre-seeded-row path (`POST /api/agents/:id`, a routine), are untraversed.
- **The injection screen, at all.** No agent in this repo enables the opt-in LLM
  screen, so no scenario here makes a `ScreenUntrustedContent` call — the fake
  can answer one (`injection_detected: false`) but nothing asks. The fake router
  also deliberately picks `neo4j`, so the search agent's guarded `web` route is
  never taken; a conversation scenario should not double as an injection-guard
  scenario. The gap did not close when `screen` joined the tier on 2026-08-26 —
  it just changed which claim is unobserved here, from "the screen stays on
  Anthropic" to "the screen follows the switch". Both are pinned hermetically
  instead: `clients-verda.test.ts` now requires the map entry AND the override
  spread on the screen's own call expression (balanced-paren extraction, not a
  grep, after a decoy defeated the grep). Whether that client is any good AS a
  screener is the eval suite's `screen-on-the-tier` scenario, which needs a live
  endpoint. What the guard does when it fires is `withInjectionGuard`'s own
  tests' job.
- **Multi-call batches.** The fake never returns `additional_calls`, so
  `multiToolCalls: 'parallel'` — the default for both loop patterns — is never
  demonstrated end to end.
- **Output-cap truncation recovery.** Every fake completion carries
  `finish_reason: 'stop'`, so `llmCallHitOutputCap` and the adapters' one
  corrective retry are unexercised.
- **The auth gate.** This suite runs _with_ the dev bypass on (`SD-15`), so it
  says nothing about an unauthenticated caller being refused. That stays
  `SD-13`'s own tests' job.

And two things that are outside the traversal rather than untested, both
consequences of running under vitest rather than a server:

- The server action is called **in-process**, so SolidStart's RPC encode/decode
  is not on the path.
- `src/middleware.ts` is never imported, so the server-boot arming it does
  (`startRoutineScheduler`, `installUsageRecorder`) does not happen — which is
  why `recordTurn()`'s counters see nothing here.

One non-gap worth writing down, because it looks like one: **a dead MCP gateway
is not a failure path.** Measured — a turn with the gateway refusing connections
completes `done`, because every gateway read degrades on purpose (`listTools`
logs and returns the app-side tools; `getGraphSchema` warns and refuses the
pattern cache). Scenario 6's throw path therefore uses a failing pattern build
instead; see its header.

## Results (2026-08-26, hermetic, against `main` @ 4ff54b3)

**43 tests across 8 files, all green.** 187 s wall clock, of which ~180 s is
scenario 4 sitting through two ninety-second cold starts by design. (The first
run was 40 tests; the three added close the throw path and the marker-list
completeness pin — see the mutation table below.)

Green on `main` is itself a finding: the app-layer flow — server actions, the
turn runner, `continueSession`, persistence, the SSE wire, the tier scope under
concurrency — holds up against a **protocol-compliant** endpoint on both tiers.
Whatever is failing on the live self-hosted route is therefore not one of these
shapes; it is something the fake does not reproduce (real model output, real
latency, credentials, or the actorCritic path above).

Checks verified **by mutation**, not by reading:

| Mutation                                                                                                      | What went red                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientOverrideFor()` returns `undefined` unconditionally                                                     | scenario 5's per-turn tier assertions                                                                                                                                                   |
| a late `system` block added to `Synthesize` + `baml-generate`                                                 | scenario 7's wire-shape check, and the general-agent turn                                                                                                                               |
| `pnpm test:e2e` added to `ci.yml`                                                                             | `e2e-not-in-ci.test.ts`                                                                                                                                                                 |
| an `import '../../e2e/lib/mode'` added under `src/`                                                           | `e2e-not-in-ci.test.ts`                                                                                                                                                                 |
| `events.ts`: the `catch`'s `error` frame deleted, stream closed silently                                      | 06's throw path — `the stream closed without an error frame; frames were []`                                                                                                            |
| `turn.server.ts`: `runAndSave` no longer flips the row to `error` before rethrowing                           | 06's throw path — `the row was left spinning at running`                                                                                                                                |
| `compactExecution.server.ts`: `clientOverrideFor('compactExecution')` removed                                 | 05 — `Synthesize on turn 2 (verda)` (the controller assertion stayed green)                                                                                                             |
| `baml-adapters.server.ts`: `clientOverrideFor('describe')` removed from the single-item `ResultDescribe` call | 05 — `moves the cheap side-roles too` — `ResultDescribe did not follow the tier switch`. The per-role grep in `clients-verda.test.ts` stayed green, which is why this scenario exists   |
| the same removal on `ResultDescribeBatch` instead                                                             | **nothing here** — a one-result turn takes the single-item path, so this suite cannot see the batch. Caught by `baml-adapters.test.ts` and the per-file scan in `clients-verda.test.ts` |
| a `MARKERS` entry removed (stands in for a function added to `baml_src/`)                                     | 00's completeness pin, naming the missing function                                                                                                                                      |
| a function name in 05's anthropic-position loop pointed at a call the fake never makes                        | `no <fn> call was made, so this asserts nothing` — the vacuity guard added 2026-08-26. Before it, that leg iterated an empty filter and passed; its verda twin always had the guard     |
| `clientOverrideFor('screen')` removed from the screen call site                                               | **nothing here** — no agent enables the LLM screen, so no turn makes one. Caught by `clients-verda.test.ts`'s balanced-paren pin on the call's own argument list                        |

Two of those are worth their own line.

The wire-shape check was **vacuous on its first draft** — the enforcement it
depends on had silently failed to land, and only the mutation exposed it. That
is the reason the rule below is a rule.

And the first two rows above are a hole this suite shipped with: an independent
review deleted the SSE `catch`'s error frame and **every scenario stayed green**,
because all four injected faults resolve through `onResult` with
`status: 'error'` and none of them makes the turn throw. The silent-stop shape
the suite is named for was the one it did not cover. Both halves of the throw
path now have a test and both go red when removed.

### Adding one

Write a `*.e2e.ts` under `scenarios/`. Two rules:

- **Import from `e2e/lib/*` only.** App modules are reached through
  `bootApp()`, which sets `MCP_GATEWAY_URL` and the endpoint env vars _before_
  the first dynamic `import()` — `mcp-client.server.ts` freezes its URL at
  module load, so a static import at the top of a scenario file would connect
  to whatever is on `:8811` and fail looking like an app bug.
- **Assert on evidence, not on inputs.** Which tier a call took is the `model`
  the fake recorded, not the preference the test wrote. Whether history survived
  is what the model was handed on turn 3, not that three turns returned a string.

And check your assertion can fail: mutate the source, watch it go red, and say
which checks you verified that way. A green test that would stay green with the
feature removed manufactures a coverage number.
