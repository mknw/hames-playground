# Docker Compose Documentation

## Overview

The kg-agent project uses Docker Compose to orchestrate the stack:

- **n8n**: Workflow automation platform
- **neo4j**: Graph database (Community Edition v5.26)
- **postgres**: Relational database (PostgreSQL 16)
- **redis**: Key-value store and cache (redis-stack — RedisJSON + RediSearch)
- **mcp-gateway**: Docker's Model Context Protocol gateway for AI tool integration
- **doc-convert**: document → markdown sidecar for the Data Stash
- **app**: the SolidStart app itself — opt-in via the `app` profile (#197)

All services communicate via a shared bridge network (`app-network`).

## Service Details

### n8n

- **Container**: n8n-seederis
- **Ports**: 5678:5678
- **Timezone**: Europe/Brussels
- **Data**: Persisted in `./n8n_data`

### Neo4j

- **Container**: neo4j-mldsgraph
- **Ports**:
  - 7474 (HTTP browser interface)
  - 7687 (Bolt protocol)
- **Authentication**: neo4j/password
- **Plugins**: APOC, n10s
- **Data**: Persisted in `./neo4j_data`
- **Healthcheck**: Validates HTTP endpoint on port 7474

### PostgreSQL

- **Container**: postgres-seederis
- **Image**: postgres:16-alpine
- **Ports**: 5432:5432
- **Authentication**: postgres/password
- **Default Database**: kgagent
- **Data**: Persisted in `postgres_data` named volume
- **Healthcheck**: `pg_isready -U postgres`

### Redis

- **Container**: redis-seederis
- **Image**: redis/redis-stack:7.4.0-v8 (bundles RedisJSON + RediSearch, required by the Data Stash pipeline; plain redis:7-alpine has no modules)
- **Ports**: 6379:6379
- **Authentication**: None (alpine default)
- **Data**: Persisted in `redis_data` named volume
- **Healthcheck**: `redis-cli ping`

### MCP Gateway

- **Image**: docker/mcp-gateway
- **Ports**: 8811:8811
- **MCP Servers**: neo4j-cypher, fetch, web_search, context7, rust-mcp-filesystem, memory, redis, database-server
- **Transport**: streaming
- **Dependencies**: Waits for Neo4j healthcheck

### app (the SolidStart app, #197)

- **Container**: kg-agent-app · **Image**: built from `app/Dockerfile` (tagged `kg-agent-app:local`)
- **Ports**: 3444:3444 · **Healthcheck**: `GET /api/health` (liveness only — see below)
- **Profile**: `app` — a bare `docker compose up -d` leaves it out; naming it
  (`docker compose up -d app`) or `--profile app` brings it in
- **Config**: `env_file: app/.env` (optional), with the in-network endpoints
  overridden in `environment:`
- **Dependencies**: postgres / neo4j / redis healthy, mcp-gateway started
- **Requires Compose ≥ 2.24** for the `env_file: [{path, required: false}]` long
  syntax that makes `app/.env` optional. Older Compose rejects the whole file,
  not just this service — so check `docker compose version` first if the bring-up
  suddenly fails on an otherwise untouched stack.

**Deployment/parity, not the dev loop.** `pnpm dev` on the host is unchanged and
remains how you develop; this service exists so the same code can be run the way
it is deployed. Build and run:

```bash
docker compose build app && docker compose up -d app
curl localhost:3444/api/health
```

**The image**: three stages — `deps` (full `pnpm install --frozen-lockfile`,
with a C toolchain because node-pty compiles from source) → `build`
(`baml-generate` **then** `vinxi build`, sequentially: `pnpm build`'s `&`
backgrounds the generate step, and `baml_client/` is gitignored so it is never
already on disk here) → `runtime` (`node:22-bookworm-slim` + `.output`).
Nitro's node-server output carries its own `node_modules`, so the runtime stage
installs nothing — but its tracer only follows the `require`/`import` graph it
can statically see, and it silently drops the two packages that matter most:
node-pty's `build/Release/` (addon + spawn-helper, loaded by path) and
`@boundaryml/baml`'s entry `index.js`. Both are therefore staged complete in
the `build` stage (dereferencing pnpm's symlinks into `.pnpm/`) and overlaid
onto `.output/server/node_modules` in `runtime`, so what the image guarantees
is that `require('node-pty')` and `require('@boundaryml/baml')` both work —
asserted by CI, because `/api/health` touches neither and a broken image boots
happily. `app/node_modules` is `.dockerignore`d because a host-built tree would
be the wrong platform; the staged copies come from the in-image install.

**Endpoint rewrites** (`environment:` beats `env_file:`):

| Var                    | Container value                                        | Why                                                            |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `DATABASE_URL`         | `postgresql://postgres:password@postgres:5432/kgagent` | service name, not localhost                                    |
| `MCP_GATEWAY_URL`      | `http://mcp-gateway:8811/mcp`                          | same                                                           |
| `REDIS_HOST_DIRECT`    | `redis`                                                | Data Stash direct client (`STASH_DIRECT_REDIS=1`)              |
| `DOC_CONVERT_URL`      | `http://doc-convert:8000`                              | conversion sidecar                                             |
| `EMBEDDINGS_LOCAL_URL` | `http://host.docker.internal:8090/v1`                  | the embedder is a **host** llama-server, not a compose service |

Neo4j needs no entry: `config/endpoints.ts` picks `bolt://neo4j:7687` in a
production build (the `localhost` form is its `import.meta.env.DEV` branch).

**Auth**: the same `import.meta.env.DEV` substitution structurally disables the
dev bypass in the image, so the container always runs real Entra sign-in —
`AZURE_*`, `AUTH_SESSION_SECRET` and `VITE_ALLOWED_EMAILS` must be in
`app/.env`. The allow-list is read from `process.env` at runtime (falling back
to the build-time inlined value), so one image serves any tenant. `VITE_DEV_BYPASS_AUTH`
must stay `import.meta.env`-only (inlined, dead in a production build) — porting
it to the same `process.env`-first pattern as the allow-list would let a
runtime env var re-enable the bypass inside the container. Port 3444 is
published unchanged, so the registered redirect URI still matches.

**Healthcheck**: `/api/health` is a liveness probe — it reports that the process
is serving HTTP and touches no dependency. A readiness-style probe would mark
the app unhealthy during a Postgres blip and, under `restart: unless-stopped`,
restart a process that is fine.

**Docker socket**: mounted, because the compute sandbox shells out to
`docker run` / `docker exec` (`sandbox/docker-backend.server.ts`). Sandbox
containers become siblings on the host; none of those calls bind-mount host
paths, so they work unchanged from inside the container. The mount is
root-equivalent on the host, which is also why the container runs as root — an
unprivileged user would gain nothing and lose socket access. Drop both together
if you do not need sandbox agents. `kg-sandbox:base` is still built separately
(`docker build -t kg-sandbox:base rootfs/`).

**Build resources**: the vinxi build peaks near 2.3 GB RSS. Give the Docker VM
(colima / Docker Desktop) at least 4 GB or the build dies mid-bundle with
`cannot allocate memory` — a 2 GB VM cannot build this image no matter which
containers you stop.

**CI**: the `image` job in `.github/workflows/ci.yml` builds this Dockerfile on
every PR and then boots the image with no dependencies attached and waits for
`/api/health`, so a change that breaks the build or the runtime stage is caught
without anyone running Docker locally.

## MCP Gateway Configuration Issue & Solution

### The Problem

We discovered a critical mismatch between Docker's official MCP catalog and the neo4j-cypher server implementation:

- **Docker MCP Catalog**: Maps config key `url` → environment variable `NEO4J_URL`
- **neo4j-cypher server**: Actually expects environment variable `NEO4J_URI`

This caused authentication failures because the connection string wasn't being passed correctly.

### The Solution

Created a **custom catalog** (`custom-catalog.yaml`) that properly maps configuration to environment variables:

```yaml
env:
  - name: NEO4J_URI # FIXED: Was NEO4J_URL
    value: "{{neo4j-cypher.uri}}" # FIXED: Was {{neo4j-cypher.url}}
  - name: NEO4J_USERNAME
    value: "{{neo4j-cypher.username}}"
  - name: NEO4J_PASSWORD
    value: "{{neo4j-cypher.password}}"
  - name: NEO4J_DATABASE
    value: "{{neo4j-cypher.database}}"
  - name: NEO4J_READ_ONLY
    value: "{{neo4j-cypher.read_only}}"
```

### Configuration Files

All MCP configuration files are located in the `configs/` directory:

1. **configs/mcp-config.yaml**: Contains connection parameters

   ```yaml
   neo4j-cypher:
     uri: bolt://neo4j:7687 # Uses Docker service name
     username: neo4j
     password: password
     database: neo4j
     read_only: false
   ```

2. **configs/custom-catalog.yaml**: Custom catalog definition with corrected environment variable mappings
   - **neo4j-cypher**: Graph database queries (fixed NEO4J_URI mapping)
   - **fetch**: Web content retrieval
   - **web_search**: DuckDuckGo search
   - **context7**: Library documentation lookup
   - **rust-mcp-filesystem**: File system operations
   - **memory**: Knowledge graph memory
   - **redis**: Redis operations (connects to redis container)
   - **database-server**: PostgreSQL/MySQL/SQLite queries (connects to postgres container)
   - Uses SHA256 digests for image references (e.g., `mcp/fetch@sha256:...`)

3. **configs/catalog.yaml**: Full Docker MCP catalog for global mode

4. **docker-compose.yaml**: Mounts all configuration files read-only
   ```yaml
   volumes:
     - ./configs/mcp-config.yaml:/mcp/config.yaml:ro
     - ./configs/custom-catalog.yaml:/mcp/custom-catalog.yaml:ro
     - ./configs/catalog.yaml:/mcp/catalog.yaml:ro
   ```

## Important Notes

### Service Networking

- Use Docker service names for inter-container communication (not `host.docker.internal`)
  - Neo4j: `neo4j:7687` (bolt) / `neo4j:7474` (http)
  - PostgreSQL: `postgres:5432`
  - Redis: `redis:6379`
- All services are accessible on the `app-network` bridge network
- MCP servers spawned by the gateway also join this network to reach backends

### Neo4j Authentication Reset

- If authentication rate limiting occurs, you must **completely remove the `neo4j_data` directory**
- Neo4j only accepts credential changes before initial database creation
- Pattern: Stop containers → `rm -rf neo4j_data` → Restart

### Configuration Management

- MCP Gateway works best with YAML configuration files mounted as volumes
- Using environment variables or Docker secrets proved less reliable
- Configuration files are mounted read-only (`:ro`) for security

### MCP Gateway Discovery

The custom catalog was created by:

1. Cloning the mcp-gateway repository
2. Examining `pkg/gateway/clientpool.go` to understand template evaluation
3. Identifying the `argsAndEnv` function that constructs environment variables
4. Creating a corrected mapping based on what the neo4j-cypher server actually expects

## Adding Additional MCP Servers

To add new MCP servers to the custom catalog:

1. **Find the server's image digest**:

   ```bash
   # If the image is already pulled locally
   docker images | grep mcp/<server-name>
   docker inspect <image-id> --format='{{index .RepoDigests 0}}'
   ```

2. **Add to custom-catalog.yaml**:

   ```yaml
   registry:
     server-name:
       description: Server description
       title: Display Name
       type: server
       image: mcp/server-name@sha256:<digest>
       tools:
         - name: tool_name_1
         - name: tool_name_2
   ```

3. **Add server to docker-compose.yaml command**:

   ```yaml
   command:
     - --servers=neo4j-cypher,fetch,new-server
   ```

4. **Add configuration if needed** (in mcp-config.yaml):
   ```yaml
   new-server:
     param1: value1
     param2: value2
   ```

**Important**: Always use SHA256 digests (`@sha256:...`) not tags (`:latest`) for image references. The gateway doesn't accept tag-based references in the format `@latest`.
