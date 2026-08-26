# Documentation Index

> **kg-agent**: Knowledge Graph Agent System — Neo4j, BAML, harness-patterns, SolidStart UI

## Quick Links

| Document                                                                                | Description                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)                                                               | Project overview and quick start                                                                                                                                                                                                                                                               |
| [GLOSSARY.md](../GLOSSARY.md)                                                           | **The house vocabulary** — _pattern_, _controller_, _actor_, _critic_, _harness_, _EventView_, _ContextEvent_, _tool namespace_, _Data Stash_, _stash session_, _sandbox flavour_, _action_, _routine_. Terms only, never implementation; each entry points at the doc that owns the mechanism |
| [GitHub Project — "Harness Playground tasks"](https://github.com/users/mknw/projects/5) | Live planning board (Status / Priority / MSCW per issue)                                                                                                                                                                                                                                       |
| [plan/ROADMAP.md](plan/ROADMAP.md)                                                      | The roadmap _shape_: target multi-user architecture, phases 0–4 with MoSCoW ratings + dependency spine (Entra SSO #119 as the gate)                                                                                                                                                            |
| [reviewing.md](reviewing.md)                                                            | **Review map** for the global `/reviewing-changes` skill: pointers to where conventions, spec resolution, gates and the review protocol live — facts stated here directly only when stated nowhere else                                                                                        |

---

## Planning (`docs/plan/`)

Forward-looking design docs. Live item-tracking stays on the GitHub project board; these hold the converged shapes.

| Document                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [plan/ROADMAP.md](plan/ROADMAP.md)                                   | Multi-user target architecture + phased MoSCoW roadmap (#107 identity patterns, #119–#122)                                                                                                                                                                                                                                                                                                                                                                                                     |
| [plan/sandbox.md](plan/sandbox.md)                                   | Sandbox compute design — core shipped (#79/#89/#97/#78 flavours); still plan-only: Swarm, Firecracker, ephemeral one-shot, #82                                                                                                                                                                                                                                                                                                                                                                 |
| [plan/skills-adoption.md](plan/skills-adoption.md)                   | Adopting a curated set of Claude Code **agent skills** as our own bundle: one directory with two namespaces (bare = OSS-portable, `kg-` = project-only), the per-skill adaptation sheet for 19 vendored files, ADR-mechanism and `grilling`/`council` overlap reconciliation, pinned-commit upstream sync, MIT attribution, and the `.gitignore` fix that makes `.claude/skills/` reach Orca workers at all                                                                                    |
| [plan/graph-pseudonymisation.md](plan/graph-pseudonymisation.md)     | Stripping people out of Graph tool results **without NER** — Graph's own labelled identity fields are the roster (data-privacy plan item 3). The pure core in `lib/privacy/` is built and tested but wired to nothing; where to hook, what `conversations.context` stores and where the (personal-data) table lives are open questions                                                                                                                                                         |
| [plan/pseudonym-fidelity-bench.md](plan/pseudonym-fidelity-bench.md) | Measured answer to open question 4 of the above: **do `PERSON_1` placeholders survive an LLM paraphrase?** Live Synthesize run over NL/FR/EN × prompt-guidance off/on, with per-language survival/mangle/hallucination rates and a recommendation on wiring the guidance and on widening `reverse`                                                                                                                                                                                             |
| [plan/offline-agent-auth.md](plan/offline-agent-auth.md)             | Credential model for `POST /api/agents/:id` acting for an **offline** user (#106/#107/#110/#119/#129): why the shipped encrypted per-user MSAL cache + `acquireTokenSilent` is already the right offline mechanism and the OBO grant is not, why `configs/action-tokens.yaml` — not the refresh token — is the dangerous secret, the `action_tokens` table that replaces it (hashed, scoped, revocable, audited), a risk-ordered 7-step migration, and a 9-row threat table                    |
| [plan/harness-npm-lib.md](plan/harness-npm-lib.md)                   | Extracting harness-patterns into an npm package — working name **`hames`** (#225/#226 owner decisions, 2026-08-23): one core package first, companions (`harness-baml`, `sandbox-docker`, `stash`, `retriever`, ready-made harnesses) later; `stash` is a dependency of sandbox+retriever, not a standalone companion; `workspace:*` dev loading and a **workspace-built** production docker image (publishing serves external devs only); a Changesets publish flow; a risk-ordered migration |
| [plan/hames-guide.md](plan/hames-guide.md)                           | **Draft skeleton** for the developer guide that ships as a skill alongside `hames`: composition model, writing a pattern, the LLM seam, tool transports, the typed error surface, and what kg-agent does that the library does not ship                                                                                                                                                                                                                                                        |

---

## Agent Working Docs (`docs/agents/`)

How agents are briefed and what they are held to. Procedures themselves live in `.claude/skills/` (see [plan/skills-adoption.md](plan/skills-adoption.md)).

| Document                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [agents/sensitive-domain-brief.md](agents/sensitive-domain-brief.md) | **Read by sub-agents, not by coordinators.** A pointer-based brief: a dispatch carries only the path plus a neutral scope phrase, and the lane self-selects against the brief's own map. Exists so a coordinator can hand off work in areas whose context is expensive to restate in its own visible text. Also carries the handling rules and deliverable contract for work in those areas. Companion to the `kg-lane-dispatch` skill, which owns the hand-off line itself          |
| [agents/AGENT-BRIEF.md](agents/AGENT-BRIEF.md)                       | **The dispatch spec template** — the body of an Orca worker dispatch or of an agent-ready GitHub issue. Behavioural contracts and complete acceptance criteria, never file paths or line numbers (a brief outlives the tree it was written against), plus explicit out-of-scope. Carries this repo's **standing acceptance criteria**: CI gate, coverage floors (once #165 lands), prettier on changed files, conventional commits, no attribution trailers, `pnpm`-only from `app/` |

## Decision Records (`docs/adr/`)

Irreversible one-liners with a why — too small for a `docs/plan/` doc, too durable for a PR body. The `docs/plan/` ⇄ PR-body ⇄ `CLAUDE.md` ⇄ `docs/adr/` division of labour is stated in the README below.

| Document                       | Description                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [adr/README.md](adr/README.md) | **The ADR mechanism + the index table.** Format (1–3 sentences), numbering, the three-condition write gate (hard to reverse · surprising without context · a real trade-off), confirm-before-write, the `proposed → accepted → [deprecated \| superseded]` lifecycle, and the two non-negotiables: _"we just picked it" is not a valid rationale_, and _never back-fill silently_ |

Records: [0001](adr/0001-anthropic-only-default-chains.md) Anthropic-only default chains · [0002](adr/0002-controller-nothink-clients.md) controller on `*NoThink` · [0003](adr/0003-redis-stack-amd64.md) redis-stack + `linux/amd64` · [0004](adr/0004-server-only-suffix-boundary.md) `.server.ts` boundary · [0005](adr/0005-harness-patterns-replaces-baml-agent.md) harness-patterns replaces `baml-agent`. All five are back-filled and carry their original decision date plus the sources the rationale was mined from.

---

## Architecture Documentation

### Harness Patterns Framework

| Document                                                                                   | Description                                                                             |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [harness-patterns/README.md](harness-patterns/README.md)                                   | Overview, core concepts, quick start                                                    |
| [harness-patterns/api.md](harness-patterns/api.md)                                         | Complete API reference                                                                  |
| [harness-patterns/frontend.md](harness-patterns/frontend.md)                               | SolidStart integration, server actions, sessions                                        |
| [harness-patterns/examples.md](harness-patterns/examples.md)                               | Example agent catalog (6 agents)                                                        |
| [harness-patterns/parallel.md](harness-patterns/parallel.md)                               | Parallel pattern design notes                                                           |
| [harness-patterns/with-references.md](harness-patterns/with-references.md)                 | `withReferences` meta-pattern + `expandPreviousResult` synthetic tool design (#30, #19) |
| [harness-patterns/withReferences-tutorial.md](harness-patterns/withReferences-tutorial.md) | Hands-on walkthrough — search the web, attach refs at ingress, write to Neo4j           |

Authoritative source-level docs (closer to the code):

- [`app/evals/README.md`](../app/evals/README.md) — **harness/client compatibility evals** (`pnpm eval:harness`): the scenario set, the `EVAL_CLIENT` seam and why it is not a new routing switch, the roles that are never re-pointed, and how the suite is kept structurally out of CI. Run it whenever a BAML client changes
- [`app/src/lib/harness-patterns/SPEC.md`](../app/src/lib/harness-patterns/SPEC.md) — full framework API and design spec
- [`app/src/lib/harness-patterns/README.md`](../app/src/lib/harness-patterns/README.md) — the `hames` library front page
- [`app/src/lib/harness-client/agents/README.md`](../app/src/lib/harness-client/agents/README.md) — example implementations

### UI Frontend

| Document                                 | Description                                               |
| ---------------------------------------- | --------------------------------------------------------- |
| [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) | Component structure, data flow, Chat-Graph linking, theme |

Source-level index: see [app/README.md](../app/README.md#documentation-index).

### Data Stash

| Document                       | Description                                                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DATA_STASH.md](DATA_STASH.md) | Document upload → chunk → embed → search pipeline (#6/#9/#8): modules, API routes, Redis storage model (incl. base64 binary, #89), embedding-space rule, redis-stack + local-embedder requirements               |
| [data-flow.md](data-flow.md)   | **Visual data-flow diagrams** (Mermaid) — Data Stash pipeline, sandbox attachment lifecycle (#79/#97), `/work` ⇄ Data Stash sync (#89), and sandbox tool dispatch / runtime topology. Spans Data Stash + sandbox |

### Agent Workflow (`docs/agents/`)

| Document                                           | Description                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [agents/issue-tracker.md](agents/issue-tracker.md) | **How a skill fetches a spec**: the `gh` commands for issues/PRs, resolving a bare `#42`, the label set, and the spec/scheduling split — the issue body is the spec, the [project board](https://github.com/users/mknw/projects/5) (Status/Priority/MSCW) is read-only context. Named by `/reviewing-changes`' Spec axis |

### Agent Trigger Endpoint

| Document                             | Description                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AGENT_TRIGGER.md](AGENT_TRIGGER.md) | `POST /api/agents/:id` async agent trigger → **action** rows: endpoint contract, in-process fire-and-forget model, `kind`/`source`/`status` data model, per-user token auth (`configs/action-tokens.yaml`), recording storage + playback via the Data Stash, sidebar filter + promotion gate, status-lifecycle quirk |

### Auth & Deployment

| Document                                                         | Description                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [deployment/entra-setup.md](deployment/entra-setup.md)           | **Entra tenant setup** (#119): provisioning checklist (app registration, redirect URIs, client secret), the delegated Graph scope set + consent ordering trap, app env vars and key rotation, the `oid`-based identity model. Operator-facing — in-app architecture is below and in [UI_ARCHITECTURE.md §3](UI_ARCHITECTURE.md)        |
| [PREVIEW.md](PREVIEW.md)                                         | **Preview deployment runbook**: the executable sequence for putting the app in front of the preview circle on one Azure VM — sizing, NSG ports, DNS, the exact Entra redirect URI, the one-command container bring-up, a smoke checklist, backups + a verified restore drill, rollback, and an explicit list of what is _not_ true yet |
| [PREVIEW-WELCOME.md](PREVIEW-WELCOME.md)                         | **Onboarding note for the preview circle**: how to sign in, what the assistant can do, what is stored and what is sent to Anthropic (written to be accurate rather than reassuring), what not to type into it, and how to report problems (`preview`-labelled issue)                                                                   |
| [MICROSOFT_GRAPH.md](MICROSOFT_GRAPH.md)                         | **Per-user Graph access** (Pattern C, #110): what the Microsoft 365 agent can do, the app-side tool transport + dispatch order, cross-user isolation guarantees, the encrypted per-user token lifecycle, and how to add a connector                                                                                                    |
| [graph-api-notes.md](graph-api-notes.md)                         | **Microsoft Graph API field notes**: what Graph actually returns — the endpoint map incl. deprecations, identifier formats, response envelopes, field-reliability table, query-language traps, what each error really means, and an explicit "not verified" list. Open this when a Graph response surprises you                        |
| [user-guides/microsoft-graph.md](user-guides/microsoft-graph.md) | **User guide — Microsoft 365 agent**: example questions that work, the ones that don't (and why), reading its answers. The living record of user-askable expressions; update it when a connector lands                                                                                                                                 |
| [data-privacy/plan.md](data-privacy/plan.md)                     | **Data protection findings + plan**: what personal data the app holds and where, retention (and its absence), third-country transfers to the LLM providers, erasure gaps, Belgium-specific obligations (CAO 81, works council, GBA/APD), and the ordered action list. Read before production rollout                                   |

---

## Infrastructure Documentation

| Document                                         | Description                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DOCKER_COMPOSE.md](DOCKER_COMPOSE.md)           | Neo4j, MCP Gateway, Redis service configuration                                                                                                                                       |
| [MCP_GATEWAY.md](MCP_GATEWAY.md)                 | MCP Gateway reference, CLI, troubleshooting                                                                                                                                           |
| [sandbox-flavours.md](sandbox-flavours.md)       | Sandbox rootfs flavours (#78) — the `image-processing` + `data` + `office` images, the router-over-flavoured-sandboxes recipe, ephemeral vs persistent, and deferred hardening (#116) |
| [sandbox/README.md](sandbox/README.md)           | Sandbox debugging — identify/inspect/reap containers, `/work` durable-workspace layout, `.harness-logs` jq recipes                                                                    |
| [deployment/azure-vm.md](deployment/azure-vm.md) | Single-VM deployment runbook (Azure VM or any VPS): compose hardening (loopback binds), UI as systemd host service, Caddy TLS, env reference, ops                                     |
| [PREVIEW.md](PREVIEW.md)                         | The container run shape of the same box, wired end to end for the preview: `docker-compose.prod.yaml`, `.env.production.example`, Caddy, `scripts/backup-preview.sh`                  |

**Key config files:**

- `docker-compose.yaml` — service orchestration
- `docker-compose.prod.yaml` — production overlay for the preview VM (loopback binds, `${VAR:?}` credentials, Caddy); selected via `COMPOSE_FILE` in the repo-root `.env` — see [PREVIEW.md](PREVIEW.md)
- `.env.production.example` — every production environment variable, one line of why each; copy to the repo-root `.env`
- `configs/Caddyfile` — TLS termination + reverse proxy for the preview (hostname arrives as `$APP_DOMAIN`)
- `configs/mcp-config.yaml` — MCP server connection params
- `configs/custom-catalog.yaml` — custom MCP server definitions (Docker image-based)
- `configs/action-tokens.yaml` — Bearer secret → userId map for `POST /api/agents/:id` (git-ignored; see `template.action-tokens.yaml` and [AGENT_TRIGGER.md](AGENT_TRIGGER.md))
- `.mcp.json` — Claude Code MCP integration (gateway URL port 8811)

---

## Data Management

| Document                                             | Description                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [org-graph.md](org-graph.md)                         | **The organizational graph**: the ontology (4 labels, 6 relations, no reports-to and why), which rules Neo4j Community can enforce and which the app has to, the one authorised wipe vs the idempotent setup path, the app-only Graph roster ingest and its exclusions, why Teams are blocked on a tenant permission, and the roster as a pseudonymisation mapping source |
| [../neo4j_dumps/README.md](../neo4j_dumps/README.md) | Database versioning: export, import, reset                                                                                                                                                                                                                                                                                                                                |
| [../models/README.md](../models/README.md)           | **The local GGUF weights** — which file each `make` target (`embed` :8090, `llm-small` :8095) expects under `models/`, why the directory is gitignored, the `MODELS_DIR` override a git worktree needs, and how to point either model at a remote endpoint instead                                                                                                        |

Scripts: `scripts/export-neo4j.sh` · `scripts/import-neo4j.sh` · `scripts/reset-neo4j.sh` · `app/src/lib/org-graph/scripts/` ([README](../app/src/lib/org-graph/scripts/README.md))

---

## Environment Variables

| Variable                                              | Purpose                                                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                                  | The `openrouter` Data Stash embedding provider only — no BAML chain uses it                                                                                                                   |
| `EMBEDDINGS_PROVIDER`                                 | Data Stash embedding provider: `local` (default) or `openrouter` (see [DATA_STASH.md](DATA_STASH.md))                                                                                         |
| `EMBEDDINGS_LOCAL_URL` / `EMBEDDINGS_LOCAL_MODEL`     | Override the local embedder URL (`http://localhost:8090/v1`) / model (`Qwen3-Embedding-0.6B`). The URL includes `/v1`; changing the MODEL invalidates the vector index                        |
| `EMBEDDINGS_LOCAL_API_KEY`                            | Optional bearer token for the embedder — unset for a local llama-server, set to reach a remote OpenAI-compatible endpoint                                                                     |
| `SMALL_LLM_BASE_URL` / `SMALL_LLM_API_KEY`            | `LocalQwenSmall`'s endpoint (`http://localhost:8095/v1`, `make llm-small`) and its optional bearer token. BAML reads these directly, so they have no in-code default — see `app/.env.example` |
| `ANTHROPIC_API_KEY`                                   | Anthropic models (Sonnet 5, Sonnet 4.6, Haiku 4.5) — every BAML chain; **required**, and the only LLM provider key                                                                            |
| `AZURE_TENANT_ID`                                     | Entra tenant (directory) GUID — the OIDC authority (#119)                                                                                                                                     |
| `AZURE_CLIENT_ID`                                     | Entra app registration (client) id                                                                                                                                                            |
| `AZURE_CLIENT_SECRET`                                 | Entra client secret (server-side; resolves sign-in server-side, see `lib/auth/entra.server.ts`)                                                                                               |
| `AUTH_SESSION_SECRET`                                 | HMAC key signing the auth cookies (`openssl rand -base64 32`)                                                                                                                                 |
| `TOKEN_ENCRYPTION_KEY`                                | Encrypts the per-user MSAL token cache at rest; HKDF-derived from `AUTH_SESSION_SECRET` when unset                                                                                            |
| `DATA_ENCRYPTION_KEY`                                 | **Required.** Encrypts stored conversations and personal data at rest. No fallback — see `app/src/lib/db/crypto.server.ts`                                                                    |
| `AUTH_REDIRECT_URI` / `AUTH_POST_LOGOUT_REDIRECT_URI` | Optional OIDC redirect / post-logout overrides (default dev port 3444)                                                                                                                        |
| `VITE_ALLOWED_EMAILS`                                 | Comma-separated allow-list; supports `*@domain.com` wildcards                                                                                                                                 |
| `VITE_DEV_BYPASS_AUTH`                                | `'true'` to skip auth in dev (gated on `import.meta.env.DEV`; ignored in prod builds). See `app/.env.example` and `lib/auth/dev-bypass.ts`                                                    |

---

## File Structure

```
kg-agent/
├── GLOSSARY.md                  # House vocabulary (terms only, no implementation)
├── docs/
│   ├── INDEX.md                 # You are here
│   ├── UI_ARCHITECTURE.md       # Frontend architecture
│   ├── DATA_STASH.md            # Document ingestion pipeline
│   ├── data-flow.md             # Mermaid data-flow diagrams (Data Stash + sandbox)
│   ├── AGENT_TRIGGER.md         # POST /api/agents/:id async trigger → actions
│   ├── DOCKER_COMPOSE.md        # Docker setup
│   ├── MCP_GATEWAY.md           # MCP Gateway reference
│   ├── MICROSOFT_GRAPH.md       # Per-user Graph access (Pattern C, #110)
│   ├── graph-api-notes.md       # What Graph actually returns: ids, quirks, deprecations
│   ├── sandbox-flavours.md      # Rootfs flavours (#78): image-processing/data/office
│   ├── agents/
│   │   ├── AGENT-BRIEF.md       # Dispatch spec template + standing acceptance criteria
│   │   └── sensitive-domain-brief.md  # Sub-agent-only brief; coordinators hand over the path
│   ├── adr/                     # Architecture decision records
│   │   ├── README.md            # The mechanism + the index table (statuses live here)
│   │   └── NNNN-<slug>.md       # One decision each, 1–3 sentences + optional sections
│   ├── plan/                    # Forward-looking design docs
│   │   ├── ROADMAP.md           # Multi-user architecture + phased MoSCoW roadmap
│   │   ├── sandbox.md           # Sandbox design (core shipped; Swarm/Firecracker = plan)
│   │   ├── graph-pseudonymisation.md      # No-NER identity stripping over Graph's own labels
│   │   ├── pseudonym-fidelity-bench.md    # Do PERSON_1 placeholders survive an LLM paraphrase?
│   │   ├── harness-npm-lib.md             # Extracting harness-patterns to npm as `hames`
│   │   └── hames-guide.md                 # Draft skeleton: hames developer guide
│   ├── agents/
│   │   └── issue-tracker.md     # gh commands + the issue-body-is-the-spec rule
│   ├── deployment/
│   │   ├── azure-vm.md          # Single-VM deployment runbook
│   │   └── entra-setup.md       # Entra tenant provisioning + consent (#119)
│   ├── PREVIEW.md               # Preview deployment runbook (container shape, one VM)
│   ├── PREVIEW-WELCOME.md       # Onboarding note handed to the preview circle
│   ├── sandbox/
│   │   └── README.md            # Sandbox operational debugging
│   ├── user-guides/
│   │   └── microsoft-graph.md   # Microsoft 365 agent: what you can ask
│   └── harness-patterns/        # Harness patterns documentation
│       ├── README.md            # Overview
│       ├── api.md               # API reference
│       ├── examples.md          # Example agents (6)
│       ├── frontend.md          # Frontend integration
│       ├── parallel.md          # Parallel pattern design
│       ├── prompt-caching.md    # Cache-breakpoint budget and placement (#122)
│       ├── with-references.md   # withReferences meta-pattern design (#30)
│       └── withReferences-tutorial.md  # withReferences walkthrough
├── app/
│   ├── README.md                # UI quick start + index
│   └── src/lib/
│       ├── harness-patterns/    # Pattern framework (source + README.md)
│       └── harness-client/      # Frontend integration layer (agents/README.md)
├── configs/                     # MCP and catalog configurations
├── scripts/                     # Utility scripts
├── neo4j_dumps/                 # Graph data exports
├── models/                      # Local GGUF weights (gitignored except README.md)
├── Makefile                     # `make embed` :8090 · `make llm-small` :8095
└── docker-compose.yaml
```
