# CLAUDE.md

Project-level guidance for Claude Code in this repository.

## Commands

**Every `pnpm` command runs from `app/`** — never npm/npx, never from the repo root. The script list itself is a one-file lookup in `app/package.json`; what is not in that file:

- **`pnpm baml-generate` after any edit under `baml_src/`.** `baml_client/` is generated and gitignored; a stale or missing one surfaces as ~270 phantom test failures, not as a BAML error. Never hand-edit it.
- **Three llama-servers, three ports, and mixing them up is the trap.** `pnpm dev:llama` starts the local _chat_ model (GLM-4.7-Flash) on **8080**. The other two are `make` targets at the repo root, each running in the foreground: `make embed` serves the Data Stash _embedding_ model on **8090**, `make llm-small` serves the small summarizer (`LocalQwenSmall`, the designated describe-role model) on **8095**. Their GGUF weights live gitignored in `models/` — [`models/README.md`](models/README.md) says which file goes where, and a missing one fails the target outright instead of leaving a dead port.
- **`pnpm dev:exposed`** binds 0.0.0.0 — required for anything in Docker (Playwright MCP, the gateway) to reach the dev server.

### Client routing: Anthropic by default, self-hosted opt-in

Every BAML function declares one of the role chains in `baml_src/anthropic-only.baml` (the cheap `DescribeAnthropic` tier's own block there enumerates which functions ride it). There is no second routing MODE, and exactly one routing env var (`USE_VERDA_INFERENCE`, next paragraph): the mixed-provider chains and `USE_MIXED_CHAINS` were removed 2026-08-24 (ADR-0001) — their cross-provider rate limits made dev iteration too noisy, and one provider is also one processor to paper. `baml_src/local-client.baml` holds the two local clients — `LocalGLM` for manual wiring, and `LocalQwenSmall` (the `make llm-small` server) as the describe role's designated owned-inference replacement. Neither is in a chain yet.

Two things re-point part of that, and both move exactly the roles in `VERDA_CLIENT_BY_ROLE` — controller / actor / critic / synthesizer — never `router` / `describe` / `screen` / `planner`:

- `USE_VERDA_INFERENCE=1` is the **deployment default**: the tier every run takes when nothing else says otherwise. Unset, it changes nothing.
- **Per-user, per-run**: `runWithInferenceTier(tier, fn)` opens an AsyncLocalStorage scope (same shape as `runWithSettings`), and `runTurnAndPersist` opens one per turn from the user's stored preference (`user_prefs.inference_tier`, `app/src/lib/db/user-prefs.server.ts`). That is what the header switch drives. The preview default when a user has never chosen is **verda if the endpoint is configured**, else anthropic — a `verda` scope with no endpoint throws rather than falling through to Anthropic, so defaulting an unconfigured deployment there would break every turn.

Both act through the SAME seam: a per-call `client` override spread into the BAML options bag. Re-pointing the chains in `baml_src/` is not the mechanism and must not become it — that class of edit moves whole roles at once, and `screen` must stay on `DescribeAnthropic` in every tier position (SA-M5).

Which client a role runs on: the `client X` line on each function in `baml_src/` — that line is the only thing that routes a call by default. `app/src/lib/harness-patterns/clients.server.ts`'s `resolveClientForRole` is a **mirror** of those declarations used for prompt/batch budgeting; it routes nothing, so editing it alone re-sizes prompts for a model no call reaches. Its neighbours `clientOverrideFor` / `activeInferenceTier` are the exception that does route, per call, and only under the two levers above. Re-point both, BAML first. The canonical per-function list for the cheap tier is on the `DescribeAnthropic` block in `baml_src/anthropic-only.baml` — and re-pointing that chain would move the injection screen with it (see below).

Docker services (Neo4j, MCP Gateway, Redis) come up with `docker compose up -d` from the repo root.

---

## Technology Stack

- **Framework:** SolidStart v1.x (file-based routing, server actions, SSE)
- **UI components:** Ark UI (headless, SolidJS bindings)
- **Styling:** UnoCSS with attributify mode — attribute-syntax only, no `class=`
- **Graph:** Cytoscape.js for interactive graph visualization
- **Agent framework:** harness-patterns (see below) — replaces legacy `baml-agent`
- **LLM functions:** BAML (`baml_src/` → `baml_client/`, never edit generated client)
- **Tool access:** MCP Gateway (Docker, port 8811) via `harness-patterns/tools.server.ts`
- **Database:** Neo4j via `neo4j-driver` (direct) + MCP (agentic)
- **Package manager:** pnpm (never npm/npx)

---

## Design Decisions

**Agent framework:** All agentic work uses harness-patterns. The old `lib/baml-agent/` system has been removed. Do not recreate it.

**Server/client boundary:** Files with `.server.ts` suffix are server-only; `assertServerOnImport()` is enforced at runtime. Keep this convention strictly.

**BAML regeneration:** Always run `pnpm baml-generate` after editing any file in `baml_src/`. Never edit `baml_client/` directly. `pnpm dev` / `pnpm dev:exposed` regenerate first via their `predev` hooks (#154), and three guards cover the rest: a boot-time warning when the on-disk `baml_src/` no longer matches the snapshot baked into `baml_client/` (`baml-version-check.server.ts`), and a per-call warning when a BAML call was handed a collector but captured nothing (`warnIfCollectorEmpty`). A stale client does NOT error — the generated functions take their arguments positionally, so a signature change silently shifts every later argument and drops the trailing options object (collector + client override).

**UnoCSS attributify:** The `color` HTML attribute conflicts with UnoCSS attributify. Use `text="xs cyan-400"` (combined) instead of separate `color="cyan-400"`.

**Graph tabs:** `SupportPanel` uses `lazyMount` + `unmountOnExit` on `Tabs.Root` — Cytoscape instances only exist for the active tab. The Neo4j/Memory tabs consume accumulated `graphElements` from `index.tsx`. The All tab derives elements on-demand from `contextEvents` via `turn-utils.ts` based on user-selected turns, with per-turn color coding via `GraphVisualization`'s `extraStyles` prop.

**Postgres columns are encrypted at rest.** `DATA_ENCRYPTION_KEY` is **required** — no fallback, deliberately not shared with `AUTH_SESSION_SECRET` or `TOKEN_ENCRYPTION_KEY`, because those three rotate at wildly different costs. What is encrypted: `conversations.title` / `conversations.context`, `users`/`auth_sessions` `email` + `display_name`, `routines.input` + `label`. What is not, and must stay that way: ids, `user_id`, `agent_id`, the lifted enums (`kind`/`source`/`status`/`trigger_kind`/`enabled`) and every timestamp — SQL still does the owner scoping, the indexes and the ordering. Three things that are not in the files: the seam is the four repository modules (`query()` sees opaque SQL and an untyped param array, so it cannot be the chokepoint), `encryption-coverage.test.ts` is the source-scan pin that no other module runs SQL against those tables, and the backfill for legacy plaintext rows runs from `initSchema()` — booting with encrypted rows and no key is a deliberate hard failure. **The test suite runs against its own database** (`kgagent_test`, provisioned by `src/__tests__/global-setup.ts`) precisely because that backfill would otherwise rewrite your dev rows with the unit-test key. Full rationale: `app/src/lib/db/crypto.server.ts`.

**Probe before scaffolding:** For architectural questions, converge with the user on the shape before writing implementation docs or code; `/grill-me` runs the interview. See [`docs/plan/sandbox.md`](docs/plan/sandbox.md) for the kind of doc that should _follow_ such a conversation, not start it.

---

## Code minimalism

_The ladder below is adapted, in our own words, from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT); licence in `.claude/skills/NOTICE.md`._

The best code is the one never written, and lazy here means efficient, not careless. Before writing anything, stop at the first rung that holds: does this need to exist at all (YAGNI) → does this repo already have it → does the standard library do it → does a native platform feature cover it → does an already-installed dependency solve it → can it be one line → only then, the minimum that works. Deletion over addition, boring over clever, the fewest files possible; no abstraction, no dependency and no boilerplate nobody asked for.

The ladder runs _after_ you understand the problem, not instead of it — read the task and the code it touches, trace the real flow end to end, then climb. A small diff you do not understand is not lazy, it is a second bug. Fix the root cause rather than the symptom: a report names one caller, so find the others and fix the shared function once. And never be lazy about the things that cost more later — input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and anything explicitly asked for.

Ark UI is the chosen primitive layer; never replace Ark components with native elements.

---

## Agent skills

Project skills live in `.claude/skills/` (tracked in git, so worktrees inherit
them — no copy step); each carries the `kg-` prefix and encodes something only
true of this repo. The **generic set** (bare names: `grilling`, `codebase-design`, …)
was extracted to `~/Code/muster-skills` and is installed globally via
`~/.claude/skills` symlinks, so it is available here and in every other project
without copies. `dispatching-work` lives in the same `~/Code/muster-skills` repo
but was authored there directly — it was never extracted from this one. Model-
invoked skills announce themselves through their own descriptions; the ones you
have to ask for by name are `/grill-me` and `/improve-codebase-architecture`.

To obtain the generic set on a machine that does not have it yet — the repo is
[github.com/mknw/muster-skills](https://github.com/mknw/muster-skills) (private;
ask for access), and the symlinks are what make it global rather than per-project:

```bash
gh repo clone mknw/muster-skills ~/Code/muster-skills && mkdir -p ~/.claude/skills \
  && for d in ~/Code/muster-skills/*/; do ln -sfn "${d%/}" ~/.claude/skills/; done
```

Each skill is a top-level directory in that repo, so the loop links the skills
and skips its `README.md` / `LICENSE` / `NOTICE.md`.

- A `kg-*` skill may call a generic skill (global scope is visible in every
  project). A generic skill must never call a `kg-*` skill — that invariant is
  what keeps the generic set portable. A repo-local map (e.g.
  [`docs/reviewing.md`](docs/reviewing.md)) pointing a generic skill at a
  `kg-*` one is config, not the generic skill's body doing the calling, so it
  does not breach this.
- Sub-agents live beside them in `.claude/agents/` (`code-reviewer`,
  `silent-failure-hunter`), tracked the same way and dispatched via the Agent
  tool's `subagent_type`.
- Issue-tracker workflow — how a skill fetches the spec for a change:
  [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md). The issue body
  is the spec; the project board is scheduling, read-only context.
- Data the skills read: house vocabulary in [`GLOSSARY.md`](GLOSSARY.md),
  decision records in [`docs/adr/`](docs/adr/README.md) (which also states when
  one gets written, and that they are not to be re-litigated).
- Provenance and upstream pins for the vendored files still in-repo
  (`kg-dtalk-ui`, the two sub-agents, the Code minimalism section below, plus
  the vendored docs outside `.claude/` — `docs/adr/README.md` and
  `docs/agents/AGENT-BRIEF.md`): `.claude/skills/PROVENANCE.md`;
  licences: `.claude/skills/NOTICE.md`. Adoption programme (historical):
  [`docs/plan/skills-adoption.md`](docs/plan/skills-adoption.md).

It names paths and invariants, never contents: every model-invoked skill's
description is already permanently loaded, so listing them here would restate it
at full context cost.

`/reviewing-changes` (conventions + spec fidelity, two unmerged axes — a
generic muster-skills skill; in this repo it reads
[`docs/reviewing.md`](docs/reviewing.md) as its map) complements the built-in
`/code-review` (correctness bugs + cleanups). Run the built-in first — it can
fix what it finds.

---

## Harness Patterns — Quick Reference

Framework in `app/src/lib/harness-patterns/`. Front page: [`README.md`](app/src/lib/harness-patterns/README.md); full API + design spec: [`app/src/lib/harness-patterns/SPEC.md`](app/src/lib/harness-patterns/SPEC.md).

<!-- The `prettier-ignore` markers below are load-bearing: the repo root has no
     .prettierrc, so prettier's defaults would rewrite these samples to double
     quotes + semicolons, against app/.prettierrc.json. -->

**BAML functions must use `.bind(b)`:**

<!-- prettier-ignore -->
```typescript
simpleLoop(b.Neo4jController.bind(b), tools.neo4j, { patternId: 'neo4j-query', schema })
```

**Preferred: use adapter factories instead:**

<!-- prettier-ignore -->
```typescript
const controller = createNeo4jController(tools.neo4j ?? [])
const actor = createActorControllerAdapter(tools.all)
const critic = createCriticAdapter()
```

**Multi-turn sessions:**

<!-- prettier-ignore -->
```typescript
// Continue: pass serialized from previous turn
continueSession(serialized, patterns, newInput)
// After approval gate:
resumeHarness(serialized, patterns, approved)
```

**EventView inside patterns:**

<!-- prettier-ignore -->
```typescript
view.fromLastPattern().ofType('tool_result').get()   // → ContextEvent[]
view.fromPatterns(['neo4j-query']).serialize()        // → XML for LLM
```

### Adding a New Agent

1. Create `app/src/lib/harness-client/agents/<name>.server.ts` — export `AgentConfig` with `id`, `name`, `description`, `icon`, `servers[]`, `createPatterns`
2. Register in `app/src/lib/harness-client/registry.server.ts`

---

## BAML Clients

**The chains themselves live in `baml_src/`** — the role chains in `anthropic-only.baml`, the leaf clients in `clients.baml` — and are one lookup away. What is _not_ in those files is why each client is shaped the way it is, so that is what this section carries.

**The chains** — declared in `baml_src/anthropic-only.baml`:

| Client                 | Role                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RouterAnthropic`      | Intent classification                                                                                                                                                                                                                                                                          |
| `ControllerAnthropic`  | simpleLoop tool-loop controller — `*NoThink` models, and the backstop stays Sonnet-tier: no Haiku fallback on structured output                                                                                                                                                                |
| `ActorAnthropic`       | actorCritic actor — the same models as the controller, with thinking left ON                                                                                                                                                                                                                   |
| `PlannerAnthropic`     | planner (#27) upfront decomposition — one call per chain, thinking left ON (the reasoning IS the deliverable)                                                                                                                                                                                  |
| `CriticAnthropic`      | Evaluation/critique                                                                                                                                                                                                                                                                            |
| `SynthesizerAnthropic` | Response synthesis                                                                                                                                                                                                                                                                             |
| `DescribeAnthropic`    | The cheap tier: six `describe` functions (batched + per-item result summaries, run titles, intent compaction, the retriever's query rewrite, the citation picker) **plus** `ScreenUntrustedContent` on its own `screen` role. Canonical list: the block on this chain in `anthropic-only.baml` |

**Extended thinking (#139):** these models think by default — no request asks for
it — and the trace is never exposed (empty string + signature), so it cannot feed
`reasoning`. Measured on 12 captured controller prompts × 6 samples: the simpleLoop
controller is better WITHOUT it (72/72 valid actions vs 70/72; median output 438 →
249 tokens; it stops re-querying when it already holds the answer), so
`ControllerAnthropic` uses the `*NoThink` clients. The actor, planner, router,
critic and compactExecution keep thinking — unmeasured, and the corpus had no
actor prompts. A thinking-only response with no text is retried once by the
adapters.

**Output caps + truncation recovery:** client `max_tokens` are 32768 (Sonnet 5) / 16384 (Sonnet 4.6, Haiku 4.5) / 4096 (Opus 4.1). EVERY leaf declaring `max_tokens` in `baml_src/*.baml` must be mirrored in `CLIENT_MAX_OUTPUT_TOKENS` (`app/src/lib/settings.ts`) — a missing entry silently blinds truncation detection for that client (SA-C2); `client-output-caps.test.ts` enforces the mirror. A controller response that hits its cap truncates mid-JSON (historically: `BamlValidationError: missing status/is_final` when a sandbox actor inlined a huge script into `tool_args`). The adapters detect cap-hits and do ONE corrective retry with truncation guidance appended to the per-call `context`; the loops emit truncation-specific feedback instead of generic "invalid JSON" when `tool_args` were cut off (`llmCallHitOutputCap`). Multi-call turns (`additional_calls`, see below) raise cap-hit risk — the prompts cap batches at 4 calls/turn for this reason.

**One envelope, demonstrated everywhere:** `ActorFewShots` / `LoopFewShots` render each example as the same JSON object `ctx.output_format` and the turn log ask for, and the mode-gated `LoopMultiCalls` / `ActorMultiCalls` branches demonstrate a batch — the fourth instance of "disagreeing demonstrations are defects" (see the comment on `LoopFewShots` for the captured failure: a sandbox actor copied the old brace-less `key: value` few-shot shape into a complete, correct, unparseable action). A brace-less envelope is NOT recovered in the adapters: it fails the parse and takes whatever retry the caller owns, which costs a round-trip where a misread of free-form lines would run the wrong tool call.

**Multi-call turns:** both loop patterns accept `multiToolCalls: 'parallel' | 'sequential' | 'off'` (default `'parallel'`) — the controller batches several tool calls into one turn via `ControllerAction.additional_calls`, saving one controller round-trip per batched call. Each advertised mode both describes AND demonstrates one batched action in its own branch of `LoopMultiCalls`/`ActorMultiCalls` (parallel: independent lookups; sequential: write-then-run), in the same JSON envelope everything else in the prompt uses — #248 was a model reaching for a field described but never shown, and inventing a YAML `additional_calls:` list for it. `'sequential'` runs in order with stop-on-failure (sandbox agents); `'off'` renders no branch, so it suppresses the demonstration along with the rest of the affordance, but still executes un-advertised batches serially (no agent uses it today). Full semantics: `app/src/lib/harness-patterns/SPEC.md`.

**The injection screen has its own role** — `screen` resolves to `DescribeAnthropic` rather than riding `describe` (SA-M5). Same client today; the separation is what matters, because re-pointing summarization at a cheaper model must never drag prompt-injection screening along with it — a screen must not be talked out of reporting by the content it reviews, and must copy spans verbatim so the guard can neutralize them. Rationale on the map entry in `clients.server.ts`. **The separation lives only in that TypeScript map**: in BAML both roles name the same `DescribeAnthropic` chain, so re-pointing the chain — the one-line edit that reads like "switch the owned-inference tier on" — moves the screen too. The describe tier is moved by rewriting its six `client` lines individually, or by adding a `DescribeLocal` chain for them; `injection-screen.baml` stays on `DescribeAnthropic`.

**Self-hosted inference (`VerdaQwen`, `baml_src/verda-client.baml`)** — the company's own Qwen deployment on a Verda (DataCrunch) GPU behind vLLM, as a confidential-compute route: prompts stay on infrastructure the company controls. Reached only through `USE_VERDA_INFERENCE=1`, which re-points the controller / actor / critic / synthesizer roles; router / describe / screen / planner stay Anthropic, so the flag is a routing switch and NOT a "no prompt leaves the building" guarantee (`describe` in particular is handed tool results verbatim — widening the map is an owner call). Endpoint and key come from `VERDA_INFERENCE_ENDPOINT` (which must be the OpenAI base, i.e. end in `/v1`) and `VERDA_INFERENCE_API_KEY`; with the flag on, a missing or root-only endpoint throws at module load rather than falling back to Anthropic — a silent fallback would send confidential prompts to the provider the flag exists to avoid.

Four things shape this client. It runs a **thinking model with thinking off** — `chat_template_kwargs { enable_thinking false }`, which `openai-generic` forwards into the request body verbatim. This is correctness, not tuning: the deployment runs vLLM with no reasoning parser, so without it the reasoning lands in `content` ahead of the JSON envelope (with a stray `</think>` between them) and eats the `max_tokens` the envelope needs. Declared on the client, so no call site can forget it; pinned on the rendered body by `verda-body-shape.test.ts`, because the failure mode is a degraded parse rather than an error. It **asks for no caching**: no `allowed_role_metadata`, so the controller templates' `cache_control` breakpoints (#122) are dropped instead of forwarded, and nothing in a request asks a third party to retain a prompt (the deployment's own vLLM prefix cache is a server flag outside this repo). The endpoint **scales to zero** — billing follows activity and the first call after idle pays a cold start of minutes — hence the deliberately generous `http { request_timeout_ms }` and the all-or-nothing flag: one warm box per session, never a trickle of stray calls. And its window is **131072**, from vLLM's `--max-model-len`, mirrored in `MODEL_CONTEXT_WINDOWS` so `resolveClientForRole` trims against the server's real ceiling; `CLIENT_PRICING` deliberately has no entry, because the box is billed by the GPU-second and an invented per-token rate would render as a confident price — it is priced by TIME instead (next paragraph).

**Cost: two pricing models, one currency (EUR).** Everything the app renders as a price is in euro, because that is the currency the bills arrive in, and which model a call takes is decided by the client BAML actually **selected** — never by the tier the run intended, so a call that fell back to Anthropic on a verda-tier turn is priced as Anthropic. Token-priced clients keep the per-MTok arithmetic on the vendor's published USD list price (`CLIENT_PRICING`, `app/src/lib/settings.ts`) and convert once, at `EUR_PER_USD`: a **static** rate set by hand, deliberately not a live FX lookup, or two page loads of one conversation would disagree for a reason that has nothing to do with the conversation. That var is named for the direction it multiplies in — `0.86`, not the EUR/USD pair quote 1.16 — because `positiveRate` accepts any positive number and the reciprocal would inflate every figure by ~35% silently; a source-scan pin in `pricing-eur.test.ts` keeps the reversed name from coming back. `VerdaQwen` — the sole member of `TIME_PRICED_CLIENT`, whose value is pinned equal to `VERDA_CLIENT_NAME` by `pricing-eur.test.ts` because a rename moving only one of the two literals would silently drop the box back to a €0 per-token figure — is `VERDA_EUR_PER_HOUR` (default €1.819/h) × the **per-attempt** `timing.durationMs` BAML reports, and its tokens are free. Both rates come from `cost-rates.server.ts`, read per call so a host change needs no rebuild; `settings.ts` cannot read them itself because it is client-safe and `process` is undefined in the browser bundle. An unmeasured time-priced attempt makes the whole step read as cost-unknown rather than as free — a time bill with no time is not a free call.

The number a time-priced call renders is a **floor, and is labelled one** (`≥`, "compute time"), in the panel's per-step chip, the session summary bar and the dashboard's cost column and footnote. It sums the durations of the calls themselves; the box is also paid for the `VERDA_SCALEDOWN_SECONDS` window it stays warm after the last one and for the cold start before the first, and neither is any call's duration. Caching contributes no saving on that basis — it cannot save wall-clock — so a time-priced step is its own `noCacheEur` baseline. A step that MIXES the two — a self-hosted attempt plus an Anthropic retry — keeps the marker: `isTimePricedStep` beside `stepCostEur` counts the step's time-priced attempts rather than reading the last one's `basis`, which is what dropped the `≥` from a step holding a billed GPU hour. `stepCostEur` in `metrics/aggregate.ts` is the single conversion rule the dashboard and the observability panel both fold through (two copies would be one edit from disagreeing about the same conversation), and it is also where a pre-EUR `costUsd` stamp is converted at the DEFAULT rate: the rate in force when it was stamped was never recorded, so re-pricing history every time the env var moved would be worse than a fixed approximation.

The live check is manual (CI has no endpoint access): `USE_VERDA_INFERENCE=1 pnpm dlx tsx --env-file=.env src/lib/harness-patterns/scripts/smoke-verda.ts` from `app/` — three calls, back-to-back to pay one cold start, each asserting the collector reports `VerdaQwen` rather than trusting the flag, after a preflight that re-reads the served model id from `GET /v1/models` (the deployment, not this repo, decides what it serves) with a 15s bound on that fetch — Node's `fetch` has none, and an unbounded preflight hung the whole check for ~4 minutes and then failed with the bare string `fetch failed`, i.e. it broke exactly when it was being run to diagnose a broken endpoint. **`GET /v1/models` is not a readiness probe**: measured 2026-08-26 it answered a full vLLM payload in 1.2s while a 21-token completion on the same deployment took 146s, because the container was still cold. A 200 there means "the deployment exists and the key is accepted", never "the next call will be quick". The third is `ActorController` with a POPULATED attempt log and a context, which is the actor's retry shape and the only one of the three a passing first attempt does not cover. Its sibling `smoke-verda-load.ts` measures the same route under load — sequential baseline, 4- and 8-way concurrency, and 20 controller-shaped calls counted for parse failures; measured 2026-08-25 at a 2.75k-token prompt: 4.1s single-call, 6.3s p50 / 9.9s p95 at 8 in flight, 64 → 208 tok/s aggregate decode, 47/47 envelopes parsed. One replica, so concurrency is queueing rather than scaling. The hermetic half is three files under `app/src/__tests__/lib/harness-patterns/`: `clients-verda.test.ts`, which pins that every role in the Verda map has a call site spreading `clientOverrideFor(role)` — an entry without one reads like routing and changes nothing; `verda-body-shape.test.ts`, which renders a request offline and pins what goes on the wire (the thinking kwarg, the model id, and no `cache_control` anywhere); and `prompt-role-order.test.ts`, which renders EVERY BAML function through an OpenAI-generic client and pins that no `system` message follows a user or assistant one.

**`system` goes at the front, in every template.** OpenAI-compatible servers require it and vLLM 400s the whole request (`System message must be at the beginning.`); Anthropic lifts only the LEADING system block into its top-level `system` field and silently rewrites the rest to `user`, so an illegal ordering is invisible for as long as a function only ever runs there. `ActorController` carried two — the CONTEXT block in `ActorTaskFrame` and every result block in `ActorAttemptLog` — and the harness evals (#267) caught them: the actor's first attempt passed and every RETRY 400d, which is actorCritic dead on the self-hosted route, silently, because nothing fails until a critic first rejects something. Both now render `user`, which is what `LoopController`'s `LoopTurnLog` always did and why it never had the bug. The rewrite is free on Anthropic — the provider was already coercing those blocks, so the model-visible text and the #122 cache breakpoints are byte-identical and only the message grouping changes. `prompt-role-order.test.ts` audits all thirteen functions, not just the two that were wrong: the blast radius was set by which client a role happened to resolve to, and that map is one edit away from moving.

Local inference lives in `baml_src/local-client.baml` and is in no chain: `LocalGLM` (GLM 4.7 Flash, `pnpm dev:llama` on :8080) for manual wiring, and `LocalQwenSmall` (`make llm-small` on :8095) as the describe role's designated replacement, with the flip documented on its own block.

**Running the small models remotely is env-vars-only.** `LocalQwenSmall` and the Data Stash embedder both speak the OpenAI-compatible wire format, and neither has a hardcoded host — "local" names the format, not the machine. Four vars move both to a remote endpoint with no code change, no rebuild, no `baml-generate`: `SMALL_LLM_BASE_URL` + `SMALL_LLM_API_KEY` for the 4B summarizer, `EMBEDDINGS_LOCAL_URL` + `EMBEDDINGS_LOCAL_API_KEY` for the 0.6B embedder. Both URLs include the `/v1` suffix; both keys are optional and are sent as `Authorization: Bearer`. The `SMALL_LLM_*` pair has no in-code default — BAML options take a bare `env.X` reference — so `app/.env.example` carries the localhost values and is the place they are documented. Changing the embedding _model_ (rather than its host) invalidates the vector index; see `docs/DATA_STASH.md`.

Required env var: `ANTHROPIC_API_KEY`; plus `VERDA_INFERENCE_ENDPOINT` + `VERDA_INFERENCE_API_KEY` when `USE_VERDA_INFERENCE=1`. (`OPENROUTER_API_KEY` is unrelated to routing — it belongs to the optional `openrouter` embedding provider; see `docs/DATA_STASH.md`.)

**Scale-to-zero is a latency mode the whole app has to survive, not just the client.** Measured 2026-08-26 against the live deployment: a single completion into a sleeping box took **146s**; three chats sent in quick succession into a sleeping box are ONE replica's queue, not three cold starts in parallel, so a burst multiplies its own wait. Under that queueing **two distinct platform behaviours were observed, and they are mutually exclusive readings rather than two halves of one story**: two calls returned **nothing at all** and were still unanswered at the client's 600s `request_timeout_ms`, ending as `BamlTimeoutError` (twice in the same turn — controller, then synthesizer); a different call was given up on by the deployment's own gateway and said so **promptly**, `504 {"error":"inference request was canceled"}` after **55s**, i.e. that client learned within a minute and burned no timeout. Which behaviour applies when is **unmeasured** — 55s is one observation under queueing, not a contract — and the two readings point opposite ways on the timeout, which is why it stays an owner decision below. Three consequences are now code rather than folklore:

- **A turn that comes back with nothing is not a success.** `runChain` almost never throws — every pattern catches internally and records an `error` event — so all three harness entry points used to read "the chain returned" as success, and a turn whose LLM calls ALL failed came back `status: 'running'` with `response: ''`. That is `event: done` on the wire, no assistant bubble and a green completion mark in the client, and `'done'` in the row's lifted `status` column: a failed turn recorded as an empty conversation. `settleTurn` (`harness.server.ts`) is the one shared decision now — nothing to show AND something recorded → `status: 'error'`. The conjunction is deliberate: an error WITH a response is the designed partial-answer path (#83), no error and no response is a chain with no synthesizer, and `paused` is an approval gate ending with no response on purpose. `turn-outcome.test.ts` pins all three non-cases as well as the failure.
- **The stream never goes byte-silent.** A blocked call writes nothing for its whole timeout, and zero bytes for ten minutes is indistinguishable from a dead connection to any intermediary with an idle read timeout. That is **defence in depth, not a fix for a measured drop**: the proxy actually in front of the preview is Caddy, and `configs/Caddyfile` records that Caddy's default has no response timeout (it sets `flush_interval -1`, which is what stops SSE frames being buffered). The heartbeat buys "provably alive on the wire" against any future intermediary and against NAT idle eviction. It does **not** buy a user-visible signal — a comment frame is invisible to a human by construction, which is why the wait has a second, separate mechanism (next bullet). `SSE_KEEPALIVE_MS` lives in `lib/sse-client.ts` — beside the parser that must drop it, and NOT in `routes/api/events.ts`, where a non-handler export is stripped from the built route and every `POST` answered `503 ReferenceError` — and writes a comment frame every 15s; `parseChatStream` already dropped `:` lines, and `events-keepalive.test.ts` pins both halves.
- **The wait is visible, and the progress bar stays out of it (D-c).** A turn-level `warming` frame — a new SSE event name, NOT a harness `ContextEvent`, so nothing about one wait is persisted into a conversation blob or replayed on reload — puts a spinner, the words "starting GPU" and a counting-down estimate where the next assistant bubble will land, and the chain's progress bar is suppressed for exactly that window. The suppression is the point: the bar's denominator is seeded by the turn's FIRST event, so without it the bar appears at 0/N and sits there for the whole 146s, which reads as a hung chat. **When it fires** is the `router`'s doing: that role runs on Anthropic in both switch positions and answers in a second or two, so the moment worth announcing is not "a verda-tier turn began" but "routing has answered and the next call is verda-bound while nothing says the box is up" — hence the hook is in `clientOverrideFor()`, the per-call seam that builds a verda-bound options bag, and never in `resolveClientForRole` beside it, which is asked the same question for prompt budgeting without a call following. There is **no matching "warmed" frame**: the client clears on the next frame of any kind, because one more frame is one more frame that can be dropped and a dropped clear leaves a spinner up forever. **The estimate is a measurement or it says it is not** — the median of cold starts this process actually observed, falling back to one named `COLD_START_FALLBACK_MS` (146s, the 2026-08-26 reading), with `basis` on the wire so a tooltip can never dress the fallback as a local figure. Showing the notice errs pessimistic (anything short of proof the box is warm shows it, costing a spinner that clears in four seconds); RECORDING a wait into the history does not get that licence and requires evidence the box went cold, or a warm call this process had not noticed would enter the history as a four-second cold start and drag every future estimate down. `lib/inference/cold-start.server.ts`; wording and countdown in the client-safe `lib/cold-start-format.ts`; scenario 8 in `app/e2e/` pins that the frame lands _inside_ the wait rather than alongside the answer.
- **What is still an owner decision:** the 600s timeout itself — it trades "survive a cold start" against "notice a cancelled request", nobody has measured the platform's own ceiling, and the two observations above argue opposite ways (if cancels always surface as a prompt 504 the generous timeout costs nothing; if the silent pair were cancelled and the reply was dropped, that is a worse platform defect and the case for lowering is strong). Its **hard floor is ~150s**: anything below that reliably fails the first call of every session, by the 146s cold start measured above. Also open: the fact that a turn whose PROCESS dies leaves its row at `status='running'` forever — the row is seeded before the run and only rewritten at the end, so nothing reconciles an abandoned one. See the rationale block in `baml_src/verda-client.baml`.

**Structured-output failures propagate.** No role has a cross-provider ladder to escalate to — the Anthropic chains fall back within Anthropic, and `VerdaQwen` is a single leaf — so a `BamlValidationError` that is neither a truncation nor an empty completion surfaces instead of being retried on a weaker model. Errors are tracked as events; compactExecution reads them via `view.hasErrors()` (scoped by ViewConfig, so they expire naturally across turns).

---

## MCP Gateway

Docker-based gateway on port 8811.

- `configs/custom-catalog.yaml` — available MCP servers (Docker image-based)
- `configs/mcp-config.yaml` — enable/disable and connection params per server

Tool namespaces in `tools.server.ts`: `neo4j`, `web`, `context7`, `filesystem`, `memory`, `redis`, `database` (and `all`). There is no `github` namespace: the GitHub MCP server and its PAT were removed in #226 E3 — no agent used it, and the `gh` CLI covers this repo's own GitHub work.

`KNOWN_TOOL_SERVERS` maps tool names to namespaces when auto-detection would fail.

**Connection pool (#120):** `mcp-client.server.ts` keeps a pool of gateway connections (`MCP_GATEWAY_POOL_SIZE`, default 4) instead of one singleton. Each `callTool`/`listTools` leases a connection for the duration of the call and releases it in a `finally`, so the reconnect-once retry rebuilds only the failing connection and never disturbs other in-flight calls. Above the pool size, calls open a short-lived overflow connection (closed on release) rather than queueing behind a busy slot. This multiplexes the client→gateway hop only — per-server serialization (e.g. redis over serial stdio) is enforced inside the gateway and is unchanged.

**Redis MCP quirks** (encapsulated by `document-store.server.ts` / `document-ingest.server.ts`; full detail in [`docs/DATA_STASH.md`](docs/DATA_STASH.md)):

- The `redis` service must be **redis-stack** (RedisJSON + RediSearch); plain `redis` has no modules. On Apple-Silicon/colima, run it `platform: linux/amd64` (a git-ignored `docker-compose.override.yml`) — the arm64 `redisearch.so` SIGILLs on vector ops.
- Param names: `json_get`/`json_set` use `name`/`path`; `expire`/`hset`/`sadd` take `expire_seconds`; `delete` uses `key` (not `name`); `set_vector_in_hash`/`vector_search_hash` use `name`/`index_name` + a float `vector`/`query_vector`.
- The gateway runs each redis server over **serial stdio** (so bulk writes are sequential), returns multi-value results (e.g. `smembers`) as **one text block per element** (`callTool` aggregates these into an array), and **auto-parses JSON-looking string args into objects** (so chunk metadata is base64-encoded before `hset`).

---

## Styling

UnoCSS attributify mode — always use attribute syntax:

```tsx
<div flex="~ col" text="sm gray-600" p="4" gap="2">
<button bg="cyan-600/10 hover:cyan-600/20" text="xs cyan-400">
```

**Theming (#226 B8):** the interface palette is `ui-bg-*` / `ui-text-*` / `ui-border-*` / `ui-accent` / `ui-danger` / `ui-success`, each resolving to `var(--ui-…)`. `uno.config.ts`'s first preflight declares those variables on `:root` (dark) and redefines them on `:root.light`; `src/lib/theme.ts` decides which class `<html>` carries and exports the `THEME_BOOT_SCRIPT` that `entry-server.tsx` inlines to avoid a flash. **Write `ui-*`. Never add a `dark:` variant** — the token flips, the component does not.

The switch is three-state: `light`, `dark`, `system` (the default). `system` follows `prefers-color-scheme` live; an explicit choice is persisted in `localStorage.theme` and ignores the OS. Only `light`/`dark` are ever written — `system` is the absent key.

`dark-{bg,text,border}-*` and `neon-*` still exist as fixed hexes, and are now **graph-canvas data colours only** (`lib/turn-colors.ts`, `lib/agent-palette.ts`, Cytoscape's style object, xterm's theme — none of which can read a CSS variable). An `i-…` glyph aside, a `dark-*` or `neon-cyan` token in `src/components` or `src/routes` is a bug; `__tests__/lib/theme-migration.test.ts` fails on one. `cyber-{600,700,800}` (indigo) stays fixed on purpose: it reads on both grounds.

Not yet on the theme, and visible in light mode: the Cytoscape canvas, `UserMenu`'s dropdown (white in both modes), the retriever citation chips (`.doc-ref*`) and the sidebar completion-flash keyframes.

**Icons** — `material-symbols` (+ `material-symbols-light`) is **the** icon set; they are the only two collections registered in `presetIcons` (`app/uno.config.ts`):

- Use via `class="i-material-symbols-<icon-name>"` — icon classes are the one sanctioned `class=` exception, since `presetIcons` has no attributify form
- Example: `<span class="i-material-symbols-database-outline" w="5" h="5" text="ui-accent" aria-hidden="true" />`
- Browse icons at [https://icones.js.org](https://icones.js.org) — filter by `material-symbols`
- ⚠️ mdi is gone (#226 B6): `@iconify-json/mdi` is no longer a dependency and no `i-mdi-*` class survives in `app/src`. An `i-mdi-*` is a bug — the collection is not registered, so it emits no CSS and the glyph renders as an empty span
- Full styleguide (attributify rules, house recipes, role→colour mapping, a11y + graph checklists): the `kg-dtalk-ui` skill

---

## Documentation

**[`docs/INDEX.md`](docs/INDEX.md) is the index** — every doc, with a sentence on what each holds. It is maintained; a second list here would only drift out of step with it.

The three reached most often, so you do not have to go via the index for them:

- [GitHub Project — "Harness Playground tasks"](https://github.com/users/mknw/projects/5) — the live planning board (Status / Priority / MSCW per issue). Item tracking lives there, not in a file.
- [`docs/plan/ROADMAP.md`](docs/plan/ROADMAP.md) — the roadmap _shape_: multi-user target architecture, phased MoSCoW plan, Entra SSO #119 as the gate. Keep it in sync with the board's MSCW field.
- [`docs/agents/AGENT-BRIEF.md`](docs/agents/AGENT-BRIEF.md) — the dispatch spec template, and the standing acceptance criteria every piece of work in this repo is held to.
