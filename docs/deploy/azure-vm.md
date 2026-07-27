# Deploying to a single Azure VM (or any VPS)

Lift-and-shift runbook for the current architecture. It maps 1:1 to what the
app needs at runtime, so it works on a plain VPS or an Azure VM identically —
"push to Azure" here just means "an Azure Linux VM running this stack."

> Not yet suitable for multi-replica / autoscale. The app keeps per-session run
> state, the sandbox `AttachmentTable`, and background jobs **in process memory**,
> so it runs as a **single long-lived instance**. Scaling out first needs the
> state externalized (#105) and the sandbox made remote (#78).

---

## Topology (one VM)

```
                         Internet
                            │  443 / 80
                    ┌───────▼────────┐
                    │     Caddy      │  TLS termination (auto Let's Encrypt)
                    └───────┬────────┘
                            │  127.0.0.1:3000
        ┌───────────────────▼───────────────────┐
        │  UI (SolidStart)  — systemd, on host   │  `pnpm start` (vinxi start)
        │  • shells `docker run` for sandboxes    │  needs docker CLI + node-pty
        │  • node-pty for the Shell terminal      │  cwd = ui/  (resolves ../configs)
        └───┬───────────┬──────────┬─────────┬────┘
   localhost│           │          │         │ /var/run/docker.sock
      5432  │      7687 │     8811 │    8090 │ (sandbox + gateway spawn containers)
   ┌────────▼──┐ ┌──────▼───┐ ┌────▼─────┐ ┌─▼──────────┐
   │ postgres  │ │  neo4j   │ │ mcp-     │ │ embeddings │   ← `docker compose`,
   │  :5432    │ │  :7687   │ │ gateway  │ │ (optional) │     ports bound to
   │ (convos)  │ │(apoc+n10s)│ │ :8811    │ │  :8090     │     127.0.0.1 only
   └───────────┘ └──────────┘ └────┬─────┘ └────────────┘
   redis-stack :6379 (DataStash)   │ mounts docker.sock, spawns 1 container/MCP-server
```

**Why the UI runs on the host, not in a container:** it shells out to
`docker run -d --rm …` for compute sandboxes (`docker-backend.server.ts:291`) and
uses `node-pty` for the Shell terminal. There is **no UI Dockerfile** today (only
`rootfs/Dockerfile`, which is the sandbox image). Running the UI as a host
`systemd` service gives it a native `docker` CLI and native `node-pty` with the
least friction. Containerizing it later is possible but needs a socket mount +
`docker` CLI in the image + native rebuild.

---

## 1. Provision the VM

- **Architecture: x86 / amd64.** This sidesteps the redis-stack arm64 SIGILL bug
  (see `docker-compose.override.yml`); on x86 the native image just works, delete
  that override.
- **Size:** start around **4 vCPU / 16 GB** (e.g. Azure `Standard_D4s_v5`). Neo4j
  (+apoc+n10s), redis-stack, Postgres, the Node server, *and* N concurrent sandbox
  containers all share this box. Bump RAM if you raise the sandbox cap.
- **OS:** Ubuntu 22.04 / 24.04 LTS.
- **Disk:** Premium SSD, 64 GB+ (Docker images + the three data volumes).
- **Network security group — open only:**
  - `22` (SSH) — ideally restricted to your IP.
  - `80` + `443` (Caddy).
  - **Nothing else.** Postgres/Redis/Neo4j/gateway stay on `127.0.0.1` (step 4).

## 2. Install prerequisites

```bash
# Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out/in so the UI service user can use docker

# Node 22 + pnpm (via corepack)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable && corepack prepare pnpm@latest --activate

# Caddy (reverse proxy + auto-TLS)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
# ...add Caddy's apt repo, then:
sudo apt-get install -y caddy
```

## 3. Code + configs

```bash
sudo git clone <repo> /opt/kg-agent && cd /opt/kg-agent
```

Keep the repo layout intact — **`ui/` and `configs/` must stay siblings**: the
server resolves the MCP catalog via `path.resolve(process.cwd(), '..', 'configs', …)`
with cwd = `ui/` (`server-catalog.server.ts:42`).

Create the git-ignored config files with **real** values:
- **`configs/mcp-config.yaml`** — the enabled-servers list + secrets (GitHub PAT,
  neo4j password, …). Per #88, scope the GitHub token to **public/read-only** and
  pre-provision statically; there is no runtime secret-setting on a Linux host.
- **`docker-config.json`** — Docker registry auth so the gateway can pull MCP
  server images (mounted read-only into the gateway).
- **`ui/.env`** — see the env table in step 9.

## 4. Harden the compose stack for a public host ⚠️

The committed `docker-compose.yaml` publishes Postgres, Redis, Neo4j, and the
gateway on `0.0.0.0`. **On a public VM that is an internet-exposed database.**
Add a server-side `docker-compose.override.yml` (git-ignored) binding every
published port to loopback, and change the default passwords:

```yaml
# /opt/kg-agent/docker-compose.override.yml  (production)
services:
  postgres:
    ports: ["127.0.0.1:5432:5432"]
    environment: ["POSTGRES_PASSWORD=<STRONG_PW>"]
  neo4j:
    ports: ["127.0.0.1:7474:7474", "127.0.0.1:7687:7687"]
    environment: ["NEO4J_AUTH=neo4j/<STRONG_PW>"]
  redis:
    ports: ["127.0.0.1:6379:6379"]
  mcp-gateway:
    ports: ["127.0.0.1:8811:8811"]
  # (drop the arm64 `platform: linux/amd64` override — you're on x86 now)
```

The UI reaches all of these over `localhost`, so loopback binding is transparent
to the app and closes the exposure.

## 5. Bring up the backing tier

```bash
cd /opt/kg-agent
docker compose up -d                 # neo4j, postgres, redis-stack, mcp-gateway (+ n8n if wanted)
docker compose ps                    # all healthy?

# Build the sandbox base image — the compute sandbox needs it or every run fails
docker build -t kg-sandbox:base rootfs/     # matches SANDBOX_IMAGE default
```

## 6. Build + run the UI (systemd)

```bash
cd /opt/kg-agent/ui
pnpm install --frozen-lockfile      # builds node-pty natively for node 22
pnpm baml-generate                  # generate baml_client/ (also run by build)
pnpm build                          # vinxi build → .output/
```

`/etc/systemd/system/kg-agent.service`:

```ini
[Unit]
Description=kg-agent UI (SolidStart)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=kgagent                        # a user in the `docker` group
WorkingDirectory=/opt/kg-agent/ui   # cwd must be ui/ so ../configs resolves
EnvironmentFile=/opt/kg-agent/ui/.env
Environment=PORT=3000
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/pnpm start       # vinxi start — serves .output/
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kg-agent
journalctl -u kg-agent -f
```

## 7. Embeddings backend (only if you use DataStash / retriever search)

The Data Stash pipeline needs an embedder. Two options:
- **Self-host** a `llama-server --embedding` on `:8090` (needs the GGUF model on
  disk) as its own systemd unit, and set `EMBEDDINGS_PROVIDER=local` +
  `EMBEDDINGS_LOCAL_URL=http://127.0.0.1:8090`.
- **Hosted provider** — set `EMBEDDINGS_PROVIDER` to a remote provider instead.

If you don't use DataStash search, you can skip this.

## 8. Reverse proxy + TLS

`/etc/caddy/Caddyfile`:

```
your.domain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy    # auto-provisions a Let's Encrypt cert
```

## 9. Environment reference (`ui/.env`)

Every var the server reads (`grep process.env src/`), with its localhost default:

| Var | Purpose | Default / note |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required** — all default BAML chains | — |
| `USE_MIXED_CHAINS` | `1` to use mixed-provider chains | unset = Anthropic-only |
| `OPENROUTER_API_KEY` | mixed chains + possibly embeddings | needed iff `USE_MIXED_CHAINS=1` |
| `DATABASE_URL` | Postgres (conversations) | `postgresql://postgres:password@localhost:5432/kgagent` — **override the password** |
| `MCP_GATEWAY_URL` | MCP gateway endpoint | `http://localhost:8811/mcp` |
| `NEO4J_USER` / `NEO4J_PASSWORD` | direct Neo4j driver | resolves to `bolt://localhost:7687` on host (`config/endpoints.ts:37`) |
| `COMPUTE_BACKEND` | sandbox backend | `docker` (firecracker `#78` not implemented) |
| `SANDBOX_IMAGE` | sandbox container image | `kg-sandbox:base` (built in step 5) |
| `DOCKER_BIN` | docker CLI path | `docker` |
| `EMBEDDINGS_PROVIDER` / `EMBEDDINGS_LOCAL_URL` / `EMBEDDINGS_LOCAL_MODEL` | DataStash embedder | see step 7 |
| `STACK_SECRET_SERVER_KEY` | auth (Stack Auth) | configure a real project; **do not** ship `DEV_BYPASS_AUTH=true` to prod |

> Redis is **not** a direct env connection — all Redis access is via the gateway's
> redis MCP server, so there's no `REDIS_URL` to set.

## 10. Operations

**Update / redeploy:**
```bash
cd /opt/kg-agent && git pull
cd ui && pnpm install --frozen-lockfile && pnpm build
sudo systemctl restart kg-agent
docker compose pull && docker compose up -d   # only if the gateway image moved
```

**Logs:** `journalctl -u kg-agent` (UI) · `docker compose logs -f mcp-gateway` (gateway).

**Backups:** snapshot the three named volumes — `neo4j_data`, `postgres_data`,
`redis_data` — on a schedule (Azure Disk snapshots, or `pg_dump` + `neo4j-admin
dump` + Redis RDB). These hold all conversations, the graph, and the Data Stash.

**Sandbox hygiene:** the startup reaper (#97) force-removes orphaned
`kg-sandbox=1` containers on boot; check with
`docker ps --filter label=kg-sandbox=1`. Manual reap:
`docker ps -aq --filter label=kg-sandbox=1 | xargs -r docker rm -f`.

## 11. Known gaps before this is "real prod"

- **Single instance, no HA.** In-memory run/sandbox state means no horizontal
  scale and a restart orphans in-flight runs. Externalizing that is #105 (+ a
  durable-run worker) and #78 (remote sandbox).
- **Secrets are file-based.** Upgrade path: Azure Key Vault → an
  `EnvironmentFile` populated at boot (VM managed identity), instead of a
  plaintext `ui/.env` + `configs/mcp-config.yaml`.
- **Auth.** Confirm a real Stack Auth project (or the email allow-list) is wired
  and `DEV_BYPASS_AUTH` is off.
- **No UI Dockerfile.** If you later want everything under compose, add one
  (socket mount + docker CLI in-image + native `node-pty` rebuild).

## 12. Azure niceties (optional)

- **Key Vault** for `ANTHROPIC_API_KEY` / DB passwords / the GitHub PAT, fetched
  into the systemd `EnvironmentFile` via the VM's managed identity.
- **Azure Backup** on the data disk instead of hand-rolled volume dumps.
- **cloud-init / setup script** to make the box reproducible (steps 2–8 as a
  provisioning script) — worth doing once you've validated the manual path.
