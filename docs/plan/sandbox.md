# Sandbox Compute Infrastructure (Plan)

> **Status: core shipped; forward-looking sections remain the plan.** `withSandbox` + DockerBackend shipped in PR #81 (#79); durable `/work` ⇄ DataStash workspaces in PR #95 (#89); lifecycle hardening (startup reaper, health-check on reuse, Shell-hydrate) in PRs #103/#104 (#97); rootfs flavours (`image-processing`/`data`/`office`) + the router-over-flavours recipe in PR #117 (#78). The durable API lives in [`ui/src/lib/harness-patterns/README.md`](../../ui/src/lib/harness-patterns/README.md); operational debugging in [`../sandbox/README.md`](../sandbox/README.md); flavours in [`../sandbox-flavours.md`](../sandbox-flavours.md). Still plan-only: **Swarm** (parallel strategies), **Firecracker substrate** (#78), **ephemeral one-shot mode**, timer-driven sweep + LRU cap (#82), and the "Deferred / v1+" section.

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

The wrapper composes orthogonally with everything already in the harness — `chain(withSandbox(actorCritic), synthesizer)`, `withSandbox(chain(simpleLoop, synthesizer, actorCritic))`, `router → routes({…: withSandbox(coder)})`, `withReferences(withSandbox(actorCritic))`. Wrapper patterns (`chain`, `router`, `routes`, `withReferences`) and individual agents need **no** changes — the sandbox handle propagates to nested tool-calling controllers automatically (see [How tools reach the controller](#how-tools-reach-the-controller)). The only code that becomes sandbox-aware is the two controllers that actually dispatch tools.

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
│     ├── sandbox manager  (ui/src/lib/sandbox/)
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
- `withSandbox(chain(simpleLoop, synthesizer, actorCritic))` shares **one** sandbox across all of the chain's children for free: `simpleLoop` and `actorCritic` both read the same handle from ALS (a file one writes to `/work` is visible to the other); `synthesizer` simply never touches the scope. No `sandbox` parameter is threaded through `chain`.
- **Placement is the design lever.** Wrapping the whole chain → shared workspace across children. Wrapping a single child (`chain(withSandbox(actorCritic), synthesizer)`) → only that child sees the sandbox, and it's torn down before the synthesizer runs.

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

The harness drives the backend directly from `ui/src/lib/sandbox/`. There is no separate pool-manager process.

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

7. Synthesizer: composes the chat answer.

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
| `/work/in` | Uploads + prior deliverables, **restored on first boot** of each session's container. | Durable (DataStash). Read-only by convention. |
| `/work/out` | Files the agent wants kept. **Promoted to the DataStash on every turn exit.** | Durable (DataStash). |
| `/work` (elsewhere) | Scratch. | Ephemeral — gone when the container recycles. |

**Mechanism** (`ui/src/lib/sandbox/work-artifacts.server.ts` + `work-sync.server.ts`):

- **Hydrate** — on first boot only (tracked by `Attachment.isFirstBoot`), `listDocuments(sessionId)` → write each into `/work/in`. Reused live attachments skip this, so a multi-turn session doesn't re-hydrate every turn.
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
      chain(actorCritic, synthesizer)      // a full agentic loop per strategy
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

All surface to pattern code as standard `tool_result` events. Downstream patterns (critic, synthesizer) decide how to react.

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
2. `ui/src/lib/sandbox/` — `ComputeBackend` interface + `DockerBackend` implementation. `boot` / `destroy` / `connectMcp` only; no warm pool yet, no reset.
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
- [`ui/src/lib/harness-patterns/README.md`](../../ui/src/lib/harness-patterns/README.md) — pattern framework overview (`withReferences` is the analogous wrapper)
