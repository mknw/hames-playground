# CLAUDE.md

Project-level guidance for Claude Code in this repository.

## Commands

**Every `pnpm` command runs from `app/`** — never npm/npx, never from the repo root. The script list itself is a one-file lookup in `app/package.json`; what is not in that file:

- **`pnpm baml-generate` after any edit under `baml_src/`.** `baml_client/` is generated and gitignored; a stale or missing one surfaces as ~270 phantom test failures, not as a BAML error. Never hand-edit it.
- **Two llama-servers, two ports, and mixing them up is the trap.** `pnpm dev:llama` starts the local _chat_ model (GLM-4.7-Flash) on **8080**. The Data Stash _embedding_ server is a different model on **8090**, started by hand:

  ```bash
  llama-server --embedding -m models/Qwen3-Embedding-0.6B-Q8_0.gguf --port 8090 --ctx-size 8192
  ```

- **`pnpm dev:exposed`** binds 0.0.0.0 — required for anything in Docker (Playwright MCP, the gateway) to reach the dev server.

### Client routing: Anthropic-default, mixed-chains opt-in

Every BAML call (Router / LoopController / ActorController / Critic / Synthesize / ResultDescribe) routes through the Anthropic-only fallback chains in `baml_src/anthropic-only.baml` by default. Cross-provider rate limits (Groq + OpenRouter + OpenAI) interfered too much during dev iteration, so Anthropic-only is the dev default.

To use the **mixed-provider production chains** (RouterFallback / ControllerFallback / etc. in `baml_src/clients.baml`):

```bash
USE_MIXED_CHAINS=1 pnpm dev:exposed
```

This unsets the override and lets each BAML function fall back to its declared chain. Production deployments and occasional mixed-chain testing both use this. See `app/src/lib/harness-patterns/clients.server.ts` for the toggle.

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

**The chains themselves live in `baml_src/`** — `anthropic-only.baml` for the default, `clients.baml` for the mixed-provider ones — and are one lookup away. What is _not_ in those files is why each client is shaped the way it is, so that is what this section carries.

**Default (Anthropic-only)** — declared in `baml_src/anthropic-only.baml`:

| Client                 | Role                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `RouterAnthropic`      | Intent classification                                                                                                                   |
| `ControllerAnthropic`  | simpleLoop tool-loop controller — `*NoThink` models, and the backstop stays Sonnet-tier: no Haiku fallback on structured output         |
| `ActorAnthropic`       | actorCritic actor — the same models as the controller, with thinking left ON                                                            |
| `PlannerAnthropic`     | planner (#27) upfront decomposition — one call per chain, thinking left ON (the reasoning IS the deliverable)                           |
| `CriticAnthropic`      | Evaluation/critique                                                                                                                     |
| `SynthesizerAnthropic` | Response synthesis                                                                                                                      |
| `DescribeAnthropic`    | Lightweight tool result summarization (one batched call per ≤8 results, `compactBulkData`), titles, intent compaction (`compactIntent`) |

**Extended thinking (#139):** these models think by default — no request asks for
it — and the trace is never exposed (empty string + signature), so it cannot feed
`reasoning`. Measured on 12 captured controller prompts × 6 samples: the simpleLoop
controller is better WITHOUT it (72/72 valid actions vs 70/72; median output 438 →
249 tokens; it stops re-querying when it already holds the answer), so
`ControllerAnthropic` uses the `*NoThink` clients. The actor, planner, router,
critic and compactExecution keep thinking — unmeasured, and the corpus had no
actor prompts. A thinking-only response with no text is retried once by the
adapters.

**Output caps + truncation recovery:** Anthropic client `max_tokens` are 32768 (Sonnet 5) / 16384 (Sonnet 4.6, Haiku 4.5); the mixed-chain Groq/OpenRouter leaves cap at 2048–4096. EVERY leaf declaring `max_tokens` in `baml_src/*.baml` must be mirrored in `CLIENT_MAX_OUTPUT_TOKENS` (`app/src/lib/settings.ts`) — a missing entry silently blinds truncation detection for that client (SA-C2); `client-output-caps.test.ts` enforces the mirror. A controller response that hits its cap truncates mid-JSON (historically: `BamlValidationError: missing status/is_final` when a sandbox actor inlined a huge script into `tool_args`). The adapters detect cap-hits and do ONE corrective retry with truncation guidance appended to the per-call `context`; the loops emit truncation-specific feedback instead of generic "invalid JSON" when `tool_args` were cut off (`llmCallHitOutputCap`). Multi-call turns (`additional_calls`, see below) raise cap-hit risk — the prompts cap batches at 4 calls/turn for this reason.

**Multi-call turns:** both loop patterns accept `multiToolCalls: 'parallel' | 'sequential' | 'off'` (default `'parallel'`) — the controller batches several tool calls into one turn via `ControllerAction.additional_calls`, saving one controller round-trip per batched call. `'sequential'` runs in order with stop-on-failure (sandbox agents); `'off'` suppresses the prompt affordance but still executes un-advertised batches serially (no agent uses it today). Full semantics: `app/src/lib/harness-patterns/SPEC.md`.

**Mixed-provider chains** (gated by `USE_MIXED_CHAINS=1`, see top of file) — `RouterFallback` / `ControllerFallback` / `CriticFallback` / `SynthesizerFallback` / `DescribeFallback`, each spreading its role across OpenRouter, Groq and OpenAI with an Anthropic backstop last. There is no `ActorFallback` and no `PlannerFallback`. **The planner opts out of mixed chains entirely** — `MIXED_CLIENT_BY_ROLE.planner` pins `PlannerAnthropic` in both modes. It used to borrow `ControllerFallback` as the same reason-over-a-tool-catalog workload, but that chain's Groq `gpt-oss-120b` is the client documented below to fail structured output on larger context, which is why both controllers carry a manual `GroqGPT120B` → `GroqFast` escalation. The planner has no such ladder, runs once per chain over the largest catalog in the repo (`tools.all`), and a throw there means the chain silently runs unplanned. Declared in `baml_src/clients.baml`.

**The injection screen also opts out** — `MIXED_CLIENT_BY_ROLE.screen` pins `DescribeAnthropic` in both modes (SA-M5). It used to ride the `describe` role, which under mixed chains silently put prompt-injection screening on `DescribeFallback`'s first leaf (`GroqFast`, the weakest model in the repo): a screen must not be talked out of reporting by the content it reviews and must copy spans verbatim so the guard can neutralize them. Rationale on the map entry in `clients.server.ts`.

Local inference (`LocalGLM` — GLM 4.7 Flash on localhost:8080) is defined in `baml_src/local-client.baml` and available for manual wiring but not used in any fallback chain.

Required env vars: `ANTHROPIC_API_KEY` (always). With `USE_MIXED_CHAINS=1` also: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`.

**Known limitation (mixed-chains only):** Groq `gpt-oss-120b` fails structured output (`BamlValidationError`) on turn 2+ with larger context. `baml-adapters.server.ts` catches this manually and retries with `GroqGPT120B` then `GroqFast`. Anthropic-only runs propagate the validation error instead. Errors are tracked as events; compactExecution reads them via `view.hasErrors()` (scoped by ViewConfig, so they expire naturally across turns).

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

Custom tokens: `dark-bg-{primary,secondary,tertiary}`, `dark-text-{primary,secondary,tertiary}`, `dark-border-{primary,secondary}`, `neon-{cyan,magenta,purple}`, `cyber-{600,700,800}`.

**Icons** — `material-symbols` (+ `material-symbols-light`) is **the** icon set; they are the only two collections registered in `presetIcons` (`app/uno.config.ts`):

- Use via `class="i-material-symbols-<icon-name>"` — icon classes are the one sanctioned `class=` exception, since `presetIcons` has no attributify form
- Example: `<span class="i-material-symbols-database-outline" w="5" h="5" text="neon-cyan" aria-hidden="true" />`
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
