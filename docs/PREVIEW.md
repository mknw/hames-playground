# Preview deployment runbook

The procedure the owner executes to put the app in front of 5–15 colleagues on a
single Azure VM, signed in with Entra and restricted to `*@contoso.com` (set
`VITE_ALLOWED_EMAILS` to the real domain when deploying).

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

**One runbook, any provider.** [ADR-0008](adr/0008-deployment-guidance-is-provider-neutral.md)
makes this guidance provider-neutral: which provider, how many hosts and which
environments a deployment has are its operator's decisions, recorded outside
this repository. §§0–11 describe **one environment on one VM** that builds its
own image, with Azure as the worked example where a step is
provider-specific. §12 lists what a second environment adds, including what
must change before two of them can share a box, and §13 how a deploy and a
promotion work once CI builds the images. §14 is the same single-environment
procedure as a script, `scripts/bootstrap-vps.sh`, for an Ubuntu VPS from any
provider, with the host hardening and an anti-lockout procedure.

---

## 0. Before you start

You need, and this list is the whole list:

| Thing                             | Why                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Azure subscription access         | to create the VM and its network security group                                    |
| Control of a DNS name             | Caddy's certificate is issued against it, and Entra's redirect URI is pinned to it |
| Entra admin on the company tenant | to add a redirect URI and (if not already done) grant the delegated Graph scopes   |
| An `ANTHROPIC_API_KEY`            | the only LLM provider key; without it people sign in and then get no answers       |
| A password manager or vault       | to escrow three secrets **off** the VM — see §7                                    |

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

**Enable the disk encryption offered at VM creation.** The app now encrypts the
conversation store and the personal-data columns itself (#260, §7), so this is
no longer the only layer — but it is the one that covers everything the
application-level key does not: the Neo4j store, the Data Stash volume, the
`backups/` directory and `.env` itself.

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

sudo git clone https://github.com/mknw/hames-playground /opt/hames
sudo chown -R "$USER":"$USER" /opt/hames      # NOT optional — see below
cd /opt/hames
```

**The `chown` is load-bearing.** `sudo git clone` leaves the tree `root:root`,
and everything after this point runs as you: writing `.env`, `mkdir -p backups`
inside `scripts/backup-preview.sh` (§9, and its cron entry, which is installed
as your user), and `git checkout <good-sha>` in the rollback (§10). Skip it and
those fail with a permission error at the worst possible moment rather than here.

Keep the repo layout intact: `app/` and `configs/` must stay siblings.

Three files have to exist before first boot:

1. **`configs/mcp-config.yaml`** — connection parameters for the MCP servers.
   Write it explicitly, from §3a below. **Do not copy
   `configs/template.mcp-config.yaml`** — that template is the development set.
2. **`docker-config.json`** — already in the clone: it is tracked, not
   git-ignored. Mounted read-only into the gateway, it sets the gateway's
   `dynamic-tools` feature to `"disabled"`, so the gateway's own management
   tools (`mcp-find`, `mcp-add`, `mcp-exec`, …) never reach an agent (#412,
   #420). Keep the `features` block: without it the gateway turns them back on.
   **Never put registry credentials in this file**, which is tracked in a
   public repo. The pinned gateway does not read `auths` from it for its pulls
   anyway. If a server image is private, run `docker login` and
   `docker pull <image>` on the host, so the credentials stay in your own
   `~/.docker/config.json`, outside the repo. The gateway starts catalog
   servers with `--pull never` and uses the image the daemon already has. See
   [`deployment/azure-vm.md` §3](deployment/azure-vm.md#3-code--configs).
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
(`packages/harness-patterns/tools.server.ts:111,130`) — into one loop
(`packages/agents/agents/general.server.ts:47,57,63`). An agent's
declared `servers: [...]` array is display metadata for the agent picker
(`AgentSelector.tsx:182,195`); **it filters nothing**. So the gateway's enabled
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
# /opt/hames/configs/mcp-config.yaml — preview. Deliberately NOT a copy of
# configs/template.mcp-config.yaml (that is the development set).
neo4j-cypher:
  enabled: true
  uri: bolt://neo4j:7687
  username: neo4j
  password: ${NEO4J_PASSWORD} # filled from .env by the `mcp-config` render service
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

| Omitted               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`               | 45 tools including `scan_keys` and `json_get`. Data Stash keys are `stash:doc:{sessionId}:{docId}` (`packages/harness-patterns/stash/document-store.server.ts:145-146`) — scoped by **session, never by owner** — so this is a read of every colleague's uploaded documents from any signed-in account's controller turn                                                                                                                                                                                                                           |
| `database-server`     | arbitrary SQL over the app's own Postgres, across every user's rows. `conversations.context` is no longer plaintext — `conversations.server.ts:205` writes it through `encryptJsonb` and `:102`/`:317` read it back (#260) — so a raw `SELECT` returns envelopes rather than transcripts. What stays cleartext is what SQL has to scope and order by: `id`, `user_id`, `agent_id`, both timestamps (`app/src/lib/db/client.server.ts:38-46`). That is still every colleague's conversation metadata, and nothing about the tool makes it read-only |
| `rust-mcp-filesystem` | 24 tools with `allow_write: true`. No registered agent uses them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `playwright`          | a browser with `browser_evaluate` / `browser_run_code`. A development and E2E tool; no registered agent uses it                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `github`              | never in the tracked template; removed from `configs/custom-catalog.yaml` entirely by #226 E3, so no config block has a server definition to start; and its last consumer agent was deleted by #266. Three layers deep — but check for the token explicitly anyway, below                                                                                                                                                                                                                                                                          |

**Dropping `redis` costs nothing, on one condition.** Uploads, ingestion and
search do not use the redis MCP server: `STASH_DIRECT_REDIS='1'` in `.env`
routes the whole Data Stash app path through a direct `ioredis` connection
(`app/src/lib/redis-direct.server.ts:286-288`), and the retriever's backend is
an app-side object, not a gateway tool. **Leave that variable set.** Unset it
and the stash falls back to the gateway path you just removed.

**What the allow-list leaves, and cannot fix.** The table above is what it
removes. These two properties belong to what stays, and neither is a setting you
can tighten here:

- **`neo4j-cypher` is shared, writable state.** The catalog gives it
  `write_neo4j_cypher` alongside the two read tools
  (`configs/custom-catalog.yaml:9-12`) and the config above sets
  `read_only: false`. There is no owner scoping anywhere in the graph layer —
  `grep -n 'user_id\|ownerId' app/src/lib/neo4j/*.ts` returns nothing — so
  every signed-in colleague's turn reads **and writes** the same graph. That is
  deliberate for a preview whose point is the shared graph; §11 records the
  identical property for `memory`. It is a disclosure obligation rather than a
  bug, and `PREVIEW-WELCOME.md` carries it.
- **The agent holding that surface declares no content boundary.**
  `withInjectionGuard` is declared by exactly three agents — `microsoft-365`,
  `search` and `retriever-agent` — and `general`, the one that passes
  `tools.all` into its loop, is not among them (a known, filed gap: #206). Two
  of the preview's five servers are `fetch` and `web_search`, so text from a
  page whose author is not your colleague lands in the same controller turn
  that holds `write_neo4j_cypher` and the shared `memory` writes, unsanitised.
  No setting on this VM switches that boundary on for `general` — it is the code
  change filed as #206. It bears on how far to trust an answer that cites a fetched
  page, and on who you invite — the same register §11 uses for the sandbox.

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

Use your existing app registration or a new single-tenant one
([`deployment/entra-setup.md`](deployment/entra-setup.md) §1). Three changes,
in the Entra admin center:

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

**Preflight — three greps before the one command.** The env template ships `preview.example.com` and
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

The other half of the preflight is the four values that have no default and no
fallback. `DATA_ENCRYPTION_KEY` is the one that hides: it does **not** fail at
boot on a fresh database. The schema init finds no encrypted rows, logs a
warning and continues
(`app/src/lib/db/migrate-encryption.server.ts:363-379`), so the stack comes up
healthy and the first sign-in is what dies — `encryptField` throws with no key
(`app/src/lib/db/crypto.server.ts:158,184`) on the session insert
(`app/src/lib/auth/session-store.server.ts:134`) and the user upsert
(`app/src/lib/auth/users.server.ts:105`). That surfaces at §8 step 4 as an
opaque error and takes steps 5–9 with it. Catch it here instead:

```bash
K="AUTH_SESSION_SECRET|TOKEN_ENCRYPTION_KEY|DATA_ENCRYPTION_KEY|ANTHROPIC_API_KEY"
grep -nE "^($K)=(''|\"\")?$" .env    # must return nothing — a hit is still empty
grep -cE "^($K)=" .env               # must print 4 — fewer means a line is gone
```

Two checks because the two failures look nothing alike: a value left at the
template's `''` and a line removed from `.env` altogether.

**Pre-launch check — the private tier is TWO endpoints, and it refuses on one.**
Only if this host will reach the self-hosted tier at all: either
`USE_VERDA_INFERENCE='1'`, or nothing set but a user picking **Private** on a
conversation's switch (beside the Agent selector), which is available whenever
the endpoints are configured. The
`describe` role runs on a 4B summarizer at `SMALL_LLM_BASE_URL`, and a private
tier without it is **refused, not descaled** — deliberately, because falling back
onto the 27B would be a routing change nobody asked for, invisible in every log,
on the role that is handed tool results verbatim. So a host with the 27B
configured and this line missing has a switch whose private position either
fails every turn or renders disabled, depending on which of the two is
missing:

```bash
# All three, or none of them — two out of three is the refusal. Must print 3 or 0.
grep -cE "^(VERDA_INFERENCE_ENDPOINT|VERDA_INFERENCE_API_KEY|SMALL_LLM_BASE_URL)='.+'$" .env

# And read the two URLs back: both MUST end in `/v1`. Without it every call 404s
# on `<root>/chat/completions`, which the app refuses at module load for the 27B.
grep -E "^(VERDA_INFERENCE_ENDPOINT|SMALL_LLM_BASE_URL)=" .env
```

`SMALL_LLM_API_KEY` is **not** required: llama-server authenticates nothing, and
an endpoint that does check a key 401s loudly on its own.

```bash
cd /opt/hames

# The sandbox base image. Not optional if anyone will use a sandbox agent —
# without it every sandbox run fails, and the failure is at run time, not boot.
docker build -t kg-sandbox:base rootfs/

# The whole stack: app, Postgres, Neo4j, redis-stack, MCP gateway, doc-convert,
# and Caddy in front.
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

## 7. Escrow the three keys — do this now, not later

```bash
grep -E '^(AUTH_SESSION_SECRET|TOKEN_ENCRYPTION_KEY|DATA_ENCRYPTION_KEY)=' .env
```

Put all three values in a password manager or Key Vault, **outside this VM and
outside its backups**. The backup script deliberately does not copy `.env`,
because a backup carrying both the ciphertext and its key protects nothing —
which makes the escrow the only copy, and a missing one unrecoverable.

They do not fail the same way, and the difference decides how urgent this is:

- `user_tokens` is AES-256-GCM ciphertext keyed by `TOKEN_ENCRYPTION_KEY`
  (HKDF-derived from `AUTH_SESSION_SECRET` when unset). Losing it costs the
  per-user Microsoft token cache — people sign in again and it refills.
- `DATA_ENCRYPTION_KEY` (#260) is the expensive one. It encrypts
  `conversations.title` / `conversations.context`, the `users` and
  `auth_sessions` profile columns and the `routines` prompt, with **no
  fallback to derive it from** — so a restored dump without it is ciphertext
  forever, and the app refuses to serve rather than pretending the rows are
  empty. Rotating it needs a re-encryption pass that has not been written yet;
  the `v1.` envelope prefix is what will let that pass be lazy when it is.

Both halves of that are stated the same way in
[`azure-vm.md` §9](deployment/azure-vm.md), which is the reference for the
systemd shape of the same box — including the pre-cutover `pg_dump` to take if
this VM ever holds rows written before the key was set.

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
| 4   | Click **Sign in with Microsoft**, use your `@contoso.com` account (the value the allow-list is set to)     | Entra prompt → back to `/` signed in. A redirect-URI mismatch shows as an Entra error page, not an app error                                                                                                                             |
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
> **What this script is not.** It writes to `/opt/hames/backups`, on the same
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
polls the service's own healthcheck up to `NEO4J_RESTART_TIMEOUT` times (default
180 — one `docker compose ps` plus a one-second sleep each, so nearer 4–5
minutes of wall clock than 180 seconds; the measured startup is ~80 s, and the
slack is deliberate), and **aborts non-zero with `THE GRAPH IS DOWN`** if it
never goes healthy. A restart that fails there used to be swallowed and
followed by a green MANIFEST; the run now stops so somebody looks at it.

Install the cron entry as the user in the `docker` group:

```cron
MAILTO=you@contoso.com
# /opt/hames — nightly at 03:30 local time.
# stdout to the log; stderr deliberately NOT redirected, so cron mails you the
# failure and only the failure.
30 3 * * * cd /opt/hames && ./scripts/backup-preview.sh >> /var/log/hames-backup.log
```

```bash
crontab -e                                    # paste the lines above
sudo touch /var/log/hames-backup.log && sudo chown "$USER" /var/log/hames-backup.log
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
> — and any path printed by the `find` is a run that did not complete. A
> directory holding **only** that marker is the commonest case and the one
> worth recognising on sight: the stack was not running, so the run stopped
> before it dumped anything. The marker is written before that check for
> exactly this reason — checked first, the likeliest nightly failure left no
> directory at all and the `find` stayed silent.

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
  if [ "$i" = 24 ]; then
    docker logs --tail 30 neo4j-restorecheck
    echo 'RESTORE UNPROVEN: neo4j never answered — do not count this dump as verified' >&2
  fi
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

**What a restore does not bring back:** the three keys in §7. Restore the
database onto a rebuilt VM with a different `AUTH_SESSION_SECRET` /
`TOKEN_ENCRYPTION_KEY` and every user's stored Microsoft token cache is lost —
which degrades gracefully (people sign in again) but silently breaks background
runs until they do. `DATA_ENCRYPTION_KEY` does not degrade gracefully: without
the exact value that wrote them, the restored conversations, titles, profile
columns and routine prompts are ciphertext nothing can read, and the app
refuses to serve rather than pretending otherwise. A dump taken after the first
boot with that key set is worthless without it — which is the whole reason §7
says escrow it before the first sign-in rather than after the first backup.

## 10. Rollback

**A bad app release** — the data tier is untouched, so this is a rebuild:

```bash
cd /opt/hames
git log --oneline -5                      # find the last good commit
git checkout <good-sha>
docker compose up -d --build app          # Caddy and the data tier keep running
docker compose logs -f app
```

> **This is only data-safe on the near side of #260, and that is now behind
> you.** The app tier is stateless with respect to the database, so checking
> out an older commit is normally a rebuild and nothing more. Encryption at
> rest changed that: `conversations.context` and the profile columns hold
> ciphertext that pre-#260 code has no key handling for, so a `<good-sha>`
> older than `56ac2b4` is a data migration wearing a rollback's clothes. That
> build has no decrypt path at all — it hands the envelope to the deserializer
> where the event stream used to be (`conversations.server.ts:81` on the near
> side of that commit) — and its first save of a conversation overwrites the
> row's ciphertext with plaintext. **Check the target first**:
>
> ```bash
> git merge-base --is-ancestor 56ac2b4 <good-sha> && echo 'safe rollback' \
>   || echo 'CROSSES #260 — do not check this out without a restore plan'
> ```
>
> If you must cross it, restore a pre-encryption dump alongside the older code
> ([`azure-vm.md` §9](deployment/azure-vm.md) has the `pg_dump` to have taken);
> there is no down-migration and no decrypt-back script.

Faster, if the previous image is still on the box: `docker images hames-app`,
then `docker tag <old-id> hames-app:local && docker compose up -d app` — no
build. Tag a known-good image (`docker tag hames-app:local hames-app:rollback`)
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
  work — only vector search over the uploads is dead. Fix it by running the
  embedding server on the VM as its own systemd unit — `make embed` at the repo
  root is that server, and [`models/README.md`](../models/README.md) says which
  GGUF it expects — and setting `EMBEDDINGS_LOCAL_URL` (the `/v1` suffix is
  required); or by pointing `EMBEDDINGS_PROVIDER` at a hosted embedder. The
  endpoint does not have to be on this box: "local" names the OpenAI-compatible
  wire format, not the machine. See [`azure-vm.md` §7](deployment/azure-vm.md)
  and [`DATA_STASH.md`](DATA_STASH.md).
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
  signed-in user's agent. It is in the preview's allow-list (§3a) because
  `general` advertises it in the picker — a choice made when that list was
  written, not something the agent's `servers: [...]` array enforces; nothing
  in the preview writes to it on its own.
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
- **Encryption at rest has no rotation path yet.** Conversations and the
  personal-data columns are encrypted (#260, §7), but the key lives in `.env`
  on the same box as the data it protects — the escrow copy is what makes that
  survivable — and changing it needs a re-encryption pass nobody has written.
  Treat `DATA_ENCRYPTION_KEY` as set once for the life of this preview.

## 12. More than one environment

[ADR-0008](adr/0008-deployment-guidance-is-provider-neutral.md) records why
this is guidance rather than a plan: how many environments a deployment runs,
and on how many hosts, is its operator's decision. What follows is what a
second environment (a dev or a prod beside staging, say) adds to §§0–11. None
of it is built here.

**Each environment is a complete copy of §§3–7**: its own compose project,
`.env`, Postgres, Neo4j and Redis volumes, and three keys. That means **one
escrow per environment in §7**, with no key reused across environments.
Environments may load the same graph into their own Neo4j, but conversation
databases are never shared.

**Changes to compose and code have to land before two environments can share
one host.** The committed files assume one stack per Docker daemon, in five
places:

1. **Container names.** Every service except `mcp-config` and `mcp-gateway`
   pins a `container_name` (`docker-compose.yaml:23,121,149,175,201`;
   `docker-compose.prod.yaml:157`). Those names are global to the daemon. The
   top-level `name: hames` (`docker-compose.yaml:4`) also has to differ per
   project.
2. **Ports.** Each project publishes the same loopback ports
   (`docker-compose.yaml:26-204`), and the overlay gives Caddy `80`/`443` in each
   project (`docker-compose.prod.yaml:162-165`). Only one process can bind each
   port.
3. **The sandbox reaper.** It force-removes every `kg-sandbox=1` container on
   the host when a process starts
   (`packages/sandbox/docker-backend.server.ts:415-451`, called from
   `packages/sandbox/with-sandbox.server.ts:198`; the #97 caveat). One
   environment's restart kills the other's in-flight sandboxes.
4. **Volumes the gateway creates.** The `memory` server's `claude-memory` volume
   (`configs/custom-catalog.yaml:103-104`) is created by the gateway, not by
   compose, so it is not scoped to a project and both environments would share
   one memory graph. The sandbox cache volume has the same shape
   (`docker-backend.server.ts:151-152`), but `SANDBOX_CACHE_VOLUME` overrides it
   per environment.
5. **Memory.** §1 sizes one stack at 16 GiB and calls that "not generous". Two
   stacks have not been measured.

Until those are fixed, a second project on the same VM collides at
`docker compose up`. Worse, it may come up and share state. The overlay stays
load-bearing as it is today (§2), so read any of those changes against this
runbook, not against the compose file alone.

**One Caddy, two hostnames.** On a shared host, a single Caddy outside both
projects terminates TLS for each environment's hostname and proxies each one
to its own app. `configs/Caddyfile` has one site block (`{$APP_DOMAIN}`, line
18), so it needs a second. It also needs distinct upstreams. Line 21 proxies
to `app:3444` by compose service name, both projects call their app service
`app`, and the loopback alternative collides on `127.0.0.1:3444` (item 2). A
host with one environment keeps today's one-site shape.

**Hostnames.** One per environment, under a domain you control (§4), and Entra
needs one redirect URI per environment hostname (§5a); an app registration
accepts several. Where DNS is not ready, a provider-assigned name can stand in
for §4's A record (on Azure, a public IP's `<label>.<region>.cloudapp.azure.com`,
so two names on one VM means two public IPs). Read §14's note on shared
provider names and Let's Encrypt's limits before relying on one.

**A registry replaces `--build`.** CI builds each image once and pushes it to
a private registry, and each host pulls by digest. Images stay private because
they can carry org data. Prefer a registry the hosts and CI reach with a
workload identity over one that needs a stored credential: on Azure, that is a
container registry that GitHub Actions pushes to through OIDC
workload-identity federation and each VM pulls from with its own managed
identity, so no long-lived registry secret exists anywhere. A host that has to
store a pull credential is the thing to avoid, which is why §14's single box
builds its own image instead. The app service then runs
`image: <registry>/<repo>@sha256:<digest>` instead of building
`hames-app:local` (`docker-compose.yaml:188-200`). That compose change comes
with the workflows, not before them.

**Each environment has its own allow-list.** A release-candidate environment
typically lists a subset of users. One image can serve different lists only
because the runtime value wins over the build-time one
(`app/src/lib/auth/allowList.ts:24-29`), so **the CI build must not set
`VITE_ALLOWED_EMAILS`**: if it did, that value would become the fallback
allow-list in every environment, prod included. §8 step 5 is still the test of
each gate, so run it once per environment. An Entra group or app-role check
would replace the lists and is not designed here.

**One GPU box for several environments.** If every environment points
`VERDA_INFERENCE_*` at the same scale-to-zero deployment, a turn in one
environment can queue behind a turn in another. Each app process keeps its own
cold-start estimate and its own wake poll
(`app/src/lib/inference/cold-start.server.ts:71-77`;
`app/src/lib/inference/wake.server.ts:117,293-303`). So the "starting GPU"
countdown in one environment does not know about a wake that another
environment just paid for, and an environment that joins partway through
another's cold start can record the rest of that wait as a cold start of its
own, which lowers its estimate. Only the countdown is affected, not routing.

**Where the live layer runs.** The coordinated burst, `pnpm eval:harness` and
`smoke-verda.ts` belong against a remote environment rather than a laptop. A
laptop on Apple Silicon is aarch64 and the hosts are linux/amd64, and #412
shows what that difference hides. The hermetic layers do not move
([`testing/pyramid.md`](testing/pyramid.md)).

## 13. Deploy and promotion, once the workflows exist

None of these workflows exist in this repository yet. This is the shape that
keeps the artifact that was approved the artifact that ships: an environment
that pulls runs the digest the environment before it ran, never a rebuild.
Environment branches and rebuilding prod from a release tag were rejected for
exactly that reason, because each ships bytes nobody tested
([ADR-0007](adr/0007-three-environments-digest-promotion.md), considered
options). A single box that builds its own image from a pinned commit (§14)
needs no registry credential, at a cost: nothing can promote "the bytes staging
ran" until CI builds the images.

| Trigger                                           | What happens                                                                           | Gate                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Merge to `main`                                   | CI builds the image once, pushes it to the registry and deploys that digest to **dev** | CI green                                             |
| Push of a protected tag such as `app-v0.2.0-rc.1` | The digest built for that commit deploys to **staging**                                | a tag ruleset restricts who can create `app-v*` tags |
| Promotion of a staging release                    | The **same digest** that staging is running deploys to **prod**. Nothing rebuilds      | a GitHub Environment `prod` with required reviewers  |

Three rules carry the design:

- **Deploy by digest, never by a mutable tag.** A tag is how a person names a
  release, and the digest is what a VM runs. Promotion reads the digest that
  staging deployed and hands that same value to prod.
- **`app-v` tags are kept apart from the npm release tags.** `release.yml`
  pushes `v<version>` and `@hames-ai/<pkg>@<version>` for the packages
  (`.github/workflows/release.yml:15-20`). An app tag never takes either form.
- **On a VM that pulls, rollback means redeploying the previous digest.** §10's
  `git checkout` and rebuild stays the procedure for a VM that builds its own
  image. Its #260 warning still applies to any digest built from a commit
  before `56ac2b4`.

## 14. Bootstrapping a single VPS — `scripts/bootstrap-vps.sh`

§§3–8 as one script, plus the host hardening an unmanaged VPS needs, for one
Ubuntu x86_64 box from any provider. A VPS is the customer's to secure, and
providers' own hardening guides converge on the same baseline (OVHcloud's
[How to secure a VPS](https://docs.ovhcloud.com/en/guides/bare-metal-cloud/virtual-private-servers/secure-your-vps)
is one example): updates, SSH keys only, an optional SSH port move, a host
firewall and `fail2ban`. The script applies that on the box and then runs
§§3–8 there. What happens outside the box (a firewall in front of it,
snapshots, out-of-band access) is an owner action, below. The script is
idempotent: each stage checks before it changes anything, so you resume by
re-running it. Its header and `--help` hold the details. A deployment that
keeps its own parameters and runbook elsewhere runs this script at a pinned
commit of this repository; nothing in it is specific to one host.

**Before the first run:**

- The commit you deploy must digest-pin the `mcp-gateway` image (#421) and
  must have the tracked `docker-config.json` set `dynamic-tools` to
  `"disabled"` (#422). Both are boot gates: the latest upstream gateway release
  breaks this stack (#417), and with `dynamic-tools` on the gateway adds its
  own management tools to every agent's tool list. The script never writes
  that file and never puts a registry credential in it. Every catalog image is
  public. If one ever needs auth, log in and pull on the host, as §3 says.
- The login user (`ubuntu` below) has passwordless sudo, its
  `~/.ssh/authorized_keys` holds your key, and you are logged in with it. The
  script refuses to turn passwords off for an account without a usable key.
- Open an interactive SSH session and leave it open for the whole first run.
  See the anti-lockout procedure below.

**Run it.** Do a dry run first. The hostname and the ACME mailbox are required
arguments and are never committed anywhere. `--ref` is required on every real
run that checks out the repo, and it must be the reviewed commit's full
40-character SHA. A branch name, a tag or a short SHA is refused, so the three
runs cannot deploy three different states of `main`:

```bash
# Piped. It never prompts; it lists what is missing.
ssh ubuntu@<host> 'bash -s -- --hostname <fqdn> --acme-email <mailbox> --ref <sha> --dry-run' \
  < scripts/bootstrap-vps.sh

# Copied. It prompts for the owner-supplied values, with secrets hidden.
scp scripts/bootstrap-vps.sh ubuntu@<host>:
ssh -t ubuntu@<host> 'bash bootstrap-vps.sh --hostname <fqdn> --acme-email <mailbox> --ref <sha>'
```

Run the second run, which does the apt installs and the image build, so that a
dropped connection cannot stop an apt transaction halfway: copy the script and
start it under `tmux`, or with `nohup … > bootstrap.log 2>&1 &`, and follow the
log.

A first bootstrap takes three runs. Exit code 3 means the run stopped for an
action, and you re-run with the same arguments once it is done:

1. The first run hardens SSH and the firewall, then stops at the anti-lockout
   checkpoint.
2. The second run installs `fail2ban` and Docker, checks out the repo, writes
   `.env` and builds the images. It then stops before `boot` until the
   owner-supplied values and the key escrow are in place.
3. The third run, with `--keys-escrowed`, boots the stack, seeds the graph and
   runs the smoke checks. The flag counts only on a run after the one that
   generated the keys: on the generating run it is ignored, because nobody can
   have escrowed keys that did not exist yet.

| Stage       | What it changes on the box                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight` | Nothing. It refuses anything that is not x86_64 (#412), not Ubuntu, under 4 GiB of RAM or under 20 GiB of free disk, a root login, or a user without passwordless sudo                                                                                                                                                                                                                                        |
| `updates`   | `apt-get upgrade`, plus `/etc/apt/apt.conf.d/20auto-upgrades`, which turns on daily unattended upgrades from the security origin only. Docker's repo is not in that origin, so the engine is never upgraded under the stack. Reboots are never automatic                                                                                                                                                      |
| `ssh`       | `/etc/ssh/sshd_config.d/00-hames-hardening.conf`: keys only, no passwords, no keyboard-interactive, no root login, and `Port` lines only if `--ssh-port` is given. The `00-` prefix makes it sort first, because sshd keeps the first value it reads and a cloud image's `50-cloud-init.conf` can turn passwords back on. The stage runs `sshd -t` before any reload and reads the result back with `sshd -T` |
| `firewall`  | `ufw`: deny incoming, allow outgoing, allow the SSH port(s), 80/tcp, 443/tcp and 443/udp, on IPv4 and IPv6. Each SSH port is allowed and read back before `ufw` is enabled. It prints the rules for a firewall in front of the box                                                                                                                                                                            |
| `fail2ban`  | Installs `fail2ban` and writes `/etc/fail2ban/jail.local` with the baseline `[sshd]` values: `maxretry = 3`, `findtime = 5m`, `bantime = 30m`, on the SSH port(s). `ignoreip` is loopback plus the operator: `--f2b-ignore <ip>[,…]`, else this SSH session's own client address, printed. It refuses to overwrite a `jail.local` it did not write                                                            |
| `docker`    | Docker Engine and the compose plugin from Docker's apt repository, never the snap. It checks that the key file holds exactly Docker's one signing key and refuses if Docker publishes no suite for the release. It writes `/etc/docker/daemon.json` with log rotation if the file is absent, requires Compose 2.24 or later, and adds the login user to the `docker` group                                    |
| `checkout`  | Clones the repo into `/opt/hames`, detached at `--ref`, a required full commit SHA, fetched by id if no branch carries it. It refuses a dirty tree and any commit older than #260. It writes §3a's five-server `configs/mcp-config.yaml` and never touches the tracked `docker-config.json`                                                                                                                   |
| `env`       | Creates `.env` (mode 600) from the template. It generates the two database passwords and the three keys on the box, and never regenerates an existing value or one a data volume already depends on. It lists, or prompts for, the owner's values. `--keys-escrowed` records the escrow, except on the run that generated the keys                                                                            |
| `hostname`  | Writes `APP_DOMAIN`, `ACME_EMAIL` and the two auth URIs into `.env`, checks that DNS points at the box, and prints the Entra steps                                                                                                                                                                                                                                                                            |
| `images`    | `docker compose build` and `pull`, a host pull of the five allow-listed MCP server images (in the gateway a failed pull is only a warning), and `docker build -t kg-sandbox:base rootfs/`. `--sandbox-flavours` also builds the three flavour images the `flavoured-sandbox` agent needs                                                                                                                      |
| `boot`      | Runs every gate first: the gateway pin, `dynamic-tools` disabled, §6's preflight, the escrow, DNS, a GitHub-token scan, and the rendered config (every port but Caddy's on loopback, the gateway allow-listed). Then it runs `docker compose up -d` and waits for every service                                                                                                                               |
| `seed`      | Imports `neo4j_dumps/seed-data.cypher`, or `--seed-file`, through `scripts/import-neo4j.sh`, and only into an empty graph. It never passes `--wipe`                                                                                                                                                                                                                                                           |
| `smoke`     | §8's on-box half: `ss` shows nothing public but the SSH port(s), 80 and 443; the gateway serves exactly the five servers; HTTP redirects to HTTPS; `/api/health` answers over a valid certificate; an unauthenticated `POST /api/events` gets 401; there is no GitHub token; `dynamic-tools` is still disabled; and the graph is not empty                                                                    |

**The anti-lockout procedure.** The lockout-capable stages, `ssh` and
`firewall`, run first. Once either one changes something, the script stops
before running anything else:

1. Before the first run, open an interactive session (`ssh ubuntu@<host>`) and
   leave it open. An sshd reload, a socket restart and enabling `ufw` all leave
   existing sessions alone.
2. When the run stops at the checkpoint (exit 3), prove that a **new** login
   works with the key alone. The script prints the exact command, with `-p` if
   the port moved:
   `ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no ubuntu@<host> true`.
3. If that fails, revert from the session you kept open:
   `sudo rm -f /etc/ssh/sshd_config.d/00-hames-hardening.conf`, then
   `sudo systemctl daemon-reload && sudo systemctl restart ssh.socket`, then
   `sudo ufw allow 22/tcp`.
4. If no session is left, use the provider's out-of-band access: a web, serial
   or KVM console (it logs in with the account's password, if it has one), or a
   rescue or recovery boot. From a rescue system, find the disk with `lsblk`,
   mount it on `/mnt`, delete
   `/mnt/etc/ssh/sshd_config.d/00-hames-hardening.conf`, set `ENABLED=no` in
   `/mnt/etc/ufw/ufw.conf`, and boot normally. A mistake in a firewall in front
   of the box is undone in the provider's console, not from rescue. Find out
   how your provider's rescue access works **before** the first run.
5. **A `fail2ban` ban drops the kept session too**, because its reject rule
   matches established packets. Three mistyped user names from one address in
   5 minutes ban it for 30 minutes; a retried wrong key for the right user
   does not count. The jail therefore never bans the operator's address
   (`ignoreip`, above). If it happens anyway, from another address:
   `sudo fail2ban-client set sshd unbanip <ip>`; else the console, a rescue
   boot, or wait 30 minutes. A re-run from a different address replaces the
   exempt one, so two operators pass both with `--f2b-ignore`.
6. Close the old session only after step 2 passes, then re-run the script.

**The SSH port: not moved by default, available as `--ssh-port`.** Hardening
guides often recommend a port between 49152 and 65535. The script makes the
move only when asked, and in two runs, so the box always has a port that is
known to work:

1. `--ssh-port <P>` adds `P` to `ufw` first, then has sshd listen on 22 **and**
   `P`, and points the `fail2ban` jail at both. Then the checkpoint asks for a
   new key login with `-p <P>`.
2. Add `--ssh-port-verified` to the same arguments after that login works. sshd
   then listens on `P` only, and `ufw` closes 22 only once nothing listens on
   it. Then comes the checkpoint again.

On Ubuntu 24.04 and later sshd is socket-activated, so the listening port
belongs to `ssh.socket` (`ListenStream`), not to sshd. Editing the packaged
`/lib/systemd/system/ssh.socket`, as some guides do, is overwritten by an
upgrade. The script writes `Port` lines in its sshd drop-in instead, and
Ubuntu's `sshd-socket-generator` turns those into the socket's `ListenStream`
on `systemctl daemon-reload`. The script then restarts `ssh.socket`. If the
generated socket or the listener does not come up on every port, the script
puts the previous drop-in back before it stops.

The recommendation is **not to move it by default**. With passwords off,
key-only login plus `fail2ban` already defeats the brute force that a port move
hides from. A move also has up to five places that must agree: sshd,
`ssh.socket`, `ufw`, the `fail2ban` jail and any firewall in front of the box,
and missing any one of them locks you out. What a move buys is a quieter auth
log. If you want SSH narrowed, a better control is a firewall rule in front of
the box that admits only your source address, if it is fixed.

**The login account.** Guides often recommend a restricted user for work that
does not need root. The options, for a box whose only login is the deploy
user's key:

- **Keep the login user with passwordless sudo (recommended).** A piped run of
  this script, or an automated one, cannot answer a password prompt.
- **Require a password for sudo.** This protects against a stolen key only if
  the user is also kept out of the `docker` group. The group "grants root-level
  privileges to the user"
  ([Docker](https://docs.docker.com/engine/install/linux-postinstall/)), so a
  stolen key plus the group is root without any password. It also breaks
  non-interactive runs, and the password has to live somewhere, usually next
  to the key.
- **Add a separate deploy user without sudo, which runs docker.** This is
  restricted in name only. Running docker needs either the `docker` group,
  which is root-equivalent, or sudo.

The script adds the login user to the `docker` group, which grants nothing that
passwordless sudo does not already grant. The control is the key: keep it
passphrase-protected, and held only by the people who run the box. Revisit
this when a second person needs a login, or if the box moves to rootless
Docker.

**Owner action: a firewall in front of the box.** Many providers offer one: a
network or edge firewall, or a cloud security group. It drops traffic before it
reaches the box, which makes it a second layer worth having. The `firewall`
stage prints a rule set that mirrors `ufw`, with the actual SSH port(s). For a
firewall that applies rules in order, first match wins:

| Order | Action | Protocol | Match                        | Why                                                    |
| ----- | ------ | -------- | ---------------------------- | ------------------------------------------------------ |
| 0     | Accept | TCP      | state `established`          | replies to the box's own connections (apt, ACME, APIs) |
| 1     | Accept | UDP      | source port 53               | DNS replies, where UDP is stateless                    |
| 2     | Accept | TCP      | destination port 22 (or `P`) | SSH; add your source IP if it is fixed                 |
| 3     | Accept | TCP      | destination port 80          | the ACME HTTP-01 challenge, then the redirect to 443   |
| 4     | Accept | TCP      | destination port 443         | the app                                                |
| 5     | Accept | UDP      | destination port 443         | HTTP/3                                                 |
| 6     | Accept | UDP      | source port 123              | NTP replies, where UDP is stateless                    |
| 7     | Accept | ICMP     |                              | reachability and path-MTU discovery                    |
| last  | Deny   | any      |                              | everything else                                        |

A stateful security group needs only the inbound accepts. If the firewall
filters IPv4 only, `ufw` stays the only filter for IPv6. During a port move,
keep a rule for 22 beside the one for `P` until the second run. Run §2's
off-box port scan after you change these rules: it is the only check of the
network path.

**Owner action: backups and what a disk image holds.** §9's
`scripts/backup-preview.sh` writes to the same disk and does not survive losing
the box. A provider snapshot of the whole disk does, and the recommended
minimum is the key escrow (§7, which `boot` requires) plus one snapshot right
after the first successful smoke, and again before any risky change such as a
ref bump across a migration. For a consistent image, `docker compose stop`
first, then `start` after the snapshot. Check whether your provider also takes
automatic backups by default, because then a disk image exists whether or not
you take one.

Know what any disk image of the box holds, and so what anyone who can restore
one gets:

- the graph and the conversation store;
- `user_tokens`: each user's MSAL cache, **with the refresh token**, for the
  delegated Graph scopes (`app/src/lib/auth/user-tokens.server.ts`;
  the default set is `DEFAULT_GRAPH_SCOPES` in `entra-config.server.ts`);
- `.env` on the same disk, with `AZURE_CLIENT_SECRET` and the
  `TOKEN_ENCRYPTION_KEY` that decrypts those tokens, beside
  `DATA_ENCRYPTION_KEY`;
- the Data Stash uploads in the redis volume, and Caddy's TLS key.

So an image is not just stored rows: it is live mail, calendar and file access
as every user, until their refresh tokens are revoked. The app's own column
encryption does not help against it, because its keys are in the image.
Protect the provider account itself, with two-factor sign-in and as few people
as possible. If the provider offers no disk encryption, the options are:

- **Root full-disk encryption.** It needs a custom image and an unlock at
  every boot, remote (dropbear-initramfs) or through the console. Usually not
  worth it for a non-production box.
- **A LUKS data volume.** A loop file or an additional disk, holding Docker's
  data-root (or just the volumes), `/opt/hames/.env` and `backups/`, unlocked
  by hand over SSH after a reboot, with `docker.service` ordered after the
  mount and its passphrase escrowed with the three keys. The script never
  reboots on its own, so a manual unlock fits. Snapshots and backups then hold
  ciphertext. It does not protect a running host.
- **Cheaper first steps.** Trim `AZURE_GRAPH_SCOPES` so the token store holds
  less, and keep an org-graph export off the box until the volume exists.

**What the owner supplies.** The script generates every secret it can and asks
for these:

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (the secret
  **value**), from the Entra app registration (§5).
- `VITE_ALLOWED_EMAILS`: this deployment's allow-list. The template's
  `*@contoso.com` counts as missing.
- `ANTHROPIC_API_KEY`.
- Optionally, the private tier: `VERDA_INFERENCE_ENDPOINT`,
  `VERDA_INFERENCE_API_KEY` and `SMALL_LLM_BASE_URL` (all three or none, both
  URLs ending in `/v1`), plus `SMALL_LLM_API_KEY` and `USE_VERDA_INFERENCE`.
- `--hostname`, `--acme-email` and `--ref <reviewed commit SHA>` on the command
  line; `--ssh-port` if you want the port moved; `--f2b-ignore` if the operator's
  address is not the one running the script.
- The Entra redirect URI `https://<fqdn>/api/auth/callback`, admin consent for
  the Graph scopes, and the client secret's expiry date. The `hostname` stage
  prints the exact steps (§5).
- The key escrow (§7): copy the three keys off the box from your own terminal,
  then re-run with `--keys-escrowed`. The marker stores a hash of the keys, so
  a changed key needs a new escrow, and the flag is ignored on the run that
  generated them.
- Which graph to start with: the public seed (the default), or an org graph
  export copied onto the box and passed as `--seed-file`. That export holds
  personal data, so it must never be committed.
- Outside the box: the firewall rules and the backup choice above.

**How a VPS differs from §§1, 2 and 4:**

- **§1, disk encryption.** A VPS may offer no encryption at creation; see the
  options above.
- **§2, firewall.** Without an NSG, `ufw` is the host's filter, but Docker
  publishes ports through its own NAT rules, which divert packets before `ufw`
  sees them, so `ufw` does not guard a Docker-published port at all
  ([Docker: packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/)).
  The overlay's `127.0.0.1` binds keep everything except Caddy private. The
  script checks that intent before boot and checks the result with `ss`
  afterwards. A firewall in front of the box sits before both.
- **§4, the hostname.** Prefer a name under a domain you control to the
  provider's default host name. Let's Encrypt allows 50 certificates per
  registered domain per 7 days and takes the registered domain from the Public
  Suffix List ([rate limits](https://letsencrypt.org/docs/rate-limits/)). A
  provider's default names whose parent domain is not on that list share one
  limit with every other customer using one: on OVHcloud, for example, the
  `vps-*.vps.ovh.net` names (checked 2026-10-03).

**What the script was tested against, and what it was not.**
`scripts/bootstrap-vps.test.sh` runs in CI with ShellCheck. It needs no daemon
and no root, and it pins the gates: the listener check, the gateway pin,
`dynamic-tools`, secrets that are never printed or regenerated, the boot gate's
`.env` checks, the escrow marker, the key check, the port move and the jail
values. It also runs the `ssh` and `firewall` stages and the checkpoint against
a fake box (shims for sudo, sshd, ufw, ss and systemctl), asserting what was
called and in which order, plus the rendered-exposure and volume gates. Each
pin was shown to go red by a mutation. Before the script was made
provider-neutral (a change of wording, of the managed-file header and of one
removed provider-specific warning, not of logic), its real stages were
exercised in throwaway Ubuntu 24.04 and 26.04 containers, including with
systemd as PID 1, the real `ssh.socket`, `ufw` and `fail2ban`, over SSH and
through dropped sessions: the SSH hardening and a refused password login
afterwards; the two-run port move with a key login on each port; the Docker
install from the `resolute` suite; and the checkout, `.env` and hostname
stages, with a re-run that leaves `.env` byte-identical. Not tested: a provider's own image (its
cloud-init drop-ins, whether `ssh.socket` is enabled), anything that needs a
Docker daemon (the image build, `up`, ACME, the smoke checks against a live
stack), a firewall in front of the box and rescue access. The first real run,
with a session kept open, is the test of those.

## What is not true of this deployment

Two things a reader might reasonably assume are in place, and are not — one
because the work is unfinished, one because the preview deliberately leaves it
switched off. Neither is required to deploy.

A third used to be here — "conversations are encrypted at rest" — and it is now
true: #260 merged on 2026-08-26 and `DATA_ENCRYPTION_KEY` is a **required**
variable of this deployment (§7). If you are reading a copy of this runbook that
still lists it as pending, that copy predates the merge. That is the shape this
table rots in: `main` moves, and a row here quietly stops describing the build
you are about to deploy. Re-read it against `git log` rather than trusting it.

| Claim                                            | Reality today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Names are pseudonymised before prompts go out." | The substitution modules exist and are tested, but nothing in production imports them — `grep -rn pseudonymise app/src` returns only the modules under `app/src/lib/privacy/` and their own tests, on this branch and on `main`. Every egress path is unhooked, mapped path-by-path in PR #258 (merged).                                                                                                                                                                                                                                                                                                                                                                     | a decision that has not been taken yet — `docs/plan/graph-pseudonymisation.md` holds the open questions. PR #264 (merged 2026-08-26) supplied the roster the substitution would read from, which leaves the hook itself as the only missing piece                                                                                                                                                                                                                                                                                 |
| "Inference runs on our own hardware."            | With the endpoint configured, every signed-in user gets a per-conversation switch (beside the Agent selector, with the chosen tier shown on every sidebar row) and **every** role follows it, the prompt-injection screen included. So no model call a turn makes goes off the box on that setting. Two edges: the embeddings provider is a separate seam (`EMBEDDINGS_PROVIDER=openrouter` would send query text out; the default is `local`), and the screen's own client is now an **unmeasured** screener — the owner accepted that trade knowingly, and `pnpm eval:harness`'s `screen-on-the-tier` scenario is what settles it. No agent enables that classifier today. | **Shipped and widened twice** — PR #263 merged 2026-08-26 (controller / actor / critic / synthesizer); the router / planner / describe roles were added the same day on the owner's call, because the router sees the raw user message and `describe` sees tool results verbatim; the injection screen followed on the rule that no call made under the private tier may be sent to any public AI provider (owner decision, answer 7). There is no exception left. With the endpoint unset, nothing about this deployment changes |

[`PREVIEW-WELCOME.md`](PREVIEW-WELCOME.md) says all of this to the preview
circle in plain language. **Keep the two documents in step**, in both
directions: a row that is still pending must not be promised there, and a row
that lands must be corrected there — #260 landing is what moved that note's
storage paragraph from "not separately encrypted" to what it says today, and
nothing but this instruction connects the two.

> **KNOWN DRIFT, and it is the owner's to close (recorded 2026-08-26).**
> `PREVIEW-WELCOME.md`'s "What happens to what you type" still tells preview
> users _"Your messages are sent to Anthropic … That is the only external model
> provider involved — nothing is sent anywhere else for inference."_ The row
> above has now landed twice, and the default path for a new user is **verda
> when the endpoint is configured**, so that sentence is wrong on the default
> path rather than on an opt-in edge — and it is wrong in the direction of
> over-stating what leaves, which is the harmless direction for a
> data-handling promise but is still wrong. The substitute is not "nowhere":
> DataCrunch is a hosting provider with its own contract, location and
> sub-processors, which `docs/data-privacy/plan.md` is careful to say. Rewriting
> a user-facing data-handling promise is not a doc edit, so it has deliberately
> not been done here; this marker exists so the tree records the divergence
> instead of only a PR body doing so.

## State of this runbook

Written against `origin/main` and rehearsed as far as a laptop allows. What that
means concretely:

**Verified by execution on a laptop**

- The merged production configuration (`docker compose config`): every data-tier
  port on `127.0.0.1`, both passwords substituted into the services _and_ into
  the app's `DATABASE_URL`, a stray `app/.env` correctly contributing nothing,
  no Arm redis override loaded, and the gateway's merged `command:` carrying
  `--servers=…` with no `--enable-all-servers` left in it.
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

One of those is newer than the rehearsals above: encryption at rest arrived with
#260 **after** this runbook was executed on a laptop, so the first boot with
`DATA_ENCRYPTION_KEY` set has not been walked through here. Its own test suite
covers the code; what is unrehearsed is this sequence — a from-scratch database,
the key present from the first boot, and step 4 of §8 writing the first
encrypted session row.

One local result that is **not** a finding about the VM: running redis-stack
natively on Apple Silicon dies with `Illegal instruction` on the RediSearch
module. That is the arm64 defect `docker-compose.override.yml` exists for, it
reproduces with or without these changes, and it is why §1 says x86.
