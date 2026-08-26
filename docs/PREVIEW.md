# Preview deployment runbook

The procedure the owner executes to put the app in front of 5–15 colleagues on a
single Azure VM, signed in with Entra and restricted to `*@dtsc.be`.

**Relationship to [`deployment/azure-vm.md`](deployment/azure-vm.md):** that
document is the general single-VM architecture and stays the reference for _why_
the box is shaped this way — topology, the systemd run shape, the full
environment table, the known gaps. This one is the container run shape, wired
end to end and reduced to a sequence you can execute in order. Where the two
disagree about the container path, this file wins; where this file is silent,
that one is the fallback.

Everything here runs inside the VM. No Azure CLI, no Key Vault, no managed
backup — those are upgrades ([`azure-vm.md` §12](deployment/azure-vm.md)), not
prerequisites.

**What was and was not proved before this was written** is at the bottom
(§"State of this runbook"). Read it before you rely on a step.

---

## 0. Before you start

You need, and this list is the whole list:

| Thing                          | Why                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Azure subscription access      | to create the VM and its network security group                                    |
| Control of a DNS name          | Caddy's certificate is issued against it, and Entra's redirect URI is pinned to it |
| Entra admin on the DTSC tenant | to add a redirect URI and (if not already done) grant the delegated Graph scopes   |
| An `ANTHROPIC_API_KEY`         | the only LLM provider key; without it people sign in and then get no answers       |
| A password manager or vault    | to escrow two secrets **off** the VM — see §7                                      |

---

## 1. VM sizing

**`Standard_D4s_v5` — 4 vCPU / 16 GiB / 64 GiB Premium SSD, Ubuntu 24.04 LTS,
x86/amd64.**

- **x86, not Arm.** The Arm build of redis-stack SIGILLs on RediSearch vector
  operations under some hypervisors, which is the whole reason
  `docker-compose.override.yml` exists for local Apple-Silicon work. On x86 the
  native image is correct — and the production overlay never loads that file
  (§3), so nothing carries the workaround onto the VM.
- **16 GiB is not generous.** Neo4j (+apoc+n10s), redis-stack, Postgres, the
  Node server, Caddy and _N concurrent sandbox containers_ share it. The
  container build alone peaks near 2.3 GB RSS.
- **64 GiB disk.** Docker images dominate: redis-stack is ~2.7 GB and neo4j
  ~840 MB before any data.
- One instance, no HA. The app holds per-session run state, the sandbox
  attachment table and background jobs in process memory, so a restart orphans
  in-flight runs. That is a known limit (#105, #78), not a misconfiguration.

**Enable the disk encryption offered at VM creation.** Until the conversation
store is encrypted by the app (see §"What is not true yet"), disk encryption is
the _only_ thing standing between a detached disk and every stored conversation.

## 2. Firewall — network security group

Open exactly three inbound ports:

| Port  | Source       | For                                           |
| ----- | ------------ | --------------------------------------------- |
| `22`  | your IP only | SSH                                           |
| `80`  | Any          | the ACME HTTP-01 challenge, then a 301 to 443 |
| `443` | Any          | the app (TCP; add UDP too if you want HTTP/3) |

**Nothing else.** Postgres, Neo4j, Redis, the MCP gateway, doc-convert and the
app's own 3444 are all published on `127.0.0.1` by
`docker-compose.prod.yaml`, so they are reachable over SSH tunnels and from
nowhere else.

> This is worth checking rather than assuming after any compose edit. Docker
> writes its own iptables rules and a `0.0.0.0` publish reaches the host
> **regardless of `ufw`** — the NSG is then the only thing left. Run
> `docker compose config | grep -A3 ports:` and confirm every `host_ip` is
> `127.0.0.1` except Caddy's.
>
> That is Compose's _rendered intent_, which is not the same as what the kernel
> ended up listening on. Prove it at the host level too, once the stack is up
> (§8 step 1a): `ss -ltnp` must show nothing on a non-loopback address except
> `22`, `80` and `443`. Better still, run one port scan from off the box —
> that is the only check that tests the NSG rather than the VM's own view of
> itself.

## 3. Provision the box

```bash
# Docker Engine + compose plugin (needs Compose >= 2.24 for this stack)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # then log out and back in
docker compose version              # must be >= 2.24

sudo git clone https://github.com/mknw/hames-playground /opt/kg-agent
sudo chown -R "$USER":"$USER" /opt/kg-agent      # NOT optional — see below
cd /opt/kg-agent
```

**The `chown` is load-bearing.** `sudo git clone` leaves the tree `root:root`,
and everything after this point runs as you: writing `.env`, `mkdir -p backups`
inside `scripts/backup-preview.sh` (§9, and its cron entry, which is installed
as your user), and `git checkout <good-sha>` in the rollback (§10). Skip it and
those fail with a permission error at the worst possible moment rather than here.

Keep the repo layout intact: `app/` and `configs/` must stay siblings.

Three git-ignored files have to exist before first boot:

1. **`configs/mcp-config.yaml`** — connection parameters for the MCP servers.
   Write it explicitly, from §3a below. **Do not copy
   `configs/template.mcp-config.yaml`** — that template is the development set.
2. **`docker-config.json`** — Docker registry auth, mounted read-only into the
   gateway so it can pull MCP server images.
3. **`.env`** — the one below.

```bash
cp .env.production.example .env
chmod 600 .env
$EDITOR .env       # every placeholder; the file explains each variable
```

`.env` at the **repo root** is the single source of runtime configuration. It is
read twice, deliberately: Compose reads it for `${VAR}` substitution (that is how
`COMPOSE_FILE`, the two database passwords and `APP_DOMAIN` reach the overlay),
and the `app` service loads the same file as its `env_file`. There is no
`app/.env` on this host — the overlay pins the app's `env_file` to the root file
so a stray one cannot contribute anything.

The two lines at the top of `.env` are what make the bring-up a single command:

```
COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml
COMPOSE_PROFILES=app
```

Setting `COMPOSE_FILE` also stops Compose auto-loading
`docker-compose.override.yml`, so the laptop-only Arm redis workaround can never
apply here.

### 3a. The agent-reachable tool surface

Everything the MCP gateway lists reaches an agent controller: the `general`
agent passes `tools.all` — literally every listed tool
(`app/src/lib/harness-patterns/tools.server.ts:41-48`) — into one loop
(`app/src/lib/harness-client/agents/general.server.ts:37,44,51-52`). An agent's
declared `servers: [...]` array is display metadata for the agent picker
(`AgentSelector.tsx:148,161`); **it filters nothing**. So the gateway's enabled
set _is_ the preview's tool surface, and it has to be chosen rather than
inherited.

**Two things decide it, and only one of them is the control.**

`docker-compose.prod.yaml` replaces the base file's `--enable-all-servers` with
an explicit allow-list:

```
--servers=neo4j-cypher,fetch,web_search,context7,memory
```

That is the control. `--enable-all-servers` means _every server in the
catalog_, so `configs/mcp-config.yaml` is a **connection-parameter file, not an
enablement list** — deleting an entry from it changes nothing while the flag is
set. Verified on this stack, same config file both times: with the flag, nine
servers and 134 tools; with the allow-list, five servers and 17 tools. A trimmed
config file on its own would read like protection and match nothing.

Write `configs/mcp-config.yaml` with exactly the five, so the file and the
allow-list say the same thing and nobody has to reconcile them later:

```yaml
# /opt/kg-agent/configs/mcp-config.yaml — preview. Deliberately NOT a copy of
# configs/template.mcp-config.yaml (that is the development set).
neo4j-cypher:
  enabled: true
  uri: bolt://neo4j:7687
  username: neo4j
  password: <the NEO4J_PASSWORD you set in .env>
  database: neo4j
  read_only: false

fetch:
  enabled: true

web_search:
  enabled: true

context7:
  enabled: true

memory:
  enabled: true
```

**What is left out, and why:**

| Omitted               | Why                                                                                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`               | 45 tools including `scan_keys` and `json_get`. Data Stash keys are `stash:doc:{sessionId}:{docId}` (`app/src/lib/document-store.server.ts:156-161`) — scoped by **session, never by owner** — so this is a read of every colleague's uploaded documents from any signed-in account's controller turn |
| `database-server`     | arbitrary SQL over the app's own Postgres, i.e. `conversations.context`, which is plain `JSONB` holding verbatim tool results (`app/src/lib/db/client.server.ts:38`)                                                                                                                                 |
| `rust-mcp-filesystem` | 24 tools with `allow_write: true`. No registered agent uses them                                                                                                                                                                                                                                     |
| `playwright`          | a browser with `browser_evaluate` / `browser_run_code`. A development and E2E tool; no registered agent uses it                                                                                                                                                                                      |
| `github`              | never in the tracked template, and the allow-list makes a stray block inert anyway — but check for it explicitly, below                                                                                                                                                                              |

**Dropping `redis` costs nothing, on one condition.** Uploads, ingestion and
search do not use the redis MCP server: `STASH_DIRECT_REDIS='1'` in `.env`
routes the whole Data Stash app path through a direct `ioredis` connection
(`app/src/lib/redis-direct.server.ts:286-288`), and the retriever's backend is
an app-side object, not a gateway tool. **Leave that variable set.** Unset it
and the stash falls back to the gateway path you just removed.

**Pre-launch check — the GitHub MCP server and its token (#261 P0-2).** The
tracked template carries no `github:` block, so a from-scratch provision is
clean. The hazard is the realistic move: copying a working development
`mcp-config.yaml` onto the VM. Before inviting anyone:

```bash
grep -n 'github' configs/mcp-config.yaml      # must return nothing
grep -rnE 'ghp_|github_pat_' configs/ .env    # must return nothing
```

The allow-list is the second layer here — a `github:` block that survives is
never started, verified against a config that still had one. **Revoking the
classic PAT that #261 confirmed live is a separate action and is not covered by
anything in this runbook**: it is the owner's, on github.com, and it stays open
in #261 until done. Nothing on this VM ships it; that is not the same as it
being dead.

## 4. DNS

Create an **A record** for `APP_DOMAIN` pointing at the VM's public IP, and wait
for it to resolve **before** the first bring-up:

```bash
dig +short preview.example.com     # must return the VM's public IP
```

Caddy requests the certificate the moment it starts. If the name does not yet
resolve, the ACME challenge fails, Caddy backs off and retries, and repeated
failures count against Let's Encrypt's rate limits. DNS first, then boot.

## 5. Entra app registration — the exact changes

Use the existing **DTalk v2** registration (`docs/deployment/entra-setup.md` has
the id) or a new single-tenant one. Three changes, in the Entra admin center:

**a. Add the redirect URI.** _Authentication → Add a platform → Web → Redirect
URIs_:

```
https://<APP_DOMAIN>/api/auth/callback
```

That path is not a convention — it is the route file
`app/src/routes/api/auth/callback.ts`, and it is the default the app builds when
`AUTH_REDIRECT_URI` is unset (`app/src/lib/auth/entra-config.server.ts:39`, with
`localhost:3444` substituted for the host). It must match **character for
character**, including the scheme, the absence of a trailing slash and the
absence of a port. Keep the existing `http://localhost:3444/api/auth/callback`
entry — Entra allows several, and dev still needs it.

Set the same value in `.env` as `AUTH_REDIRECT_URI`. The app sends whatever is
in the variable; Entra rejects the sign-in if the registration does not carry it.

**b. Post-logout URI.** Set `AUTH_POST_LOGOUT_REDIRECT_URI` in `.env` to

```
https://<APP_DOMAIN>/auth/signin
```

(the route `app/src/routes/auth/signin.tsx`, default at
`entra-config.server.ts:40`). Front-channel logout with the v2 endpoint needs no
separate registration.

**c. Consent every delegated Graph scope, before anyone signs in.** _API
permissions → Microsoft Graph → Delegated_: `User.Read`, `email`, `Mail.Read`,
`Mail.Send`, `Calendars.ReadWrite`, `Files.Read.All`, `Sites.Read.All`, then
**Grant admin consent**. The full set is requested at sign-in
(`DEFAULT_GRAPH_SCOPES`, `entra-config.server.ts`), and **a scope that is
requested but not consented fails the entire sign-in**, not just the connector
that wanted it. If a scope turns out to be blocked, trim it via
`AZURE_GRAPH_SCOPES` in `.env` and restart — no code change.

Also confirm the client secret in `.env` is the secret **value**, not its id, and
note its expiry somewhere you will see it.

Detail and rationale: [`deployment/entra-setup.md`](deployment/entra-setup.md).

## 6. Boot

**Preflight, one command.** The env template ships `preview.example.com` and
`ops@example.com` pre-filled in four places, and two of them —
`AUTH_REDIRECT_URI` and `AUTH_POST_LOGOUT_REDIRECT_URI` — are the ones an
operator who edits `APP_DOMAIN` most easily forgets. They do not fail loudly:
unset, they silently default to `http://localhost:3444/…`
(`app/src/lib/auth/entra-config.server.ts:39-40,119-121`), and left at the
placeholder they surface as an opaque Entra error at §8 step 4 rather than as a
configuration error here.

```bash
grep -n 'example\.com' .env       # must return nothing
```

```bash
cd /opt/kg-agent

# The sandbox base image. Not optional if anyone will use a sandbox agent —
# without it every sandbox run fails, and the failure is at run time, not boot.
docker build -t kg-sandbox:base rootfs/

# The whole stack: app, Postgres, Neo4j, redis-stack, MCP gateway, doc-convert,
# and Caddy in front. n8n is deliberately parked behind its own profile.
docker compose up -d --build
```

That is the one command. Watch it come up:

```bash
docker compose ps                     # every service running; app healthy
docker compose logs -f caddy          # "certificate obtained successfully"
docker compose logs -f app
```

First boot takes several minutes: the image build dominates, then Neo4j needs
~30 s and Caddy needs an ACME round-trip.

Two things to confirm before you invite anyone:

```bash
# 1. Nothing but Caddy is on a public interface.
docker compose ps --format '{{.Service}}\t{{.Ports}}'

# 2. The app is serving, and the bypass is off.
curl -s https://<APP_DOMAIN>/api/health          # {"status":"ok",...}
docker compose exec app printenv VITE_DEV_BYPASS_AUTH   # false
```

> The `false` above is belt-and-braces, not the control. The dev sign-in bypass
> is gated on `import.meta.env.DEV`, which Vite replaces with `false` when this
> image is built, so a production image ignores the variable entirely and
> `app/src/lib/auth/dev-bypass.ts` warns at module load if one is present. The
> control that actually keeps strangers out is the allow-list — and it is
> fail-closed: `VITE_ALLOWED_EMAILS` unset rejects **every** account
> (`app/src/lib/auth/allowList.ts`).

## 7. Escrow the two keys — do this now, not later

```bash
grep -E '^(AUTH_SESSION_SECRET|TOKEN_ENCRYPTION_KEY)=' .env
```

Put both values in a password manager or Key Vault, **outside this VM and
outside its backups**. `user_tokens` is AES-256-GCM ciphertext keyed by
`TOKEN_ENCRYPTION_KEY` (HKDF-derived from `AUTH_SESSION_SECRET` when unset). If
the VM is what you lose, a restored database without these values is
undecryptable — the backup script deliberately does not copy `.env`, because a
backup carrying both the ciphertext and its key protects nothing.

**It becomes three keys the day PR #260 lands.** `DATA_ENCRYPTION_KEY` is the
one with the expensive rotation: it makes every stored conversation unreadable,
not just the token cache, and it has no fallback to derive from. Escrow it here
with the other two the moment you set it (§"What is not true yet").

## 8. Smoke checklist

Run all of it yourself before inviting anyone, from a browser that has never
seen the host.

Two of the checks are multi-line and neither has an in-app symptom when it
fails, so they come first, on the box:

```bash
# 1a. What the kernel is actually listening on (§2). Compose's rendered view is
#     intent; this is the result. Nothing on a non-loopback address but 22/80/443.
ss -ltnp

# 1b. The agent-reachable tool surface (§3a). Nothing else asserts this — a
#     regression here is invisible in the app and looks like a working deploy.
docker compose logs mcp-gateway | grep -E 'Those servers are enabled|tools listed'
```

Step 1b must print exactly:

```
- Those servers are enabled: neo4j-cypher, fetch, web_search, context7, memory
> 17 tools listed in …
```

Order varies; the **set** and the **count** do not. `redis`,
`database-server`, `rust-mcp-filesystem`, `playwright` or `github` in that line
means the overlay's `--servers` allow-list did not apply — stop and fix it
before anyone signs in. A count materially above 17 means the same thing (the
exact number tracks the pinned MCP images, so treat a ±1 drift after an image
bump as a re-check, not an alarm; 134 is the un-narrowed surface).

Two things that are _not_ failures here: the gateway prints those lines only at
startup, so on a long-running box `docker compose restart mcp-gateway` first if
the grep comes back empty; and
`Warning: Secret 'neo4j-cypher.password' not found` is expected — the catalog
declares the password both as a secret and as a config-substituted env var
(`configs/custom-catalog.yaml:13-23`), and it is the latter that is used.

| #   | Step                                                                                                       | Pass looks like                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `curl -sI http://<APP_DOMAIN>/`                                                                            | `301` to `https://` — Caddy's automatic redirect                                                                                                                                                                                         |
| 2   | `curl -s https://<APP_DOMAIN>/api/health`                                                                  | `{"status":"ok","uptimeSeconds":…}` over a **valid** certificate (no `-k`)                                                                                                                                                               |
| 3   | Open `https://<APP_DOMAIN>/` **in a browser**, private window                                              | lands on `/auth/signin`, no session. Use a browser, not `curl`: the redirect is client-side, so `curl /` returns `200 text/html` — that is the SSR shell, not a session                                                                  |
| 4   | Click **Sign in with Microsoft**, use your `@dtsc.be` account                                              | Entra prompt → back to `/` signed in. A redirect-URI mismatch shows as an Entra error page, not an app error                                                                                                                             |
| 5   | Sign in with an account **outside** the allow-list (a personal MS account, or temporarily narrow the list) | lands on `/auth/access-denied` with no session. **Do not skip this** — it is the only test of the gate itself                                                                                                                            |
| 6   | Send a message in a chat and wait for a full answer                                                        | tokens stream in; the turn completes. Failure here is usually `ANTHROPIC_API_KEY`                                                                                                                                                        |
| 7   | Ask something that touches the graph, then open the graph panel                                            | nodes render. Failure here is usually the Neo4j password (§11)                                                                                                                                                                           |
| 8   | Upload a document in the Data Stash panel                                                                  | it appears and can be downloaded. Semantic **search** over it is expected to be unavailable — see §11                                                                                                                                    |
| 9   | Sign out                                                                                                   | back at `/auth/signin`, and the session is gone (revisiting `/` does not restore it)                                                                                                                                                     |
| 10  | `docker compose logs app \| grep -Ei 'dev-bypass\|warn'`                                                   | no dev-bypass warning. **`-E` is not optional**: a basic `grep` treats `\|` as a literal pipe character, so `grep -i "dev-bypass\|warn"` matches nothing and exits 1 against input that _does_ carry the warning — which reads as a pass |

> **`curl https://<APP_DOMAIN>/` answering `200` with HTML is not evidence that
> anything is unprotected.** Every route serves the same SolidStart shell; the
> gate is on the server actions behind it (`'use server'` modules each carry
> their own authenticated-and-allow-listed check) and on the session cookie.
> Step 5 is the test of the gate. Step 3 only confirms the app renders.

§9's backup is **optional for this alpha** (see the box at the top of it). If
you do run it, run its restore drill once as well — a backup nobody has restored
is a hypothesis.

## 9. Backups — optional for this alpha

> **Owner decision, 2026-08-25: backups are not required to open this preview.**
> The database is spun from scratch and the data in it is disposable. What
> follows is a working extra, not a gate. Revisit it before anything outgrows
> "alpha"; until then a lost VM means a lost preview, and that is an accepted
> outcome rather than an oversight.
>
> **What this script is not.** It writes to `/opt/kg-agent/backups`, on the same
> disk as the data it copies, and **nothing moves it off the box**. It protects
> against a bad migration, a wrong `DELETE`, or a corrupted volume. It does not
> protect against losing the VM — which is the threat §1 and §7 are about, and
> the one the key escrow in §7 exists for. Off-box copies (a blob upload, an
> `rsync`, an Azure Disk snapshot schedule) are deliberately not built here.
> Say it that way to anyone who asks whether their conversations are safe;
> `PREVIEW-WELCOME.md` says it that way to the preview circle.

`scripts/backup-preview.sh` writes a timestamped directory under `backups/`
containing a Postgres dump, a Neo4j dump and a Redis RDB, verifies each one, and
deletes directories older than seven days. It uses docker and coreutils and
nothing else.

```bash
./scripts/backup-preview.sh              # back up, verify, rotate
./scripts/backup-preview.sh --no-neo4j   # skip the step that has downtime
```

**Neo4j is stopped for its dump, and the graph is unavailable for about 1.5–2
minutes** — measured, not estimated: ~10 s for stop + dump + start, then ~80 s
before Neo4j's healthcheck goes green again. Almost all of the window is Neo4j's
own startup, so it does not shrink with a small graph. Neo4j Community has no
online backup (`neo4j-admin database backup` is Enterprise), and copying a live
store directory produces a file that restores _sometimes_ — a short scheduled
outage is the honest trade. Schedule it when nobody is using the app; use
`--no-neo4j` for an ad-hoc run that must not interrupt anyone.

**The script will not leave the graph down quietly.** A failed dump or a Ctrl-C
restarts Neo4j from an `EXIT` trap, best-effort, so the already-visible failure
keeps the screen. On the successful path it does the opposite: it starts Neo4j,
polls the service's own healthcheck for up to `NEO4J_RESTART_TIMEOUT` seconds
(default 180 — the measured startup is ~80), and **aborts non-zero with `THE
GRAPH IS DOWN`** if it never goes healthy. A restart that fails there used to be
swallowed and followed by a green MANIFEST; the run now stops so somebody looks
at it.

Install the cron entry as the user in the `docker` group:

```cron
MAILTO=you@dtsc.be
# /opt/kg-agent — nightly at 03:30 local time.
# stdout to the log; stderr deliberately NOT redirected, so cron mails you the
# failure and only the failure.
30 3 * * * cd /opt/kg-agent && ./scripts/backup-preview.sh >> /var/log/kg-agent-backup.log
```

```bash
crontab -e                                    # paste the lines above
sudo touch /var/log/kg-agent-backup.log && sudo chown "$USER" /var/log/kg-agent-backup.log
```

> **`>> log 2>&1` is the version that fails silently.** With stderr in the log
> too, cron has no output, sends no mail, and a backup that stopped working
> stops working quietly — the failure is visible only to whoever thinks to read
> a log about a job they believe is fine. The form above keeps the progress
> lines in the log and lets the `FAILED:` line reach you.
>
> If the box has no MTA, cron mail goes nowhere either. The fallback needs no
> mail: a run that does not finish leaves an `INCOMPLETE` marker in its output
> directory, so one command tells you whether the last week is sound —
>
> ```bash
> ls -d backups/*/ | tail -7 ; find backups -name INCOMPLETE
> ```
>
> — and any path printed by the `find` is a run that did not complete.

### Verifying a backup

The script already verifies at capture time and records the verdicts in
`MANIFEST`: the Postgres archive is parsed back with `pg_restore --list` and must
contain `conversations` table data, and the Redis file must carry the `REDIS`
magic header. The Neo4j dump is only checked for being non-empty, which the
manifest says plainly — there is no offline integrity check for that format.

So the Neo4j half is proved by **restoring it**, and if you intend to rely on
these files at all, that drill is the thing to run once on this VM:

```bash
BK=backups/<timestamp>

# 1. Postgres — restore into a scratch database and count what came back.
docker compose exec -T postgres createdb -U postgres restorecheck
docker compose exec -T postgres pg_restore -U postgres -d restorecheck --no-owner < "$BK/postgres.dump"
docker compose exec -T postgres psql -U postgres -d restorecheck -c 'select count(*) from conversations;'
docker compose exec -T postgres dropdb -U postgres restorecheck

# 2. Neo4j — load into a scratch VOLUME, never over the live one.
#    Create it explicitly: `docker run -v <name>:/data` auto-creates a volume, so
#    a typo here would silently seed an empty one and fail further down.
docker volume create neo4j_restorecheck
docker run --rm --user root -v neo4j_restorecheck:/data -v "$PWD/$BK":/backups \
  --entrypoint sh neo4j:5.26 -c \
  'neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true'
docker run -d --name neo4j-restorecheck -v neo4j_restorecheck:/data \
  -e NEO4J_AUTH=neo4j/restorecheck neo4j:5.26
# Poll rather than guess: a fixed `sleep 30` is short on a busy box (~45 s was
# needed once) and the resulting timeout reads as a bad backup. Bounded at 2
# min, so a genuinely broken restore stops instead of spinning.
for i in $(seq 1 24); do
  docker exec neo4j-restorecheck cypher-shell -u neo4j -p restorecheck \
    'MATCH (n) RETURN count(n);' 2>/dev/null && break
  [ "$i" = 24 ] && docker logs --tail 30 neo4j-restorecheck
  sleep 5
done
docker rm -f neo4j-restorecheck && docker volume rm neo4j_restorecheck

# 3. Redis — seed a scratch volume, then let redis-stack start on it normally.
docker volume create redis_restorecheck
docker run --rm -v redis_restorecheck:/data -v "$PWD/$BK":/seed alpine \
  cp /seed/redis.rdb /data/dump.rdb
docker run -d --name redis-restorecheck -v redis_restorecheck:/data redis/redis-stack:7.4.0-v8
sleep 10 && docker exec redis-restorecheck redis-cli DBSIZE
docker rm -f redis-restorecheck && docker volume rm redis_restorecheck
```

> **The Redis step must start the redis-stack image with its own entrypoint** —
> seed the volume and let it boot, rather than overriding the command with a
> bare `redis-server`. The snapshot carries RediSearch AUX data, and a Redis
> without the modules loaded refuses it outright: `The RDB file contains AUX
module data I can't load: no matching module 'scdtype00'`, then exits 1. This
> is not theoretical — it is what the first draft of this command did.

Restoring **onto the live stack** is the same commands without the scratch names,
with `docker compose stop app` first so nothing writes underneath you.

**What a restore does not bring back:** `AUTH_SESSION_SECRET` and
`TOKEN_ENCRYPTION_KEY` (§7). Restore the database onto a rebuilt VM with
different values and every user's stored Microsoft token cache is lost — which
degrades gracefully (people sign in again) but silently breaks background runs
until they do. Once PR #260 lands, `DATA_ENCRYPTION_KEY` joins that list and
stops degrading gracefully: without it the restored conversations are ciphertext
nothing can read, and the app refuses to boot rather than pretending otherwise.

## 10. Rollback

**A bad app release** — the data tier is untouched, so this is a rebuild:

```bash
cd /opt/kg-agent
git log --oneline -5                      # find the last good commit
git checkout <good-sha>
docker compose up -d --build app          # Caddy and the data tier keep running
docker compose logs -f app
```

> **This stops being data-safe once PR #260 lands.** Today the app tier is
> stateless with respect to the database, so checking out an older commit is a
> rebuild and nothing more. After conversation encryption at rest ships,
> `conversations.context` holds ciphertext the pre-#260 code cannot read, and a
> checkout that crosses that commit is a data migration wearing a rollback's
> clothes. Re-read this section against `docs/data-privacy/plan.md` when #260
> merges.

Faster, if the previous image is still on the box: `docker images kg-agent-app`,
then `docker tag <old-id> kg-agent-app:local && docker compose up -d app` — no
build. Tag a known-good image (`docker tag kg-agent-app:local kg-agent-app:rollback`)
right after a successful deploy and this stays available.

**A bad configuration** — `.env` edits need only a recreate:
`docker compose up -d --force-recreate app caddy`.

**Bad data** — only an option if you took a backup, which §9 says is optional
for this alpha. If you did: stop the app first, restore per §9, then start it.

```bash
docker compose stop app
# …restore…
docker compose start app
```

**Full stop** — `docker compose down` keeps every named volume (that is the
default; `-v` is what destroys them, and it destroys Caddy's certificates too).
`docker compose up -d` brings it all back.

**Emergency lockout** — to cut off access without losing anything, stop Caddy:
`docker compose stop caddy`. The app keeps running on `127.0.0.1:3444` for
diagnosis, and nothing is reachable from outside.

## 11. Known limitations of this preview

- **Semantic search over uploaded documents will not work.** The Data Stash
  embedder defaults to a `llama-server` on port 8090 that this stack does not
  run; the base compose points the app at `host.docker.internal:8090`, and on the
  VM nothing is listening there. Upload, storage, download and conversion all
  work — only vector search over the uploads is dead. Fix it by running a
  `llama-server --embedding` on the VM as its own systemd unit and setting
  `EMBEDDINGS_LOCAL_URL` (the `/v1` suffix is required), or by pointing
  `EMBEDDINGS_PROVIDER` at a hosted embedder. See
  [`azure-vm.md` §7](deployment/azure-vm.md) and
  [`DATA_STASH.md`](DATA_STASH.md).
- **Neo4j's password is set once.** `NEO4J_AUTH` is applied only when the data
  volume is empty, so changing `NEO4J_PASSWORD` in `.env` after first boot
  changes what the app sends and not what the database expects — the symptom is
  an authentication failure on the graph panel with no other clue. Change it in
  both places:
  `docker compose exec neo4j cypher-shell -u neo4j -p <old> "ALTER CURRENT USER SET PASSWORD FROM '<old>' TO '<new>'"`,
  then update `.env` and `docker compose up -d --force-recreate app`.
- **Postgres has the same one-shot trap.** `POSTGRES_PASSWORD` is applied only
  when the data volume is initialised. It only bites on a reused volume, which
  a from-scratch preview does not have — but it is the same footgun, and worth
  knowing before you reuse a volume from an earlier attempt.
- **No off-box backups.** `backups/` sits on the VM's own disk and nothing
  copies it away (§9). Losing the VM loses the data with it. Accepted for this
  alpha by owner decision; not a posture to carry past it.
- **The `memory` MCP server is one graph for everybody.** It is backed by a
  single named volume (`claude-memory:/app/dist`,
  `configs/custom-catalog.yaml:88-104`) with no per-user or per-session
  scoping, so anything an agent writes there is readable by every other
  signed-in user's agent. It is in the preview's server set (§3a) because
  `general` advertises it; nothing in the preview writes to it on its own.
- **The sandbox containers are not hardened.** They run as root with no
  capability drops, no read-only root and no seccomp profile, and only the
  strict egress profile is actually enforced — the other profile names fall
  through to unrestricted outbound. That is deferred work (#116), not a
  configuration you can turn on here. It matters for who you invite, not for how
  you deploy.
- **One instance.** A restart orphans in-flight runs (#105, #78).
- **Docker socket.** The app container mounts `/var/run/docker.sock` because
  sandbox agents shell out to `docker run`. That mount is root-equivalent on the
  host. If nobody in the preview needs sandbox agents, dropping the mount (and
  adding `USER node` to `app/Dockerfile`) removes the most privileged thing on
  the box — they go together.
- **No app-level encryption of conversations yet.** See §"What is not true yet".

## What is not true yet — lands with in-flight work

Three things a reader might reasonably assume are in place, and are not. None
is required to deploy. The two that need a variable have one reserved and
commented in `.env.production.example`, ready for the day the work lands.

| Claim                                            | Reality today                                                                                                                                                                                                                      | Lands with                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Conversations are encrypted at rest."           | `conversations.context` is plain `JSONB` (`app/src/lib/db/client.server.ts:38`) — the full event stream, including verbatim tool results. Only the per-user Microsoft token cache is encrypted. Disk encryption is the only layer. | **PR #260, open.** The key is `DATA_ENCRYPTION_KEY` (`app/src/lib/db/crypto.server.ts:73` **on that branch**, not this one) — deliberately no fallback to `AUTH_SESSION_SECRET` or `TOKEN_ENCRYPTION_KEY`, and encrypted rows present with no key is a hard boot failure. Escrow it with the other two (§7) the day it lands, and re-read §10 |
| "Names are pseudonymised before prompts go out." | The roster-based substitution modules exist and are tested, but nothing in production imports them — verified by grep, and independently mapped path-by-path in PR #258. Every egress path is unhooked.                            | a decision that has not been taken yet (see PR #258 and `docs/plan/graph-pseudonymisation.md`)                                                                                                                                                                                                                                                |
| "Inference runs on our own hardware."            | Every BAML chain routes to Anthropic. The self-hosted Verda route is written but unmerged, and even with it on, four roles stay on Anthropic — so it is a routing switch, never a "nothing leaves the building" claim.             | **PR #263, open.** `USE_VERDA_INFERENCE='1'` re-points the controller / actor / critic / synthesizer only; router, describe, screen and planner stay on Anthropic                                                                                                                                                                             |

[`PREVIEW-WELCOME.md`](PREVIEW-WELCOME.md) says all of this to the preview
circle in plain language. **Keep the two documents in step**: if you deploy
before that first row changes, the welcome note must not promise encryption.

## State of this runbook

Written against `origin/main` and rehearsed as far as a laptop allows. What that
means concretely:

**Verified by execution on a laptop**

- The merged production configuration (`docker compose config`): every data-tier
  port on `127.0.0.1`, both passwords substituted into the services _and_ into
  the app's `DATABASE_URL`, a stray `app/.env` correctly contributing nothing,
  n8n parked, no Arm redis override loaded, and the gateway's merged `command:`
  carrying `--servers=…` with no `--enable-all-servers` left in it.
- **§3a's tool surface, by running the gateway three ways against the same
  catalog.** `--enable-all-servers` with a five-server `mcp-config.yaml`:
  _nine_ servers enabled, 134 tools — the config file does not narrow anything,
  which is why the allow-list and not the config file is the control.
  `--servers=neo4j-cypher,fetch,web_search,context7,memory`: five servers, 17
  tools. The same allow-list against the development `mcp-config.yaml` that
  still carries a `github:` block: still five servers, still 17 tools, no
  `github`.
- Fail-closed substitution: removing `POSTGRES_PASSWORD` aborts with
  `required variable POSTGRES_PASSWORD is missing a value` rather than silently
  falling back to the base file's `password`.
- The single-command path — `COMPOSE_FILE` + `COMPOSE_PROFILES` in the root
  `.env` making a bare `docker compose` address the right seven services, with
  the app's runtime variables arriving from that same file.
- The image building through this compose path, booting, and passing its
  healthcheck.
- Caddy in front of it: HTTPS `200` on `/api/health` over HTTP/2, `80 → 443`
  redirect, the response headers, HTTP/3 advertised. The certificate came from
  Caddy's **internal CA** (the site name was `localhost`), so ACME itself is
  untested.
- The backup script end to end against a live stack — `pg_dump` +
  `pg_restore --list` verification, the Redis `SAVE` + copy + magic-header check,
  the manifest, and rotation.
- The **whole script including its Neo4j branch**, against a live stack: 9.5 s
  wall clock, the graph back up on its own afterwards, and the resulting dump
  loaded into a scratch volume and queried — 49 nodes live, 49 nodes restored.
  This is what the 1.5–2 minute figure above was measured from.
- The Neo4j path was also proved independently against a throwaway instance
  (seed a node → stop → dump → load into a fresh volume → start → query). That
  run is where §9's Redis restore command was corrected: the first draft started
  a bare `redis-server`, which refuses the snapshot outright because it carries
  RediSearch AUX data.

**Not verified, and only a real VM can**

ACME issuance against a public name; the Entra sign-in and the allow-list
rejection (no tenant is reachable from a laptop); an end-to-end chat turn
against a real `ANTHROPIC_API_KEY`; the cron entry; and every claim about Azure
NSG behaviour. Treat §5 and steps 4–7 of §8 as the parts to walk through slowly.

One local result that is **not** a finding about the VM: running redis-stack
natively on Apple Silicon dies with `Illegal instruction` on the RediSearch
module. That is the arm64 defect `docker-compose.override.yml` exists for, it
reproduces with or without these changes, and it is why §1 says x86.
