# @hames/sandbox

The **containment** companion package for
[`@hames/harness-patterns`](../harness-patterns): `withSandbox`, the Docker
compute backend, the warm pool / scheduler / attachment table, the egress
profiles, the bash guard and the durable `/work` ⇄ document-store sync — moved
out of the host app behind injected seams.

It exists as its own package for one reason: **`withSandbox` is a harness
pattern, but a developer installing the simpler patterns must not pull Docker
code into their tree.** `@hames/harness-patterns` stays free of it; a host that
wants containment adds this.

## Surface

| Subpath                      | What lives there                                                                               | Client-safe?                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `.` (barrel)                 | `withSandbox`, `DockerBackend`, `getComputeBackend`, the compute types, the store seam         | **no** — server-only, pulls the Docker backend |
| `./types`                    | `ComputeBackend` / `VMHandle` / `RuntimeConfig` / …, `SANDBOX_TOOL_PREFIX`, `V0_IN_VM_SERVERS` | yes — types + constants, no `node:` imports    |
| `./settings`                 | `SandboxSettings` + `DEFAULT_SANDBOX_SETTINGS` (the caps and per-call defaults)                | yes — same rule                                |
| `./guard` (= `./bash-guard`) | `screenBashCommand` / `bashGuardPolicyFromEnv` — the in-VM command screen                      | yes                                            |
| `./egress-policy`            | the four egress profiles and the per-boot network/gateway naming                               | yes                                            |
| `./workspace-store`          | `configureWorkspaceStore(...)` — the durable `/work` seam a host wires                         | server                                         |
| `./with-sandbox.server`      | the wrapper itself, for a host that skips the barrel                                           | server                                         |
| `./pty-manager.server`       | the interactive Shell path the host's routes drive (node-pty, loaded lazily — see below)       | server                                         |
| `./docker-backend.server`    | the compute backend — an implementation detail; named here because the host's tests mock it    | server                                         |

**The barrel is server-only and it pulls Docker with it.** That is not an
oversight: `with-sandbox.server.ts` constructs a `DockerBackend` by default, so
a lazy import in the barrel would move the edge rather than remove it. The two
client-safe subpaths above are the answer instead — `./types` is what a browser
component imports, `./settings` is what a host's own client-safe settings module
imports, and neither reaches a `node:` module or the server assertion.

## What is injected vs imported

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

**Imported directly:** `@hames/harness-patterns` (types, `assert.server`,
`context.server`, `tool-transport.server`), `@modelcontextprotocol/sdk` (the
in-VM MCP client) and `node-pty` (the Shell path). Nothing else — there are no
`app/src` imports, type-only included, pinned two ways (see **Guards**).

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
of it.

It stays a real `dependency` — not `optional`, not `peer` — for the other half:
a consumer who _does_ open a shell must get it installed without reading a
README. Lazy about **when** it loads, explicit about **that** it is required.
The pack smoke pins both halves: it asserts the manifest still declares it, then
renames the installed copy away and requires `./pty-manager.server` to import
anyway.

**Composed host-side:** the `'use server'` route handlers around the PTY
manager with their per-route auth gates, the document store itself, and the
`AgentDeps.withSandbox` supplier that `@hames/agents`' ready-made definitions
receive — the package is what the host wires INTO that supplier, never the
supplier itself.

## The rootfs images are repo infrastructure, not package code

`withSandbox` boots `kg-sandbox:base` and its three flavours
(`image-processing`, `data`, `office`), plus the allowlist CONNECT proxy behind
the `pypi` / `github-trusted` egress profiles. Those image definitions live in
**[`rootfs/`](../../rootfs) at the repository root** and stay there: they are
built and published by whoever operates a deployment, they version on a
different clock from this TypeScript, and a consumer of the tarball supplies its
own (or uses `backend` to supply a different compute substrate entirely). The
package names the images; it does not carry them.

Two consequences worth stating rather than discovering:

- `rootfs/egress-proxy/proxy.mjs` has its own test suite, and it stayed with the
  app (`app/src/__tests__/lib/sandbox/egress-proxy.test.ts`) — a package test
  reaching up into the repo root would be exactly the "not independently
  shippable" shape the co-located suite exists to avoid.
- `scripts/` here (the live-container smoke checks) drives those images, so it
  is dev tooling for THIS repo and is excluded from the published tarball along
  with `__tests__/`.

## No build step

Like the other `@hames` packages, this one **ships TypeScript source**: `main`
and every `exports` target is a `.ts` file, there is no `dist/`, and `pnpm pack`
is the whole publish pipeline. Consumers are **TS-bundler consumers** — a
project whose bundler or runtime compiles TypeScript (Vite/vinxi, esbuild, tsx,
Bun, `--experimental-strip-types`). A plain `node dist/index.js` consumer is not
supported, deliberately: a build step would make the published artefact
different from the source every test in this repo runs against.

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
   it into a scratch project and _evaluates_ every entry the host imports. This
   is what catches a **value** import escaping into `app/src` (as
   `ERR_MODULE_NOT_FOUND` naming the app path) or a dependency the manifest does
   not declare. In practice such an edge surfaces at the probe's **step 3**, not
   its step-6 eval loop — step 3 imports `pty-manager.server`, which transitively
   imports `with-sandbox.server` — so step 3 reports it under its own headline
   rather than under the node-pty one. It also asserts that neither `__tests__/` nor `scripts/` ships,
   and that node-pty is declared but not needed at module load (above).
3. **`package-conventions.test.ts`** — every workspace package carries a
   `.prettierrc.json` (issue #354: without one, prettier's defaults reformat
   whole files and `--check` agrees with itself, which once hid a lost docblock
   on a published export), a LICENSE and a README.
