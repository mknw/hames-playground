# @hames-ai/sandbox

## What this is

Lets an agent built with
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme)
run the code it writes inside a disposable Docker container instead of on
your machine. `withSandbox` wraps a pattern and attaches a container to it
while it runs; the pattern's `sandbox_*` tools (shell, file read, write, edit,
list and search) act inside that container. By default the container has no
network at all, shell commands are screened before they run, and files the
agent leaves in `/work/out` can be saved to a document store your application
supplies. It is its own package so that installing the core library never
pulls Docker code into your project.

## Which package do you need?

Five packages that work together. The first is the foundation; add the others
for what they do.

| If you want to…                                                                      | Use                                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| build an agent out of composable pieces — tool loops, routers, planners              | [`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme) |
| get typed model calls with the prompts already written                               | [`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)         |
| use a ready-made agent                                                               | [`@hames-ai/agents`](https://github.com/mknw/hames-playground/tree/main/packages/agents#readme)                     |
| use Microsoft 365 or Neo4j from an agent, or a ready tool catalog for an MCP gateway | [`@hames-ai/connectors`](https://github.com/mknw/hames-playground/tree/main/packages/connectors#readme)             |
| run agent-written code in a container                                                | [`@hames-ai/sandbox`](https://github.com/mknw/hames-playground/tree/main/packages/sandbox#readme)                   |

## See it running

The [hames app](https://github.com/mknw/hames-playground) is the reference
host for all five packages: a self-hosted agent workspace whose agents are
built from them, with every step of every run visible in its UI. Its
[Quickstart](https://github.com/mknw/hames-playground#quickstart) runs it
locally with Docker and pnpm.

## Exports

Below, the _host_ is your application — the code that imports this package.

| Subpath                      | What lives there                                                                               | Browser-safe?                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `.` (root entry point)       | `withSandbox`, `DockerBackend`, `getComputeBackend`, the compute types, the store seam         | **no** — server-only, pulls the Docker backend |
| `./types`                    | `ComputeBackend` / `VMHandle` / `RuntimeConfig` / …, `SANDBOX_TOOL_PREFIX`, `V0_IN_VM_SERVERS` | yes — types + constants, no `node:` imports    |
| `./settings`                 | `SandboxSettings` + `DEFAULT_SANDBOX_SETTINGS` (the caps and per-call defaults)                | yes — same rule                                |
| `./guard` (= `./bash-guard`) | `screenBashCommand` / `bashGuardPolicyFromEnv` — the in-VM command screen                      | yes                                            |
| `./egress-policy`            | the three selectable egress profiles and the per-boot network/gateway naming                   | yes                                            |
| `./workspace-store`          | `configureWorkspaceStore(...)` — the durable `/work` seam a host wires                         | server                                         |
| `./with-sandbox.server`      | the wrapper itself, for a host that skips the root entry point                                 | server                                         |
| `./pty-manager.server`       | the interactive Shell path the host's routes drive (node-pty, loaded lazily — see below)       | server                                         |
| `./docker-backend.server`    | the compute backend — an implementation detail; named here because the host's tests mock it    | server                                         |

**The root entry point is server-only and it pulls Docker with it.** That is
not an oversight: `with-sandbox.server.ts` constructs a `DockerBackend` by
default, so a lazy import there would move the dependency rather than remove
it. The two browser-safe subpaths above are the answer instead — `./types` is what a browser
component imports, `./settings` is what a host's own client-safe settings module
imports, and neither reaches a `node:` module or the server assertion.

## What your application passes in

**Injected (host → package):**

- `configureWorkspaceStore({ list, get, store, guessMimeType, isTextMime })` —
  the durable-workspace seam (`/work/in` hydrate, `/work/out` promote). The
  package owns the protocol; the host owns storage and content classification.
  **Explicit-config-only**: unset is a named error at first use
  (`WorkspaceStoreNotConfiguredError`), never a silent no-op, because
  "0 files written" is indistinguishable from a healthy steady-state turn. A
  missing supplier throws at the `configureWorkspaceStore` call, not on the turn
  that first produces a deliverable.
- `WithSandboxConfig.tenantId` — a string, or a **resolver called per run**. It
  is the conversation owner's id, resolved server-side; the resolver form exists
  because a host builds its patterns once and caches them for a conversation's
  life, while the authenticated user is only in scope per turn.
- Every per-call knob on `WithSandboxConfig`: `backend`, `pool`, `scheduler`,
  `attachments`, `resources`, `egress`.

**Imported directly:** `@hames-ai/harness-patterns` (types, `assert.server`,
`context.server`, `tool-transport.server`), `@modelcontextprotocol/sdk` (the
in-VM MCP client) and `node-pty` (the Shell path). Nothing else — it imports no code
from the hames app in this repository, type-only included, pinned two ways (see
**Guards**).

**`node-pty` is declared but loaded lazily.** It is a NATIVE module, and the
only thing that needs its `.node` addon is one `spawn` call on the
interactive-shell path — so `pty-manager.server.ts` imports the _type_
statically (erased) and the _value_ with `await import('node-pty')` at that
call. Importing the module therefore costs nothing, and a consumer who never
opens a shell never touches the addon. This is not hypothetical: pnpm's
build-script allowlist (`onlyBuiltDependencies`) lives in a **workspace root**
manifest that a consumer of this tarball does not inherit, so node-pty installs
with its build scripts ignored and works only where a prebuild happens to match.
Deferring the import turns "this package cannot be imported" into "this
package's PTY feature is unavailable on this host", which is the truthful scope
of it. Concretely: node-pty ships prebuilt `.node` binaries and its own loader
falls back to `prebuilds/<platform>-<arch>/` when no `build/` output exists, so
the shell path works unbuilt on the four platforms it prebuilds for (darwin and
win32, arm64 and x64 — **not** linux). A consumer on a platform with no prebuild
needs node-pty's own install script to run, and only pnpm 10 withholds it: under
npm or yarn that script runs by default and the addon is built. So if opening a
shell fails with a missing-`.node`-addon error **on pnpm**, run
`pnpm approve-builds` and reinstall.

It stays a real `dependency` — not `optional`, not `peer` — for the other half:
a consumer who _does_ open a shell must get it installed without reading a
README. Lazy about **when** it loads, explicit about **that** it is required.
The pack smoke pins both halves: it asserts the manifest still declares it, then
renames the installed copy away and requires `./pty-manager.server` to import
anyway.

**Composed host-side:** the `'use server'` route handlers around the PTY
manager with their per-route auth gates, the document store itself, and the
`AgentDeps.withSandbox` supplier that `@hames-ai/agents`' ready-made definitions
receive — the package is what the host wires INTO that supplier, never the
supplier itself.

## Egress profiles

**`egress` takes one of three SELECTABLE profiles**, and that is the whole set:
`mcp-only` (the shipped default — `--network none`, no network at all), `pypi`
and `github-trusted` (an internal-only docker network plus an allowlist CONNECT
proxy). The `EgressProfile` type carries a fourth member, `open`, which is
deliberately absent from `EGRESS_PROFILES`: a caller that asks for it fails
CLOSED to `mcp-only`, exactly like an unknown name, unless the deployment sets
`SANDBOX_ENABLE_OPEN_EGRESS=1`. It is a single-operator escape hatch, off by
default — not a fourth profile. The per-profile table, the default allowlists
and the residual-DNS caveat are in
[running code in a sandbox](../../docs/tutorials/running-code-in-a-sandbox.md).

## Container images live outside the package

`withSandbox` boots `kg-sandbox:base` and its three flavours
(`image-processing`, `data`, `office`), plus the allowlist CONNECT proxy behind
the `pypi` / `github-trusted` egress profiles. Those image definitions live in
**[`rootfs/`](../../rootfs/README.md) at the repository root** and stay there: they are
built and published by whoever operates a deployment, they version on a
different clock from this TypeScript, and a consumer of the tarball supplies its
own (or uses `backend` to supply a different compute substrate entirely). The
package names the images; it does not carry them.

Two consequences worth stating rather than discovering:

- `rootfs/egress-proxy/proxy.mjs` has its own test suite, and it lives in
  the hames app's test tree (`app/src/__tests__/lib/sandbox/egress-proxy.test.ts`) — a package test
  reaching up into the repo root would be exactly the "not independently
  shippable" shape the co-located suite exists to avoid.
- `scripts/` here (the live-container smoke checks) drives those images, so it
  is dev tooling for THIS repo and is excluded from the published tarball along
  with `__tests__/`.

## No build step

Like the other `@hames-ai` packages, this one **ships TypeScript source**: `main`
and every code target in `exports` is a `.ts` file (`./package.json` is the one
non-code entry), there is no `dist/`, and `pnpm pack` is the whole publish
pipeline. Consumers are **TS-bundler consumers** — a project whose bundler or
runtime compiles TypeScript: Vite/vinxi, esbuild, tsx, Bun. **Not**
`node --experimental-strip-types`, which refuses to strip types under
`node_modules` — exactly where an installed package lives
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on Node v22.21.1). A
plain `node dist/index.js` consumer is not supported either, deliberately: a
build step would make the published artefact different from the source every
test in this repo runs against.

## Tests

The suite is co-located under `__tests__/` and excluded from the published
tarball via the `files` allowlist. Run it with `pnpm test` from
`packages/sandbox/`. It runs in a plain node environment with no app test
database and no `~` alias: everything it imports is this package, its declared
dependencies, or its own fixtures.

## Guards

Three, and none of them subsumes the others:

1. **`zero-app-imports.test.ts`** (host-side source scan) — no file here imports
   `app/src`, including **type-only** and including the co-located `__tests__/`
   tree. A type-only import is erased by tsx before a tarball exists, so this
   raw-text scan is the only thing that sees it; the tests are in scope because
   nothing else reaches them either (they do not ship, so the pack smoke is
   blind to them, and CI runs this suite from inside the workspace, where a
   climb into `app/` resolves fine) — and a suite that reaches into the host is
   the one thing that would make the package not independently runnable.
2. **`scripts/pack-smoke.sh`** (CI, `packages` job) — packs the tarball, installs
   it into a scratch project and _evaluates_ every entry in a set DERIVED from
   the app's imports and this package's `exports` map, never a list typed into
   the probe. This is what catches a **value** import escaping into `app/src` (as
   `ERR_MODULE_NOT_FOUND` naming the app path) or a dependency the manifest does
   not declare. In practice such an edge surfaces at the probe's **node-pty
   check**, not its derived eval loop — that check imports `pty-manager.server`,
   which transitively imports `with-sandbox.server` — so it reports the edge under
   its own headline rather than under the node-pty one. It also asserts that
   neither `__tests__/` nor `scripts/` ships, and that node-pty is declared but
   not needed at module load (above).
3. **`package-conventions.test.ts`** — every workspace package carries a
   `.prettierrc.json` (issue #354: without one, prettier's defaults reformat
   whole files and `--check` agrees with itself, which once hid a lost docblock
   on a published export), a LICENSE and a README.
