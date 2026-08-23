# harness-playground

A playground for building agent applications out of composable **harness patterns** — primitives like `simpleLoop`, `actorCritic`, `parallel`, `router`, `withReferences`, `withApproval` that you chain into agents fit for any task. BAML provides typed LLM reasoning at each pattern's leaf; an MCP gateway provides the tools.

The repo ships several example agents that exercise the framework (default Neo4j + web research, code-mode, and several more in the registry). The point of the project is the framework — the agents are showcases of what becomes easy when the primitives are right.

## Feature showcase

Cross-pattern data flow with `withReferences` — the agent searches the web in one turn, then writes the results into Neo4j on the next turn. The LLM-driven selector at each route's ingress attaches the most relevant prior `tool_result` events to the new pattern's `priorResults` channel; the controller uses the synthetic `expandPreviousResult` tool (or inline `ref:<id>` argument substitution) to pull the full data when it needs it. No re-fetching; no hallucinated content.

![TypeScript 5.7 features fetched via web_search and written to Neo4j as connected Concept nodes](docs/harness-patterns/screenshots/05-neo4j-graph-result.png)

→ Walkthrough: [`docs/harness-patterns/withReferences-tutorial.md`](docs/harness-patterns/withReferences-tutorial.md) · Design: [`docs/harness-patterns/with-references.md`](docs/harness-patterns/with-references.md)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    SolidStart UI (Port 3444)                    │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────────┐ │
│  │ Chat +      │  │ Graph          │  │ Support Panel         │ │
│  │ Sidebar     │  │ Visualization  │  │ (Observability/Tools) │ │
│  └──────┬──────┘  └────────────────┘  └───────────────────────┘ │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           Harness Patterns (Server Functions)             │   │
│  │  Router → simpleLoop / actorCritic / withReferences /     │   │
│  │  parallel / withApproval / … → compactExecution                │   │
│  │  + UnifiedContext, EventView, BAML adapters, SSE stream   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼─────────────┬──────────────┐
              ▼               ▼             ▼              ▼
     ┌────────────┐  ┌────────────────┐  ┌──────────┐  ┌──────────┐
     │ Neo4j      │  │ MCP Gateway    │  │ Postgres │  │ Redis    │
     │ (Direct +  │  │ (Port 8811)    │  │ (5432)   │  │ (6379)   │
     │  via MCP)  │  │ neo4j, web,    │  │ chat     │  │ guardrail│
     │ Port 7687  │  │ memory, redis, │  │ history  │  │ + h9s    │
     └────────────┘  │ filesystem, …  │  └──────────┘  └──────────┘
                     └────────────────┘
```

## Requirements

- Docker Desktop
- Node.js >= 22
- pnpm

## Quick Start

```bash
# 1. Start backend services
docker compose up -d

# 2. Wait for Neo4j health check (check with docker compose ps)
docker compose ps

# 3. Load seed data into Neo4j
./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher

# 4. Start the UI
cd app
pnpm install
pnpm dev
```

The app itself runs natively here on purpose — that is the development loop, and
step 1 deliberately does not start it. To run it as a container instead (parity
with deployment), see [Running the app in a container](#running-the-app-in-a-container).

**Access Points:**

- **UI**: http://localhost:3444
- **Neo4j Browser**: http://localhost:7474 (neo4j/password)
- **MCP Gateway**: http://localhost:8811/mcp
- **Postgres** (chat history): localhost:5432 (postgres/password, db `kgagent`)
- **n8n** (optional): http://localhost:5678

## Services

All services run in Docker containers via the `app-network` bridge network:

| Service         | Port       | Description                                                     |
| --------------- | ---------- | --------------------------------------------------------------- |
| **Neo4j**       | 7474, 7687 | Graph database with APOC and n10s plugins                       |
| **MCP Gateway** | 8811       | Model Context Protocol gateway for AI tools                     |
| **Postgres**    | 5432       | Conversation history (per-user, persisted across restarts)      |
| **Redis**       | 6379       | Guardrail circuit-breaker state, ephemeral cache                |
| **n8n**         | 5678       | Workflow automation (optional)                                  |
| **app**         | 3444       | The SolidStart app itself — opt-in (`--profile app`), see below |

## Running the app in a container

The app ships a Dockerfile (`app/Dockerfile`) and a compose service, `app`
(#197). It is **deployment/parity, not the dev loop** — `pnpm dev` on the host
stays the way to develop, and nothing about it changed.

```bash
docker compose build app        # multi-stage: pnpm install → baml-generate → vinxi build
docker compose up -d app        # starts its dependencies too (postgres, neo4j, redis, gateway)
curl localhost:3444/api/health  # {"status":"ok","uptimeSeconds":…}
docker compose logs -f app
```

The service sits behind a compose **profile**, so a bare `docker compose up -d`
still brings up only the backing services — naming `app` explicitly (as above)
enables the profile. To bring up everything at once: `docker compose --profile app up -d`.

Notes worth knowing before you run it:

- **Config comes from `app/.env`** (`env_file`, optional so a fresh clone can
  still start the rest of the stack). The compose service overrides the
  host-facing endpoints in it with their in-network equivalents —
  `postgres:5432`, `mcp-gateway:8811`, `redis`, `doc-convert:8000`. Neo4j needs
  no override: `config/endpoints.ts` already resolves `bolt://neo4j:7687` in a
  production build.
- **Real auth is required.** The dev bypass is gated on `import.meta.env.DEV`,
  which Vite replaces with `false` in the build that goes into the image — so
  the container always runs the real Entra sign-in and needs `AZURE_*` +
  `AUTH_SESSION_SECRET` + `VITE_ALLOWED_EMAILS` in `app/.env`
  ([`docs/deployment/entra-setup.md`](docs/deployment/entra-setup.md)). The published
  port is the same 3444, so the registered redirect URI keeps working.
- **The Data Stash embedder is not a compose service** — it is a llama-server on
  the host (port 8090). The container reaches it via
  `EMBEDDINGS_LOCAL_URL=http://host.docker.internal:8090/v1`.
- **`/var/run/docker.sock` is mounted** so the compute sandbox can keep shelling
  out to `docker run` / `docker exec`; sandbox containers are then siblings on
  the host. That mount is root-equivalent on the host — drop it (and add
  `USER node` to the Dockerfile) if you do not need the sandbox agents. Building
  `kg-sandbox:base` is still a separate step: `docker build -t kg-sandbox:base rootfs/`.
- **Build resources:** the vinxi build peaks around 2.3 GB RSS. On
  Docker Desktop / colima give the VM at least 4 GB, or the build is OOM-killed
  mid-bundle (`cannot allocate memory`).

Full service reference: [`docs/DOCKER_COMPOSE.md`](docs/DOCKER_COMPOSE.md).

## Harness Patterns Framework

The harness is the main deliverable. It's a composable pattern framework built on a `UnifiedContext` event log: patterns are functions of `(scope, view, tools)` that emit events and can be composed via `chain`, `router`, `parallel`, `withApproval`, `withReferences`, etc. BAML provides type-safe LLM reasoning at each pattern's leaf. Patterns share infrastructure (event commit, SSE streaming, session persistence) and stay independent in semantics — you can drop one in or out without disturbing the others.

### Core flow

1. **Router** classifies the user message and selects a route
2. **Inner pattern** (typically `simpleLoop` or `actorCritic`) runs the tool loop, optionally wrapped with `withReferences` so prior `tool_result` events from earlier turns are attached to the new pattern's `priorResults` channel via an LLM-driven selector
3. **compactExecution** turns the accumulated events into the final assistant response

### Tool namespaces (via MCP Gateway)

`neo4j`, `web`, `context7`, `filesystem`, `github`, `memory`, `redis`, `database`, `code` — plus any custom servers added to `configs/custom-catalog.yaml`. Tool grouping happens in `app/src/lib/harness-patterns/tools.server.ts` (`inferServer()` + `KNOWN_TOOL_SERVERS` lookup).

Full API: [`app/src/lib/harness-patterns/README.md`](app/src/lib/harness-patterns/README.md) · Examples: [`app/src/lib/harness-client/examples/README.md`](app/src/lib/harness-client/examples/README.md) · Cross-pattern data flow walkthrough: [`docs/harness-patterns/withReferences-tutorial.md`](docs/harness-patterns/withReferences-tutorial.md).

## Conversation Persistence

Conversations are persisted to Postgres in a single `conversations(id, user_id, agent_id, title, context jsonb, created_at, updated_at)` table — the `context` column is the full `serializeContext()` blob, no normalization. Schema is bootstrapped idempotently on first DB hit, so the bring-up is just `docker compose up -d`.

- Per-user scoping: every load/save is gated by `user_id` (the Entra `oid`, or `dev-bypass-user` when `VITE_DEV_BYPASS_AUTH=true`)
- Sticky titles: first 60 chars of the first user message becomes the title, locked in via `COALESCE` on update
- Sidebar lists threads via `listConversations()`; selecting one calls `loadConversation()` and replays events into the graph + observability panel

Implementation: `app/src/lib/db/{client,conversations}.server.ts` and `app/src/lib/harness-client/session.server.ts`.

## MCP Servers

Configured in `configs/custom-catalog.yaml` and enabled via `configs/mcp-config.yaml`. The gateway runs with `--enable-all-servers`, so any registered server is exposed unless explicitly disabled.

| Server                | Tools                                                         | Purpose                                                          |
| --------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `neo4j-cypher`        | `get_neo4j_schema`, `read_neo4j_cypher`, `write_neo4j_cypher` | Execute Cypher (uses fixed `NEO4J_URI` mapping, not `NEO4J_URL`) |
| `fetch`               | `fetch`                                                       | Retrieve content from the web                                    |
| `web_search`          | `web_search`                                                  | DuckDuckGo web search                                            |
| `rust-mcp-filesystem` | filesystem ops                                                | Sandboxed filesystem access via configured allowed directories   |
| `github`              | repo / issue / PR ops                                         | GitHub API                                                       |
| `memory`              | entity / observation / relation ops                           | Knowledge-graph–style scratch memory                             |
| `redis`               | key / hash / json / vector ops                                | Redis primitives + RediSearch                                    |
| `database-server`     | SQL ops                                                       | Generic database access                                          |
| `playwright`          | browser automation                                            | E2E testing (requires `pnpm dev:exposed`)                        |
| `context7`            | `resolve-library-id`, `get-library-docs`                      | Library docs                                                     |

Tool namespaces consumed by `harness-patterns/tools.server.ts`: `neo4j`, `web`, `context7`, `filesystem`, `github`, `memory`, `redis`, `database`, `code` (and `all`). See `KNOWN_TOOL_SERVERS` in that file for the namespace lookup.

## Neo4j Database

**Access**: http://localhost:7474
**Credentials**: neo4j / password
**Plugins**: APOC, n10s (neosemantics)

### Data Versioning

Binary database files are **gitignored**. Graph data is version-controlled as human-readable Cypher:

```bash
# Export current graph state
./scripts/export-neo4j.sh

# Import from a Cypher dump
./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher

# Reset to seed data
./scripts/reset-neo4j.sh
```

See [neo4j_dumps/README.md](neo4j_dumps/README.md) for the complete workflow.

### Reset Database

If you encounter authentication issues or need a fresh start:

```bash
docker compose down
rm -rf neo4j_data
docker compose up -d
./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher
```

## Configuration Files

| File                  | Purpose                                  | Key Settings                 |
| --------------------- | ---------------------------------------- | ---------------------------- |
| `docker-compose.yaml` | Service orchestration                    | Ports, volumes, healthchecks |
| `mcp-config.yaml`     | MCP server connection parameters         | Neo4j URI, credentials       |
| `custom-catalog.yaml` | Custom MCP catalog with tool definitions | Server images, env mappings  |
| `.mcp.json`           | Claude Code MCP integration              | Gateway endpoint             |
| `app/baml_src/*.baml` | BAML function definitions                | Agent prompts, types         |

## Project Structure

```
kg-agent/
├── docker-compose.yaml       # Neo4j, MCP Gateway, Postgres, Redis, n8n
├── configs/
│   ├── mcp-config.yaml       # MCP server connection params
│   └── custom-catalog.yaml   # Custom MCP catalog (Docker image-based)
├── .mcp.json                 # Claude Code MCP config
├── neo4j_dumps/              # Cypher exports for data versioning
├── scripts/                  # export-neo4j.sh, import-neo4j.sh, reset-neo4j.sh
├── app/                       # SolidStart frontend
│   ├── baml_src/             # BAML function definitions (regenerate via `pnpm baml-generate`)
│   ├── src/
│   │   ├── routes/           # SolidStart routes + /api/events SSE endpoint
│   │   ├── components/       # UI components (Ark UI)
│   │   └── lib/
│   │       ├── harness-patterns/  # Composable pattern framework
│   │       ├── harness-client/    # Server actions, registry, session, examples/
│   │       ├── db/                # Postgres pool + conversations repo
│   │       ├── neo4j/             # neo4j-driver singleton + write actions
│   │       └── auth/              # Entra OIDC (MSAL) + session store + helpers
│   └── package.json
├── docs/                     # Documentation (see docs/INDEX.md)
└── graphiti-mcp/             # Graphiti MCP utilities (optional)
```

## Adding New MCP Servers

1. **Find the server's image digest**:

   ```bash
   docker pull mcp/<server-name>
   docker inspect mcp/<server-name> --format='{{index .RepoDigests 0}}'
   ```

2. **Add to `custom-catalog.yaml`**:

   ```yaml
   registry:
     your-server:
       description: Description
       title: Display Name
       type: server
       image: mcp/server-name@sha256:<digest>
       tools:
         - name: tool_name
       env:
         - name: CONFIG_VAR
           value: "{{your-server.config_key}}"
   ```

3. **Add configuration to `mcp-config.yaml`** (if needed):

   ```yaml
   your-server:
     config_key: value
   ```

4. **Update `docker-compose.yaml`**:

   ```yaml
   command:
     - --servers=neo4j-cypher,fetch,web_search,your-server
   ```

5. **Restart the gateway**:
   ```bash
   docker compose restart mcp-gateway
   ```

**Important**: Always use SHA256 digests (`@sha256:...`), not tags (`:latest`).

## Documentation

| Document                                                                         | Description                                                     |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [docs/INDEX.md](docs/INDEX.md)                                                   | Documentation index and overview                                |
| [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md)                               | SolidStart UI structure and patterns                            |
| [docs/DOCKER_COMPOSE.md](docs/DOCKER_COMPOSE.md)                                 | Service configuration details                                   |
| [docs/MCP_GATEWAY.md](docs/MCP_GATEWAY.md)                                       | MCP Gateway reference                                           |
| [GitHub Project](https://github.com/users/mknw/projects/5)                       | Development roadmap / planning board (replaced docs/ROADMAP.md) |
| [docs/harness-patterns/README.md](docs/harness-patterns/README.md)               | Harness patterns overview + tutorials                           |
| [app/src/lib/harness-patterns/README.md](app/src/lib/harness-patterns/README.md) | Harness patterns API reference                                  |
| [neo4j_dumps/README.md](neo4j_dumps/README.md)                                   | Neo4j data versioning workflow                                  |

## Troubleshooting

### MCP Gateway not loading servers

```bash
docker logs kg-agent-mcp-gateway-1
```

Look for image pull errors or configuration issues.

### Agent not connecting to Neo4j

1. Check Neo4j is healthy: `docker compose ps`
2. Verify connection in `mcp-config.yaml`: `uri: bolt://neo4j:7687`
3. Test directly: `docker exec neo4j-mldsgraph cypher-shell -u neo4j -p password`

### UI build errors

```bash
cd app
pnpm baml-generate  # Regenerate BAML client
pnpm build
```

### View service logs

```bash
docker compose logs -f              # All services
docker compose logs -f neo4j        # Neo4j only
docker compose logs -f mcp-gateway  # Gateway only
```

## Development

```bash
# Start UI in development mode
cd app && pnpm dev

# Generate BAML TypeScript client
cd app && pnpm baml-generate

# Run BAML tests
cd app && pnpm baml-test

# Lint code
cd app && pnpm eslint
```

## License

[Add your license information here]
