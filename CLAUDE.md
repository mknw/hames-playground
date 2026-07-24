# CLAUDE.md

Project-level guidance for Claude Code in this repository.

## Commands

All commands run from `ui/` using `pnpm`:

```bash
pnpm dev              # Dev server on port 3444 (vinxi)
pnpm dev:exposed      # Bind to 0.0.0.0 (required for Docker/Playwright MCP access)
pnpm build            # Runs baml-generate + vinxi build in parallel
pnpm test:run         # Run all tests once (vitest)
pnpm test             # Watch mode
pnpm baml-generate    # Regenerate baml_client/ from baml_src/
pnpm baml-test        # Run BAML tests
pnpm dev:llama        # Start local GLM-4.7-Flash *chat* model (port 8080)
pnpm exec tsc --noEmit --project tsconfig.json  # Type-check (from ui/)
```

Local **embedding** server for the Data Stash pipeline (separate from `dev:llama`'s chat model — different model, port 8090):
```bash
llama-server --embedding -m models/Qwen3-Embedding-0.6B-Q8_0.gguf --port 8090 --ctx-size 8192
```

Run a single test file:
```bash
cd ui && pnpm vitest run src/__tests__/lib/harness-patterns/simpleLoop.test.ts
```

### Client routing: Anthropic-default, mixed-chains opt-in

Every BAML call (Router / LoopController / ActorController / Critic / Synthesize / ResultDescribe) routes through the Anthropic-only fallback chains in `baml_src/anthropic-only.baml` by default. Cross-provider rate limits (Groq + OpenRouter + OpenAI) interfered too much during dev iteration, so Anthropic-only is the dev default.

To use the **mixed-provider production chains** (RouterFallback / ControllerFallback / etc. in `baml_src/clients.baml`):

```bash
USE_MIXED_CHAINS=1 pnpm dev:exposed
```

This unsets the override and lets each BAML function fall back to its declared chain. Production deployments and occasional mixed-chain testing both use this. See `ui/src/lib/harness-patterns/clients.server.ts` for the toggle.

Docker services (Neo4j, MCP Gateway, Redis):
```bash
docker compose up -d
docker compose ps
```

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

**BAML regeneration:** Always run `pnpm baml-generate` after editing any file in `baml_src/`. Never edit `baml_client/` directly.

**UnoCSS attributify:** The `color` HTML attribute conflicts with UnoCSS attributify. Use `text="xs cyan-400"` (combined) instead of separate `color="cyan-400"`.

**Graph tabs:** `SupportPanel` uses `lazyMount` + `unmountOnExit` on `Tabs.Root` — Cytoscape instances only exist for the active tab. The Neo4j/Memory tabs consume accumulated `graphElements` from `index.tsx`. The All tab derives elements on-demand from `contextEvents` via `turn-utils.ts` based on user-selected turns, with per-turn color coding via `GraphVisualization`'s `extraStyles` prop.

**Probe before scaffolding:** For architectural questions (new patterns, infrastructure, deployment shapes, anything with multiple non-obvious options), sample the option space first and converge with the user on the shape before writing implementation docs or code. Going straight to a fully-detailed design tends to lock in defaults the user would have redirected. See [`docs/plan/sandbox.md`](docs/plan/sandbox.md) for the kind of doc that should *follow* such a conversation, not start it.

---

## Harness Patterns — Quick Reference

Framework in `ui/src/lib/harness-patterns/`. Full API: [`ui/src/lib/harness-patterns/README.md`](ui/src/lib/harness-patterns/README.md).

**BAML functions must use `.bind(b)`:**
```typescript
simpleLoop(b.Neo4jController.bind(b), tools.neo4j, { patternId: 'neo4j-query', schema })
```

**Preferred: use adapter factories instead:**
```typescript
const controller = createNeo4jController(tools.neo4j ?? [])
const actor = createActorControllerAdapter(tools.all)
const critic = createCriticAdapter()
```

**Multi-turn sessions:**
```typescript
// Continue: pass serialized from previous turn
continueSession(serialized, patterns, newInput)
// After approval gate:
resumeHarness(serialized, patterns, approved)
```

**EventView inside patterns:**
```typescript
view.fromLastPattern().ofType('tool_result').get()   // → ContextEvent[]
view.fromPatterns(['neo4j-query']).serialize()        // → XML for LLM
```

### Adding a New Agent

1. Create `ui/src/lib/harness-client/examples/<name>.server.ts` — export `AgentConfig` with `id`, `name`, `description`, `icon`, `servers[]`, `createPatterns`
2. Register in `ui/src/lib/harness-client/registry.server.ts`

---

## BAML Clients

**Default (Anthropic-only)** — declared in `baml_src/anthropic-only.baml`:

| Client | Role | Chain |
|--------|------|-------|
| `RouterAnthropic` | Intent classification | AnthropicHaiku45 → AnthropicSonnet5 |
| `ControllerAnthropic` | Tool loop controllers (simpleLoop + actor) | AnthropicSonnet5 → AnthropicSonnet46 (backstop stays Sonnet-tier — no Haiku fallback on structured output) |
| `CriticAnthropic` | Evaluation/critique | AnthropicHaiku45 → AnthropicSonnet5 |
| `SynthesizerAnthropic` | Response synthesis | AnthropicSonnet5 → AnthropicHaiku45 |
| `DescribeAnthropic` | Lightweight tool result summarization, titles, intent compaction (`compactIntent`) | AnthropicHaiku45 |

**Output caps + truncation recovery:** Anthropic client `max_tokens` are 32768 (Sonnet 5) / 16384 (Sonnet 4.6, Haiku 4.5) — mirrored in `CLIENT_MAX_OUTPUT_TOKENS` (`ui/src/lib/settings.ts`); keep the two in sync. A controller response that hits its cap truncates mid-JSON (historically: `BamlValidationError: missing status/is_final` when a sandbox actor inlined a huge script into `tool_args`). The adapters detect cap-hits and do ONE corrective retry with truncation guidance appended to the per-call `context`; the loops emit truncation-specific feedback instead of generic "invalid JSON" when `tool_args` were cut off (`llmCallHitOutputCap`).

**Mixed-provider chains** (gated by `USE_MIXED_CHAINS=1`, see top of file) — declared in `baml_src/clients.baml`:

| Client | Chain |
|--------|-------|
| `RouterFallback` | OpenRouterGemma4 → GroqFast → GroqGPT120B |
| `ControllerFallback` | OpenRouterNemotron120B → OpenAIGPT5 → OpenRouterMiniMax2_5 → GroqGPT120B |
| `CriticFallback` | GroqQwen3_32b → GroqGPT120B → OpenRouterMiniMax2_5 |
| `SynthesizerFallback` | OpenRouterGemma4 → GroqQwen3_32b → OpenAIGPT5 |
| `DescribeFallback` | GroqFast → OpenRouterGemma4 → OpenAIGPT5Mini |

Local inference (`LocalGLM` — GLM 4.7 Flash on localhost:8080) is defined in `baml_src/local-client.baml` and available for manual wiring but not used in any fallback chain.

Required env vars: `ANTHROPIC_API_KEY` (always). With `USE_MIXED_CHAINS=1` also: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`.

**Known limitation (mixed-chains only):** Groq `gpt-oss-120b` fails structured output (`BamlValidationError`) on turn 2+ with larger context. `baml-adapters.server.ts` catches this manually and retries with `GroqGPT120B` then `GroqFast`. Anthropic-only runs propagate the validation error instead. Errors are tracked as events; synthesizer reads them via `view.hasErrors()` (scoped by ViewConfig, so they expire naturally across turns).

---

## MCP Gateway

Docker-based gateway on port 8811.

- `configs/custom-catalog.yaml` — available MCP servers (Docker image-based)
- `configs/mcp-config.yaml` — enable/disable and connection params per server

Tool namespaces in `tools.server.ts`: `neo4j`, `web`, `context7`, `filesystem`, `github`, `memory`, `redis`, `database`, `code` (and `all`).

`KNOWN_TOOL_SERVERS` maps tool names to namespaces when auto-detection would fail.

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

**Icons** (`@unocss/preset-icons` + `@iconify-json/mdi` installed):
- Use MDI icons via `class="i-mdi-<icon-name>"` (note: requires `class=`, not attributify syntax)
- Example: `<span class="i-mdi-database-outline" style={{ width: '20px', height: '20px', color: '#22d3ee' }} />`
- Browse icons at [https://icones.js.org](https://icones.js.org) — filter by `mdi`
- The `color` HTML attribute conflicts with attributify; use inline `style={{ color: '...' }}` for icon color

---

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/INDEX.md`](docs/INDEX.md) | Full documentation index |
| [GitHub Project — "Harness Playground tasks"](https://github.com/users/mknw/projects/5) | Live planning board (Status / Priority / MSCW per issue) — item tracking lives here |
| [`docs/plan/ROADMAP.md`](docs/plan/ROADMAP.md) | Roadmap *shape*: multi-user target architecture + phased MoSCoW plan (Entra SSO #119 gates; keep in sync with the board's MSCW field) |
| [`docs/UI_ARCHITECTURE.md`](docs/UI_ARCHITECTURE.md) | Component structure, data flow, Chat-Graph linking |
| [`docs/DATA_STASH.md`](docs/DATA_STASH.md) | Data Stash pipeline: upload → chunk → embed → search (#6/#9/#8), API routes, Redis storage, redis-stack + local-embedder requirements |
| [`docs/AGENT_TRIGGER.md`](docs/AGENT_TRIGGER.md) | `POST /api/agents/:id` async agent trigger → action rows: contract, fire-and-forget model, `kind`/`source`/`status` columns, token auth (`configs/action-tokens.yaml`), recording playback via Data Stash, promotion gate |
| [`ui/README.md`](ui/README.md) | UI quick start and file index |
| [`ui/src/lib/harness-patterns/README.md`](ui/src/lib/harness-patterns/README.md) | Harness patterns full API |
