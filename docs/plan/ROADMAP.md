# Roadmap — multi-user aspirational shape

> **Status: active plan.** Converged 2026-07-14/16. Live tracking on the
> [GitHub project board](https://github.com/users/mknw/projects/5) (the `MSCW`
> field mirrors the Must/Should/Could/Won't ratings below); this file holds the
> *shape* — phases, dependencies, and the architecture the phases build toward.
> Update both together.

## Target architecture

Two reframes drive everything:

1. **The MCP gateway is the *shared/org-identity* tool boundary — not the
   one-shop for all tools.** Anything needing *per-user* identity is an
   **app-side tool template**: the server resolves the user's token/secret from
   the authenticated `userId` at call time (the generalized `neo4j-driver`
   shape). The tool schema exposed to the model has **no token field**; secrets
   never enter prompt/context/event log (#107 principle 1).
2. **Isolation is physical, never LLM self-scoping.** The LLM writes arbitrary
   Cypher/queries, so scoping binds to the *connection* (per-user database,
   user-keyed prefix, Entra-delegated token) — not to query text (#107
   principle 2).

```
 User (browser / iOS shortcut)
        │  Entra SSO (OIDC)  ←──────────── #119: THE foundation
        ▼
┌──────────────────────────────────────────────────────────────┐
│  App server — SolidStart, single VM (compose + Caddy)          │
│  authenticated userId → runWithUserId(...)                     │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ Server-side credential resolver — never a tool arg         ││
│  │  Pattern A (#108)      Pattern C (#110)     Pattern B (#109)││
│  │  org identity          Entra OBO            per-user vault  ││
│  │                                              [deferred]     ││
│  └───┬──────────────────────┬─────────────────────────────────┘│
│      ▼                       ▼                                  │
│  ┌─────────┐        ┌──────────────────┐                       │
│  │  MCP    │        │ App-side tool     │                       │
│  │ gateway │        │ templates         │                       │
│  │ (shared │        │ MS Graph via OBO  │                       │
│  │ org id) │        │ (mailbox/calendar)│                       │
│  └────┬────┘        └──────────────────┘                       │
│   fetch/web/context7/fs/playwright/redis/github(App token)/…   │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Data layer — per-user scoped                               │ │
│  │  Neo4j/DozerDB db-per-user (#121) · Postgres · Redis       │ │
│  │  (user-keyed) · encrypted MSAL refresh cache ── Key Vault  │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Deployment stays **single VM + `docker compose up -d` + Caddy** for this whole
cycle (see [`../deploy/azure-vm.md`](../deploy/azure-vm.md)); the app keeps
per-session state in process memory, so multi-replica is out of scope until
that state is externalized.

## Critical-path spine

```
                        ┌─ Pattern A RBAC (#108) ──┬─ per-user Neo4j / DozerDB (#121)
Entra SSO (#119) ──────►├─ #106 live smoke test     ├─ per-user Redis objects
(external lead time:    ├─ per-user data everywhere
 tenant owner)          └─ Pattern C OBO (#110) ◄── MSAL refresh cache on Key Vault

auth-independent, start now: gateway client pool (#120) · prompt caching (#122)
                             multi-session (#105) · sandbox sweep+cap (#82)
```

**#119 (Entra SSO) gates five workstreams and carries external lead time**
(tenant owner: app registration + admin consent). Start that conversation
first; everything in Phase 0 proceeds in parallel meanwhile.

## Phases

### Phase 0 — concurrency floor + quick wins *(auth-independent, in parallel)*

| MSCW | Item | Why now |
|---|---|---|
| **Must** | #120 gateway client pool + connection-scoped reconnect | One user's transport reconnect currently tears down every other user's in-flight gateway call (`mcp-client.server.ts` singleton). Correctness floor for #105 and multi-user. |
| **Must** | #105 PR 1 — reattach live view on switch-back + sidebar spinner | The "interrupted conversation" complaint; backend continuity already exists. |
| **Should** | #122 Anthropic prompt caching (BAML `cache_control`) | Router→Controller→Critic→Synth chains re-send stable prefixes within seconds; textbook cache shape. |
| **Should** | #82 sandbox timer-driven sweep + LRU cap | Last open sandbox-lifecycle gap (#97 closed). |
| **Could** | #105 PR 2 — multi-active cap ("max N reached — wait for a session to stop") | Policy layer over PR 1's plumbing. |

### Phase 1 — identity foundation *(the gate)*

| MSCW | Item | Notes |
|---|---|---|
| **Must** | #119 Entra SSO (replace/federate Stack Auth) | Company is on M365 → Entra is the IdP; also the prerequisite for OBO (#110). |
| **Must** | Thread real `userId` through the gaps | `configs/action-tokens.yaml` → Entra ids (**#106 live smoke test**), per-user Redis keys (Local/Global objects), session scoping. |

### Phase 2 — data isolation + shared tools (Pattern A)

| MSCW | Item | Notes |
|---|---|---|
| **Must** | #108 Pattern A: GitHub App installation token, app-side RBAC, server-side data scoping | Properly closes #88's GitHub-token task. |
| **Should** | #121 per-user Neo4j via DozerDB | Physical db-per-user; agentic path routed app-side (gateway can stop holding the Neo4j secret). Cross-user analytics = app-side fan-out (DozerDB has no Fabric/composite yet). |

### Phase 3 — Microsoft per-user identity *(narrowed by the MS-only decision)*

| MSCW | Item | Notes |
|---|---|---|
| **Must** | OBO MS Graph tool template + encrypted MSAL refresh cache (Azure Key Vault) | The one tool template needed this cycle; the refresh cache also serves async agent-trigger runs (no live user session). Closes #88's secrets posture. |
| **Must** | #110 Pattern C: Entra OBO for M365 mailbox / calendar / personal Graph | Entra enforces per-user scope (delegated) — no hand-rolled scoping guard. |
| **Should** | M365 SharePoint / org reference data via Graph **application** token + server-side scoping | Pattern A flavor of Graph. |

### Phase 4 — scale headroom

| MSCW | Item | Notes |
|---|---|---|
| **Should** | Tiered credential-profile gateway replicas (standard vs privileged) | The #107 "gateway concurrency" axis beyond the client pool. |
| **Should** | #105 PR 3 — real mid-run cancellation (abort token through the harness) | Only if wait-at-cap proves insufficient; same primitive a durable-run worker needs. |
| **Should** | #116 sandbox flavour guardrails / hardening | Open-sandbox tool surface, egress. |
| **Could** | Horizontal gateway replicas | |

### Won't-have *(this cycle — explicit)*

| Item | Why deferred |
|---|---|
| #109 Pattern B per-user vault (Google/Slack/personal GitHub) | **MS-only decision 2026-07-14**; re-promote when a concrete non-MS per-user connector need appears. |
| #78 Firecracker microVM substrate | Flavours shipped (#117); compose-on-VM deploy needs no docker-daemon externalization now. |
| #87 MCP catalog hot-swap | Superseded in spirit by #88/#107 static-provisioning posture. |
| #76 / #77 GenUI, #73 / #75 Ontology agents | Net-new bets off the multi-user critical path; deserve their own planning conversation. |
| AKS / multi-replica app tier | Blocked on state externalization regardless; single VM suffices at 30 users. |

## Standing decisions this plan encodes

- **~30 users forecast**; single-instance, persistent Node server.
- **Deploy = Azure VM (or any VPS) + compose + Caddy** — [`../deploy/azure-vm.md`](../deploy/azure-vm.md).
- **MS-only per-user identity this cycle**; org-wide tokens + app-side RBAC where org scope is acceptable (#108); Entra OBO where personal scope is required (#110).
- **Per-user graph = DozerDB db-per-user** (#121) — free, drop-in on Neo4j 5.26; accepts no-RBAC + no-Fabric limits at this scale.
- **Sandbox**: Docker backend with `base`/`image-processing`/`data`/`office` flavours (shipped #117); Firecracker deferred — see [`sandbox.md`](sandbox.md).
