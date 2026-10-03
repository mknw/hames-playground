# Docker Compose Documentation

## Overview

The stack runs as one Docker Compose project, `hames`:

- **neo4j**: Graph database (Community Edition v5.26)
- **postgres**: Relational database (PostgreSQL 16)
- **redis**: Key-value store and cache (redis-stack — RedisJSON + RediSearch)
- **mcp-gateway**: Docker's Model Context Protocol gateway for AI tool integration
- **doc-convert**: document → markdown sidecar for the Data Stash
- **app**: the SolidStart app itself — opt-in via the `app` profile (#197)

All services communicate via a shared bridge network (`app-network`). Every
published port is bound to `127.0.0.1`, and the two database passwords come from
the repo-root `.env` — see [Credentials and existing volumes](#credentials-and-existing-volumes)
before the first `docker compose up` on a machine that already has the stack.

## Service Details

### Neo4j

- **Container**: hames-neo4j
- **Ports** (loopback only):
  - 127.0.0.1:7474 (HTTP browser interface)
  - 127.0.0.1:7687 (Bolt protocol)
- **Authentication**: `neo4j` / `NEO4J_PASSWORD` from the repo-root `.env`
- **Plugins**: APOC, n10s
- **Data**: Persisted in the `neo4j_data` named volume
- **Healthcheck**: Validates HTTP endpoint on port 7474

### PostgreSQL

- **Container**: hames-postgres
- **Image**: postgres:16-alpine
- **Ports**: 127.0.0.1:5432:5432
- **Authentication**: `postgres` / `POSTGRES_PASSWORD` from the repo-root `.env`
- **Default Database**: hames
- **Data**: Persisted in `postgres_data` named volume
- **Healthcheck**: `pg_isready -U postgres`

### Redis

- **Container**: hames-redis
- **Image**: redis/redis-stack:7.4.0-v8 (bundles RedisJSON + RediSearch, required by the Data Stash pipeline; plain redis:7-alpine has no modules)
- **Ports**: 127.0.0.1:6379:6379
- **Authentication**: None (alpine default)
- **Data**: Persisted in `redis_data` named volume
- **Healthcheck**: `redis-cli ping`

### MCP Gateway

- **Image**: docker/mcp-gateway, pinned by digest to the 2026-01-22 build. Current
  upstream releases cannot run this stack (#417); the comment on the service in
  `docker-compose.yaml` says why, and what a bump needs first
- **Ports**: 127.0.0.1:8811:8811
- **MCP Servers**: neo4j-cypher, fetch, web_search, context7, rust-mcp-filesystem, memory, redis, database-server
- **Transport**: streaming
- **Config**: reads the RENDERED `/mcp/rendered/config.yaml`, written by the
  one-shot `mcp-config` service from `configs/mcp-config.yaml` with the root
  `.env` passwords filled in (`scripts/render-mcp-config.sh`)
- **Dependencies**: Waits for Neo4j healthcheck and for `mcp-config` to exit 0

### app (the SolidStart app, #197)

- **Container**: hames-app · **Image**: built from `app/Dockerfile` (tagged `hames-app:local`)
- **Ports**: 127.0.0.1:3444:3444 · **Healthcheck**: `GET /api/health` (liveness only — see below)
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
(just `vinxi build` since the one-corpus change: the BAML client is committed
in `packages/harness-baml/` and arrives with the workspace copy, so there is
nothing to generate first. It used to be `baml-generate` **then** `vinxi build`,
sequentially, because `pnpm build`'s `&` backgrounded the generate step and the
app's own `baml_client/` was gitignored so it was never
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

| Var                             | Container value                                                  | Why                                                            |
| ------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`                  | `postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/hames` | service name, not localhost; password from the root `.env`     |
| `NEO4J_USER` / `NEO4J_PASSWORD` | `neo4j` / `${NEO4J_PASSWORD}`                                    | the direct driver's credential, from the root `.env`           |
| `MCP_GATEWAY_URL`               | `http://mcp-gateway:8811/mcp`                                    | same                                                           |
| `REDIS_HOST_DIRECT`             | `redis`                                                          | Data Stash direct client (`STASH_DIRECT_REDIS=1`)              |
| `DOC_CONVERT_URL`               | `http://doc-convert:8000`                                        | conversion sidecar                                             |
| `EMBEDDINGS_LOCAL_URL`          | `http://host.docker.internal:8090/v1`                            | the embedder is a **host** llama-server, not a compose service |

The Neo4j URL needs no entry: `config/endpoints.ts` picks `bolt://neo4j:7687`
in a production build (the `localhost` form is its `import.meta.env.DEV`
branch); only the credential is supplied.

**Auth**: the same `import.meta.env.DEV` substitution structurally disables the
dev bypass in the image, so the container always runs real Entra sign-in —
`AZURE_*`, `AUTH_SESSION_SECRET` and `VITE_ALLOWED_EMAILS` must be in
`app/.env`. The allow-list is read from `process.env` at runtime (falling back
to the build-time inlined value), so one image serves any tenant. `VITE_DEV_BYPASS_AUTH`
must stay `import.meta.env`-only (inlined, dead in a production build) — porting
it to the same `process.env`-first pattern as the allow-list would let a
runtime env var re-enable the bypass inside the container. Port 3444 is
published on 127.0.0.1 only, so `http://localhost:3444` — and the registered
redirect URI — still matches.

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
     password: ${NEO4J_PASSWORD} # filled from the root .env by `mcp-config`
     database: neo4j
     read_only: true # agents are read-only against Neo4j (#403)
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

4. **docker-compose.yaml**: the one-shot `mcp-config` service renders
   `configs/mcp-config.yaml` into the `mcp_config` volume, filling
   `${NEO4J_PASSWORD}` / `${POSTGRES_PASSWORD}` from the root `.env`; the gateway
   mounts that volume and the catalogs read-only
   ```yaml
   volumes:
     - mcp_config:/mcp/rendered:ro # --config=/mcp/rendered/config.yaml
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

### Published ports are loopback-only

Every `ports:` entry in `docker-compose.yaml` is `127.0.0.1:<host>:<container>`,
so `localhost:5432`, `localhost:7474` etc. work from your machine and nothing is
reachable from the LAN. Container-to-container traffic is unaffected: it goes
over `app-network` by service name and never touches a published port. The one
thing this changes is a container reaching a compose service through
`host.docker.internal` or the host's IP — on Linux, `host-gateway` cannot reach
a port bound to 127.0.0.1. Nothing in the repo does that today; use the service
name if you add something that would (e.g. point the Playwright MCP server at
`http://app:3444`, not `http://host.docker.internal:3444`, when the target is
the compose `app` container rather than `pnpm dev:exposed` on the host).

### Credentials and existing volumes

`NEO4J_PASSWORD` and `POSTGRES_PASSWORD` live in ONE place: the **repo-root
`.env`** (Compose's substitution source — not `app/.env`). Every consumer reads
them from there:

- the databases themselves and the `app` container, through `${VAR:?}` in
  `docker-compose.yaml` — every `docker compose` command, including `exec` and
  `ps`, fails until both are set;
- the MCP gateway, whose `configs/mcp-config.yaml` carries `${…}` placeholders
  that the one-shot `mcp-config` service fills in on every `up`;
- `pnpm dev` on the host, the three test suites' database URLs and the
  org-graph scripts, through `app/src/lib/config/compose-credentials.server.ts`
  (an exported variable wins; otherwise the root `.env` is read);
- the Neo4j helper scripts, through `scripts/lib/compose-env.sh` (same rule).

None of them has a fallback literal. A test run against a Postgres that rejects
the password **fails** (`src/__tests__/global-setup.ts`) instead of letting the
DB-backed suites skip themselves green.

```bash
cp .env.example .env    # at the repo root; any values work on a NEW stack
```

Both databases apply their password **only when the data volume is first
created**. An existing volume keeps the password it was created with, which for
every stack started before this change is the old compose default, `password`.
Setting a new value in `.env` does not change it — the database keeps expecting
the old one, and the app and gateway get authentication failures. **Never delete
a volume to fix this**; it is the graph and every conversation. Pick one:

**A. Keep the existing password (no rotation).** Put the value the volume was
created with into the root `.env`:

```bash
NEO4J_PASSWORD='password'
POSTGRES_PASSWORD='password'
```

Nothing else needs editing — every other consumer reads the same file. Ports
move to loopback on the next `docker compose up -d`.

**B. Rotate in place.** Start from state A (the stack up with the OLD password in
`.env`), then:

```bash
# Neo4j — administration commands run against the `system` database.
docker compose exec neo4j cypher-shell -u neo4j -p 'password' -d system \
  "ALTER CURRENT USER SET PASSWORD FROM 'password' TO '<new-neo4j-password>'"

# Postgres — psql over the container's local socket needs no password.
docker compose exec postgres psql -U postgres -c \
  "ALTER USER postgres WITH PASSWORD '<new-postgres-password>'"
```

Then write the two new values into the root `.env` — the only place they
live — and recreate what read the old ones: `docker compose up -d
--force-recreate mcp-gateway neo4j postgres` (and `app`, if you run it; the
`mcp-config` renderer re-runs on its own), then restart `pnpm dev`. If you
have `DATABASE_URL`, `NEO4J_PASSWORD` or `TEST_DATABASE_URL` set explicitly in
`app/.env` or your shell, those still win and must change too — nothing in the
repo sets them. Use URL-safe characters (`openssl rand -hex 24`): the Postgres
value is spliced into `postgresql://` URLs, and the gateway renderer refuses
`& \ / @ : # ? %` and spaces rather than write a broken one. Neo4j 5 rejects
passwords under 8 characters.

**Locked out after failed logins?** Neo4j locks an account briefly after
repeated authentication failures (`dbms.security.auth_lock_time`). Wait, then
retry with the password the volume was created with — the data never needs
deleting.

### A stack from before the hames rename

The project was called `kg-agent` until 2026-10-02 (#416). It was renamed on a
clean slate: the `hames` project does not adopt the old `kg-agent_*` volumes,
and the old containers still hold the published ports. On a machine that ran
the old stack, `docker compose up -d` therefore fails on those ports until the
old project is gone. Remove it by its old name, so that the command cannot reach
any other project. Look first:

```bash
docker compose -p kg-agent --profile app ps -a
```

`-v` deletes that project's data, so run it only if you mean to discard it:

```bash
docker compose -p kg-agent --profile app down -v
```

If `ps -a` listed a container of a service this file no longer declares (an
orphan, such as `n8n` started from an older checkout), add `--remove-orphans`.
Without it, `down` skips that container, which keeps `kg-agent_app-network` in
use, so `down` exits non-zero.

The Postgres database was renamed too, from `kgagent` to `hames`. If `app/.env`
or your shell sets `DATABASE_URL` or `TEST_DATABASE_URL` explicitly, change
`/kgagent…` to `/hames…` in it. If you go back to a checkout from before the
rename, undo that edit as well.

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
