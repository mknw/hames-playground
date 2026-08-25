# Deploying to a single Azure VM (or any VPS)

> **⚠️ PRELIMINARY PLAN — not a validated runbook.** Treat every step here as a
> proposal to be checked against the box you are actually building, not as a
> procedure that has been executed end to end. It has not been rehearsed on a
> clean VM.
>
> **Secrets will be pushed to Azure later**, so keep that destination in mind
> while reading: the `app/.env` + `configs/mcp-config.yaml` files below are the
> interim shape, and the intended end state is Key Vault → an `EnvironmentFile`
> materialized at boot via the VM's managed identity (§11, §12). Do not design
> anything around the plaintext-file layout surviving.

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
                            │  127.0.0.1:3444
        ┌───────────────────▼───────────────────┐
        │  UI (SolidStart)  — systemd, on host   │  `pnpm start` (vinxi start)
        │  • shells `docker run` for sandboxes    │  needs docker CLI + node-pty
        │  • node-pty for the Shell terminal      │  cwd = app/  (resolves ../configs)
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

**Why this guide runs the UI on the host:** it shells out to `docker run -d --rm …`
for compute sandboxes (`docker-backend.server.ts:291`) and uses `node-pty` for the
Shell terminal, and a host `systemd` service gives it a native `docker` CLI and a
native `node-pty` with the least friction. That is still the deployment shape
described below.

The container route now exists as an alternative (#197): `app/Dockerfile` plus the
`app` compose service, which covers exactly those two needs — the image carries a
`docker` CLI and mounts `/var/run/docker.sock` (sandbox containers become siblings
on the host), and `node-pty` is compiled inside the image for the image's own
platform. Everything else in this guide (§4 `.env`, §6 secrets, §8 Caddy) applies
either way; the difference is that steps 6–7's `pnpm build` + `systemd` unit become
`docker compose build app && docker compose up -d app`, with Caddy proxying to the
same `127.0.0.1:3444`. See [`docs/DOCKER_COMPOSE.md`](../DOCKER_COMPOSE.md#app-the-solidstart-app-197).
Note the gap with the rest of this VM's shape: the compose `app` service
publishes `3444:3444`, which Docker binds to `0.0.0.0` and — because Docker
writes its own iptables rules — reaches the host regardless of `ufw`, unlike
every other port pinned to `127.0.0.1` in the diagram above; the container
route should rewrite that mapping to `127.0.0.1:3444:3444` or otherwise rely
on the NSG to keep 3444 off the public interface.

---

## 1. Provision the VM

- **Architecture: x86 / amd64.** This sidesteps the redis-stack arm64 SIGILL bug
  (see `docker-compose.override.yml`); on x86 the native image just works, delete
  that override.
- **Size:** start around **4 vCPU / 16 GB** (e.g. Azure `Standard_D4s_v5`). Neo4j
  (+apoc+n10s), redis-stack, Postgres, the Node server, _and_ N concurrent sandbox
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

Keep the repo layout intact — **`app/` and `configs/` must stay siblings**: the
server resolves the MCP catalog via `path.resolve(process.cwd(), '..', 'configs', …)`
with cwd = `app/` (`server-catalog.server.ts:42`).

Create the git-ignored config files with **real** values:

- **`configs/mcp-config.yaml`** — the enabled-servers list + secrets (neo4j
  password, …). Pre-provision them statically; there is no runtime
  secret-setting on a Linux host.
- **`docker-config.json`** — Docker registry auth so the gateway can pull MCP
  server images (mounted read-only into the gateway).
- **`app/.env`** — see the env table in step 9.

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
cd /opt/kg-agent/app
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
WorkingDirectory=/opt/kg-agent/app   # cwd must be app/ so ../configs resolves
EnvironmentFile=/opt/kg-agent/app/.env
Environment=PORT=3444
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
  `EMBEDDINGS_LOCAL_URL=http://127.0.0.1:8090/v1`. **The `/v1` suffix is
  required** — the value is used as `` `${baseUrl}/embeddings` ``
  (`embeddings.server.ts`), and both the code default and the compose service
  include it.
- **Hosted provider** — set `EMBEDDINGS_PROVIDER` to a remote provider instead.

If you don't use DataStash search, you can skip this.

## 8. Reverse proxy + TLS

`/etc/caddy/Caddyfile`:

```
your.domain.com {
    reverse_proxy 127.0.0.1:3444
}
```

```bash
sudo systemctl reload caddy    # auto-provisions a Let's Encrypt cert
```

## 9. Environment reference (`app/.env`)

Every var the server reads (`grep process.env src/`), with its localhost default:

| Var                                                                       | Purpose                                                                | Default / note                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                       | **Required** — every BAML chain, and the only LLM key                  | —                                                                                                                                       |
| `OPENROUTER_API_KEY`                                                      | the `openrouter` embedding provider only                               | needed iff `EMBEDDINGS_PROVIDER=openrouter`                                                                                             |
| `DATABASE_URL`                                                            | Postgres (conversations)                                               | `postgresql://postgres:password@localhost:5432/kgagent` — **override the password**                                                     |
| `MCP_GATEWAY_URL`                                                         | MCP gateway endpoint                                                   | `http://localhost:8811/mcp`                                                                                                             |
| `MCP_GATEWAY_POOL_SIZE`                                                   | warm gateway connections kept in the client pool (#120)                | `4` — leases isolate reconnects; extra concurrent calls open a short-lived overflow connection rather than queueing                     |
| `NEO4J_USER` / `NEO4J_PASSWORD`                                           | direct Neo4j driver                                                    | resolves to `bolt://localhost:7687` on host (`config/endpoints.ts:37`)                                                                  |
| `COMPUTE_BACKEND`                                                         | sandbox backend                                                        | `docker` (firecracker `#78` not implemented)                                                                                            |
| `SANDBOX_IMAGE`                                                           | sandbox container image                                                | `kg-sandbox:base` (built in step 5)                                                                                                     |
| `DOCKER_BIN`                                                              | docker CLI path                                                        | `docker`                                                                                                                                |
| `EMBEDDINGS_PROVIDER` / `EMBEDDINGS_LOCAL_URL` / `EMBEDDINGS_LOCAL_MODEL` | DataStash embedder                                                     | see step 7                                                                                                                              |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`             | **Required** — Microsoft Entra sign-in (#119)                          | from the app registration; see [`entra-setup.md`](entra-setup.md)                                                                       |
| `AUTH_SESSION_SECRET`                                                     | **Required** — HMAC key signing the auth cookies                       | `openssl rand -base64 32`                                                                                                               |
| `TOKEN_ENCRYPTION_KEY`                                                    | encrypts the per-user MSAL token cache at rest (#110)                  | HKDF-derived from `AUTH_SESSION_SECRET` when unset; **set it explicitly in prod** so the two can rotate independently                   |
| `DATA_ENCRYPTION_KEY`                                                     | **Required** — encrypts stored conversations and personal data at rest | `openssl rand -base64 32`. No fallback, by design. See the escrow warning below                                                         |
| `AUTH_REDIRECT_URI` / `AUTH_POST_LOGOUT_REDIRECT_URI`                     | OIDC redirect / post-logout URIs                                       | default to port **3444**; the redirect MUST match one registered on the app (Web platform)                                              |
| `AZURE_GRAPH_SCOPES`                                                      | override the delegated Graph scope set                                 | defaults to the full connector set; every scope must be consented under API permissions **first**, or sign-in fails                     |
| `VITE_ALLOWED_EMAILS`                                                     | email allow-list for real auth                                         | comma-separated; supports `*@domain.com`                                                                                                |
| `VITE_DEV_BYPASS_AUTH`                                                    | skips sign-in entirely                                                 | `'true'` in `.env.example`. **Must be `'false'` in prod** — and note the name: `DEV_BYPASS_AUTH` (no `VITE_` prefix) is read by nothing |

> **`DATA_ENCRYPTION_KEY` is not recoverable from the database.** It encrypts
> `conversations.title` / `conversations.context`, the `users` and
> `auth_sessions` profile columns, and the `routines` prompt. A restored dump
> without it is ciphertext forever — so back the key up **somewhere other than
> the machine holding the data**, alongside `TOKEN_ENCRYPTION_KEY`. Starting the
> app with encrypted rows present and the key absent is a deliberate hard boot
> failure (it refuses to serve rather than return empty conversations that the
> next write would overwrite), so a lost key shows up as an outage, not as
> silent data loss. Rotating it needs a re-encryption pass, not just a restart:
> the ciphertext carries a `v1.` version prefix so that pass can be lazy, but it
> has not been written yet.

> **Redis has two paths.** The agentic one goes through the gateway's redis MCP
> server (configured in `configs/mcp-config.yaml`, no app env var). The direct
> one — `redis-direct.server.ts` — reads `REDIS_HOST_DIRECT` (falling back to
> `REDIS_HOST`), `REDIS_PORT`, `REDIS_PWD` (falling back to `REDIS_PASSWORD`)
> and `REDIS_SSL`. They default to `localhost:6379` with no password, which is
> right for this single-VM shape, but set `REDIS_PWD` if you password the
> instance. There is no `REDIS_URL`.

## 10. Operations

**One-time `ui/` → `app/` rename migration** (only if this VM was deployed before
the #193 rename): the systemd unit above already assumes `app/`, but an existing
install still has the old dir, `.env` and unit paths.

```bash
cd /opt/kg-agent && git pull
mv -n ui/.env app/.env          # -n: re-running the migration must not clobber app/.env
sudo sed -i \
  -e 's#WorkingDirectory=/opt/kg-agent/ui#WorkingDirectory=/opt/kg-agent/app#' \
  -e 's#EnvironmentFile=/opt/kg-agent/ui/.env#EnvironmentFile=/opt/kg-agent/app/.env#' \
  /etc/systemd/system/kg-agent.service
sudo systemctl daemon-reload
```

Then run the **Update / redeploy** recipe below (install + build under `app/` +
restart) and confirm the service is actually up:

```bash
systemctl is-active kg-agent && journalctl -u kg-agent -n 20 --no-pager
```

Only once that restart is verified, drop the old tree — it is the rollback copy
until then:

```bash
rm -rf /opt/kg-agent/ui
```

**Update / redeploy:**

```bash
cd /opt/kg-agent && git pull
cd app && pnpm install --frozen-lockfile && pnpm build
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
  plaintext `app/.env` + `configs/mcp-config.yaml`.
- **Auth.** Confirm the Entra app registration is wired (#119) — tenant/client
  id + secret, a redirect URI registered for this host's domain, the delegated
  Graph scopes consented, `AUTH_SESSION_SECRET` set — and that
  `VITE_DEV_BYPASS_AUTH` is `'false'`. The Stack Auth keys this guide used to
  name (`STACK_SECRET_SERVER_KEY`, …) are no longer read by the app; see
  `app/.env.example`. Getting this wrong yields a deploy nobody can sign in to,
  or one anybody can.
- **Two supported run shapes.** Host `systemd` (this guide) or the `app` compose
  service (#197). The container shape has not yet been exercised on a real
  deployment — the `systemd` path is the one with mileage.

## 12. Azure niceties (optional)

- **Key Vault** for `ANTHROPIC_API_KEY` / DB passwords, fetched
  into the systemd `EnvironmentFile` via the VM's managed identity.
- **Azure Backup** on the data disk instead of hand-rolled volume dumps.
- **cloud-init / setup script** to make the box reproducible (steps 2–8 as a
  provisioning script) — worth doing once you've validated the manual path.
