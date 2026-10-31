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
  Node server, Caddy, the CPU embedder and _N concurrent sandbox containers_
  share it. Budget separately for a second app container if deployed on the
  same host (§12). The shared embedder's 3 GiB Compose cap gives headroom after
  a 2 GiB cgroup OOM during dev ingest. That cap is a
  placeholder, not measured RSS or a capacity guarantee; the failed-ingest
  peak remains unmeasured.
  Measure peak RSS and ingestion latency alongside serving and
  builds before choosing a host size. The container build alone peaks near
  2.3 GB RSS.
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

Neo4j is isolated on `neo4j-internal` (`internal: true`, IPv4 gateway mode `isolated`, Docker Engine >= 28; `make check-docker` locally); only `neo4j-relay`
shares it. HTTP/Bolt loopback publishes belong to the relay, and container
consumers use `neo4j-relay`, keeping Neo4j off `app-network` (#241 G13).
Plugins are baked into the image; CSV file URLs and APOC file imports stay off.
Before recreating the stack, take a Neo4j dump using the currently running
image. The first `docker compose up -d` after adopting G13 moves an older store
to 5.26.32; that store-format move cannot be undone.
See the [opt-in egress check](testing/neo4j-egress.md).

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
nowhere else. The `embedder` is published nowhere, loopback included.

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

test "$(id -u)" -ne 0 || exit 1
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /opt/hames
( umask 022; git clone https://github.com/mknw/hames-playground /opt/hames )
cd /opt/hames
```

The deployment user owns the checkout from its first Git write. Run Git as that
user with `umask 022`; `sudo git` creates root-owned tracked files. The same
user later writes `.env`, backups and rollback checkouts.

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

For the single-app shape, `.env` at the **repo root** is the single source of runtime configuration. It is
read twice, deliberately: Compose reads it for `${VAR}` substitution (that is how
`COMPOSE_FILE`, the two database passwords and `APP_DOMAIN` reach the overlay),
and the `app` service loads the same file as its `env_file`. There is no
`app/.env` on this host — the overlay pins the app's `env_file` to the root file
so a stray one cannot contribute anything. The opt-in two-clone shape (§12) replaces
that app env file with separate app-only files while keeping Compose inputs in
the release checkout’s root `.env`.

The two lines at the top of `.env` are what make the bring-up a single command:

```
COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml
COMPOSE_PROFILES=app
```

Setting `COMPOSE_FILE` also stops Compose auto-loading
`docker-compose.override.yml`, so the laptop-only Arm redis workaround can never
apply here.

### 3a. The agent-reachable tool surface

Every agent takes a namespace slice of its discovered tools. The gateway's
enabled set bounds its portion of the preview surface; the app's hosted Exa
transport independently adds only `web_search_exa` and `web_fetch_exa` under
`web` by default. Set `EXA_TOOLS=search`, `fetch`, or `off` in the repo-root
`.env` to narrow or disable Exa; an optional `EXA_API_KEY` belongs in that
server-only file. With no key, boot logs keyless mode and Exa's free rate limit
applies. The gateway set still has to be chosen rather than inherited.
(Until 2026-10-21 the `general` agent passed `tools.all` —
literally every listed tool — into one loop, so the enabled set WAS the surface;
the agent was removed, and `agent-postgres-tools.test.ts` pins that no agent is
handed the whole listing again.) An agent's declared `servers: [...]` array is
display metadata for the agent picker (`AgentSelector.tsx:182,195`); **it filters
nothing**.

**The gateway allow-list controls the gateway portion; `EXA_TOOLS` controls
the hosted Exa portion.**

`docker-compose.prod.yaml` replaces the base file's `--enable-all-servers` with
an explicit allow-list:

```
--servers=neo4j-cypher,fetch,web_search,context7
```

That is the control. `--enable-all-servers` means _every server in the
catalog_, so `configs/mcp-config.yaml` is a **connection-parameter file, not an
enablement list** — deleting an entry from it changes nothing while the flag is
set. Verified on this stack, same config file both times: with the flag, nine
servers and 134 tools; with the allow-list, five servers and 17 tools (measured
before the `memory` server was retired; the allow-list is four servers now and the
count has not been re-measured). A trimmed
config file on its own would read like protection and match nothing.

Write `configs/mcp-config.yaml` with exactly the four, so the file and the
allow-list say the same thing and nobody has to reconcile them later:

```yaml
# /opt/hames/configs/mcp-config.yaml — preview. Deliberately NOT a copy of
# configs/template.mcp-config.yaml (that is the development set).
neo4j-cypher:
  enabled: true
  uri: bolt://neo4j-relay:7687
  username: neo4j
  password: ${NEO4J_PASSWORD} # filled from .env by the `mcp-config` render service
  database: neo4j
  read_only: true # agents are read-only against Neo4j (#403), the preview included

fetch:
  enabled: true

web_search:
  enabled: true

context7:
  enabled: true
```

A preview provisioned before 2026-10-03 has `read_only: false` in that file.
Change it to `true`, then render it again and recreate the gateway:
`docker compose run --rm mcp-config && docker compose up -d --no-deps --force-recreate mcp-gateway`.
The gateway reads the copy the one-shot `mcp-config` service renders, so
recreating it with `--no-deps` alone, or restarting it, re-reads the old copy
(`docs/MCP_GATEWAY.md`, "Neo4j writes"). Re-running `scripts/bootstrap-vps.sh`
rewrites the file but does not recreate the running gateway either, so run the
same two commands after it. Until then the server still offers the write tool;
the app keeps it from every agent either way, and logs
`the MCP gateway lists write_neo4j_cypher` once per process while the server
offers it.

**What is left out, and why:**

| Omitted               | Why                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`               | 45 tools including `scan_keys` and `json_get`. Data Stash keys are `stash:doc:{sessionId}:{docId}` (`packages/harness-patterns/stash/document-store.server.ts:145-146`) — scoped by **session, never by owner** — so this is a read of every colleague's uploaded documents from any signed-in account's controller turn                                                                 |
| `database-server`     | removed from `configs/custom-catalog.yaml` entirely (#412): agents get no Postgres access. It ran arbitrary SQL over the app's own Postgres, across every user's rows. No config block has a server definition to start, the `mcp-config` render service is given no Postgres credential, and the app withholds the server's tools from every agent's catalog whatever the gateway lists |
| `rust-mcp-filesystem` | 24 tools with `allow_write: true`. No registered agent uses them                                                                                                                                                                                                                                                                                                                         |
| `playwright`          | a browser with `browser_evaluate` / `browser_run_code`. A development and E2E tool; no registered agent uses it                                                                                                                                                                                                                                                                          |
| `github`              | never in the tracked template; removed from `configs/custom-catalog.yaml` entirely by #226 E3, so no config block has a server definition to start; and its last consumer agent was deleted by #266. Three layers deep — but check for the token explicitly anyway, below                                                                                                                |

**Dropping `redis` costs nothing, on one condition.** Uploads, ingestion and
search do not use the redis MCP server: `STASH_DIRECT_REDIS='1'` in `.env`
routes the whole Data Stash app path through a direct `ioredis` connection
(`app/src/lib/redis-direct.server.ts:286-288`), and the retriever's backend is
an app-side object, not a gateway tool. **Leave that variable set.** Unset it
and the stash falls back to the gateway path you just removed.

**What the allow-list leaves, and cannot fix.** The table above is what it
removes. These two properties belong to what stays, and neither is a setting you
can tighten here:

- **`neo4j-cypher` is shared state, and agents only read it.** The owner
  decided on 2026-10-03 that agents are read-only against Neo4j, the preview
  included (#403). Two layers hold that: the config above sets
  `read_only: true`, under which the server does not offer
  `write_neo4j_cypher`, and the app leaves that tool out of every agent's tool
  list whatever the server offers (`AGENT_WITHHELD_TOOLS` in
  `packages/harness-patterns/mcp-client.server.ts`). There is still no owner
  scoping anywhere in the graph layer —
  `grep -n 'user_id\|ownerId' app/src/lib/neo4j/*.ts` returns nothing — so
  every signed-in colleague's turn reads the same graph. The future writer is
  the memory hook (#419), which writes through the app and asks the user to
  confirm first (#206). The shared `memory` MCP server is retired (§11).
  `PREVIEW-WELCOME.md` carries the Neo4j property.
- **The agent holding that surface used to declare no content boundary; the
  one left without one is the sandbox agent.** `withInjectionGuard` is declared
  by four agents — `microsoft-365`, `search`, `retriever-agent` and
  `general-next`. The unguarded `general` agent, which passed `tools.all` into
  one loop (web fetch and the shared `memory` writes in the same controller turn),
  was removed on 2026-10-21, and the shared memory graph itself was retired on
  2026-10-22: no agent is handed any memory-graph tool. (No agent holds
  `write_neo4j_cypher` either, since #403.) The gap that remains in this register
  is the sandbox agent's, the same one §11 records for the sandbox.

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

### 4a. Request admission, uploads and SSE

Both sites use `configs/Caddyfile`'s `preview` snippet. Caddy limits **request
bodies** to **32 MiB** on `/api/stash/upload` and `/api/agents/*`, and **1 MiB**
on every other path; this does not limit response bytes or stream duration.
The app's Data Stash accepts **5 MiB decoded content**
(`packages/harness-patterns/stash/document-store.server.ts`, `MAX_CONTENT_BYTES`).
The multipart intake sends raw file bytes; the JSON intake can send base64
(under 7 MiB for a maximal binary) or escaped text. A maximal text body can
expand sixfold under JSON escaping: **30 MiB**, plus up to **2 MiB** for the
envelope/metadata. The 1 MiB cap accommodates the **64 KiB** skill-file limit
even after sixfold JSON escaping (`packages/sandbox/skills.ts`). Arbitrarily
padded JSON, metadata or multipart fields are not exempt. The app still enforces
its smaller content limits.
`request_body max_size` rejects reads beyond the cap with 413
([Caddy reference](https://caddyserver.com/docs/caddyfile/directives/request_body)).
The app can receive up to the applicable cap before Caddy aborts an oversized
request, including a chunked body; the cap does not pre-buffer it at the proxy.

Rate limiting lives in `app/src/lib/request-rate-limit.server.ts`, wired before
route work in both middleware routers. Stock Caddy has no built-in rate limiter;
its [rate-limit module](https://caddyserver.com/docs/modules/http.handlers.rate_limit)
is non-standard. A small app admission gate avoids a custom plugin build and
another dependency to audit/pin. It uses token buckets:

- Each **verified user ID** gets **600 requests/minute**, with a burst of
  **120** shared across that owner's browser sessions and action tokens, routes
  and HTTP methods. Session routes resolve the cookie through the session store;
  `POST /api/agents/:id` uses `resolveActionUser(bearerSecret(authorization))`,
  including when a cookie is also present. Only the identity the endpoint honors
  is charged, once. Route auth and allow-list checks still decide access
  (SD-13/SD-15/SD-16).
- Verified principals consume **only their own allowance**. Requests with no
  verified principal (including unknown/expired cookies and unknown action
  tokens) normally consume a **per-address 600/minute, burst 120** allowance, then
  the process-wide **anonymous 6000/minute, burst 1000** backstop. Refusals at
  an earlier bucket do not drain the later one. Cookie lookup precedes address
  admission, so verified office users do not share a NAT allowance.
- The unresolved path trusts only the single address Caddy explicitly writes
  with `header_up X-Forwarded-For {remote_host}`. This requires Caddy as the sole
  public ingress and the app's loopback-only binding; do not expose the app port
  or place another proxy in front without revisiting that trust contract.
  Missing, malformed or multiple forwarded addresses share one fallback bucket.
  The sole exception is a direct socket from `127.0.0.1`, `::1` or
  `::ffff:127.0.0.1` with **no** forwarding header: local dev/browser-suite RPCs
  consume only the anonymous global backstop (100/second, burst 1000). The
  socket peer, never the URL or another header, establishes this exception;
  absent peer metadata keeps the fallback. An empty or malformed forwarding
  header does not qualify. This is admission, not authentication or a dev-auth
  bypass. Caddy supplies the overwritten address even over a loopback socket,
  so public unresolved requests retain their per-address bound. The config pin
  also forbids removing that header after overwriting it (Opus Y1).
- Exhaustion returns **429** with whole-second `Retry-After` and
  `Cache-Control: no-store`. A failed session lookup returns **503**, not an
  anonymous fallback. Both user and address tables hold at most **256** entries;
  a new key is refused if full, and only fully refilled entries may be reclaimed.

The per-user refill allows ten requests/second because terminal input sends a
request per keystroke (`InteractiveTerminal.tsx`). These are preview defaults,
not measured capacity guarantees. Session-route requests with cookies incur a
session lookup before admission; route authorization still performs its own check. State is
**in memory per process**, shared by the two router bundles, reset on restart,
and separate for release/dev containers and any replicas. This is admission
control, not a concurrent-request cap or edge DDoS protection: distributed or
anonymous floods can still exhaust the anonymous backstop and affect other
anonymous users, and authentication or other shared resources can still be
overwhelmed. These buckets do not promise availability under distributed floods.
There is no timer on an admitted SSE response, and exhaustion never cancels one.
`flush_interval -1` stays on both upstreams, with no response buffering or stream
timeout ([Caddy streaming reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)).

Validate syntax offline using a local **stock Caddy 2.10** binary, never a running
deployment. From the repo root, this uses synthetic inputs and temporary storage;
it does not start a server or perform ACME/DNS/live-provider checks:

```bash
check_dir=$(mktemp -d)
cp configs/Caddyfile "$check_dir/Caddyfile"
mkdir "$check_dir/dev-sites"
# Single-app config, with no dev site mounted:
APP_DOMAIN=release.example.invalid ACME_EMAIL=operator@example.invalid \
  XDG_DATA_HOME="$check_dir/data" XDG_CONFIG_HOME="$check_dir/config" \
  caddy validate --adapter caddyfile --config "$check_dir/Caddyfile" &&
  cp configs/Caddyfile.dev "$check_dir/dev-sites/dev.caddy" &&
  APP_DOMAIN=release.example.invalid DEV_APP_DOMAIN=dev.example.invalid \
  ACME_EMAIL=operator@example.invalid XDG_DATA_HOME="$check_dir/data" \
  XDG_CONFIG_HOME="$check_dir/config" \
  caddy validate --adapter caddyfile --config "$check_dir/Caddyfile"
rm -rf "$check_dir"
```

Unit text pins: `app/src/__tests__/lib/config/caddy.test.ts`; admission and failure
policy: `app/src/__tests__/lib/request-rate-limit.test.ts`. These checks do not
prove live ACME, uploads or SSE timing; operator smoke on **both** hostnames
remains required after deployment. No host access or private-tier probe is part
of this step.

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

> **`AUTH_REDIRECT_URI` is also the app's public origin.** Its scheme, host and
> port are what every state-changing request is checked against (#455,
> `app/src/lib/auth/csrf.server.ts`). A `POST`, `PUT`, `PATCH` or `DELETE` whose
> `Origin` (else `Referer`) names anything else is answered `403`, and that
> includes every server function and the sign-in button itself. So the value
> must be the address users' browsers load the app from: the public `https://`
> name the TLS-terminating reverse proxy serves, never the app's internal
> address or port. A proxy that rewrites `Host` does not affect it, because the
> check never reads `Host`. Callers that send no browser headers and no session cookie, such as
> the bearer-token agent trigger, are not affected
> ([`AGENT_TRIGGER.md`](AGENT_TRIGGER.md#authentication--configsaction-tokensyaml)).
> Unset, or not an `http(s)` URL, a production build **refuses to boot**, with
> a `[csrf]` line naming the variable. One app, one public origin: serving the
> same container under a second hostname means its writes are refused there.
> Keep the proxy's `Referrer-Policy` off `no-referrer`: under it the sign-in and
> sign-out forms send `Origin: null` and are refused.

**b. Post-logout URI.** Set `AUTH_POST_LOGOUT_REDIRECT_URI` in `.env` to

```
https://<APP_DOMAIN>/auth/signin
```

(the route `app/src/routes/auth/signin.tsx`, default at
`entra-config.server.ts:40`). Front-channel logout with the v2 endpoint needs no
separate registration.

**c. Keep the already-consented delegated Graph scopes.** _API permissions →
Microsoft Graph → Delegated_: `User.Read`, `email`, `Mail.Read`, `Mail.Send`,
`Calendars.ReadWrite`, `Files.Read.All`, `Sites.Read.All`. MSAL also supplies
`openid`, `profile`, `offline_access`; keep their consent for background refresh.
The full set is requested at sign-in (`DEFAULT_GRAPH_SCOPES`), and **a requested
scope without consent fails the entire sign-in**. With user consent disabled,
adding `Calendars.Read` causes “Approval required” even though the existing
`Calendars.ReadWrite` permission already covers the calendar reader.

`AZURE_GRAPH_SCOPES` may trim only this seven-scope set (case-insensitive);
all other scopes, including `Calendars.Read` and delegated `.default`, refuse
boot and delegated token minting. Keep the same registration/client id and add
only the redirect URI. The owner is no longer asked to remove `Mail.Send` or
`Calendars.ReadWrite` or revoke their existing grants. Leave application
permissions (the roster read) unchanged.

The app requests `Mail.Send` and `Calendars.ReadWrite` but ships no Graph write
tool; requesting these scopes adds no write tool. HITL write gating stays
Neo4j-only. See the [consent runbook](deployment/entra-setup.md#keep-the-consented-permissions-in-entra).

Also confirm the client secret in `.env` is the secret **value**, not its id, and
note its expiry somewhere you will see it.

Detail and rationale: [`deployment/entra-setup.md`](deployment/entra-setup.md).

## 6. Boot

**Preflight — three greps before the one command.** The env template ships `preview.example.com` and
`ops@example.com` pre-filled in four places, and two of them —
`AUTH_REDIRECT_URI` and `AUTH_POST_LOGOUT_REDIRECT_URI` — are the ones an
operator who edits `APP_DOMAIN` most easily forgets. The post-logout URI does not
fail loudly: unset, it silently defaults to `http://localhost:3444/…`
(`app/src/lib/auth/entra-config.server.ts:39-40,119-121`). `AUTH_REDIRECT_URI`
is no longer silent, because it is also the public origin every write is checked
against (§5a): unset, the server refuses to boot with a `[csrf]` line naming it;
left at the placeholder, it boots and the sign-in button answers `403 … only
from pages on https://preview.example.com`.

```bash
grep -n 'example\.com' .env       # must return nothing
```

The other half of the preflight is the required values with no default or
fallback. `ANTHROPIC_API_KEY` may be empty only on a private-only server
(`INFERENCE_TIERS=self_deployed`); the three encryption/session keys remain required. `DATA_ENCRYPTION_KEY` is the one that hides: it does **not** fail at
boot on a fresh database. The schema init finds no encrypted rows, logs a
warning and continues
(`app/src/lib/db/migrate-encryption.server.ts:363-379`), so the stack comes up
healthy and the first sign-in is what dies — `encryptField` throws with no key
(`app/src/lib/db/crypto.server.ts:158,184`) on the session insert
(`app/src/lib/auth/session-store.server.ts:134`) and the user upsert
(`app/src/lib/auth/users.server.ts:105`). That surfaces at §8 step 4 as an
opaque error and takes steps 5–9 with it. Catch it here instead:

```bash
K="AUTH_SESSION_SECRET|TOKEN_ENCRYPTION_KEY|DATA_ENCRYPTION_KEY"
# Ordinary deployments also require ANTHROPIC_API_KEY (4 keys total).
# A private-only deployment requires only these 3; env_problems below checks policy.
if ! grep -qE "^INFERENCE_TIERS=[\"']?(self_deployed|private)[\"']?$" .env; then
  K="$K|ANTHROPIC_API_KEY"
fi
grep -nE "^($K)=(''|\"\")?$" .env    # must return nothing — a hit is still empty
grep -cE "^($K)=" .env               # must print 3 (private-only) or 4 — fewer means a line is gone
```

Two checks because the two failures look nothing alike: a value left at the
template's `''` and a line removed from `.env` altogether.

**Pre-launch check — the private tier requires all five values.**
The 27B chat endpoint, the 4B summarizer and the systemone decisions URL are
one tier. A partial configuration is refused; there is no public-provider
fallback and no summarizer fallback onto the 27B. The decisions URL is a
**full URL ending in `/v1/systemone`**, rather than a base to which the app
appends a path. Its bearer key, `SMALL_LLM_API_KEY`, is **required** and shared
with the summarizer, even if a local llama-server accepts unauthenticated
summarization. `AGENTS.md`'s private-tier section is the routing contract.

P4 file ingestion (#717) is enabled only when INFERENCE_TIERS=self_deployed. Do not unset it on a deployment whose conversations hold ingested files: history is not screened on a tier flip until the release slice in #693 lands.

**Private-only server (#653):** set `INFERENCE_TIERS=self_deployed` in the runtime `.env`.
The bootstrap and server boot then require all five private-tier values and accept
an empty `ANTHROPIC_API_KEY`. Existing Anthropic conversation rows and last-used
seeds resolve to private for their next turn, without rewriting the history.
Server actions refuse new Anthropic selections. The switch keeps Anthropic visible
but greyed out, disabled, with an explanation. Explicit public run frames and
public/unverified client overrides fail before a provider request; summaries,
screening, memory and titles use their private role clients. Unset preserves
all existing behavior. `USE_SELF_DEPLOYED_INFERENCE=1` by itself does **not** disable
Anthropic or waive its key. This is a configuration check, never a health probe.

For staging, **configure all five values** with the operator's private-tier
endpoints and keys. A user who never chose starts on Private whenever the
whole tier is configured, even with `USE_SELF_DEPLOYED_INFERENCE` unset; the first turn
may pay a metered cold start. The conversation's own tier and the user's
last-used tier take precedence. A run that names no tier at all (a script, a
job, an eval) is on the self-deployed tier by one rule that routing and the
guards both read, and is refused where the tier is not configured; it is never
routed to Anthropic. `USE_SELF_DEPLOYED_INFERENCE=1` is the boot-time switch
only: it requires the tier to be configured when the server starts, and it no
longer decides the tier of any run. A host that intentionally offers only
Anthropic leaves all five values and the flag unset, and its runs name the
Anthropic tier explicitly (every turn does).

```bash
# Must print 5 for staging (0 only for an Anthropic-only host); any partial set
# must be completed before boot. Counts only; never print keys or endpoint values.
K_PRIVATE="LARGE_LLM_BASE_URL|LARGE_LLM_API_KEY|SMALL_LLM_BASE_URL|SMALL_LLM_DECISIONS_URL|SMALL_LLM_API_KEY"
grep -cE "^($K_PRIVATE)='.+'$" .env

# Run from the checkout root. Use boot's shared validation (requires python3);
# it prints only key/problem labels, never configured values, and makes no calls.
HAMES_APP_DIR="$PWD" HAMES_BOOTSTRAP_SOURCED=1 source scripts/bootstrap-vps.sh
env_problems
```

The bootstrap asks for missing values on an interactive re-run, including a
partially configured tier; both bearer-key prompts are hidden. Its preflight
refuses a partial set, malformed URLs, or a flag enabled without the
complete set, before starting containers. This checks configuration only and
makes no provider request. The decisions URL must parse as an absolute HTTPS
URL or HTTP loopback URL, without userinfo or a trailing-dot host, with pathname
exactly `/v1/systemone`, and must not name a public systemone provider. Both
checks use this same validation. Endpoint values belong with the operator
(ADR-0008); the env names remain unchanged when the hosting provider changes.

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

For subsequent changes, use the [per-key rotation runbook](deployment/secret-rotation.md).
Gateway authentication (#392/#417) and the data re-encrypt tool remain deferred.

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

Configure the [external uptime probe and alerting checklist](deployment/observability.md)
from an independent runner. Its liveness check makes no inference calls; alert
thresholds remain named placeholders until the operator measures the deployment.

Bootstrap's on-box smoke also checks the deployed Neo4j bridge and daemon
isolation settings, paired egress probes and a Cypher round trip through the
relay, even with `--no-seed`. Private `/health` is **skipped** by default;
`--probe-private-health` explicitly permits a single GET that may wake the small
model. No completion or retry is made. See the
[probe scope](testing/neo4j-egress.md#existing-deployment-smoke-432-g20-rows-3-4-and-10)
and [dump-first Engine-upgrade runbook](deployment/docker-engine-upgrade.md).

Before admitting containers, install the [forwarded-only metadata policy and
its opt-in persistence unit](deployment/egress-design.md#forwarded-only-deployment-mode-676)
from a reviewed pinned artifact:

```sh
python3 scripts/metadata-egress.py --docker-user-only --persist # offline preview
sudo python3 scripts/metadata-egress.py --docker-user-only --apply --persist
sudo systemctl start vps-metadata-egress.service
sudo python3 scripts/metadata-egress.py --docker-user-only --check # read-only
```

**Operator notes** (from the #676 throwaway-host boot/restart trial):

- **On a host that still has the interim manual denies, do not use the block
  above.** Run the [replacement sequence](deployment/egress-design.md#operator-adoption-and-temporary-rule-replacement)
  verbatim, from `$APP_DIR` at the merged commit. Keep the manual denies until
  the second `--check`, and run the full bootstrap smoke before reopening
  ingress.
- **Never restart or stop the seed directly**: that restarts or stops Docker
  and every container. Reapply with
  `sudo systemctl restart vps-metadata-egress.service` or
  `sudo python3 -I scripts/metadata-egress.py --docker-user-only --apply`
  (from `$APP_DIR`), then `--check`.
- **From `--persist` on, a seed failure takes Docker and every container
  down** (fail-closed), at boot or on a Docker restart. Fix the cause named by
  the seed's `FAIL …` line (`journalctl -u vps-metadata-egress-seed.service`),
  then `sudo systemctl start docker`. If systemd reports "start request
  repeated too quickly", first run
  `sudo systemctl reset-failed vps-metadata-egress-seed.service docker.socket`.
- **Keep provider-console access available before persisting** and through
  the apply.

This mode denies the reviewed IPv4/IPv6 metadata inventory and conntrack
original destinations in `DOCKER-USER` only; host `INPUT`/`OUTPUT` and host
metadata access retain their existing policy (`scripts/metadata-egress.py:198`,
`:427`). `--only smoke` checks the installed rules and persistence, attempts a
three-second TCP connection to `169.254.169.254:80` from a throwaway default-
bridge container with all capabilities dropped, and requires app liveness both
before and after (`scripts/bootstrap-vps.sh:1945`; `scripts/metadata-egress.py:276`).
It uses the local app image without pulling, makes no metadata HTTP request,
and needs no public internet or private-tier box. A runtime error fails smoke;
an endpoint timeout alone is not packet proof. Dual-stack synthetic packet,
counter and reboot/restart evidence remains operator work. #676's trial
supplied it on a throwaway host; the live host relies on readback and smoke.

Docker **will** auto-start restart-policy containers before an After=docker.service
unit runs. Persistence now enables a required Before=docker.service seed that
creates DOCKER-USER in both families if missing and inserts the same tagged denies;
the After unit remains the strict parent/rule readback. #676's throwaway-host
boot/restart trial confirmed that this closes the firewall window across Docker
restarts and reboots ([report](https://github.com/mknw/hames-playground/issues/676#issuecomment-6253496890)).
Quiesce workloads during firewall maintenance,
reapply and verify both units and families before admission. Smoke requires an
increase in the tagged IPv4 DROP packet counter, plus health before and after.
Forwarded WireServer TCP 80/32526 is denied; host metadata and DNS 53 stay unchanged.
See the [gap-free replacement and console recovery procedure](deployment/egress-design.md#operator-adoption-and-temporary-rule-replacement)
and [policy upgrade procedure](deployment/app-upgrade.md#metadata-policy-upgrade).
Undo is `--docker-user-only --apply --remove`: it removes only journaled exact
rules/files/enablement, never a saved full table. On systemd 255 the trial saw
`--remove` keep Docker up; on another systemd, check `systemctl is-active docker`
afterwards. Restore interim/manual denies
first; an upgrade must not remove the active denies without that coverage.

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
- Those servers are enabled: neo4j-cypher, fetch, web_search, context7
> 7 tools listed in …
```

Order varies; the **set** and the **count** do not. `redis`,
`rust-mcp-filesystem`, `playwright` or `github` in that line means the overlay's
`--servers` allow-list did not apply, and `database-server` means the catalog
itself has it back (#412) — either way, stop and fix it before anyone signs in.
A count materially above 16 means the same thing (the exact number tracks the
pinned MCP images, so treat a ±1 drift after an image bump as a re-check, not
an alarm; 134 is the un-narrowed surface).

The count was 17 until 2026-10-03. With `read_only: true` the Neo4j server does
not offer `write_neo4j_cypher`, so it should now be 16. That figure is
derived, not yet read off a live box. A 17 after the change means the gateway
still lists the write tool: check `read_only` in the config above and that the
gateway was recreated. The app keeps the tool from every agent either way.

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
  --entrypoint sh hames-neo4j:local -c \
  'neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true'
docker run -d --name neo4j-restorecheck -v neo4j_restorecheck:/data \
  -e NEO4J_AUTH=neo4j/restorecheck hames-neo4j:local
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

Before moving a deployed pin, follow the [application upgrade gate](deployment/app-upgrade.md):
stop writers, take local dumps, retain the actual last-good images, then require
post-upgrade smoke including the embedder and explicitly authorized private-tier
checks. Same-disk dumps are required for this change window even while scheduled
off-box backups are deferred. That runbook also covers additive schema rollback.

**A bad app release** — the data tier is untouched, so this is a rebuild:

```bash
cd /opt/hames
test "$(id -u)" -ne 0 || exit 1
umask 022
git log --oneline -5                      # find the last good commit
( umask 022; git checkout <good-sha> )
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

- **Semantic search over uploaded documents (and memory) needs the GGUF on the
  VM.** The stack carries the embedder as the compose `embedder` service
  (profile `app`, so the `COMPOSE_PROFILES=app` of the bring-up includes it;
  internal network only; the app is pointed at `http://embedder:8090/v1`). The
  weights are not in git: the bootstrap's `boot` stage fetches them from Hugging
  Face, pinned by repository, revision commit and file SHA-256 in
  `models/embedder.lock`. Manual bring-up runs
  `python3 scripts/prepare-embedder.py models` first
  ([`models/README.md`](../models/README.md)). Each container start verifies the
  checksum; bootstrap waits for health and its smoke requires a 1024-dimension
  forward pass. The service publishes **no port**, not even on
  loopback. Alternatively point `EMBEDDINGS_LOCAL_URL` at a remote
  OpenAI-compatible embedder (the `/v1` suffix is required; "local" names the
  wire format, not the machine) or `EMBEDDINGS_PROVIDER` at a hosted one — which
  sends text off the box and is not what memory uses. See
  [`azure-vm.md` §7](deployment/azure-vm.md) and [`DATA_STASH.md`](DATA_STASH.md).
- **The Postgres image changed (#419 M8).** An existing database moves onto it
  by dump-and-restore, once: [`deployment/pgvector-migration.md`](deployment/pgvector-migration.md).
  The new image runs on a NEW volume (`pg16_glibc_data`), so an `up` before the
  migration brings up an empty database beside the old one rather than corrupting
  it — but the app would then see no data until the restore, so follow the
  runbook's order (dump before any `up`).
- **Neo4j's password is set once.** `NEO4J_AUTH` is applied only when the data
  volume is empty, so changing `NEO4J_PASSWORD` in `.env` after first boot
  changes what clients send and not what the database expects. Follow the
  [Neo4j password rotation procedure](deployment/secret-rotation.md#neo4j_password),
  including the gateway renderer and every app consumer.
- **Postgres has the same one-shot trap.** `POSTGRES_PASSWORD` is applied only
  when the data volume is initialised. It only bites on a reused volume, which
  a from-scratch preview does not have. Use the
  [Postgres password rotation procedure](deployment/secret-rotation.md#postgres_password-and-clone-database-credentials)
  for the interactive role-password change and matching client configuration.
- **No off-box backups.** `backups/` sits on the VM's own disk and nothing
  copies it away (§9). Losing the VM loses the data with it. Accepted for this
  alpha by owner decision; not a posture to carry past it.
- **The shared `memory` MCP server is retired (2026-10-22).** It was one graph
  for every signed-in user, kept in a single named volume with no per-user
  scoping. It is gone from the catalog, the gateway config and the §3a
  allow-list, and no agent is handed a memory-graph tool
  (`agent-postgres-tools.test.ts`). Personal memory is per-user, encrypted, in
  Postgres (#419). A host provisioned earlier may still hold the old
  `claude-memory` volume: it is no longer read, and exporting then removing it
  is a separate, announced operator step, backup first.
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

## 12. Two branch clones, one infrastructure stack

The [G20 row 8 ruling](https://github.com/mknw/hames-playground/pull/432#issuecomment-6238143691)
supports **one clone pinned to the release branch and another pinned to the dev
branch**. Each builds and runs its own app container. Both use the **same compose
project**, Postgres server, Neo4j, Redis, gateway, embedder and document converter.
Do not repeat §§3–7 in a second compose project. This remains provider-neutral
operator guidance ([ADR-0008](adr/0008-deployment-guidance-is-provider-neutral.md)).

`docker-compose.clones.yaml` is an **opt-in third overlay**, after the base and
production overlay. It adds only `app-dev` and extends the existing Caddy service;
`app` remains the release app and Caddy's existing upstream.
The dev app inherits `app/Dockerfile`'s built runtime,
healthcheck and shared dependencies, while its build contexts point at the dev
checkout. It has a distinct image tag and container name, and publishes no port.
It is never `pnpm dev`, Vite, a source bind mount, or a second full environment.
Both containers explicitly keep `VITE_DEV_BYPASS_AUTH=false` (SD-15).
Both checkouts must include the request-admission middleware (§4a), and both
app images must be rebuilt for the rate limit to apply. Updating Caddy alone
cannot add rate admission to an older app image.

### Checkouts, hostnames and app-only configuration

Keep two separate checkouts on the operator's chosen release/dev branches. Record
and verify **each branch name and full commit SHA before every build**; the
release checkout is the directory from which compose is run. Do not switch that
checkout to dev to build the second image. `DEV_CLONE_PATH` is the absolute path
to the other checkout; its `app/` and workspace root are the dev image's two build
contexts. Both checkouts must include these guards before enabling two apps.

Set these operator inputs in the release checkout's root `.env`:

| Input                                               | Meaning                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `COMPOSE_FILE`                                      | `docker-compose.yaml:docker-compose.prod.yaml:docker-compose.clones.yaml`    |
| `COMPOSE_PROFILES`                                  | `app`                                                                        |
| `DEV_CLONE_PATH`                                    | Absolute path to the separate dev-branch checkout                            |
| `DEV_REF`                                           | Reviewed full commit SHA; dev HEAD must match and its checkout must be clean |
| `APP_DOMAIN` / `DEV_APP_DOMAIN`                     | Distinct release/dev HTTPS hostnames                                         |
| `RELEASE_RUNTIME_ENV_FILE` / `DEV_RUNTIME_ENV_FILE` | Separate absolute paths to app-only runtime env files                        |
| `RELEASE_DATABASE_URL` / `DEV_DATABASE_URL`         | The separate-database policy below                                           |

The persisted `COMPOSE_FILE` is also bootstrap's explicit clone opt-in; no new
flag is needed. Bootstrap accepts exactly the file order above, optionally followed
by **one** dev sandbox overlay: `:docker-compose.dev-sandbox.yaml` for the existing
owner socket opt-in, or `:docker-compose.dev-sandbox-vm.yaml` for dev's own
environment VM ([below](#dev-sandbox-on-its-own-environment-vm)). Only after the
second may `:docker-compose.release-sandbox-vm.yaml` follow, for release's own
VM ([below](#release-sandbox-on-its-own-environment-vm)); no other order or
combination is accepted. Keep
`COMPOSE_PROFILES=app`. Set these as literal values (quote paths if needed), not
shell exports or interpolated expressions. Bootstrap refuses clone-specific inputs
under the single-app file list, unsupported file orders, missing inputs, relative
or missing runtime files, and missing overlay/validator/Caddy files. Alternate
`export KEY=value` or `KEY = value` spellings of the Compose/clone inputs are
refused in both shapes. Bootstrap requires `DEV_REF` to match the clean dev
checkout's HEAD; it does not update that checkout for you. It never
silently falls back to the root app env or the administrator database URL.

Create both app-only files with mode 0600, outside **both** checkouts (canonical
paths are checked). Bootstrap refuses group/other permission bits. Use the app
settings in `.env.production.example` as the inventory, but **do not copy the root
file wholesale**: omit `POSTGRES_PASSWORD`, compose controls, and the other
clone's settings/secrets. The validator also refuses root-only `RELEASE_DATABASE_URL`,
`DEV_DATABASE_URL`, `*_RUNTIME_ENV_FILE`, `DEV_CLONE_PATH` and `COMPOSE_FILE` in app envs,
sibling passwords/URLs/keys under any variable name, and the rendered Postgres
administrator password anywhere in either app env. Database role passwords must
differ, and `postgres`, `template0` and `template1` cannot be app databases.
The overlay supplies each app's `DATABASE_URL`, Entra
callback/logout URLs, sandbox namespace/cache, shared-service endpoints and
Neo4j credentials. Keep `VITE_ALLOWED_EMAILS` separate for each app and leave it
unset at image-build time. Runtime allow-lists win (`app/src/lib/auth/allowList.ts`).

Register **both exact HTTPS callbacks** in Entra (§5), one per hostname:
`https://<release-host>/api/auth/callback` and
`https://<dev-host>/api/auth/callback`. An app registration can list both; reusing
that registration is deliberate, but it does not justify reusing application
keys. Generate **independent `DATA_ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and
`TOKEN_ENCRYPTION_KEY` for each clone**, and escrow each key set separately (§7).
In clone mode, `--only env --keys-escrowed` fingerprints all six runtime-file
keys; changing any one invalidates the attestation. Unused root application
keys do not satisfy this gate. Boot also checks the owner-required settings in
each runtime file, including its Entra secret and allow-list.
Never put release ciphertext or a release database dump into dev. A second key
alone is not database isolation: it can instead turn a schema/backfill mistake
into an unreadable database. Auth cookies have no `Domain` attribute
(`app/src/lib/auth/cookies.server.ts`); independent signing keys also prevent one
clone accepting the other's signed login handshake (SD-17).

The clones overlay mounts `configs/Caddyfile.dev` into Caddy's optional
`dev-sites/*.caddy` import and requires `DEV_APP_DOMAIN`. That second site routes
only to `app-dev:3444`, shares the release site's request/SSE settings (§4a), and
keeps dev upstream failure confined to the dev hostname (502); Caddy startup
does not depend on dev health. Without the overlay there is no mounted dev site
and no dev-host environment variable in Caddy. Keep the hostnames distinct;
the §12 preflight already refuses shared callback origins. DNS, callback
registration and allow-list smoke are needed for **each** hostname; offline
pins do not establish reachability or authentication correctness (SD-18).

### Database policy — separate databases and limited roles

**Owner-approved row 8c:** both containers use `postgres:5432`, but each has its own
database and login role. Neo4j and Redis remain shared. This removes cross-clone
schema-hash churn and prevents either clone's encrypted-column backfill touching
the other's rows. The policy inputs are isolated in
`docker-compose.clones.yaml`'s `x-clone-database-policy`; its matching checks are
in the database-policy section of `scripts/validate-clones.mjs`. Keep this one
policy section and its matching guard aligned if the owner changes the decision;
there is no silent shared-database fallback. No host has been accessed by this step.

The operator provisions two databases/roles on the **existing**
server, using an administrator session (`psql`, not a committed credential).
For **new empty databases**, the shape is the following generic SQL; choose the
actual names privately and supply passwords with psql's interactive `\password`
command, never as shell arguments or committed SQL:

```sql
CREATE ROLE release_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE dev_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE app_release OWNER release_app;
CREATE DATABASE app_dev OWNER dev_app;
REVOKE CONNECT, TEMPORARY ON DATABASE app_release FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE app_dev FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE hames, postgres FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE app_release TO release_app;
GRANT CONNECT, TEMPORARY ON DATABASE app_dev TO dev_app;
```

Do not grant either role membership in the other, server administration, or
rights on the other database. The explicit revocation above also closes the
legacy `hames` and maintenance `postgres` databases to `PUBLIC`. Install the
`vector` extension as administrator **in each new database** before app startup. Set each URL to its own role/password and database
on `postgres:5432`. The apps must never receive the Postgres administrator
credential. An existing release database needs an operator-reviewed ownership /
grant migration and a dump first; the empty-database example is not an in-place
migration and must not be run over live data. No automated migration is shipped.

Before either app starts, verify the role attributes and `has_database_privilege`
for both cross-database directions as administrator, and attempt each cross-login:
both must be denied. Also check the legacy release database as administrator:

```sql
SELECT has_database_privilege('dev_app', 'hames', 'CONNECT'); -- must be false
```

Then each app role must be able to bootstrap its own schema.
The offline config check validates distinct role/database names, not server ACLs;
these live grant checks remain owed. `SCHEMA_SQL` stays additive/idempotent even
with separate databases; its unit pin refuses destructive schema or data edits.

### Preflight and build

From the release checkout, after reviewing both branch/commit pins and configuring
the inputs above:

```bash
set -o pipefail
docker compose config --format json |
  docker run --rm -i --pull never --network none --read-only --cap-drop ALL \
    --user "$(id -u):$(id -g)" --entrypoint node \
    -v "$PWD":"$PWD":ro -v "$DEV_CLONE_PATH":"$DEV_CLONE_PATH":ro \
    hames-app:local "$PWD/scripts/validate-clones.mjs" &&
  docker compose up -d --build app app-dev
```

The `&&` prevents startup after a failed preflight, including when pasting the
whole block. Stop on any failure; do not run startup separately after one. **Never
save or print the rendered config**: it contains secrets. The validator's CLI
prints no input or secret-bearing parse error. It refuses shared encryption /
signing keys, callbacks, sandbox caches/namespaces and database roles/databases,
and refuses a dev command override, a shared canonical build path, shared configs,
a dev socket without owner opt-in or a published dev port.
Re-run it before every manual recreate. Bootstrap runs this same validator
itself before clone Compose operations, including `images`, `boot`, and smoke
probes. The validator runs inside the release app image (`hames-app:local`,
never pulled) as you, so the host needs no Node; export `DEV_CLONE_PATH` from
the root `.env` (§12). The block above is for the socket shapes only, run from
real (non-symlink) checkout paths: it mounts the two checkouts and nothing else.
With a VM overlay selected, run bootstrap's own preflight instead
(`--only boot --dry-run` changes nothing): it resolves every host path on the
host, then mounts the checkouts and each `*_SANDBOX_DOCKER_TLS_*` file at its
real path. A missing image, a failed render, or failed validation prevents the
operation.
Rendered configuration goes directly to the validator; it is never saved or
printed. This is an operator preflight, not a runtime Docker authorization boundary.

Once configured, re-run bootstrap with the deployment's existing hostname/ACME
arguments and reviewed full `--ref`, selecting `--only images,boot --no-seed`
(or `--only boot --no-seed` for already-built images). It uses one Compose project
from the release checkout for **both** apps, retains the optional dev socket
overlay, waits for `app-dev` health as well as release health, and does not pass
`--remove-orphans` in clone mode. The single-app shape retains its existing
`docker compose up -d --remove-orphans` command unchanged.
Before that single-app command, a read-only project-scoped container query refuses
if an `app-dev` container still exists. Restore the clone file list rather than
letting a single-app boot prune it. An unavailable query also refuses startup.

Run `--only smoke --no-seed` afterwards. When clones are enabled, smoke runs
the same §12 preflight first, so the root `.env` must still hold the complete
clone input set — `DEV_REF` among them (a non-secret §12 input only the
bootstrap reads) — or smoke refuses before any probe. Smoke also
compares both running apps' database URLs, keys, callbacks, auth bypass and sandbox
namespaces/cache names with the validated configuration, and requires both apps
to be healthy in one Compose project. It makes a read-only TCP database login
with each running app's own credentials and checks the effective role/database
and non-admin role attributes, no role memberships, and denied `CONNECT` on the
sibling database and `postgres`. Database names are passed separately and queried
as parameters; no credentials are printed. Smoke compares each running `/configs`
and Docker socket mount with the render, and refuses a dev socket without the
owner opt-in. An old release still using the root administrator URL fails this
check. Administrator checks on the legacy `hames` database and browser sign-in
checks on **both** hostnames remain operator work. Offline tests do not establish
live grants or host isolation (SD-18/SD-19).

Caddy file-content detection remains tracked in #672. After changing a Caddyfile
or its imported sites, explicitly recreate only Caddy with
`docker compose up -d --no-deps --force-recreate caddy` using the same full Compose
file list. Keep the existing `caddy_data` volume so its certificates are retained;
never delete it as part of an app update.

Sandbox resources carry `kg-sandbox-environment=release` or `dev`; the startup
reaper filters **containers and networks** by both that label and `kg-sandbox=1`.
Both overlays set distinct `SANDBOX_CACHE_VOLUME` bases. Production backends
refuse a missing environment label. Unlabelled legacy sandboxes are deliberately
left alone: after confirming no old run is active, inspect and remove them by
explicit resource ID, never by an unscoped family-label sweep.

### Dev sandbox on its own environment VM

[#648](https://github.com/mknw/hames-playground/issues/648) moves one clone's
sandbox off the host socket onto that clone's **own** VM, which runs its own
Docker daemon. The app reaches that daemon over mutual TLS. Nothing is shared
between clones: one VM, one CA and one client certificate per clone. Dev moves
first. Release keeps the host socket until its own VM lands, per the owner's
answer on #648; [its move](#release-sandbox-on-its-own-environment-vm) follows
the same steps once dev is on its VM.

1. **Provision dev's VM and deliver its client files** with the operator entry
   point. Run it from the repo root of a checkout of the reviewed commit, after
   a workspace install (`corepack pnpm install --frozen-lockfile`). It holds the
   Incus manager credential, so it never runs inside an app:

   ```bash
   corepack pnpm dlx tsx@4.21.0 packages/sandbox/scripts/incus-environment.ts reconcile /operator-private/dev.json
   corepack pnpm dlx tsx@4.21.0 packages/sandbox/scripts/incus-environment.ts health /operator-private/dev.json --wait 600
   ```

   - **The config file** is operator-private. It holds the
     [`createIncusEnvironment` options](../packages/sandbox/README.md#incus-environment-vms-operator-opt-in),
     with the manager's three PEM files given as paths, plus
     `delivery: { directory, owner? }`. An unknown or misspelt key is refused.
   - **`reconcile`** creates or verifies the VM. It then copies only the CA
     certificate, the client certificate and the client key into
     `delivery.directory`: mode 0700, files 0600, owned by `delivery.owner` when
     set. Set the owner to the operator user who runs bootstrap, because the
     preflight reads the files. Keep the directory outside both checkouts.
     Unchanged files keep their inode, so a running app's binds stay valid. The
     provisioner's state directory, which holds the CA key, is never delivered.
     `reconcile` prints the four Docker inputs for step 2.
   - **`health`** probes Docker over mutual TLS with the delivered files,
     exactly as the app will. It stops at once if the daemon is not this
     environment's.

   Before routing app-dev to the VM, prove that only app-dev reaches the VM's
   Docker port, and record that proof for step 2. The one allowed source is the
   dev link network, `envapp-dev`, with app-dev at its pinned address. Create
   that network once, before the overlay, on a subnet that overlaps no host
   route and none of Docker's address pools:

   ```bash
   docker network create --driver bridge --subnet <link-subnet> --gateway <link-gateway> \
     --opt com.docker.network.bridge.name=envapp-dev envapp-dev
   ```

   The rules belong to the environment VM network guard,
   `scripts/env-vm-guard.py`. Its `--smoke --record <path>` removes any earlier
   evidence record when it starts and writes a new one only when every probe
   passes. [The plan](plan/env-vm-network.md)
   has the rules, the probes and the operator runbook. Neither the provisioner
   nor the entry point sets firewall rules.

2. **Set the dev-only inputs** in the release checkout's root `.env`, as literal
   values:

   | Input                           | Meaning                                                        |
   | ------------------------------- | -------------------------------------------------------------- |
   | `DEV_SANDBOX_DOCKER_HOST`       | `tcp://<dev VM guest IPv4>:<port>`                             |
   | `DEV_SANDBOX_DOCKER_TLS_CA`     | Absolute path to dev's delivered CA certificate                |
   | `DEV_SANDBOX_DOCKER_TLS_CERT`   | Absolute path to dev's client certificate                      |
   | `DEV_SANDBOX_DOCKER_TLS_KEY`    | Absolute path to dev's client key                              |
   | `DEV_SANDBOX_FIREWALL_EVIDENCE` | Absolute path to the operator's firewall evidence record       |
   | `DEV_SANDBOX_LINK_ADDRESS`      | app-dev's pinned IPv4 address on the `envapp-dev` link network |

   The evidence record is the guard smoke's record. It proves that only the
   link network's pinned address, which app-dev takes, reaches the VM's Docker
   port. The preflight refuses the overlay until that file exists and is not
   empty. It never reads what the file says.

3. **Append the overlay**: `COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml:docker-compose.clones.yaml:docker-compose.dev-sandbox-vm.yaml`.
   It declares `x-clone-dev-sandbox: per-env`, replaces app-dev's mounts with
   its configs plus the three files (read-only, never created when missing) and
   sets the four `SANDBOX_DOCKER_*` settings. It also attaches app-dev to the
   external `envapp-dev` network at `DEV_SANDBOX_LINK_ADDRESS` with
   `gw_priority: 1`, which makes that network app-dev's default route. App-dev
   stays on `app-network` for its data services. `gw_priority` needs a Compose
   release that supports it. The overlay cannot be combined with the socket
   opt-in.
4. **Run the same preflight**, then recreate app-dev with bootstrap's
   `--only boot --no-seed`, then `--only smoke --no-seed`. With the VM overlay
   selected, that smoke also runs the guard's read-only `--check` against the
   installed config and refuses when it does not pass.

For a clone declared `per-env`, the validator refuses:

- any Docker socket, under any target or source name, and any mount besides
  the configs and the three TLS files;
- an endpoint that is not `tcp://` to a unicast IPv4 guest address (loopback,
  link-local, unspecified and multicast addresses are refused), or TLS settings
  that do not name the mounted files;
- any `DOCKER_*` variable, which the terminal path would inherit as a second
  endpoint;
- a CA or certificate file that holds a private key or more than one
  certificate, a CA file that is not a CA, a client certificate that is a CA,
  is not signed by its own CA or does not match its key, a CA or client
  certificate outside its validity period, a key file with any group or other
  permission, and TLS files inside either checkout;
- with both clones `per-env`, a shared guest address, or either clone's client
  certificate verifying under the other clone's CA;
- networks other than exactly `app-network` and the clone's own external link
  network, `envapp-<clone>`; a link attachment without `gw_priority: 1` or
  without a pinned unicast IPv4 address; `app-network` as the default route;
  and any other service on that link network, under whatever key it names the
  network with, `app-network` renamed to it included;
- another service built from, tagged as, or sharing a namespace or mounts with
  the VM clone, joining any container by id, or mounting the VM clone's TLS
  files or a directory that holds them, whether through a bind, the file behind
  a `secrets` or `configs` entry, or a named volume whose local driver binds a
  host path.

For both apps, whatever their mode, it refuses `privileged`, `devices`,
`cap_add`, `volumes_from`, `secrets`, `configs` and shared `pid`, `ipc`,
`network_mode`, `userns_mode` or `cgroup` namespaces. Each reaches host or
sibling resources around the mount rules; the MCP gateway, for one, holds the
host socket, and Compose bind-mounts the file behind a secret or config at any
target, a socket included. A clone declared `socket` mounts no host path but its
configs and the socket, including through a named volume whose local driver
binds one, and must not carry any `SANDBOX_DOCKER_*` setting. The render
leaves out services of any other profile, so the preflight also refuses a
`profiles:` value other than `["app"]` in the selected Compose files. Smoke compares
both running apps' endpoint settings and TLS mounts with the render, and refuses
any mount on a VM clone that the render does not list. For a VM clone it also
compares the live link network with the render: its bridge name, one IPv4
subnet that holds the pinned address, the clone as its sole member, and the
clone's address on it.

**Reboots, rotation and concurrency.**

- **Reboots.** The state directory and the delivery directory must be on
  persistent storage. The entry point refuses `/tmp`, `/var/tmp`, `/run`,
  `/dev` and similar mounts, also behind a link and under their macOS
  `/private` names. After a host reboot, Incus
  restores each VM's last power state. Re-run `health --wait 600`, and run
  `reconcile` if the VM was stopped: it starts the VM and never generates new
  keys for an existing state.
- **Rotation.** The client certificate is valid for 365 days. `health` warns
  30 days before expiry, and once it has expired says so at once, instead of
  waiting on a daemon that keeps refusing it. To rotate, run `teardown`, then
  `reconcile`, then recreate app-dev: the paths are unchanged, but the files are
  new inodes. A failed teardown keeps the state and the delivered files for
  recovery.
- **One operation per state directory.** A `<stateDirectory>.lock` beside the
  directory records the holder's pid and boot, and refuses a second operation
  while that holder runs. A lock whose holder is gone, after Ctrl-C, a kill or
  a reboot, is reclaimed, and the entry point says so. A refused lock with no
  operation running means its pid now belongs to another process: remove it
  by hand. `teardown` keeps a delivery directory that holds other files, and
  says so.

**What this does not establish.** The preflight's checks are offline and see
configuration only, and smoke compares what Docker reports with that
configuration. Neither proves network isolation between the clones' VMs, or
between a VM and host services: that is the guard smoke's evidence, which the
preflight requires but never reads. The guard cannot refuse a holder of the
host Docker socket, which is root-equivalent: the release app and the MCP
gateway hold it ([plan §10](plan/env-vm-network.md#10-deliberately-left-out)).
Dev holds root inside its own VM, by design. The MCP gateway shares
`app-network` with both apps. Still owed live: `createIncusEnvironment`
creating and booting a VM on a real Incus host (the spike harness provisioned
its own VMs), and Docker answering after a guest reboot and after a host
reboot.

**Rollback.** Remove the overlay from `COMPOSE_FILE` and recreate app-dev. Dev
is then back to no Docker access and no sandbox agents. Tear down the VM, the
link network and the guard separately, in the plan's
[rollback order](plan/env-vm-network.md#7-operator-runbook).

### Release sandbox on its own environment VM

Release moves the same way, **after** dev is on its own VM, and never on dev's VM
or dev's credentials: release's own VM, CA, client certificate, link network and
evidence. Each step mirrors dev's [above](#dev-sandbox-on-its-own-environment-vm).

1. **Provision release's VM** with the entry point and its own operator-private
   config: environment `release`, bridge `envvm-release`, its own guest address,
   state directory and delivery directory. Create its link network,
   `envapp-release`, on a subnet of its own that overlaps no host route, no
   Docker address pool and not `envapp-dev`.
2. **Add `release` to the guard config** as a second environment, with service
   `app`. That is a firewall rule change: it adds release's own allow and reply
   rules, and nothing else ([plan §2.1](plan/env-vm-network.md#21-the-guard-table)),
   so review it before it is persisted. `--apply` refuses while any environment
   VM runs, so every environment VM — dev's and the release VM just provisioned
   in step 1 — is stopped for the apply, under the dead-man. Then run
   the guard smoke: its one record covers both environments, and the
   VM-to-VM probes now attribute each pair.
3. **Set the release-only inputs** in the root `.env`, as literal values:

   | Input                               | Meaning                                                               |
   | ----------------------------------- | --------------------------------------------------------------------- |
   | `RELEASE_SANDBOX_DOCKER_HOST`       | `tcp://<release VM guest IPv4>:<port>`                                |
   | `RELEASE_SANDBOX_DOCKER_TLS_CA`     | Absolute path to release's delivered CA certificate                   |
   | `RELEASE_SANDBOX_DOCKER_TLS_CERT`   | Absolute path to release's client certificate                         |
   | `RELEASE_SANDBOX_DOCKER_TLS_KEY`    | Absolute path to release's client key                                 |
   | `RELEASE_SANDBOX_FIREWALL_EVIDENCE` | Absolute path to the guard smoke's record covering `release`          |
   | `RELEASE_SANDBOX_LINK_ADDRESS`      | The release app's pinned IPv4 address on the `envapp-release` network |

   As for dev, the preflight refuses the overlay until the evidence file exists
   and is not empty. Release's file is also read, for its structure only: it
   must be a guard smoke record whose `environments` hold probes for `release`,
   so dev's record, or one written before release joined the guard config, is
   refused. Dev's own inputs and evidence stay required, and dev's record is
   still not read. The guard smoke writes the record as root, mode 0600; leave
   it so, because bootstrap reads it through `sudo`.

4. **Append the overlay after dev's**:
   `COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml:docker-compose.clones.yaml:docker-compose.dev-sandbox-vm.yaml:docker-compose.release-sandbox-vm.yaml`.
   It declares `x-clone-release-sandbox: per-env`, replaces the release app's
   mounts with its configs plus the three files, so the **host Docker socket is
   no longer mounted**, sets the four `SANDBOX_DOCKER_*` settings and attaches
   the app to `envapp-release` at `RELEASE_SANDBOX_LINK_ADDRESS` with
   `gw_priority: 1`. Bootstrap refuses the release overlay alone, before dev's,
   beside the dev socket opt-in, or twice.
5. **Tag the running release image for rollback**, then run the same preflight.
   Recreate the app with `--only boot --no-seed`, which takes release down while
   its container is recreated.
   Then run `--only smoke --no-seed`, which runs the guard's `--check` for this
   shape too.

The validator's `per-env` rules above apply to release unchanged, and with both
clones on their VMs it also refuses a shared guest address and either clone's
certificate verifying under the other's CA. The MCP gateway still holds the
host socket ([plan §10](plan/env-vm-network.md#10-deliberately-left-out)).

**Rollback.** Drop `:docker-compose.release-sandbox-vm.yaml` from `COMPOSE_FILE`
and recreate the app: release is back on the host socket and dev is unchanged.
Remove `release` from the guard config, its link network and its VM separately.

### Shared state and the limits of the claim

This shape isolates application Postgres rows, keys and ordinary sandbox cleanup;
it **does not isolate all clone data**. Both clones can read/write the shared
Neo4j graph; Redis stash keys are also shared (and, on a host not yet moved to this code, the retired gateway memory volume).
Use synthetic/demo data only until that shared-data posture is acceptable to the
operator (SD-10, SD-18). Do not describe dev as an untrusted staging boundary.
The release app retains the root-equivalent Docker socket (SD-19) until its own
VM overlay is applied ([above](#release-sandbox-on-its-own-environment-vm)). Dev has no
socket by default and mounts only its own checkout's read-only `configs/`;
sandbox agents on dev therefore remain unavailable. Dev's own environment VM
([above](#dev-sandbox-on-its-own-environment-vm)) enables them without host
Docker access. The other owner knob is
adding `docker-compose.dev-sandbox.yaml` **after** the clones overlay in
`COMPOSE_FILE`. That opt-in supplies both `x-clone-dev-docker-socket: true` and
the socket mount; the validator refuses a dev socket without that policy.
Enabling it lets dev code bypass labels, access sibling containers and recover
their secrets, regardless of DB/key separation. Namespace labels prevent
accidental cleanup only. Keep the opt-in out unless the owner accepts this
exposure. This supported option follows ADR-0008; ADR-0007 is superseded and
needs no additional note.

Tests use the shared `resolveTestDatabase()` gate before connecting. Explicit
URLs must name test databases with explicit unencoded hosts; all port-5432
targets (including an omitted port) are refused without owner opt-in;
the existing checkout-bound **owner-only** local opt-in remains the documented
exception, for test-named databases only. Agents must use a separate throwaway
server or the exact dead-port no-DB sentinel; a copied opt-in cannot authorize a
worktree. See [the pyramid](testing/pyramid.md#which-postgres-a-test-run-may-touch).
No DB/browser or live-provider checks ran for this repo-only step, and Verda
remains paused: never wake/probe it for these checks.

## 13. Deploy and promotion, once the workflows exist

None of these workflows exist in this repository yet. This is the shape that
keeps the artifact that was approved the artifact that ships: an environment
that pulls runs the digest the environment before it ran, never a rebuild.
For the current two-branch clone shape, the owner's G20 ruling in §12 governs;
this future promotion workflow still requires the tested digest, without a
rebuild. A single box that builds its own image from a pinned commit (§14)
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

For §12's two-clone shape, bootstrap reads the complete ordered `COMPOSE_FILE`
from the release checkout's root `.env`, validates both apps before Compose
operations, and keeps `app-dev` in the same project through `images`, `boot` and
smoke. Prepare both app-only env files, the separate checkout and limited database
roles first; bootstrap does not provision databases or grants. The clone
validator runs inside the release app image, so the host needs Docker only,
never Node (#681). Omitting clone inputs keeps the single-app command path
unchanged.

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

| Stage       | What it changes on the box                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight` | Nothing. It refuses anything that is not x86_64 (#412), not Ubuntu, under 4 GiB of RAM or under 20 GiB of free disk, a root login, or a user without passwordless sudo                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `updates`   | `apt-get upgrade`, plus `/etc/apt/apt.conf.d/20auto-upgrades`, which turns on daily unattended upgrades from the security origin only. Docker's repo is not in that origin, so the engine is never upgraded under the stack. Reboots are never automatic                                                                                                                                                                                                                                                                                                                                                                                     |
| `ssh`       | `/etc/ssh/sshd_config.d/00-hames-hardening.conf`: keys only, no passwords, no keyboard-interactive, no root login, and `Port` lines only if `--ssh-port` is given. The `00-` prefix makes it sort first, because sshd keeps the first value it reads and a cloud image's `50-cloud-init.conf` can turn passwords back on. The stage runs `sshd -t` before any reload and reads the result back with `sshd -T`                                                                                                                                                                                                                                |
| `firewall`  | `ufw`: deny incoming, allow outgoing, allow the SSH port(s), 80/tcp, 443/tcp and 443/udp, on IPv4 and IPv6. Each SSH port is allowed and read back before `ufw` is enabled. It prints the rules for a firewall in front of the box                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fail2ban`  | Installs `fail2ban` and writes `/etc/fail2ban/jail.local` with the baseline `[sshd]` values: `maxretry = 3`, `findtime = 5m`, `bantime = 30m`, on the SSH port(s). `ignoreip` is loopback plus the operator: `--f2b-ignore <ip>[,…]`, else this SSH session's own client address, printed. It refuses to overwrite a `jail.local` it did not write                                                                                                                                                                                                                                                                                           |
| `docker`    | Docker Engine and the compose plugin from Docker's apt repository, never the snap. It checks that the key file holds exactly Docker's one signing key and refuses if Docker publishes no suite for the release. It writes `/etc/docker/daemon.json` with log rotation if the file is absent, requires Compose 2.24 or later, and adds the login user to the `docker` group                                                                                                                                                                                                                                                                   |
| `checkout`  | Clones the repo into `/opt/hames`, detached at `--ref`, a required full commit SHA, fetched by id if no branch carries it. It refuses a dirty tree and any commit older than #260. It writes §3a's four-server `configs/mcp-config.yaml` and never touches the tracked `docker-config.json`                                                                                                                                                                                                                                                                                                                                                  |
| `env`       | Creates `.env` (mode 600) from the template. It generates the two database passwords and the three keys on the box, and never regenerates an existing value or one a data volume already depends on. It lists, or prompts for, the owner's values. `--keys-escrowed` records the escrow, except on the run that generated the keys                                                                                                                                                                                                                                                                                                           |
| `hostname`  | Writes `APP_DOMAIN`, `ACME_EMAIL` and the two auth URIs into `.env`, checks that DNS points at the box, and prints the Entra steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `images`    | Requires Engine >= 28 and safe daemon isolation settings before `docker compose build` and `pull`, a host pull of the four allow-listed MCP server images (in the gateway a failed pull is only a warning), and `docker build -t kg-sandbox:base rootfs/`. `--sandbox-flavours` also builds the three flavour images the `flavoured-sandbox` agent needs                                                                                                                                                                                                                                                                                     |
| `boot`      | Runs every gate first: the gateway pin, `dynamic-tools` disabled, §6's preflight, the escrow, DNS, a GitHub-token scan, and the rendered config (every port but Caddy's on loopback, the gateway allow-listed). The ACME gates check `.env`’s `ACME_EMAIL` (#664): unset or reserved values are refused, and a mismatch with `--acme-email` stops for the owner. Then it runs `docker compose up -d`, verifies the deployed Neo4j network is internal/isolated, recreates only Caddy when its bind-mounted Caddyfile no longer matches the checkout's (#672; a dry run lists the recreate without reaching it), and waits for service health |
| `seed`      | Imports `neo4j_dumps/seed-data.cypher`, or `--seed-file`, through `scripts/import-neo4j.sh`, and only into an empty graph. It never passes `--wipe`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `smoke`     | §8's on-box half: `ss` shows nothing public but the SSH port(s), 80 and 443; the gateway serves exactly the four servers; the running Caddy serves the checkout's Caddyfile (#672); HTTP redirects to HTTPS; `/api/health` answers over a valid certificate; an unauthenticated `POST /api/events` gets 401; there is no GitHub token; `dynamic-tools` is still disabled; the graph is not empty; Neo4j isolation and paired egress probes pass; Cypher traverses the relay. Private `/health` is skipped unless `--probe-private-health` is supplied (may wake a box)                                                                       |

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
- The private tier (§6): `LARGE_LLM_BASE_URL`,
  `LARGE_LLM_API_KEY`, `SMALL_LLM_BASE_URL`, `SMALL_LLM_DECISIONS_URL`
  and `SMALL_LLM_API_KEY` — all five or none; staging configures all five.
  The two base URLs end in `/v1`; the full decisions URL ends in
  `/v1/systemone`. `USE_SELF_DEPLOYED_INFERENCE` is a separate boot-time switch (it
  requires the tier to be configured), not a sixth required tier value.
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
pin was shown to go red by a mutation. The portable `--clones-only` subset uses
the real validator and an inert Docker shim to pin the ordered overlay, both-app
lifecycle, failed preflight, partial configuration refusal and byte-exact default
boot command transcript; `--clone-mutations` turns each guard red in CI. Before the script was made
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

| Claim                                            | Reality today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Names are pseudonymised before prompts go out." | The substitution modules exist and are tested, but nothing in production imports them — `grep -rn pseudonymise app/src` returns only the modules under `app/src/lib/privacy/` and their own tests, on this branch and on `main`. Every egress path is unhooked, mapped path-by-path in PR #258 (merged).                                                                                                                                                                                                                                                                                                                                                                                                                                              | a decision that has not been taken yet — `docs/plan/graph-pseudonymisation.md` holds the open questions. PR #264 (merged 2026-08-26) supplied the roster the substitution would read from, which leaves the hook itself as the only missing piece                                                                                                                                                                                                                                                                                 |
| "Inference runs on our own hardware."            | With the endpoint configured, every signed-in user gets a per-conversation switch (beside the Agent selector, with the chosen tier shown on every sidebar row) and **every** role follows it, the prompt-injection screen included. So no model call a turn makes goes off the box on that setting. Two edges: the embeddings provider is a separate seam (boot refuses an `EMBEDDINGS_PROVIDER` that is not `local` or declared trusted in code, so `openrouter`, which would send query text out, cannot be selected), and the screen's own client is now an **unmeasured** screener — the owner accepted that trade knowingly, and `pnpm eval:harness`'s `screen-on-the-tier` scenario is what settles it. No agent enables that classifier today. | **Shipped and widened twice** — PR #263 merged 2026-08-26 (controller / actor / critic / synthesizer); the router / planner / describe roles were added the same day on the owner's call, because the router sees the raw user message and `describe` sees tool results verbatim; the injection screen followed on the rule that no call made under the private tier may be sent to any public AI provider (owner decision, answer 7). There is no exception left. With the endpoint unset, nothing about this deployment changes |

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
> above has now landed twice, and the default path for a new user is **self_deployed
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
  catalog.** `--enable-all-servers` with a mcp-config.yaml naming only the allow-listed servers:
  _nine_ servers enabled, 134 tools — the config file does not narrow anything,
  which is why the allow-list and not the config file is the control.
  `--servers=neo4j-cypher,fetch,web_search,context7,memory` (the allow-list
  at the time, before the `memory` server was retired): five servers, 17
  tools. The same allow-list against the development `mcp-config.yaml` that
  still carries a `github:` block: still five servers, still 17 tools, no
  `github`. These figures predate the retirement and have not been re-measured.
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

Inference naming and one-release compatibility: [complete migration table](deployment/self-deployed-migration.md).
