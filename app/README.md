# The hames app

The SolidStart application: the chat interface, the server actions, turn
orchestration, auth and persistence. It composes ready-made agents from
[`@hames/agents`](../packages/agents/README.md) — themselves built on
[`@hames/harness-patterns`](../packages/harness-patterns/README.md) with their
prompts and model adapters from
[`@hames/harness-baml`](../packages/harness-baml/README.md) — reaches its tools
through [`@hames/connectors`](../packages/connectors/README.md), and runs
agent-authored code in [`@hames/sandbox`](../packages/sandbox/README.md).

Those are five workspace packages under [`../packages/`](../packages/), consumed
here through `workspace:*`. **The framework is not in this directory.** This app
is its reference host: it supplies identity, storage, catalogs, policy and
presentation, and composes what the packages export.

## Run

First-time setup — Docker services, `.env`, the two required keys — is the
[repo Quickstart](../README.md#quickstart). Once that is done, the loop from
`app/` is:

```bash
pnpm dev                          # http://localhost:3444
```

Two things that are not obvious from here:

- **`pnpm install` belongs at the repo root**, not in `app/`. The `workspace:*`
  links this app depends on are created by a root-level install; an install run
  only inside `app/` leaves `@hames/*` declared, present on disk and unlinked,
  and Vite reports that as `Cannot find module '@hames/sandbox/settings'` — which
  reads like a bad import path. The `predev` guard
  ([`scripts/check-workspace-links.mjs`](scripts/check-workspace-links.mjs)) runs
  before the dev server, names the real cause, and repairs it by running
  `pnpm install --frozen-lockfile` at the root.
- **There is no `baml-generate` here.** See [Commands](#commands).

## Ports

| Service     | Address                                            | Comes from             |
| ----------- | -------------------------------------------------- | ---------------------- |
| App         | <http://localhost:3444>                            | `pnpm dev` (vinxi)     |
| Neo4j       | <http://localhost:7474> (browser) · `7687` (bolt)  | `docker compose up -d` |
| MCP Gateway | <http://localhost:8811/mcp>                        | `docker compose up -d` |
| Postgres    | `localhost:5432` — db `kgagent`                    | `docker compose up -d` |
| redis-stack | `localhost:6379` — Data Stash                      | `docker compose up -d` |
| doc-convert | <http://localhost:8000> — binary upload → markdown | `docker compose up -d` |

`doc-convert` is only used when `STASH_CONVERT_DOCS=1`; the app reads
`DOC_CONVERT_URL` (default `http://localhost:8000`). All six are defined in the
repo-root `docker-compose.yaml`; the first five come up with a bare
`docker compose up -d` (the `app` service itself is behind a compose profile —
see [Commands](#commands)).

## Architecture

```
app/
├── src/
│   ├── routes/                          # 23 files — file-based routes + server endpoints
│   │   ├── index.tsx                    # main page (Splitter: Chat + SupportPanel)
│   │   ├── dashboard.tsx                # usage + cost dashboard
│   │   ├── profile.tsx                  # signed-in user's profile
│   │   ├── [...404].tsx
│   │   ├── auth/                        # signin.tsx · access-denied.tsx
│   │   ├── s/[token].tsx                # read-only shared conversation
│   │   └── api/
│   │       ├── events.ts                # SSE endpoint for streaming agent events
│   │       ├── health.ts                # liveness probe
│   │       ├── agents/[id].ts           # agent-trigger endpoint (#106)
│   │       ├── auth/                    # login.ts · callback.ts · logout.ts (Entra OIDC)
│   │       ├── routines/                # index.ts · [id].ts — scheduled runs (#131)
│   │       ├── sandbox/pty/             # stream.ts · input.ts · resize.ts — interactive Shell
│   │       ├── stash.ts                 # hide/unhide/archive a persisted tool result
│   │       └── stash/                   # upload.ts · ingest.ts · search.ts · document/[id].ts
│   ├── components/
│   │   ├── AuthProvider.tsx · Nav.tsx
│   │   └── ark-ui/                      # 24 files + observability/ (5) — the whole UI layer
│   │       ├── ChatInterface.tsx        # sends messages, streams SSE, entity highlighting
│   │       ├── ChatSidebar.tsx          # thread list: live progress, completion marks, select mode
│   │       ├── ChatMessages.tsx         # markdown rendering with interactive graph entity spans
│   │       ├── ChatInput.tsx · AgentSelector.tsx · ConversationTierSwitch.tsx
│   │       ├── GraphVisualization.tsx   # Cytoscape.js graph with controls, editing, extraStyles
│   │       ├── SupportPanel.tsx         # tabbed panel (lazyMount): Neo4j, Memory, Data, Terminal
│   │       ├── DataStashPanel.tsx · TerminalPanel.tsx · InteractiveTerminal.tsx
│   │       ├── ObservabilityPanel.tsx   # event timeline + LLM call detail (observability/ holds the tabs)
│   │       ├── SettingsPanel.tsx        # harness settings FloatingPanel
│   │       └── PreviewHeaderStrip.tsx · ShareConversationButton.tsx · ThemeSwitcher.tsx · UserMenu.tsx
│   ├── lib/
│   │   ├── harness-client/              # 11 files — the composition root and turn orchestration
│   │   │   ├── registry.server.ts       # overlays @hames/agents definitions with icon + accent
│   │   │   ├── session.server.ts        # the one AgentDeps bag + Postgres-backed serialized context
│   │   │   ├── turn.server.ts           # runs a turn: run frame, tier scope, wake, persistence
│   │   │   ├── action-runner.server.ts  # background runs for triggered actions and routines
│   │   │   ├── actions.server.ts        # the 'use server' surface the UI calls
│   │   │   ├── neo4j-enricher.server.ts # `onToolResult` recipe — 1-hop neighborhood for touched nodes
│   │   │   └── README.md                # session lifecycle + graph extraction, in detail
│   │   ├── auth/                        # 18 files — Entra/MSAL OIDC, session store, token crypto (#119)
│   │   ├── db/                          # 7 files — conversations, routines, user prefs, column crypto
│   │   ├── inference/                   # 9 files — tier resolution, cold-start estimate, wake poll
│   │   ├── org-graph/                   # 8 files — org roster ingestion and ontology
│   │   ├── stash/                       # Data Stash HTTP + ownership (the host transport)
│   │   ├── metrics/                     # cost + latency aggregation behind the dashboard
│   │   ├── privacy/                     # graph pseudonymisation
│   │   ├── routines/                    # scheduled-run triggers and dispatch (#131)
│   │   ├── neo4j/                       # queries.ts · graph-edit.server.ts (parameterized writes)
│   │   ├── app-tools/ · config/ · observability/
│   │   ├── settings.ts                  # HarnessSettings, defaults, MODEL_CONTEXT_WINDOWS
│   │   ├── settings-store.ts            # client-side reactive store (localStorage persistence)
│   │   ├── run-registry.ts              # multi-session run state, completion marks (#105)
│   │   ├── graph-merge.ts               # mergeGraphElements() — dedup + touched-flag refresh
│   │   ├── sse-client.ts · turn-stream.ts · api-client.ts
│   │   └── theme.ts · agent-palette.ts · cost-rates.server.ts · redis-direct.server.ts
│   ├── app.tsx · entry-client.tsx · entry-server.tsx · middleware.ts
│   └── __tests__/                       # the unit/component layer (CI)
├── e2e/                                 # app-path e2e (vitest)
├── e2e-browser/                         # browser e2e (Playwright)
├── evals/                               # live, billed harness evals — never in CI
└── scripts/                             # check-workspace-links.mjs · release-check.ts
```

What is **not** here, and used to be: the harness patterns, the agent
definitions, the sandbox, the MCP/Neo4j connectors and the Data Stash pipeline
(document store, chunking, embeddings, ingest) all live under
[`../packages/`](../packages/) now.

### How the app consumes the five packages

| Package                                                             | What it supplies                                                                                                          | Where it lands here                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@hames/harness-patterns`](../packages/harness-patterns/README.md) | Patterns, `UnifiedContext` + `EventView`, the injection guard, the tool transport, the run frame, the Data Stash pipeline | `harness-client/turn.server.ts` opens the run frame; every agent composes patterns |
| [`@hames/harness-baml`](../packages/harness-baml/README.md)         | The BAML corpus + committed client, adapter factories, role→client routing                                                | imported by the agent definitions; tier overrides come from the app                |
| [`@hames/agents`](../packages/agents/README.md)                     | Nine agent definitions (six registered + three helpers), graph extraction, replay                                         | `harness-client/registry.server.ts` overlays each with an icon and accent          |
| [`@hames/connectors`](../packages/connectors/README.md)             | The MCP-gateway namespace catalog, Microsoft Graph tools, the Neo4j non-agentic layer                                     | registered at boot; `lib/neo4j/` and `lib/app-tools/` build on it                  |
| [`@hames/sandbox`](../packages/sandbox/README.md)                   | `withSandbox`, the Docker backend, warm pool, egress profiles, `/work` sync                                               | injected into agent definitions through the `AgentDeps` bag                        |

## Key Features

### SSE Event Streaming

Agent events stream to the client in real-time via `POST /api/events`. The UI updates the graph visualization and observability panel incrementally as events arrive.

### Conversation Persistence

Conversations are persisted to Postgres in a single `conversations` table; the `context` column holds the full `serializeContext()` blob. Rows are created **at run start** (#105) so a new chat is visible in the sidebar — with live progress — during its whole first turn; the run's final save overwrites the stub. The sidebar lists per-user threads via `listConversations()` (ordered by creation, not activity), and selecting a thread calls `loadConversation()` which rehydrates events into the graph + observability panel. Conversations are deletable from the sidebar (#71) — per-row or bulk via select mode — through a user-scoped atomic `DELETE … RETURNING`; running conversations are never deletable (the run's end-save would recreate the row). Titles are sticky (first 60 chars of the first user message). Auth is Microsoft Entra ID via server-side MSAL OIDC (`src/lib/auth/`, #119); in dev, `isBypassEnabled()` (in `src/lib/auth/dev-bypass.ts`, gated on `import.meta.env.DEV && VITE_DEV_BYPASS_AUTH === 'true'`) falls back to the `dev-bypass-user` literal, overridable per test suite with `VITE_DEV_BYPASS_USER_ID` (#280). See [`src/lib/harness-client/README.md`](src/lib/harness-client/README.md#session-lifecycle) for the session lifecycle.

### Interactive Graph Visualization

- Cytoscape.js rendering with dark theme and multiple layouts
- Incremental graph updates (additive, preserves positions)
- Entity names in chat messages are interactive: hover highlights graph elements, click toggles persistent highlight
- Visual controls: node size, edge width, font size, edge labels
- Node property editing and relation creation directly from the graph
- `lazyMount` + `unmountOnExit` on tabs prevents idle Cytoscape instances

### Settings & Token Budget

Harness parameters (max tool turns, retries, result truncation, etc.) are configurable via the Settings panel in the sidebar. Settings are persisted to localStorage and sent with each request. On the server they become the `config` slot of the **run frame** — the one ambient scope a run carries ([`run-frame.server.ts`](../packages/harness-patterns/run-frame.server.ts)) — which every pattern reads through `runtimeConfig()` ([`runtime-config.server.ts`](../packages/harness-patterns/runtime-config.server.ts)) instead of threading them through function signatures. There is no fall-back outside a frame: `runtimeConfig()` throws rather than quietly answering the library defaults, because that could not distinguish a host that wants the defaults from a host that never opened a frame (#374). A `trimToFit()` utility in [`token-budget.server.ts`](../packages/harness-patterns/token-budget.server.ts) drops oldest history entries when the prompt would overflow a model's context window.

### Graph Data Extraction

`graph-extractor.ts` — now [`packages/agents/graph-extractor.ts`](../packages/agents/graph-extractor.ts), re-exported client-safe from the `@hames/agents` root barrel — handles two Neo4j result formats:

- **MCP format**: Flat record objects where nodes are `{ name, description, ... }` and relationships are `[startNode, "TYPE", endNode]` tuples
- **Neo4j driver format**: Objects with `identity`/`elementId`, `labels[]`, `properties{}`

It also recognises the **enriched payload** produced by `neo4j-enricher.server.ts` (`{ rows, _neighborhood, _touched }`) — the Neo4j panel uses the `data.touched` flag to highlight the nodes the agent's query actually targeted, while neighborhood context renders in the default cyan. `get_neo4j_schema` results are suppressed entirely (#14: prevented relationship-type names from being rendered as fake nodes). See [`harness-client/README.md`](src/lib/harness-client/README.md#graph-extraction) for the full pipeline.

### Agent Framework

See [harness-patterns/SPEC.md](../packages/harness-patterns/SPEC.md) for the full API reference; [README.md](../packages/harness-patterns/README.md) is the library front page and [GUIDE.md](../packages/harness-patterns/GUIDE.md) the developer guide. Cross-pattern data flow is handled by `withReferences` ([design](../docs/harness-patterns/with-references.md)) — every default-agent route is wrapped so the inner pattern receives an LLM-curated set of relevant prior `tool_result` events on entry, plus a synthetic `expandPreviousResult` tool the controller can call to load full content.

## Commands

All of these run from `app/`, with pnpm — never npm/npx.

```bash
pnpm dev              # dev server on port 3444 (predev checks the workspace links first)
pnpm dev:exposed      # same, bound to 0.0.0.0 — required for Docker/Playwright to reach it
pnpm build            # vinxi build
pnpm start            # serve the build output

pnpm test             # vitest, watch mode
pnpm test:run         # vitest run — the unit/component layer
pnpm test:e2e         # app-path e2e (vitest, e2e/vitest.config.ts)
pnpm test:e2e:browser # browser e2e (Playwright, e2e-browser/playwright.config.ts)
pnpm release:check    # the three hermetic layers in order, one go/no-go report

pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint .            (pnpm lint:fix to apply)
pnpm format:check     # prettier --check .  (pnpm format to write)

pnpm dev:llama        # optional: a local llama-server on :8080 for the manual
                      # LocalGLM wiring. The model path in the script is the
                      # author's cache — edit it for your machine.
```

What each of `test:run` / `test:e2e` / `test:e2e:browser` / `release:check`
actually gates, why there are three test databases, and what a GO from
`release:check` does **not** cover:
[`docs/testing/pyramid.md`](../docs/testing/pyramid.md).

There is no `baml-generate` here. The one BAML corpus lives in
[`packages/harness-baml/`](../packages/harness-baml/README.md) and ships a
COMMITTED `baml_client/`; regenerating is that package's script, run from that
directory after a `.baml` edit, and the result is committed with it.

`pnpm eval:harness` is deliberately NOT in that list. It runs the
harness/client compatibility evals in [`evals/`](evals/README.md) — real, billed
LLM calls against a live endpoint, run by hand whenever a BAML client changes to
check the shipped workflows still work on it. It is not a test, it never runs in
CI, and [`src/__tests__/evals-not-in-ci.test.ts`](src/__tests__/evals-not-in-ci.test.ts)
fails if that ever stops being true.

To run this app as a container instead of natively — deployment parity, not the
dev loop — build `Dockerfile` through the `app` compose service from the repo
root: `docker compose build app && docker compose up -d app`. Details and the
env-var rewrites: [`docs/DOCKER_COMPOSE.md`](../docs/DOCKER_COMPOSE.md#app-the-solidstart-app-197).

## Adding a New Agent

1. Create `packages/agents/agents/<name>.server.ts` exporting an
   `AgentDefinition` ([`packages/agents/types.ts`](../packages/agents/types.ts)) —
   `id`, `name`, `description`, `welcome`, `servers`, and a
   `createPatterns(sessionId, deps)` that composes the patterns.
2. Add one `registerAgent(overlay(<name>Agent, icon, accent))` line, beside its
   import, in [`src/lib/harness-client/registry.server.ts`](src/lib/harness-client/registry.server.ts).
   The overlay is where this app supplies the presentation the definition
   deliberately does not carry, and closes over the one `agentDeps()` bag.
3. Record its guard coverage in
   [`src/__tests__/lib/harness-client/agents/injection-guard-coverage-inventory.test.ts`](src/__tests__/lib/harness-client/agents/injection-guard-coverage-inventory.test.ts).
   That inventory pins every agent in the repo, guarded or not, so a new one
   fails it until the decision is written down.

If the agent needs something the host does not already supply, extend `AgentDeps`
and the `agentDeps()` bag in
[`src/lib/harness-client/session.server.ts`](src/lib/harness-client/session.server.ts).

The full walkthrough — the definition surface, what is injected vs imported vs
overlaid, and five compile-checked composition examples — is
[`packages/agents/README.md`](../packages/agents/README.md).

---

## Documentation Index

| File                                                                           | Contents                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [GitHub Project](https://github.com/users/mknw/projects/5)                     | Planning board — status, priority, MSCW per item                               |
| [src/lib/harness-client/README.md](src/lib/harness-client/README.md)           | Session lifecycle, the server-action API, graph extraction, the Neo4j enricher |
| [../packages/harness-patterns/SPEC.md](../packages/harness-patterns/SPEC.md)   | hames API reference and design spec                                            |
| [../packages/harness-patterns/GUIDE.md](../packages/harness-patterns/GUIDE.md) | Developer guide — composition model, writing a pattern, the tool seam          |
| [../packages/agents/README.md](../packages/agents/README.md)                   | The nine agent definitions, `AgentDeps`, and the host overlay                  |
| [../packages/harness-baml/README.md](../packages/harness-baml/README.md)       | The LLM seam — BAML corpus, adapters, role→client routing                      |
| [../docs/tutorials/README.md](../docs/tutorials/README.md)                     | Task-shaped tutorials for building on the `@hames` packages                    |
| [../docs/testing/pyramid.md](../docs/testing/pyramid.md)                       | The four test layers and the one command that runs three of them               |
| [../docs/UI_ARCHITECTURE.md](../docs/UI_ARCHITECTURE.md)                       | Component structure, data flow, Chat–Graph linking                             |
| [../docs/DATA_STASH.md](../docs/DATA_STASH.md)                                 | Data Stash upload → chunk → embed → search pipeline (#6/#9/#8)                 |
| [../docs/INDEX.md](../docs/INDEX.md)                                           | Full project documentation index                                               |
