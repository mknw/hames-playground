# Sandbox Compute Infrastructure (Plan)

> **Status: core shipped; forward-looking sections remain the plan.** `withSandbox` + DockerBackend shipped in PR #81 (#79); durable `/work` ⇄ DataStash workspaces in PR #95 (#89); lifecycle hardening (startup reaper, health-check on reuse, Shell-hydrate) in PRs #103/#104 (#97); rootfs flavours (`image-processing`/`data`/`office`) + the router-over-flavours recipe in PR #117 (#78). The durable API lives in [`app/src/lib/harness-patterns/SPEC.md`](../../app/src/lib/harness-patterns/SPEC.md); operational debugging in [`../sandbox/README.md`](../sandbox/README.md); flavours in [`../sandbox-flavours.md`](../sandbox-flavours.md). Still plan-only: **Swarm** (parallel strategies), **Firecracker substrate** (#78), **ephemeral one-shot mode**, timer-driven sweep + LRU cap (#82), the "Deferred / v1+" section — and **multi-user tenant isolation** ([below](#multi-user-tenant-isolation-348--the-network-twin); design stage — implementation gated on the owner's approval).

Reference design for `withSandbox` — a harness wrapper that attaches a stateful, isolated microVM to a controller pattern, exposing filesystem / shell / Python tools to the actor via MCP servers running *inside* the VM. See [#79](https://github.com/mknw/harness-playground/issues/79) for the implementation story and [#78](https://github.com/mknw/harness-playground/issues/78) for the capability vision (Polars over user-uploaded files, document extraction, NER pipelines, …).

This document is the infrastructure design — wrapper API, attachment model, MCP-in-VM architecture, backend interface, substrate options, lifecycle, failure modes. It does **not** cover:
- Why we want this (see #78)
- Rootfs flavor catalog beyond the v0 minimum (see #78 → "Rootfs flavors"; the first `image-processing` + `data` flavours are specced in [`sandbox-flavours.md`](../sandbox-flavours.md))
- `backgroundSession` (a v2 primitive, orthogonal to `withSandbox`; outlined under "Deferred / v1+")

> **Design-conversation note.** An earlier draft of this doc was scaffolded too early, before the load-bearing architectural choices were probed. The current shape was reached by sampling the option space first and converging with the user before writing. Keep that ordering. See CLAUDE.md → "Design Decisions" → "Probe before scaffolding."

---

## What `withSandbox` is

A wrapper, not a leaf pattern. It composes like `withReferences`:

```typescript
withSandbox({
  id?: string,                          // ID-addressable; omit for auto
  fresh?: boolean,                      // force a new VM, ignoring any existing attachment
  rootfs?: 'base' | string,             // flavor (v0: 'base' only)
  resources?: { cpus?, memoryMB?, timeoutSec? },
  egress?: 'mcp-only' | 'pypi' | 'github-trusted' | 'open',
})(
  pattern,                              // any wrapped pattern (controller, chain, …)
)
```

The wrapped pattern's controller (e.g., `actorCritic`, `simpleLoop`) gains the sandbox's tools for the duration of the wrapper. The actor calls them like any other MCP tool. No new pattern primitive — but the two tool-calling controllers do need a one-time change to *dispatch* to the sandbox; see [How tools reach the controller](#how-tools-reach-the-controller).

**Canonical use case:** in-chat data analysis. Agent is asked to operate on a spreadsheet or document, runs Python inside the sandbox, answers in chat. Same shape for format conversion, extraction, profiling — the conversation changes, the wrapper doesn't.

The wrapper composes orthogonally with everything already in the harness — `chain(withSandbox(actorCritic), compactExecution)`, `withSandbox(chain(simpleLoop, compactExecution, actorCritic))`, `router → routes({…: withSandbox(coder)})`, `withReferences(withSandbox(actorCritic))`. Wrapper patterns (`chain`, `router`, `routes`, `withReferences`) and individual agents need **no** changes — the sandbox handle propagates to nested tool-calling controllers automatically (see [How tools reach the controller](#how-tools-reach-the-controller)). The only code that becomes sandbox-aware is the two controllers that actually dispatch tools.

It composes with `parallel` / `parallelMap` too, with semantics that depend on **which side** of the parallel the wrapper sits:

- **Wrapper inside the branches** — `parallel(withSandbox(chainA), chainB)` or `parallelMap(items, i => withSandbox(chain(...)))`. Each wrapped branch gets its own sandbox via auto-attachment; unwrapped branches (e.g. `chainB`) run normally with no sandbox — not every branch needs one. No state collision. This is the useful direction — see "Swarm" below.
- **Wrapper outside the parallel** — `withSandbox(parallel(branchA, branchB))`. All branches share one sandbox and state can collide. No compelling use case identified, so not a focus.

**Caveat — these rest on untested or unbuilt primitives.** `parallel` has never been exercised, `parallelMap` does not exist yet, and `judge` is untested; `withApproval` was removed outright (#125 — it never actually paused) with the supervision redesign tracked in #123. The compositions here are structurally sound but depend on primitives that need building and hardening first. Treat them as design intent, not shipping capability.

---

## Attachment model

A sandbox is *attached* to a wrapper invocation. The attachment is the unit of identity — what decides reuse vs. fresh.

| Form | Behavior |
|------|----------|
| `withSandbox()` | **Auto.** Reuse if a sandbox is already attached to this wrapper instance; otherwise allocate fresh. |
| `withSandbox({ id: 'foo' })` | **ID-addressable.** Reuse the sandbox attached to ID `foo`; otherwise allocate fresh and attach. The ID persists across pattern invocations and is exposable to UI / observability. |
| `withSandbox({ fresh: true })` | **Force fresh.** Allocate a new VM regardless of any existing attachment. Used when prior state would interfere. |

Auto is the default. The wrapper's runtime context — re-entries within a session, sibling invocations inside a `chain` — determines what "this wrapper instance" means. See "Lifecycle" below.

**Vocabulary:** we use *attachment* rather than *scope* because `Scope` is already a concept on UnifiedContext / View. The two are unrelated.

**Workspace persistence vs. attachment lifetime.** The attachment keeps a VM *live* between turns, so `/work` survives turn-to-turn while the container exists — but a container is disposable (idle eviction, warm-pool `reset`, process restart all destroy it). For state that must outlive the container, add `syncWorkspace: true` to an `{ id }` sandbox: the session's stored documents are restored into `/work/in` on first boot and `/work/out` deliverables are promoted back to the DataStash on each turn's exit. See [Durable workspaces](#durable-workspaces-89).

---

## Architecture: MCP-in-VM

Each sandbox VM runs MCP servers *inside it*. The harness connects to those servers over a tunneled socket and adds them to the wrapped controller's tool array. The host-level MCP gateway is uninvolved.

```
HOST  (Linux + KVM in production; macOS via Docker fallback)
│
├── harness app  (SolidStart Node process)
│     ├── pattern: withSandbox
│     ├── sandbox manager  (app/src/lib/sandbox/)
│     │     ├── ComputeBackend  (Docker | Firecracker)
│     │     ├── attachment table  (id → handle)
│     │     ├── warm pool
│     │     └── transport bridge  (vsock | unix tunnel)
│     │
│     └── MCP gateway client  (existing, unchanged) ────── external infra
│                                                            (neo4j, web, github, …)
│
└── sandbox VMs  (one per active attachment)
      ├── /work               ← agent's working dir
      ├── /opt/mcp/
      │     ├── rust-mcp-filesystem  ← MCP filesystem server
      │     └── mcp-shell             ← MCP shell-exec server (JS in v0, amortized via warm pool)
      ├── python3            ← invoked through mcp-shell in v0
      └── init.sh             ← boots MCP servers on stdio over the tunnel
```

**Why this shape:**

- **No session-routing in the gateway.** Each VM is a self-contained MCP endpoint. "Which sandbox?" is implicit in the connection. The host gateway stays a static, host-level service for shared infra (Neo4j, web, GitHub).
- **No second deployable.** The "code at the project root" is `rootfs/` — image definition + init scripts, same shape as `docker-compose.yml`. There is no separate `vmPoolManager` daemon to build or supervise.
- **Reuse existing MCP server images.** [`rust-mcp-filesystem`](../../configs/custom-catalog.yaml) gives us read/write/edit/list/search out of the box; a JS shell-exec MCP gives us `bash`. We don't author MCP servers for v0.

**Alternatives explicitly considered and rejected:**

- *Session-aware host MCP server* — gateway routes tool calls by `sandbox_id`. Rejected: cross-session blast radius (a single privileged process would hold the union of all sandbox filesystems), MCP wasn't designed for session-aware routing, every server would have to opt in.
- *Per-session host MCP containers* — gateway spawns a filesystem-MCP container per session, mounting that session's sandbox. Rejected: container churn, doubled deployable count, gains nothing over MCP-in-VM.
- *Harness-native (non-MCP) sandbox tools* — bypass MCP entirely; the harness exposes `sandbox.bash`, `sandbox.read` etc. as native tools talking directly to the VM. Rejected for v0: throws away the MCP abstraction `tools.server.ts` already understands. Worth revisiting only if MCP-in-VM hits real friction (e.g., MCP server cold-start dominating VM boot).

---

## How tools reach the controller

The load-bearing mechanism — and **not** the same as how `withReferences` injects data. Worth stating precisely, because the obvious "it's a wrapper like `withReferences`" intuition is wrong for tools.

Today, in both tool-calling controllers (`simpleLoop`, `actorCritic`):

- the **allowlist** is a construction-time arg (`tools: string[]`), optionally extended at runtime by `dynamicToolAllowlist?: () => Promise<string[]>` and `dynamicToolPattern?: RegExp`;
- **dispatch** is a global singleton — both call `callTool(name, args)` imported from `mcp-client.server`, which always talks to the one host MCP gateway client. There is no per-call transport parameter.

So a pure outer wrapper **cannot** transparently make the inner loop call in-VM tools the way `withReferences` injects `priorResults` via `scope.data`. Even if the actor *names* a sandbox tool, dispatch would route it to the gateway, not the VM. Tools need both a routing target and an allowlist entry, neither of which a data-only channel provides.

**Chosen mechanism: request-scoped dispatch via AsyncLocalStorage.** The codebase already uses ALS request-scoping (`getRequestSettings()`). `withSandbox` acquires the sandbox and runs the wrapped pattern inside an ALS scope carrying the handle:

```typescript
const sandbox = await acquireOrAttach(cfg)
return sandboxScope.run(sandbox, () => inner.fn(scope, view))
```

The two controllers, the `callTool` dispatch layer, and the BAML adapters are changed **once** to consult that scope:

- **Allowlist (controllers)** — both controllers extend their `tools.includes(...)` guard with `sandbox.ownsTool(...)`, so sandbox-owned tool names are accepted without the caller listing them in `tools` / `availableTools`.
- **Dispatch (`mcp-client.callTool`)** — checks the active scope first: a tool name owned by the sandbox routes to its in-VM transport (`connectMcp`); everything else goes to the host gateway, exactly as today.
- **Prompt (adapters in `baml-adapters.server.ts`)** — `createLoopControllerAdapter` and `createActorControllerAdapter` append the active sandbox's `listTools()` descriptions to the gateway-derived tool list, so sandbox tools appear in the actor's first-turn prompt without being threaded through the wrapped pattern's config. The allowlist change alone wouldn't accomplish this — the prompt is built at adapter time from the gateway's tool list, separately from the runtime guard.

**What this buys composition:**

- `chain`, `router`, `routes`, `withReferences` are **unchanged** — they don't dispatch tools, and ALS propagates through their `await`s.
- `withSandbox(chain(simpleLoop, compactExecution, actorCritic))` shares **one** sandbox across all of the chain's children for free: `simpleLoop` and `actorCritic` both read the same handle from ALS (a file one writes to `/work` is visible to the other); `compactExecution` simply never touches the scope. No `sandbox` parameter is threaded through `chain`.
- **Placement is the design lever.** Wrapping the whole chain → shared workspace across children. Wrapping a single child (`chain(withSandbox(actorCritic), compactExecution)`) → only that child sees the sandbox, and it's torn down before the compactExecution runs.

**Caveat (ALS).** Propagation holds across normal `async`/`await`. It breaks if execution detours through an unbound callback (`setImmediate`, an event emitter without ALS binding). The harness sequences pattern children with `await`, so this holds today — but any future scheduler that hops async contexts must re-bind the scope.

**Alternative considered — factory-wrap (rejected for v0).** `withSandbox(cfg)((sandbox) => actorCritic(actor, [...tools, ...sandbox.toolNames], { … }))` passes the sandbox into the controller at construction with an injected `callTool`. It avoids touching the controllers, but changes `withSandbox` from "wraps a pattern" to "wraps a pattern factory," loses the clean outer-wrapper ergonomics, and forces `callTool` to become an injected parameter everywhere it's used. The ALS route keeps `withSandbox` a true outer wrapper and reuses machinery that already exists (`dynamicToolAllowlist`, ALS request-scoping).

---

## Backend interface

Single backend trait; substrate choice is operational config, not application code.

```typescript
interface ComputeBackend {
  boot(rootfs: RootfsId, runtime: RuntimeConfig): Promise<VMHandle>
  destroy(vm: VMHandle): Promise<void>
  reset(vm: VMHandle): Promise<void>                // warm-pool recycle
  connectMcp(vm: VMHandle): Promise<McpTransport>   // tunneled socket to in-VM MCP servers
  health(vm: VMHandle): Promise<HealthStatus>
}
```

Notably *not* in this interface (vs. an earlier sketch): explicit `exec()`, `mount()`, `captureOutDir()`. Those existed for one-shot script execution; in the stateful-sandbox model, every agent action is an MCP tool call routed through `connectMcp`'s transport.

| Backend | Substrate | Boot | Reset | Notes |
|---------|-----------|------|-------|-------|
| `DockerBackend` | container + bind mount | 1–3s | fresh container | v0 dev + initial prod. Works on macOS dev hosts. |
| `FirecrackerBackend` | microVM + virtio-fs | ~125ms | snapshot/restore | Production swap once the abstraction proves out. Linux + KVM only. |

The harness drives the backend directly from `app/src/lib/sandbox/`. There is no separate pool-manager process.

---

## Substrate options (the deployment-shape decision)

The deployment shape was an implicit assumption in earlier framing. Captured here explicitly:

| Option | Who owns the worker | Substrate | Verdict |
|--------|---------------------|-----------|---------|
| Local Docker (single host) | harness host | Docker engine on dev laptop or single VM | **v0 dev + bootstrap prod** |
| Remote Azure KVM worker | us | Azure D/E/F-series VM (nested virt) running Firecracker | **target prod** |
| Kata-on-AKS | kubelet | AKS node pool with `runtimeClass: kata-fc` | deferred |
| Managed (E2B / Modal / Fly Machines) | vendor | their API | not chosen |

**Decision: local Docker for dev, remote Azure KVM worker for production.** Rationale:

- Local Docker matches the existing dev workflow (macOS + Docker Desktop) and the project's "everything runs in containers" baseline.
- A single Azure D-series VM (~$70–100/mo) exposes `/dev/kvm` to the guest, so Firecracker works. ~10–20% overhead from the extra hypervisor layer vs. bare-metal KVM is acceptable for dev/internal workloads.
- Owning the worker matters because this infrastructure will be reused across projects; the calculus tilts away from managed services when costs amortize.
- Kata-on-AKS was tempting (no pool-manager code; kube handles scheduling) but adds Kubernetes to the stack and presumes a multi-project deployment posture we haven't justified yet.

The `ComputeBackend` interface keeps all four options live. The choice surfaces only at substrate-provisioning time (Makefile / compose / Terraform).

---

## Rootfs composition (v0)

`rootfs/` at the project root, alongside `docker-compose.yml`:

```
rootfs/
├── Dockerfile            ← FROM debian-slim + python3 + bundled MCP servers
├── init.sh               ← boots in-VM MCP servers, exposes them over the tunnel
└── README.md             ← how to build / publish
```

**Contents:**

- `rust-mcp-filesystem` binary — mounts `/work`, exposes filesystem MCP tools.
- A JS shell-exec MCP server (`desktop-commander` or similar) — exposes `bash`. JS is fine here: cold-start is per-VM-boot, not per-tool-call, and the warm pool absorbs it.
- Python 3 runtime — invoked through the shell tool in v0 (`bash python -c "..."` or scripts written to `/work`).
- `init.sh` starts both MCP servers on stdio, multiplexed over the tunnel.

**v0 ships one rootfs flavor (`base`).** Flavors with heavier deps (Polars / sentence-transformers / PyPDF / spaCy) are the v1 rootfs catalog (#78).

---

## Tools available in v0

The wrapped controller's actor sees:

| Tool | Backed by | Purpose |
|------|-----------|---------|
| `sandbox_read` | rust-mcp-filesystem | Read file from `/work`. |
| `sandbox_write` | rust-mcp-filesystem | Write file in `/work`. |
| `sandbox_edit` | rust-mcp-filesystem | Surgical edit. |
| `sandbox_list` | rust-mcp-filesystem | List directory. |
| `sandbox_search` | rust-mcp-filesystem | Content search. |
| `sandbox_bash` | mcp-shell | Run a shell command (covers Python via `python -c …`). |

The `sandbox_*` prefix is applied by the harness when registering the in-VM MCP server's tools with the controller, to disambiguate from any host-level filesystem tools.

Tools the agent does **not** see in v0:

- Dedicated `sandbox_python` (Jupyter-shaped, REPL state across calls) — v1.
- `sandbox_fetch_stash(id, path)` (auto-mount DataStash entries) — v1+.
- `sandbox_network_*` — egress is enforced at the kernel level, not exposed as a tool surface.

**File ingestion in v0.** The agent can write files via `sandbox_write` (small data) or fetch them via `sandbox_bash` (curl/wget). Direct user uploads to a running sandbox are a v0.x UI work item — for the Docker substrate, `docker cp` works during dev bootstrap. Auto-mounting DataStash entries is v1+ (#78).

---

## Example: in-chat spreadsheet analysis

```
1. User: "Analyze this sales CSV and tell me which region had the largest YoY growth."

2. Router → 'data-analysis' route → actorCritic wrapped in withSandbox

3. withSandbox enters
   • auto-attachment lookup: no existing sandbox → backend.boot()
   • DockerBackend starts a container from the v0 rootfs image, /work bind-mounted
   • connectMcp() returns the transport; both in-VM MCP servers are reachable
   • sandbox_* tools appended to the actor's tool array

4. Actor (turn 1): sandbox_bash("pip install polars")           → tool_result ok
   Critic: continue.
5. Actor (turn 2): sandbox_write("/work/sales.csv", <content>)  → tool_result ok
   (or user previously uploaded via the side panel; v0.x UX work.)
6. Actor (turn 3): sandbox_bash("python -c '...polars groupby...'")
   stdout → winning region + growth %.
   Critic: done.

7. compactExecution: composes the chat answer.

8. withSandbox exits → backend.reset() → VM returns to the warm pool
   (or stays attached if id was explicit and session is alive).
   With syncWorkspace, anything the actor wrote under /work/out is first
   promoted to the DataStash, so the result survives the VM (see below).
```

Same shape works for document extraction, format conversion, dataset profiling — the conversation changes, the wrapper doesn't. When the input file was *uploaded* (rather than written by the actor), `syncWorkspace` restores it from the DataStash into `/work/in` automatically on the next session, so the user can leave and come back to it.

---

## Durable workspaces (#89)

A container is disposable; the workspace shouldn't be. The 5-minute-class idle window, warm-pool `reset`, and process restarts all destroy `/work`, so anything written there is lost once the live attachment goes away. [#89](https://github.com/mknw/harness-playground/issues/89) decouples the two: **`/work` stays ephemeral scratch; the DataStash is the durable store.** Opt in per agent with `withSandbox({ id, sessionId, syncWorkspace: true })` (the Sandbox · Session agent does).

**Workspace layout (the contract the agent is taught):**

| Path | Role | Lifetime |
|------|------|----------|
| `/work/in` | Uploads + prior deliverables, **restored at every turn's entry** (only what is missing). | Durable (DataStash). Read-only by convention. |
| `/work/out` | Files the agent wants kept. **Promoted to the DataStash on every turn exit.** | Durable (DataStash). |
| `/work` (elsewhere) | Scratch. | Ephemeral — gone when the container recycles. |

**Mechanism** (`app/src/lib/sandbox/work-artifacts.server.ts` + `work-sync.server.ts`):

- **Hydrate** — at every turn's entry, diff-wise: `listDocuments(sessionId)` diffed against what `/work/in` already holds (one in-VM `find`) → write only the missing ones. A steady-state turn therefore costs a list plus a `find` and writes nothing, while a document ingested *this* turn still reaches the actor. It was gated on `Attachment.isFirstBoot` until [#206 §6.1](https://github.com/mknw/hames-playground/issues/206) — which made turn 1 work by accident of ordering and left every later turn, plus every turn after a Shell-first boot, unable to see a newly stored file. Presence, not content hash, is the diff key, so a file the agent wrote under `/work/in` is never clobbered.
- **Promote** — snapshot `/work/out` (in-VM `sha256sum`) at turn entry, diff at exit, and `storeDocument` each new/changed file. Runs in a `finally`, so deliverables are saved even if the turn throws. Deletions are ignored (promotion never removes stored docs).
- **Binary-faithful** — text files store verbatim; everything else (xlsx, pdf, images) moves as base64 staged through a `.b64` text file (the in-VM filesystem MCP is text-only) and is stored with `encoding: 'base64'`. See [DATA_STASH.md → Storage model](../DATA_STASH.md#storage-model-redis).

**Boundaries.** Only the `{ id }` path syncs; anonymous (`withSandbox({})`) and one-shot (`{ fresh: true }`) sandboxes have no session identity and are untouched. Sync requires the MCP gateway (the DataStash lives in Redis). The window in which a *live* container is reused before falling back to hydrate-from-store is the warm-cache horizon — see `idleEvictMs` in [Settings](#settings).

---

## Swarm: parallel strategies, pick a winner (forward-looking)

A composition the wrapper enables, but which depends on primitives that don't exist yet (`parallelMap`, `judge`, and the #123 supervision gate — the removed `withApproval` predecessor):

```typescript
superviseGate(                             // user picks the winner — #123, NOT BUILT
  parallelMap(strategies, (strategy) =>    // N branches, one sandbox each — DOESN'T EXIST YET
    withSandbox(
      chain(actorCritic, compactExecution)      // a full agentic loop per strategy
    )
  )
)
```

Each strategy runs a full agentic loop in its own isolated sandbox — install different libs, take a different approach — and the user (or an LLM-as-judge via the untested `judge` pattern) selects the winner at the end. The user waits, by design: swarm mode trades compute for breadth.

This is **not** the shape for data fan-out ("run this transform over 1000 rows"). That's a single sandbox with an in-process map (Polars / pandas), not N sandboxes. Stateful-in-`parallelMap` earns its keep only when each branch is a genuinely different *approach*, not a different *row*.

---

## Lifecycle

```
acquire(attachment) → boot or pool-hit → wrapped pattern runs → release → reset-or-destroy
```

**Boot path.** Wrapper enters → ask the sandbox manager for an attachment → manager looks up by ID (or creates fresh) → if no warm VM available, `backend.boot()`; otherwise pool hit → `backend.connectMcp()` returns the transport → wire MCP tools into the wrapped controller.

**Release path.** Wrapper exits → if ID-addressable and the ID outlives the wrapper (session-scoped, etc.), keep the attachment alive → otherwise `backend.reset()` and return to warm pool, or `backend.destroy()` if the pool is full or the VM is unhealthy.

**Default lifetime.** A sandbox lives for the duration of the `withSandbox` wrapper. Because the wrapper can wrap a whole subtree, `withSandbox(chain(a, b, c))` keeps one VM alive across `a`, `b`, and `c` — a shared workspace for the turn. No flag is needed for that; it's just the wrapper's own lifetime.

**`persistent` across turns.** To reattach the *same* VM on a later turn (e.g., the router re-routes to the coding agent), use an explicit `id` (ID-addressable attachment) whose lifetime is the chat session. This is v0 **step 6**, not the first cut.

**`persistent` across restart.** Surviving a harness/browser restart needs snapshot/restore + storage. Deferred to **v2** (see Restart resilience below).

**Idle eviction.** Default 5 min. Configurable per `HarnessSettings`.

**Restart resilience.** If the harness restarts, currently-attached sandboxes are lost. Accepted in v0; revisited alongside `backgroundSession` persistence in v2.

---

## Warm pool

Pre-booted VMs per rootfs flavor, *unclaimed*. Acquisition is O(ms) on a hit; cold boot otherwise. The difference from a stateless one-shot model: pool entries are "ready to be claimed by an attachment," not "ready to receive a script."

| Substrate | Reset on release |
|-----------|------------------|
| Docker | destroy + boot fresh (no snapshot story; container start ~1s dominates, warm pool important) |
| Firecracker | snapshot at first boot, restore on each acquisition (~10ms) |

---

## Scheduler

Two caps prevent both global exhaustion and any single session starving the others.

```typescript
class SandboxScheduler {
  private readonly globalCap: number       // e.g. 16
  private readonly perSessionCap: number   // e.g. 4
  private readonly inflight = new Map<SessionId, Set<VMHandle>>()
  private readonly queue: Pending[] = []

  async allocate(req: AllocReq): Promise<VMHandle> {
    while (!this.canSchedule(req.sessionId)) {
      await this.waitForSlot(req)
    }
    const vm = await this.pool.acquire(req.rootfs)
    this.track(req.sessionId, vm)
    return vm
  }
  // … release(), canSchedule() as before
}
```

Defaults overridable via `HarnessSettings`. Compositions like `parallelMap(items=10, withSandbox(…))` aren't a v0 concern (`withSandbox` is sequential within an attachment), but the scheduler caps still bound multi-session load.

---

## Failure modes

Same two-axis model — whose problem × is the VM recoverable. Simpler than an earlier sketch because there's no custom RPC channel; everything surfaces as MCP `tool_result` events.

| Failure | Whose problem | VM recoverable | Pattern sees |
|---------|---------------|----------------|--------------|
| Script bug (agent ran broken Python) | Agent | Yes — keep | `tool_result` with non-zero exit + stderr |
| Tool timeout | Could be either | Yes — keep | `tool_result` with timeout error |
| OOM | Agent (resource hint too low) or host | No — destroy | `sandbox_oom` error |
| Disk full | Agent (output too big) or host | No — destroy | `sandbox_disk_full` error |
| Egress denied | Agent (asked for blocked domain) | Yes — keep | tool error |
| Crash before MCP servers came up | Host (rootfs broken) | No — destroy + alert | `sandbox_boot_failed` |
| MCP transport unreachable mid-execution | Host (transport broken) | No — destroy | `sandbox_unreachable` |

All surface to pattern code as standard `tool_result` events. Downstream patterns (critic, compactExecution) decide how to react.

---

## macOS development

Firecracker requires KVM; macOS does not ship it. `DockerBackend` is the default on `darwin`. Same MCP-in-VM architecture, same tool surface, same `ComputeBackend` interface — only boot latency and reset semantics differ.

Devs working specifically on `FirecrackerBackend` bugs opt into Lima / UTM / OrbStack with nested virt enabled. Most dev work doesn't need this.

`COMPUTE_BACKEND=docker|firecracker` selects. Defaults to `docker` on darwin, `firecracker` on Linux when `/dev/kvm` is present.

---

## Settings

| Setting | Default | Notes |
|---------|---------|-------|
| `sandbox.globalCap` | 16 | Max concurrent **in-flight** sandbox VMs across all sessions |
| `sandbox.perSessionCap` | 4 | Max concurrent in-flight sandbox VMs per session |
| `sandbox.maxAttachments` | 8 | Hard ceiling on **parked (at-rest)** attachments in the `AttachmentTable`. When a new boot would exceed it, the least-recently-used refCount=0 attachment is evicted (#82). `globalCap` bounds in-flight; this bounds at-rest. |
| `sandbox.warmPool.base` | 1–2 | Pre-booted VMs of the base flavor |
| `sandbox.idleEvictMs` | 3_600_000 | Idle time before a parked VM is destroyed. Reaped by the per-acquire lazy sweep *and* a 60s timer-driven sweep (#82) so a fully idle harness still releases parked VMs. With durable workspaces (#89) this is only the *warm-cache* horizon — instant reuse of the live container within the window; beyond it, the next turn re-hydrates `/work/in` from the DataStash. Was 300_000 before #89. |
| `sandbox.defaultTimeoutSec` | 60 | Per-tool-call wall-clock cap |
| `sandbox.defaultMemoryMB` | 512 | Per-VM memory cap |
| `sandbox.defaultEgress` | `'mcp-only'` | Default egress profile |

All overridable per-call via the `withSandbox` config object; defaults come from `HarnessSettings`.

---

## v0 build order

Each step de-risks the next.

1. `rootfs/` Dockerfile that bundles `rust-mcp-filesystem` + JS shell-MCP + Python on `debian-slim`. Build manually; verify both MCP servers come up on stdio.
2. `app/src/lib/sandbox/` — `ComputeBackend` interface + `DockerBackend` implementation. `boot` / `destroy` / `connectMcp` only; no warm pool yet, no reset.
3. `withSandbox` wrapper **+ transport-aware dispatch**: run the wrapped pattern inside an ALS sandbox scope; change `simpleLoop` + `actorCritic` (allowlist guard), `mcp-client.callTool` (dispatch), and `baml-adapters.server.ts` (prompt-side tool descriptions) **once** so sandbox-owned tool names route to the in-VM transport, pass the allowlist guard, and appear in the actor's first-turn prompt — all from the ALS scope, with no per-pattern wiring. Auto-attachment only (no ID, no `fresh`) for the first cut. This step is what makes multi-controller chains share one sandbox for free (see [How tools reach the controller](#how-tools-reach-the-controller)).
4. End-to-end integration test: `actorCritic` wrapped in `withSandbox`, agent receives "write a Python script in /work that counts words in this string and run it," reports the count back. Single Docker container, no warm pool.
5. Warm pool (small `warmCaps`), idle eviction, scheduler caps.
6. ID-addressable attachment + `fresh: true`.
7. Side-panel terminal feed (read-only stdout stream → new EventView).

`FirecrackerBackend` swaps in after (5) once the abstraction is proven.

---

## Deferred / v1+

**v1:**
- Refined side-panel UX: file tree, persistent terminal view, per-file readouts.
- Dedicated `sandbox_python` MCP tool (Jupyter-shaped, REPL state across calls).
- Rootfs flavor catalog (#78): Polars, PyPDF, sentence-transformers, etc.
- Rust shell-exec MCP server (replaces JS) if cold-start becomes felt.
- ~~DataStash → sandbox flow: auto-mount referenced entries~~ — **landed in #89** as `syncWorkspace`: stored docs hydrate into `/work/in`, `/work/out` deliverables promote back. Still v1+: *selective* hydration (only `withReferences`-selected entries, vs. the whole session set), an explicit `sandbox_publish` tool (vs. the `/work/out` convention; needs an actorCritic synthetic-tool layer), and version/lineage UI.
- UI-initiated file uploads into a *running* sandbox (today an upload lands in the DataStash and reaches `/work/in` on the next session boot, not mid-session).

**v2: `backgroundSession` primitive.**

Orthogonal to `withSandbox`, not a variant. Runs a wrapped pattern asynchronously; the parent harness returns immediately. The inner pattern's prompt comes from the parent harness, not the user.

```typescript
const vmAgent = harness(/* ... */)
const assistant = harness(
  router(routesDescriptions),
  routes({
    'simple-question': simpleRoute,
    'coding-task': backgroundSession(vmAgent),
  })
)
```

Background sandbox work is the composition `backgroundSession(withSandbox(harness(...)))`. Each primitive does one thing; `backgroundSession` is independently useful for any long-running pattern (deep research, multi-document synthesis).

Open problems `backgroundSession` surfaces (all genuinely v2):

- **Completion delivery** — how does the background harness's "done" event reach the user? Next-turn pickup? SSE push to the UI? Both?
- **Check-in** — can the user ask "how's that going?" mid-flight?
- **Cancellation.**
- **Concurrency** — multiple background sessions per chat session?
- **Persistence** — if the harness restarts, do background sessions resume?

**Ephemeral one-shot mode** (script in, result out, VM gone — the leaf-primitive shape an earlier draft of this doc proposed) coexists with stateful sandboxes but is deferred, and its justification is weaker than it first looked. The "fan-out over a dataset" case it was meant for is better served by in-process data parallelism (a Polars / pandas map) inside a *single* stateful sandbox; the "try different approaches and pick a winner" case is served by stateful-in-`parallelMap` (see "Swarm"). No compelling use case remains that the stateful wrapper doesn't already cover — so this stays a theoretical alternative (same `ComputeBackend`, different surface; likely a separate `vmCompute` leaf pattern that allocates → executes → destroys per invocation) until one surfaces.

---

## Multi-user tenant isolation (#348 + the network twin)

> **Status: DESIGN — implementation gated on the owner's approval.** Owner-authorized programme (2026-09-20). The sandbox machinery is single-operator today; this section is the multi-user threat model and the chosen mechanism per channel. The channels are folded into one design because they are one problem: **every resource shared across boots is a cross-tenant channel the day a second user lands.**

### Threat model under multi-user

A **tenant** is an authenticated user. In the single-operator alpha the sandbox's contents were, transitively, the operator's own; that assumption is void in multi-user: the actor executes model-chosen code over **tenant-uploaded files and third-party-fetched content** (documents, web pages), so a prompt injection can turn any sandbox into attacker-controlled code. The design therefore treats **every sandbox as potentially malicious** and asks, of each shared resource: what can it read, write, or reach that belongs to someone else?

Assets at stake: other tenants' Data Stash documents and `/work` contents; the live host services — neo4j (7474/7687), postgres (5432), redis (6379), the MCP gateway (8811), all **published on the host** via `docker-compose.yaml` and routed on the compose `app-network`; the **integrity of the wheel cache** (a poisoned dependency is code execution in the next tenant's analysis); and other tenants' compute.

### The five channels, verdicts, and mechanism per channel

#### 1. `/cache` — one shared named volume across every networked boot (#348) → **per-tenant named volume**

`cacheVolumeArgs()` ([`docker-backend.server.ts`](../../app/src/lib/sandbox/docker-backend.server.ts)) mounts `SANDBOX_CACHE_VOLUME` (default `kg-sandbox-cache`) at `/cache` on every networked boot (`pypi`, `github-trusted`, `open`; `mcp-only` skips it). Every container runs as the same non-root uid (`10001`), so the volume is writable by every tenant's sandbox and read by every other tenant's `uv`/`pip` install (`UV_CACHE_DIR`/`PIP_CACHE_DIR` point at `/cache`). The sharp shape is the poisoned wheel cache from #348's review: tenant A writes the cache tenant B's installs read.

**Why not per-boot:** an anonymous volume per container loses the cross-boot warmth that is the volume's entire reason to exist (live installs would re-download the same wheels into every ephemeral container). **Why not "uv verifies index digests, document the trust assumption":** verification narrows the classic poisoned-wheel shape, but the cache is a shared *writable filesystem* whose contents outlive every container — a channel is closed by not sharing it, not by trusting a verifier's coverage of it; and "document the trust assumption" is the posture the single-operator alpha already had.

**Mechanism:** `RuntimeConfig` gains `tenantId`; the volume name derives from the base name (`SANDBOX_CACHE_VOLUME`, default `kg-sandbox-cache`) by ONE rule — `tenantId` `'default'` → the base name **verbatim**; any other `tenantId` → `${base}-${tenantId}`. The first mount still bootstraps from the image's pre-owned `/cache` (docker copies image content into a named volume on first use — the no-chown property survives), so a single-operator deploy keeps its warm cache (see [Migration](#migration-for-existing-single-tenant-deploys)).

#### 2. Egress network — per-PROFILE, shared by every tenant → **per-boot network + per-boot gateway**

`egressNetworkName(profile)` ([`egress-policy.ts`](../../app/src/lib/sandbox/egress-policy.ts)) names ONE internal network per profile, and every tenant's networked sandbox attaches to it. Containers on one docker network are mutually reachable — the embedded DNS resolves every `sbx-*` container name and the gateway's name, and L3 adjacency holds regardless of names. That is sandbox-to-sandbox reachability across tenants: code exec in tenant A's sandbox can port-scan and attack tenant B's live sandbox, and both share one gateway.

**Mechanism:** per-boot internal network `kg-sandbox-egress-<profile>-<vm.id>` plus a per-boot gateway container named for the same vm id — stable across warm-pool `reset` (which re-runs `runContainer` under the same `sbx-*` name, so the reset re-ensures the same network rather than accumulating a new one). The gateway keeps today's shape: default bridge for its own external reach, its per-boot internal network as the sandbox-facing side, listening on `SANDBOX_EGRESS_PROXY_PORT` (3128) — safe to reuse on every gateway because nothing is host-published and the networks are isolated. `ensureEgressGateway` is idempotent; the old in-flight dedupe map is GONE — per-boot names made it unreachable (boot ids are unique, so two boots can never race the same gateway name, and a warm-pool `reset` re-ensures its own names sequentially). **Fail-loud semantics unchanged:** a networked sandbox never boots without its gateway (`SandboxBootError`). **Teardown grows:** `destroy()` removes, in order, the VM's container, then its per-boot gateway, then the labeled network (`docker network rm` refuses while the gateway endpoint remains attached); `reset()` removes none of the three — it re-ensures them. `reapOrphans` gains a labeled-network sweep (`docker network prune --filter label=kg-sandbox=1`) and runs it *after* the container sweep, since prune is a no-op on networks still in use by a leftover gateway. A parked (pooled) networked VM keeps its gateway, exactly as today's per-profile gateway outlived any one sandbox; the count is bounded by `sandbox.globalCap` for live VMs, the pool's per-rootfs caps (`sandbox.warmPool`) and `sandbox.maxAttachments` for parked ones, all evicted after `idleEvictMs`. Per-boot networks also multiply docker's address-pool consumption — the default pools allow only ~30 user-defined networks (`dockerd --default-address-pool`), so a deployment must widen the pool (e.g. `--default-address-pool base=10.0.0.0/8,size=24`) as a documented prerequisite, or the design bounds networked parked VMs so live+parked networks stay under the pool.

**Why per-boot rather than per-tenant:** the per-boot gateway is the dominant cost and is required either way (a shared gateway on a shared network is precisely the mutual reachability being closed); per-boot *additionally* closes **within-tenant** cross-session reachability (a poisoned session of user A attacking user A's other session) with the same one-line mechanism; and the extra cost over per-tenant is one tiny node container per networked boot.

**Deployment prerequisite (Lane B, documented only — nothing here touches a running daemon config):** per-boot networks multiply docker's address-pool consumption. The default pools allow only ~30 user-defined networks (`dockerd --default-address-pool`), so a deployment running networked sandboxes must widen the pool (e.g. `--default-address-pool base=10.0.0.0/8,size=24`) in the daemon config of the host that runs them, or boots fail once the pools exhaust. Also documented in [`rootfs/README.md`](../../rootfs/README.md) → "Hardening & egress" and `app/.env.example` → egress section.

#### 3. Warm pool — global, keyed by rootfs flavor only → **fingerprint-scoped pool**

Verified from source ([`warm-pool.server.ts`](../../app/src/lib/sandbox/warm-pool.server.ts)): the pool is **process-global, keyed by `RootfsId` only** — not per-session, not per-tenant. What does and does not cross sessions:

- **`/work` does NOT cross.** `release` → `backend.reset` → `rm -f` + fresh `runContainer`, so a parked VM is a **fresh container with an empty tmpfs**. No new `/work` scoping is needed — what guarantees it is reset's destroy-and-reboot semantics, which must never soften into a "clear the directory" shortcut.
- **The VM's runtime DOES cross.** `native.runtime` is preserved across reset, and `acquire` hands back a parked VM regardless of the runtime the caller requested. A caller asking for `mcp-only` can therefore receive a VM booted with `pypi` egress — network attached, `/cache` mounted — and after channels 1–2 land, a VM attached to **another tenant's** cache volume and network. The egress profile is an isolation knob, and the pool leaks it across sessions (and, in multi-user, tenants) today.

**Mechanism:** the pool key becomes a fingerprint `tenantId|rootfs|egress`; `acquire` computes it from the request and hands over a parked VM **only on an exact match** — a mismatch is a pool miss (destroy the parked VM, cold-boot with the requested runtime), never a silent handover of someone else's posture. Implementation note (Lane C): a mismatched parked VM is LEFT PARKED for its own fingerprint rather than destroyed — a miss for this caller is still an exact-match hit for the posture that booted it, and the parked VM's release always re-derives the fingerprint from the VM's own `native.runtime` record (a handle with no runtime record is un-vouchable: destroyed, never parked). The same fingerprint scopes the AttachmentTable's same-session reuse, closing the review advisory that a reuse hit ignored the requested runtime: a same-id acquire whose fingerprint differs recycles the live VM (into the pool, under its own fingerprint) and boots fresh, with `isFirstBoot` re-hydrating `/work`.

#### 4. `open` egress — unproxied, unaudited by design → **removed from selectable profiles; env opt-in for the single operator**

`open` rides the default bridge: unrestricted, unproxied, unaudited (no chokepoint to log at). No agent selects it today — every sandbox agent pins `mcp-only`, `defaultEgress` is `mcp-only`, and sandbox posture is host policy, deliberately not a user preference (the settings surface drops `sandbox` outright).

**Multi-user exposure:** an `open` sandbox has full outbound network, and the live services **publish ports on the host** — neo4j 7474/7687, postgres 5432, redis 6379, the MCP gateway 8811, the doc-convert sidecar 8000 — so one `curl http://<host-ip>:6379` from an open sandbox reaches the Data Stash and the graph. In multi-user, `open` is a host-services compromise profile, not a convenience.

**Verdict: remove, not gate per-user.** A per-user gate would put an authz decision inside the backend for a profile with zero users, and contradict the host-policy ruling that kept sandbox posture out of user hands. The single operator keeps the escape hatch as an env opt-in, `SANDBOX_ENABLE_OPEN_EGRESS=1`; unset, `open` is treated like an unknown profile — warn + **fail closed to `mcp-only`** (the existing closed-failure semantics at the backend). When the flag IS set, the deployment accepts the documented posture: no audit, no allowlist, unrestricted outbound egress — and, where channel 5's loopback binding is not adopted, reachability of every host-published port. A single-operator deployment may; a multi-user deployment must not. Shipped as specified, with one spelling decision: only the exact value `1` (trimmed) enables the flag — `true`/`yes` are OFF, since a knob that admits unrestricted egress fails closed on a misspelling (`isOpenEgressEnabled`, `egress-policy.ts`).

#### 5. Host-published services — reachable from EVERY networked profile via the internal network's gateway IP → **compose loopback binding**

`--internal` networks drop traffic to and from *other networks*, not to the host itself — docker's own reference states that communication with the gateway IP address (and thus appropriately configured host services) is possible from an internal network. Every compose service publishes on all host interfaces ([`docker-compose.yaml`](../../docker-compose.yaml): neo4j 7474/7687, gateway 8811, postgres 5432, redis 6379, doc-convert 8000 — no loopback prefix). So a `pypi`/`github-trusted` sandbox can open a raw socket to its own bridge gateway IP (e.g. `http://172.18.0.1:6379`) — no proxy, no allowlist, no audit — and reach the Data Stash (redis carries no `requirepass` in compose), the graph, postgres and the gateway. This channel is live today, single-operator, and the four mechanisms above do not close it.

**Mechanism:** bind every published port to loopback (`"127.0.0.1:6379:6379"`, and the same for 7474/7687/5432/8811/8000) — a container addressing the bridge gateway IP hits a non-loopback host interface, which loopback-bound ports do not serve. The app-in-docker reaches these services over `app-network` by name, and host-side consumers keep `localhost`, so only the exposure closes. Checked against the deployment runbook ([`docs/deployment/azure-vm.md`](../deployment/azure-vm.md) §4 — no consumer reaches a port via a host IP): the tracked [`docker-compose.prod.yaml`](../../docker-compose.prod.yaml) already does exactly this (`!override` loopback binds on every published port), so the multi-user prerequisite is to adopt that shape wherever the sandbox runs — not to invent a new one. A deployment that must publish on a real interface must instead add `DOCKER-USER` iptables rules dropping traffic from the sandbox bridges to host ports.

### What stays shared, and at what granularity

| Resource                       | Today                          | After                                        | Why                                                                                                            |
| ------------------------------ | ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Images (`kg-sandbox:*`)        | shared                         | shared                                       | Read-only, built by us; nothing tenant-writable                                                              |
| `/cache` volume                | all tenants                    | **per tenant**                               | Warmth within one trust boundary; the cross-tenant write channel (#348) closes                                |
| Egress network                 | per profile, all tenants       | **per boot**                                 | Zero sandbox-to-sandbox adjacency, even within a tenant                                                      |
| Egress gateway + its audit log | per profile                    | **per boot**                                 | One chokepoint per sandbox; its log names exactly that boot                                                   |
| Warm pool                      | per rootfs, global              | per `tenant \| rootfs \| egress` fingerprint  | Posture never crosses a pool handoff                                                                         |
| Attachment id                  | per session (server-derived)   | unchanged                                    | Ids are never client-supplied; the Shell/stream routes are already owner-gated (`claimSession`/`requireSessionOwner`) |
| Scheduler caps                 | per session (`sessionId ?? 'default'`) | unchanged; optional `perTenantCap` follow-up | Every agent path keys the scheduler to the conversation's `sessionId`; the Shell path bypasses the scheduler entirely ([`pty-manager.server.ts`](../../app/src/lib/sandbox/pty-manager.server.ts)) — `perTenantCap` is the follow-up when tenants exist |
| Host MCP gateway, Data Stash, Neo4j | shared infra               | unchanged                                    | Published ports become loopback-bound (channel 5); the app-in-docker reaches them over `app-network` — "owner-scoped in their own seams" holds only for the app-level seams |

### Tenant identity seam

`RuntimeConfig` gains `tenantId`, resolved **server-side** from the conversation's owner — never accepted from client input; `'default'` when there is no authenticated user (single-operator dev). Network and volume names derive from it at the backend; nothing persists it beyond what `native.runtime` already carries. Every `RuntimeConfig` producer resolves it — the `withSandbox` wrapper AND the Shell path's direct `attachments.acquire` ([`pty-manager.server.ts`](../../app/src/lib/sandbox/pty-manager.server.ts) `start()`), which already runs behind `requireSessionOwner` and so has the owner in hand. `tenantId` is the user's own id (`users.id`, the conversation owner's oid) — NOT `users.tid`, which names the Entra organisation ([`users.server.ts`](../../app/src/lib/auth/users.server.ts)); this section's boundary is per-user, and per-organisation grouping would be a different decision.

### Migration for existing single-tenant deploys

- The default tenant maps to today's names: the cache volume keeps `SANDBOX_CACHE_VOLUME`'s value **verbatim** (no suffix), so the warm cache survives the upgrade.
- The per-profile gateway containers carry `kg-sandbox=1` and are removed by the expanded container sweep. The two per-profile *networks* are unlabeled today (`docker network create --internal`, no `--label` — [`docker-backend.server.ts`](../../app/src/lib/sandbox/docker-backend.server.ts)) and are not covered by the label-scoped prune — remove them by name (`docker network rm kg-sandbox-egress-pypi kg-sandbox-egress-github-trusted`) or leave them; nothing references them after the change.
- **Lane B prerequisite:** widen the docker daemon's address pools on any host that runs networked sandboxes (`--default-address-pool base=10.0.0.0/8,size=24`) BEFORE the upgrade — per-boot networks consume pools at one-network-per-boot, and an exhausted pool fails networked boots. Documented in [`rootfs/README.md`](../../rootfs/README.md) and `app/.env.example`; the daemon config is a deployment step, not a repo change.
- No DB migration, no settings-schema change, no new required env var. One behavior change: `open` without `SANDBOX_ENABLE_OPEN_EGRESS` fail-closes to `mcp-only` with a named warning — the same class as an unknown profile.

### Env knobs (after)

| Knob                          | Status                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SANDBOX_CACHE_VOLUME`        | meaning widens from "the cache volume" to "the cache volume **base** name" (default tenant keeps it verbatim) |
| `SANDBOX_EGRESS_PROXY_PORT`   | unchanged — every per-boot gateway listens on it, on isolated networks; nothing host-published                 |
| `SANDBOX_EGRESS_*_ALLOWLIST`  | unchanged — per-deployment policy, now enforced per boot                                                      |
| `SANDBOX_ENABLE_OPEN_EGRESS`  | **new**, default unset; when set, the deployment accepts `open`'s documented unaudited posture               |
| all others (pids/tmpfs/seccomp/apparmor/bash-guard) | unchanged                                                                             |

### Implementation slicing (dispatched only after owner approval)

1. **Lane A — tenant seam + per-tenant cache volume:** `tenantId` in `RuntimeConfig`/`WithSandboxConfig` AND in the Shell path's direct `RuntimeConfig` producer ([`pty-manager.server.ts`](../../app/src/lib/sandbox/pty-manager.server.ts) `start()`), volume-name derivation, default-tenant name compatibility.
2. **Lane B — per-boot egress network + gateway:** boot-scoped ensure, per-boot teardown, labeled-network reaping, dedupe re-keyed per boot.
3. **Lane C — warm-pool fingerprint** (after A, whose tenant component it consumes): `tenantId|rootfs|egress` keying; mismatch = pool miss.
4. **Lane D — `open` env gate:** the flag, warn + fail-closed, `.env.example` documentation.

A and B are independent; C follows A; D is small and independent. Each lane lands as its own implementation PR with an independent review (the reviewer's terms bind verbatim) and CI green on the exact head; the OWNER merges.

---

## Open questions

- **Attachment identity across turns & siblings.** Within one wrapper invocation, sharing is settled — ALS gives `withSandbox(chain(a, b, c))` one shared VM (see *How tools reach the controller*). Open: on a *new turn*, should an auto (no-`id`) wrapper reattach or start fresh? (Leaning fresh; opt into reuse with an explicit `id`.) And under `parallel`, confirm each branch's `withSandbox` gets an isolated ALS scope so sibling sandboxes don't bleed.
- **Multi-attachment per session.** Can one session hold multiple ID-addressable sandboxes simultaneously? Probably yes; bounded by `perSessionCap`.
- **UI access to a running sandbox.** Read-only filesystem browser? Terminal mirror? Either uses the same MCP endpoint the harness uses; access control is the open part.
- **Snapshot/restore fidelity** (Firecracker). Some kernel state (entropy pool, `/dev/urandom` seeds) needs explicit handling. Document quirks as they surface.
- **Cost guard.** Per-session cap soft-bounds VM count, but we need telemetry and possibly a "this will boot N VMs, ok?" gate. Deferred — first see if it bites.

---

## See also

- [GitHub Project — "Harness Playground tasks"](https://github.com/users/mknw/projects/5) — where this fits in the broader plan
- [#79](https://github.com/mknw/harness-playground/issues/79) — implementation story
- [#78](https://github.com/mknw/harness-playground/issues/78) — capability vision + rootfs flavor catalog
- [`app/src/lib/harness-patterns/README.md`](../../app/src/lib/harness-patterns/README.md) — pattern framework overview (`withReferences` is the analogous wrapper)
