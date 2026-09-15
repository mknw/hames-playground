<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/harness-patterns/hames_light-text-on-transparent-bg.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/harness-patterns/hames_dark-text-on-transparent-bg.png">
  <img src="docs/harness-patterns/hames_dark-text-on-transparent-bg.png" alt="hames" width="380">
</picture>

### The hames app

A self-hosted agent workspace: chat with agents that search the web, query a
knowledge graph, run code in isolated containers, and answer from your own
documents and Microsoft 365 — with every step of every run visible in the UI.

The agents are compositions of **hames**, a small library of typed agent
primitives — loops, planners, routers, guards — where the run's history is the
primary object and each LLM call sees only a slice chosen on purpose.

[![CI](https://img.shields.io/github/actions/workflow/status/mknw/hames-playground/ci.yml?branch=main&style=flat&label=CI)](https://github.com/mknw/hames-playground/actions/workflows/ci.yml)
[![last commit](https://img.shields.io/github/last-commit/mknw/hames-playground/main?style=flat&label=last%20commit)](https://github.com/mknw/hames-playground/commits/main)
[![stage](https://img.shields.io/badge/stage-MVP-orange?style=flat)](#the-idea)
[![app licence: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/app-PolyForm%20NC%201.0.0-blue?style=flat)](LICENSE)
[![hames licence: MIT](https://img.shields.io/badge/hames-MIT-blue?style=flat)](app/src/lib/harness-patterns/LICENSE)

[![SolidStart](https://img.shields.io/badge/SolidStart-1.x-2c4f7c?style=flat&logo=solid&logoColor=white)](https://start.solidjs.com)
[![BAML](https://img.shields.io/badge/BAML-typed%20LLM%20calls-8b5cf6?style=flat)](https://docs.boundaryml.com)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io)

[Features](#what-you-can-do-with-it) · [Architecture](#architecture) · [Primitives](#hames--the-primitives) · [Agents](#agents) · [Quickstart](#quickstart) · [Docs](#documentation) · [Contributing](#contributing) · [License](#license)

<!-- TODO: a screenshot of the running app belongs here (issue #315, G1) — do not ship a placeholder image. -->

</div>

> **⚠️ MVP stage — use at your own discretion.** These agents hold real tool
> access, and nothing here has been hardened for a deployment you do not control.
> Run it on localhost, against data you can afford to lose, with keys you can
> rotate — and read the [License](#license) before you do anything else with it.

---

## What you can do with it

- **Agents that act** — web search, Neo4j knowledge-graph queries and code
  execution in disposable Docker containers, composed per agent
- **Your documents** — upload files into a local Data Stash (chunked, embedded,
  7-day retention); semantic retrieval is a first-class route beside web and graph
- **Your Microsoft 365 identity** — per-user delegated access; the M365 agent
  answers from the signed-in user's own mailbox, calendar and files
- **Composable primitives** — loops, actor-critic, planning, routing, context
  compaction and an injection guard for untrusted content; a new agent is two steps
- **Typed LLM calls** — prompts live in version-controlled BAML files with
  declared input and output types; a parse failure is a typed error event, not a
  string you hope parses
- **Full observability** — every run streams its event log to the UI: prompts,
  tool results, cost per step, and a live graph of what the agent touched

## The idea

Every agent framework eventually collides with the same wall: the transcript.
It grows every turn, everything gets pasted into everything, and by turn five the
model is reasoning over a pile of text nobody deliberately chose for it. `hames`
starts from the other end. The run's history is the primary object, and what any
one LLM call sees is a slice of it that somebody picked on purpose.

That object is the **`UnifiedContext`** — one append-only event log per session,
where every pattern (a loop, a router, a planner, a guard) reads and appends, and
where nothing else counts as state. Patterns write into an isolated scope first
and commit only on completion, so a step that fails leaves no trace behind. A
session _is_ its serialized log, which is why continuing a conversation and
resuming after an approval gate are the same mechanism rather than two features.

**Views and scopes** are how the slice gets picked. `EventView` is a small query
API over the log — by pattern, by event type, by the last N user turns — so a
synthesizer can be handed exactly the tool results of the route that just ran,
and a router just the message history it needs to classify. `ViewConfig` declares
that per pattern instead of at every call site, so detail from three turns ago
expires by construction instead of by someone remembering to prune it.

The LLM leaf of every primitive is a **BAML** function, and that was the point of
choosing BAML: prompts live in version-controlled `.baml` files with declared
input and output types, so a controller returns a validated `ControllerAction`
instead of a string you hope parses, model fallback chains sit next to the prompt
they serve, and a parse failure arrives as a typed `error` event in the same log
as everything else. Prompts as code — not string soup.

## Architecture

```mermaid
flowchart TB
    subgraph APP["app/ — SolidStart app, port 3444"]
        UI["Chat · Graph · Observability timeline"]
        REG["Agent registry<br/>search · general · sandbox · retriever · M365"]
        UI --> REG
    end

    subgraph HAMES["app/src/lib/harness-patterns/ — hames"]
        PAT["Patterns<br/>simpleLoop · actorCritic · planner<br/>router · parallel · withReferences<br/>withInjectionGuard · retriever"]
        CTX["UnifiedContext<br/>event log + EventView"]
        PAT <--> CTX
    end

    BAML["BAML functions<br/>typed LLM reasoning at each leaf"]
    GW["MCP Gateway<br/>port 8811"]

    subgraph SVC["Companion services"]
        NEO["Neo4j<br/>7474 · 7687"]
        RDS["redis-stack<br/>6379 — Data Stash"]
        SBX["Sandbox containers<br/>docker run"]
    end

    PG["Postgres 5432<br/>conversations"]

    REG -- composes --> PAT
    PAT -- LLM leaf --> BAML
    PAT -- tool calls --> GW
    PAT -- compute --> SBX
    GW --> NEO
    GW --> RDS
    APP --> PG
```

Events flow one way: every pattern appends to the `UnifiedContext` log, the UI
streams that log over SSE, and `compactExecution` turns the accumulated events
into the final answer.

## hames — the primitives

A pattern is a function of `(scope, view, tools)` over that one event log.
Patterns stay independent in semantics, so one can be swapped without disturbing
the others — which is the whole reason the app can hold several agents that
differ only in how they compose these:

|                        |                                                                       |
| ---------------------- | --------------------------------------------------------------------- |
| **Loops**              | `simpleLoop` · `actorCritic`                                          |
| **Planning & routing** | `planner` · `router` · `routes` · `parallel`                          |
| **Context**            | `withReferences` · `retriever` · `compactExecution` · `compactIntent` |
| **Guards**             | `withInjectionGuard`                                                  |
| **Composition**        | `chain` · `harness` · `continueSession` · `resumeHarness`             |

BAML supplies the typed reasoning at each leaf; an MCP gateway supplies the
tools. Neither is baked in — the library is being pulled towards a BAML-free core
behind injected call interfaces
([`docs/plan/harness-npm-lib.md`](docs/plan/harness-npm-lib.md)).

📖 **[Read the hames front page →](app/src/lib/harness-patterns/README.md)** —
what the primitives are and why they are shaped that way. The
[spec](app/src/lib/harness-patterns/SPEC.md) beside it carries the full API,
the `UnifiedContext` architecture, the `EventView` query API and the event→BAML
type mapping.

One primitive worth a closer look: **`withReferences`** carries data across turns
without re-fetching. The agent searches the web on one turn and writes the
findings into Neo4j on the next — an LLM-driven selector attaches the relevant
prior `tool_result` events at the new pattern's ingress, and the controller pulls
the full payload through the synthetic `expandPreviousResult` tool. No
re-fetching, no hallucinated content.
→ [Walkthrough](docs/harness-patterns/withReferences-tutorial.md) ·
[Design](docs/harness-patterns/with-references.md)

## Agents

Each agent is a different composition of the same primitives — that is what they
are for. Registered in
[`app/src/lib/harness-client/registry.server.ts`](app/src/lib/harness-client/registry.server.ts).

| Agent                   | Composition                                                                                           | What it shows                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search**              | `router` → `routes(withReferences(simpleLoop))` → `compactExecution`                                  | Classify into one namespace and dispatch — Neo4j or web search. The `web` route is injection-guarded, `neo4j` is not                                                                                                                |
| **General**             | `planner` → `simpleLoop` → `compactExecution`                                                         | Pay for strategy once, up front, then hand the whole tool surface to one executor. The A/B counterpart to Search on cross-domain questions                                                                                          |
| **Sandbox · Session**   | `compactIntent` → `withSandbox(actorCritic)` → `compactExecution`                                     | A container keyed to the session, persistent across turns and shared with the interactive Shell — build incrementally, inspect files live                                                                                           |
| **Sandbox · Flavoured** | `router` → `routes(withSandbox(actorCritic))` → `compactExecution`                                    | One route per purpose-built flavour: base, image-processing, data, office                                                                                                                                                           |
| **Retriever**           | `router` → `withInjectionGuard(routes(retriever \| withReferences(simpleLoop)))` → `compactExecution` | Semantic retrieval over uploaded documents (Data Stash) as a peer route beside Neo4j and web. The guard covers both untrusted routes — `web` and `retriever`, whose chunks come from ingested files — while `neo4j` stays unguarded |
| **Microsoft 365**       | `withInjectionGuard(simpleLoop)` → `compactExecution`                                                 | Per-user identity end to end — answers from the signed-in user's own mailbox, calendar and files via delegated Graph scopes                                                                                                         |

## Quickstart

**Requirements:** Docker Desktop (or an equivalent Docker engine) · Node.js >= 22 · pnpm
· on Apple Silicon, redis runs under `platform: linux/amd64` (pinned in
`docker-compose.yaml` — the arm64 RediSearch build crashes).

```bash
git clone https://github.com/mknw/hames-playground.git
cd hames-playground

# 1. Backing services — Postgres, Neo4j, redis-stack, the MCP gateway and
#    doc-convert. The app itself runs on the host (step 4).
docker compose up -d
docker compose ps                 # all five services should be Up

# 2. Seed the graph — imports a small demo knowledge graph so the graph tools
#    and the UI's graph views have data to query on a first run. Optional,
#    but recommended. The script refuses to clear a Neo4j container that
#    already holds data unless you pass --wipe, and honours NEO4J_CONTAINER
#    if your container is named differently.
./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher

# 3. Configure — two keys are required
cd app
cp .env.example .env
openssl rand -base64 32           # this becomes DATA_ENCRYPTION_KEY
```

In `app/.env`, set **`ANTHROPIC_API_KEY`** (the only AI-provider key the app
needs) and **`DATA_ENCRYPTION_KEY`** (generated above) — conversations are
encrypted at rest, and with the key left empty the app boots but cannot save a
single conversation. Back the encryption key up separately from the database: a
dump without it is unreadable.

> **Already running another copy of this app on this machine?** The compose file
> pins a project name and fixed container names, and the app's defaults point at
> `localhost:5432/6379/7687` — a second `docker compose up -d` will adopt and
> recreate the existing stack's containers. Stop the other stack first.

```bash
# 4. Run (from app/)
pnpm install
pnpm dev                          # http://localhost:3444
```

Open <http://localhost:3444> — you should see the chat interface with the agent
list in the sidebar. Sign-in is bypassed in development
(`VITE_DEV_BYPASS_AUTH='true'`), so you land straight in the app. Type a message
and pick an agent to watch a first run stream in.

By default every agent call runs on Anthropic. A self-hosted inference tier
exists as an opt-in for deployments that must keep prompts on their own
infrastructure — see `USE_VERDA_INFERENCE` in `app/.env.example`.

**Every `pnpm` command runs from `app/`** — never npm/npx, never from the repo
root. Re-run `pnpm baml-generate` after editing anything under `app/baml_src/`.

|               |                                                          |
| ------------- | -------------------------------------------------------- |
| App           | <http://localhost:3444>                                  |
| Neo4j Browser | <http://localhost:7474> — `neo4j` / `password`           |
| MCP Gateway   | <http://localhost:8811/mcp>                              |
| Postgres      | `localhost:5432` — `postgres` / `password`, db `kgagent` |

Auth is bypassed for development (`VITE_DEV_BYPASS_AUTH='true'` in
`app/.env.example`), the compose stack publishes its databases on `0.0.0.0` with
laptop-default passwords, and both need attention before this runs anywhere but
your own machine — [`docs/deployment/azure-vm.md`](docs/deployment/azure-vm.md)
and [`docs/deployment/entra-setup.md`](docs/deployment/entra-setup.md) cover the
hardening, and [`docs/PREVIEW.md`](docs/PREVIEW.md) is the step-by-step runbook
for a single-VM deployment.

## Documentation

📚 **[`docs/INDEX.md`](docs/INDEX.md) is the index** — every doc, with a sentence
on what each one holds.

The ones reached most often:

|                                                                                                   |                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`app/src/lib/harness-patterns/SPEC.md`](app/src/lib/harness-patterns/SPEC.md)                    | The hames API reference and design spec                                        |
| [`GLOSSARY.md`](GLOSSARY.md)                                                                      | House vocabulary — pattern, controller, critic, harness, EventView, Data Stash |
| [`docs/plan/ROADMAP.md`](docs/plan/ROADMAP.md)                                                    | Roadmap shape: multi-user target architecture, phased MoSCoW plan              |
| [`docs/plan/harness-npm-lib.md`](docs/plan/harness-npm-lib.md)                                    | Extracting `hames` to npm — package layout, dev vs. production loading         |
| [`docs/DOCKER_COMPOSE.md`](docs/DOCKER_COMPOSE.md) · [`docs/MCP_GATEWAY.md`](docs/MCP_GATEWAY.md) | Services, adding an MCP server, gateway troubleshooting                        |
| [`docs/DATA_STASH.md`](docs/DATA_STASH.md)                                                        | Upload → chunk → embed → search pipeline                                       |
| [`docs/adr/`](docs/adr/README.md)                                                                 | Decision records — and when one gets written                                   |
| [GitHub Project](https://github.com/users/mknw/projects/5)                                        | The live planning board                                                        |

## Help

Something not working? Start with
[`docs/DOCKER_COMPOSE.md`](docs/DOCKER_COMPOSE.md) (backing services) and
[`docs/MCP_GATEWAY.md`](docs/MCP_GATEWAY.md) (gateway troubleshooting); if that
does not cover it, open a [GitHub issue](https://github.com/mknw/hames-playground/issues).

## Contributing

Issues and pull requests are welcome. For larger changes, open an issue first to
discuss the approach. Adding a new agent is two steps —
[`app/src/lib/harness-client/agents/README.md`](app/src/lib/harness-client/agents/README.md)
— and the hames library half is MIT, so it can be extracted and used anywhere
([`docs/plan/harness-npm-lib.md`](docs/plan/harness-npm-lib.md)).

## Security

This app holds real credentials and real tool access, and is at MVP stage.
Please report vulnerabilities **privately** via GitHub security advisories
([Security → Report a vulnerability](https://github.com/mknw/hames-playground/security/advisories/new))
rather than in a public issue.

## License

Two licenses, split along the library boundary:

| Scope                                                   | License                                     |
| ------------------------------------------------------- | ------------------------------------------- |
| `app/src/lib/harness-patterns/` — the **hames** library | [MIT](app/src/lib/harness-patterns/LICENSE) |
| Everything else — the **hames-playground app**          | [PolyForm Noncommercial 1.0.0](LICENSE)     |

Copyright (c) 2026 Michael Accetto. **Both require attribution.** The library is
MIT so it is usable anywhere, including commercially, once extracted. The app
around it is noncommercial: run it, study it, modify it, self-host it locally or
in the cloud — but not for a commercial purpose.

Third-party notices are unaffected by either: the vendored files listed in
[`.claude/skills/NOTICE.md`](.claude/skills/NOTICE.md) keep their own licenses,
with upstream pins recorded in
[`.claude/skills/PROVENANCE.md`](.claude/skills/PROVENANCE.md).
