# Attaching a sandbox workspace

**Audience:** someone whose sandboxed agent has to read a file the user uploaded, or hand
back a file it produced — across turns, and across container restarts.

**You will build:** the durable `/work` seam: a workspace store at the composition root,
`syncWorkspace` on a run, and the tenant boundary that keeps two users' caches apart.

**Time:** 10 minutes.

**Prerequisite:** [running code in a sandbox](./running-code-in-a-sandbox.md).

**The runnable version:** [`examples/attaching-a-sandbox-workspace.ts`](./examples/attaching-a-sandbox-workspace.ts) —
this page's code assembled into one file you can copy out and run.

---

## 1. The problem a container cannot solve

A sandbox container is reaped. It is evicted after an idle hour, destroyed on a `fresh`
run, lost when the dev server restarts, and — on a flavour router — _not the same
container_ as the one the previous turn used. Anything written to bare `/work` goes with
it.

So the durable half lives outside the container, in a document store the host owns, and
the package syncs two directories against it:

| Path        | Direction | Meaning                                                             |
| ----------- | --------- | ------------------------------------------------------------------- |
| `/work/in`  | in        | the session's stored documents, restored at each turn's entry       |
| `/work/out` | out       | files the agent produced, promoted to the store at each turn's exit |
| `/work`     | neither   | scratch. Per container, and it does not survive                     |

`/work/in` and `/work/out` are keyed by **session id**, not by container — which is what
lets four flavour containers share one workspace.

## 2. Supply the store

The package owns the protocol; the host owns storage and content classification. Five
suppliers, all required, wired once at the composition root:

```typescript
import { configureWorkspaceStore } from "@hames/sandbox/workspace-store";
import type { WorkspaceStore } from "@hames/sandbox";

declare const store: WorkspaceStore;

configureWorkspaceStore({
  // Every document stored under this session, including hidden/archived ones —
  // the package filters those, because that policy is the sandbox's.
  list: store.list,
  // One document's body, or null when it is gone. A TTL expiry between the
  // list and the read is an ordinary case, not an error.
  get: store.get,
  // Store a file promoted out of /work/out.
  store: store.store,
  // Your extension→MIME table, and what it considers text.
  guessMimeType: store.guessMimeType,
  isTextMime: store.isTextMime,
});
```

This app supplies the Data Stash document store plus its own MIME table — see
[wiring a host](./wiring-a-host.md#the-seam-which-is-not-changing).

**Why the MIME pair rides along** instead of being reimplemented in the package: that
table decides what your stash keeps verbatim and what it base64-encodes. A second copy
inside the package would drift from yours silently, in the direction of writing a binary
deliverable out as mangled UTF-8. Text files are stored verbatim; everything else is read
out as base64 and stored with `encoding: 'base64'`, so the original bytes round-trip.

### The seam refuses; it never degrades

Two failures, both at the composition root rather than on the turn that first produces a
deliverable.

A half-built bag throws **at the `configureWorkspaceStore` call**, naming the supplier:

```text
@hames/sandbox: configureWorkspaceStore requires a function for "store" (got undefined)
```

And asking for durable sync with no store at all raises a named error rather than doing
nothing:

```text
@hames/sandbox: durable workspace sync needs a WorkspaceStore. Call
configureWorkspaceStore({ list, get, store, guessMimeType, isTextMime }) from the host
composition root before any withSandbox({ syncWorkspace: true }) turn runs.
```

It has its own class so you can match it without matching a message:

```typescript
import { WorkspaceStoreNotConfiguredError } from "@hames/sandbox";

declare const err: unknown;

if (err instanceof WorkspaceStoreNotConfiguredError) {
  // your "this deployment is misconfigured" path
}
```

A silent no-op is precisely what this path cannot afford: `hydrateWorkspace` returning
"0 files written" is **indistinguishable from a healthy steady-state turn**, so a
deployment that opted into `syncWorkspace: true` without wiring a store would run blind
agents for its whole life and log nothing. `isWorkspaceStoreConfigured()` exists so a host
(or a test) can assert its own wiring without provoking the throw.

Nothing here is needed by a host that never sets `syncWorkspace: true` — the store is read
at the point of use, so an unconfigured package boots, type-checks and runs sandboxes
exactly as before.

## 3. Turn it on

Two fields, and the first is not optional:

```typescript
import { withSandbox } from "@hames/sandbox";
import type { ConfiguredPattern } from "@hames/harness-patterns";
import type { AgentData } from "@hames/agents";

declare const loop: ConfiguredPattern<AgentData>;
declare const sessionId: string;

const sandboxed = withSandbox({
  id: sessionId, // REQUIRED for sync — see below
  sessionId, // the workspace key
  rootfs: "base",
  egress: "mcp-only",
  syncWorkspace: true,
})(loop);
```

**`syncWorkspace` without an `id` is a no-op**, because only the id-addressable path has a
durable workspace; the anonymous-pool and `{ fresh }` paths do not. Rather than leave you
to discover that from a log trace, the wrapper says so at wrap time:

```text
[sandbox] withSandbox({ syncWorkspace: true }) ignored for pattern "…": it requires an
`id` (the anonymous-pool and `{ fresh }` paths have no durable workspace). Pass `id` —
e.g. `${sessionId}:${rootfs}` — to hydrate /work/in.
```

That warning exists because the silent version was a real bug: a route with no `id` ran in
a container where `/work/in` never existed, so a file ingested on another turn was
invisible and the actor burned its retries on `ls: cannot access '/work/in'`.

## 4. What happens on a turn

```text
acquire container
  ├─ hydrate  /work/in   ← store.list + store.get, diffed against what is there
  ├─ snapshot /work/out  ← hash every file, as the baseline
  ├─ run the pattern
  └─ promote  /work/out  ← store.store, for files new or changed vs the baseline   (finally)
```

Four properties of that sequence are worth knowing before you rely on it:

- **Hydration runs every turn, not once per boot.** Gating it on first boot made turn 1
  work by accident of ordering: a document ingested during turn 2, or before the container
  booted for a shell the user opened first, never reached the actor. Both directions diff,
  so a steady-state turn costs one document list plus one in-VM `find` and writes nothing.
- **Presence, not content, is hydration's diff key** — deliberately. `/work/in` is
  read-only by convention, but if the agent _did_ write there, re-hydrating must not
  overwrite its work, and a content-hash diff would.
- **Promotion runs in a `finally`.** Deliverables are saved even when the pattern throws.
- **A failed snapshot is not an empty one.** With no baseline, the diff would mark every
  pre-existing file as produced-this-turn and re-store the whole directory as duplicate
  documents — so a failed snapshot skips promotion for that turn instead, and the next
  turn promotes whatever changed.

Per-file failures never fail the turn — one oversized artefact must not cost the others —
but they are **named**, in the return value and in the log, because the agent has already
told the user it wrote them and the container is about to be reaped. Those failures land
in the turn's observability as run events, not in a console nobody reads.

Two more rules, for the flavour case: a later turn may land in a _different_ container, and
when two stored documents reduce to the same basename the **newest** one wins. Say both in
your actor's context, the way the shipped sandbox agents do:

```text
Files under /work/in are restored inputs; write deliverables the user should keep to
/work/out (saved to the store and restored next time). /work is scratch: a later turn may
run in a DIFFERENT sandbox flavour, and only /work/in and /work/out follow the
conversation — never leave something you need again in bare /work.
```

## 5. The tenant seam

`/work` is keyed by session, but one more resource is shared across a container's whole
lifetime: the `/cache` volume that networked boots mount for package downloads. That one
is keyed by **tenant**, and the tenant is supplied at the composition root:

```typescript
import { withSandbox, type WithSandboxConfig } from "@hames/sandbox";
import type { AgentDeps } from "@hames/agents";

declare function getRequestUserId(): string | null;

const withSandboxDep: AgentDeps["withSandbox"] = (attach) =>
  withSandbox({
    id: attach.id,
    sessionId: attach.sessionId,
    // `SandboxAttach` names these as plain strings; the host narrows them onto
    // the package's own unions here — the one adapter seam between the two
    // type surfaces, and it belongs at the composition root.
    rootfs: attach.rootfs as WithSandboxConfig["rootfs"],
    egress: attach.egress as WithSandboxConfig["egress"],
    syncWorkspace: attach.syncWorkspace,
    // A RESOLVER, called per run — never a literal.
    tenantId: () => getRequestUserId() ?? undefined,
  });
```

Three properties, each deliberate:

- **It is the conversation owner's user id, resolved server-side.** Never anything an
  agent factory or a client could name: a tenant that arrived as input is not an isolation
  boundary, it is a parameter.
- **It must be a function on the agent path.** A host builds its patterns once and caches
  the chain for the conversation's life, while the authenticated user is only in scope for
  one turn. A literal read at wrap time freezes whichever tenant was in scope during the
  build — including `'default'` for a build that ran outside a request — onto every later
  turn. The resolver is called on every run, inside the request scope.
- **`undefined` becomes the `'default'` tenant**, which keeps the existing volume name
  verbatim. That is the single-operator migration rule, not a fallback that widens
  anything.

Package-side, the id is rendered into a docker-volume-safe name, and when that rewrite
would be _lossy_ the raw id is folded in as a short digest — so two distinct ids can never
sanitize onto one name and put two tenants on one writable volume.

## 6. Where to go next

- [Running code in a sandbox](./running-code-in-a-sandbox.md) — attachment paths, egress
  profiles, flavours.
- [Wiring a host](./wiring-a-host.md) — where `configureWorkspaceStore` and the
  `withSandbox` supplier are registered.
- [`@hames/sandbox` README](../../packages/sandbox/README.md) — the injected-vs-imported
  table and the subpath map.
- [`docs/DATA_STASH.md`](../DATA_STASH.md) — the document store this app supplies, and its
  ingest pipeline.
- [`docs/plan/sandbox.md`](../plan/sandbox.md) — the attachment lifecycle and the
  multi-user tenant-isolation design.
