# Extracting harness-patterns to npm — package layout and dev-vs-production loading

**Status:** decisions recorded 2026-08-23 (owner-review comments on
[#225](https://github.com/mknw/harness-playground/issues/225) and
[#226](https://github.com/mknw/harness-playground/issues/226)); scope is
converged. No code changes in this PR — it revises this plan doc, adds a
skeleton developer guide (`docs/plan/hames-guide.md`), and updates
`docs/INDEX.md`.

**Working name: `hames`.** The published core package's leading name
candidate is **`hames`** (free on npm, no search collisions); `whiffletree`
is reserved for a future subcomponent. The name is not final — this doc uses
`hames` as a placeholder throughout and will be updated once it is. The
in-tree module keeps its current `harness-patterns` name until the rename
actually lands.

The `harness-patterns/README.md` banner has said since it was written that the
directory is "the testbed" for a library "intended to be extracted as a
standalone npm package once the core API has been validated" (four boundary
rules already enforced: no imports from `harness-client/`/`components/`, no
SolidJS in the library, runtime settings only via
`settings-context.server.ts`, UI logic stays in the consumer). This plan is
about turning that intent into a workspace someone can actually build,
develop against, and ship from — **package layout, and critically, how the
libraries get loaded in dev vs. production.** A sibling ergonomics review
([#225](https://github.com/mknw/harness-playground/issues/225), plus the
app/infra angle in [#226](https://github.com/mknw/harness-playground/issues/226))
covered the library's own API surface and module boundaries; both reviews
converged with the owner on 2026-08-23, and this revision folds those
decisions in. The headline scope change: **this plan now starts with one
package, `hames`, not five** — §1.1.

Three-sentence answer:

1. **Today there is no workspace root** — `rootfs/mcp-shell/package.json`
   also exists (it is a sandbox image build input, not a workspace member),
   but there is no `pnpm-workspace.yaml` and no root `package.json`; the
   lockfile lives at `app/pnpm-lock.yaml`. The Docker build context is `app/`
   with `app/node_modules` `.dockerignore`'d, and CI's
   `defaults.run.working-directory` is `app/`. Introducing a workspace means
   promoting the repo root to a pnpm workspace root and moving `app/` to be
   one workspace member alongside `packages/hames`.
2. **Dev must keep editing-a-library-and-seeing-it-live** — pnpm's
   `workspace:*` protocol symlinks a package straight out of
   `packages/<name>/src`, so Vite/vinxi's dev server picks up an edit the same
   way it already does for `app/src` today; no build step, no publish loop.
3. **Production (docker compose) builds from the same workspace, not from the
   published registry** — this reverses the earlier draft of this plan (see
   §3.4). There is no external-consumer relationship between the docker image
   and `hames`; publishing to npm exists to serve **outside** developers, not
   this deployment. Proof that a published tarball actually installs and
   works comes from a CI `pnpm pack` + install-tarball smoke job (§3.3/§4.3),
   decoupled from whether or when a given commit is deployed.

Before any of that: §1.4 names a piece of ground truth the layout must design
around — `harness-patterns/` today imports directly from the **generated,
gitignored** `baml_client/`, which cannot be extracted as-is. The fix is a
dedicated `harness-baml` companion (§1.5), not a workaround inside core.

---

## 1. Package layout

### 1.1 Starting layout — one package (Q2)

The owner's answer to open question 2 (§7) collapses this plan's original
five-package proposal into a single first step: **only `hames` (core) is
extracted and published to start.** `harness-baml`, `harness-guard`,
`sandbox-docker`, `stash`, `retriever`, and the ready-made-harnesses package all stay inside
`app/` until `hames` itself has proven out standalone. §1.5 keeps the
eventual multi-package shape as a documented "later," not a Step 1 goal.

```
kg-agent/                          (repo root — becomes the workspace root)
├── pnpm-workspace.yaml            (new)
├── package.json                   (new — root-level scripts/tooling only)
├── packages/
│   └── hames/                     ← app/src/lib/harness-patterns/
│       ├── src/
│       ├── package.json
│       └── README.md              (moves with it)
└── app/                            (unchanged app skeleton: routes, components,
    ├── package.json                 baml_src/, settings, auth, db, MCP tool
    ├── Dockerfile                   wiring, sandbox rootfs images, and
    └── docker-compose.yaml          everything not yet extracted)
```

### 1.2 Dependency direction (target end state)

This is the shape once §1.5's companions exist — not what Step 1 builds.

| Layer    | Package(s)                                       | Depends on                                                                                                                    |
| -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 0 (leaf) | `hames`                                          | nothing extracted — target: BAML-free, no dependency on any other extracted package                                           |
| 1        | `harness-baml`                                   | `hames`, `@boundaryml/baml` (peer)                                                                                            |
| 1        | `harness-guard`                                  | `hames` only — `injection-guard.ts` moves out of core into this package (#225 §1)                                             |
| 1        | `stash`                                          | `hames` only — **not** a consumer-facing companion (§1.5); exists so sandbox and retriever have somewhere shared to depend on |
| 2        | `sandbox-docker` (+ future providers)            | `hames`, `stash`                                                                                                              |
| 2        | `retriever`                                      | `hames`, `stash`                                                                                                              |
| 3        | ready-made harnesses (`harness-client`/`agents`) | all of the above, once they exist                                                                                             |
| —        | `app/`                                           | all extracted packages; the only place BAML generation, settings, auth, Neo4j, MCP wiring, and the SolidStart UI live         |

`hames` is not currently a leaf — it is one half of a real circular package
dependency with the sandbox module today: `baml-adapters.server.ts:39`,
`mcp-client.server.ts:9`, `patterns/actorCritic.server.ts:32`, and
`patterns/simpleLoop.server.ts:33` import the runtime value `getActiveSandbox`
from `sandbox/scope.server`, while `sandbox/{scope,index,warm-pool,with-sandbox,
scheduler,work-artifacts,docker-backend,attachment-table,work-sync}.server.ts`
and `sandbox/types.ts` import back from `harness-patterns/assert.server`,
`harness-patterns/types`, and `harness-patterns/context.server`. §1.4 tables
this as its own coupling row with the injected-dependency remedy used for the
`baml_client`/`settings` rows, because it is not optional cleanup: two
packages that import each other cannot both be `pnpm pack`-ed, since whichever
publishes second would need the other already on the registry.

The rest of the graph mirrors the import graph already `grep`-confirmed on
this branch: `harness-client/examples/*` imports both `harness-patterns` and
`baml_client`; `sandbox/work-artifacts.server.ts` imports
`document-store.server.ts` and `stash/upload-service.server.ts` — i.e.
**sandbox already depends on stash at runtime**, which is exactly why the
owner's review settled stash's status as a dependency of both sandbox and
retriever rather than a standalone companion (§1.5) — the edge already exists
in the code, this plan is only naming it correctly. `harness-patterns/README.md`'s
existing rule 1 ("must not import from `harness-client/` or any other
consumer") is exactly the no-back-edges constraint this graph needs to keep
holding once each box is a separately versioned package.

### 1.3 What stays in `app/`

Everything that is inherently app-specific: `baml_src/` (and the generated
`baml_client/` — `app/` is still where `baml-generate` runs; `harness-baml`
ships its own pre-generated copy, see §1.4), `settings.ts` / `settings-store.ts`
/ `settings-context.server.ts`, `auth/`, `db/`, `neo4j/` (the direct-driver
wrapper, as opposed to the neo4j _tool namespace_ which is MCP-side config),
`app-tools/` (the MCP tool registry and `KNOWN_TOOL_SERVERS`), `graph/`,
`privacy/`, `routines/`, `turn-utils.ts` / `turn-colors.ts` / `agent-palette.ts`
(UI-facing), all SolidStart routes/components, and both Docker artifacts.
None of this moves.

Two things move the **other** direction, per the owner's delegated decisions:

- **Typed errors move INTO core** (L7/L17 in #225, delegated decision). Today
  `error-hints.ts` returns kg-agent's own settings-panel copy
  (`error-hints.ts:14-46`) and every entry point stringifies errors before
  they leave the harness. `hames` ships a small typed hierarchy
  (`HarnessError` / `ToolTransportError` / `LLMCallError` / `PatternConfigError`
  / `ToolNotAllowedError`) instead; `app/`'s `error-hints.ts` shrinks to what it
  should always have been — a map from those typed codes to this app's UI
  copy, not a regex over exception messages.
- **`assertServerOnImport` stops being a dependency of the lib** (Q4). It is a
  30-line dev-time guarantee that almost never fired and, per #225 L10, had
  already leaked into 43 non-harness app modules that have nothing to do with
  the library. The canonical helper moves to `app/src/lib/server-only.ts`;
  `hames` keeps at most a private, unexported copy of the two-line check (or
  inlines it) and drops `assertServer`/`ServerOnlyError` from its public
  barrel entirely.

### 1.4 Coupling that must be broken before extraction — the hard part

Grepping the actual imports on this branch surfaces the thing that makes this
more than a `git mv`:

| File                                                                                                                                                                                                                                    | Imports                                                                                                                                                                                                                                                                                                   | Why it blocks extraction as-is / the fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-patterns/{baml-adapters,mcp-client}.server.ts`, `patterns/{actorCritic,simpleLoop}.server.ts`                                                                                                                                  | `../sandbox/scope.server` (`getActiveSandbox`, a **runtime value**, not a type) — while `sandbox/{scope,index,warm-pool,with-sandbox,scheduler,work-artifacts,docker-backend,attachment-table,work-sync}.server.ts` + `types.ts` import back from `harness-patterns/{assert.server,types,context.server}` | **Circular package dependency**, both directions verified. Fix: `hames` owns a `ToolTransport` interface (`ownsTool`/`callTool`/`listTools`) plus `registerTransport(t, opts)` and `withTransport(t, fn)` — the ALS half. The sandbox provider (renamed `sandbox-docker`, §1.5) registers against that seam instead of `hames` importing it directly; `app-tools` registers the same way, which is what makes the seam real. Sandbox may not even need to be a _published_ package yet to do this — see the note below.                                                                                                                                                                                                                                                                                                             |
| `harness-patterns/baml-adapters.server.ts`, `types.ts`, `controller-action.ts`, `routing.server.ts`, `baml-version-check.server.ts`, `patterns/{planner,compactExecution,with-references,simpleLoop,compactIntent,retriever}.server.ts` | `../../../baml_client/types`, `../../../baml_client/inlinedbaml`                                                                                                                                                                                                                                          | `baml_client/` is generated per-consumer and gitignored — there is no version of it to publish from core. Fix: `hames` stays **BAML-free** behind an injected LLM-call interface (`ControllerFn`/`CriticFn`/`SynthesisFn`/etc., each defaulting to a BAML-backed implementation only at the call site — `compactExecution`'s `synthesize` escape hatch already models this). A separate `harness-baml` companion ships `baml_src/` **and** a pre-generated `baml_client` bundled into its own published tarball, plus the adapters (today's `baml-adapters.server.ts` + `clients.server.ts`), so a consumer never has to run `baml-generate` themselves. `@boundaryml/baml` — including `Collector`, replaced in core by a neutral `LLMCallSink` — becomes a dependency of `harness-baml` only, declared as a peer, not of `hames`. |
| `harness-patterns/harness.server.ts`, `patterns/{router,simpleLoop,actorCritic,compactBulkData}.server.ts`                                                                                                                              | `../settings-context.server` (`getRequestSettings`)                                                                                                                                                                                                                                                       | Runtime request-scoped settings via AsyncLocalStorage. `settings-context.server.ts` stays in `app/` per §1.3, so this is a live `hames` → `app/` coupling in 5 files. Fix: `hames` defines and owns a narrow `HarnessRuntimeConfig` (`maxToolTurns`, `maxRetries`, `maxResultChars`, `maxResultForSummary`, `priorTurnCount`, `routerTurnWindow`) with its own `withRuntimeConfig`/`runtimeConfig()`; the app's `HarnessSettings` extends it with `maxConcurrentRuns` and `sandbox: SandboxSettings`.                                                                                                                                                                                                                                                                                                                               |
| `harness-patterns/{compactBulkData,baml-adapters,token-budget}.server.ts`                                                                                                                                                               | `../settings` (`CLIENT_MAX_OUTPUT_TOKENS`, `estimateLlmCostUsd`, `MODEL_CONTEXT_WINDOWS`)                                                                                                                                                                                                                 | App-level config module, keyed by this repo's BAML client names. Fix: core asks the injected function for its own budget (`ControllerFn.limits?: { contextWindow; maxOutputTokens }`) instead of looking a model up in a global table; the model-name table moves wholesale into `harness-baml`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sandbox/pty-manager.server.ts`                                                                                                                                                                                                         | `../settings` (`DEFAULT_SETTINGS`)                                                                                                                                                                                                                                                                        | Same shape as the row above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sandbox/work-artifacts.server.ts`                                                                                                                                                                                                      | `../document-store.server` (app `lib/`, not inside `stash/`)                                                                                                                                                                                                                                              | Confirms `stash` must absorb `document-store.server.ts` / `document-ingest.server.ts` / `chunking.server.ts`, and that `sandbox-docker` declares `stash` as a real dependency (§1.2), not a peer the app happens to also install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 43 non-test modules outside `harness-patterns/` (`lib/auth/`, `lib/db/`, `lib/sandbox/`, `lib/stash/`, `lib/retriever/`, `lib/routines/`, `lib/app-tools/`, `lib/harness-client/`, plus chunking/embeddings/document-store/etc.)        | `harness-patterns/assert.server`                                                                                                                                                                                                                                                                          | None of these are harness consumers — they only want the `.server.ts` runtime guard. Fix per §1.3/Q4: canonical helper moves to `app/src/lib/server-only.ts`; `hames` stops exporting it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

A few smaller ergonomics fixes ride along with this surgery, all owner-approved
as delegated decisions rather than open questions:

- **`patternId` (L11)** — currently optional, defaulting to
  `Math.random().toString(36)` (`context.server.ts:29-32`), which silently
  breaks `EventView` selection when omitted. It becomes **derived
  deterministically from pattern kind + position in the composition** (e.g.
  `${patternType}-${chainIndex}`) rather than either random or a hand-supplied
  string, with **collision tests required** before this ships.
- **Raw LLM output on BAML parse failure** (new MUST, recorded in the #225
  review) — the harness already attaches `llmCall.rawOutput` to error events,
  but `ObservabilityPanel`'s `ErrorDetail` currently drops it, so a user sees
  "invalid JSON" with no way to see what the model actually said. A fix is
  **in flight in a parallel lane**; `harness-baml`'s adapters need to keep
  carrying this attachment once extracted, not just the app-side panel.
- **OTel is deleted, not wired** (L20/open question 5 in #225). The README's
  claimed OpenTelemetry integration (`README.md:1670-1692`, `CompactSpanExporter`,
  eleven span names) does not exist anywhere in `app/src` and was an early
  experiment; the owner's decision is to delete that section (and Design
  Principle #4) rather than build it, and state plainly that `onEvent` +
  `LLMCallData` are the observability surface.

**Sandbox naming and publish timing.** `harness-sandbox` is renamed to
**`sandbox-docker`**, since a Firecracker- or k8s-talos-based provider is
planned as a later, separate package registered against the same
`ToolTransport` seam — `sandbox-docker` is one implementation, not the only
one core will ever have. Its `npm` publish may be **postponed**: the rootfs
images it manages are large, environment-specific build inputs, and there is
no compelling reason to package it before something outside this repo
actually needs to install it. It can stay local — an unpublished workspace
member, or even left inside `app/` — for as long as that holds, independent
of whether `hames` itself has already shipped.

### 1.5 Eventual layout (later)

The owner's answer to Q2 (§7) is a **later, not a never**: once `hames` has
proven out standalone as Step 1, the plan's full companion set gets
extracted too — `harness-baml` (§1.2, §5 Step 3), `harness-guard`
(`injection-guard.ts` moved out of core, §1.2), `stash` as a dependency of
`sandbox-docker` and `retriever` rather than a standalone companion (§1.2, §5
Step 4), `sandbox-docker` (renamed from `harness-sandbox`, above), `retriever`
(§5 Step 4), and the ready-made-harnesses package (`agents`,
framework-agnostic per Q7, §5 Step 5). §1.2's dependency table gives that
target shape; §5 Steps 3–5 sequence the actual extraction — this section is
only the doc's signpost for the "later" framing, not a second copy of either.

---

## 2. Dev mode — local workspace source, no publish loop

### 2.1 `pnpm-workspace.yaml` (new, repo root)

```yaml
packages:
  - "app"
  - "packages/*"
```

### 2.2 `hames`'s `package.json`

```json
{
  "name": "@kg-agent/hames",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

No `@boundaryml/baml` dependency here — see §1.4. No build step in the
package during dev either: `main`/`exports` point straight at `src/`, the
same way `app/src/lib/harness-patterns` is consumed today. This matters
because vinxi/Vite resolve TypeScript source directly — adding a
`tsc`/`tsup` build step here would reintroduce exactly the compile-then-reload
loop this plan exists to avoid. (A build step is still needed for the
_published_ artifact — see §4 — it just should not sit in the dev resolution
path.)

### 2.3 `app/package.json` — consuming the workspace

```json
{
  "dependencies": {
    "@kg-agent/hames": "workspace:*"
  }
}
```

`workspace:*` tells pnpm "always resolve to whatever is in `packages/hames`
of this checkout" — pnpm symlinks `app/node_modules/@kg-agent/hames` straight
to `packages/hames`, so editing a file there is indistinguishable, from the
dev server's point of view, from editing a file under `app/src/lib` today.
`CLAUDE.md`'s command surface is unaffected: `pnpm dev` / `pnpm dev:exposed`
still run from `app/`, and `pnpm baml-generate` after any `baml_src/` edit is
still the one thing a workspace does not automate.

One immediate consequence worth flagging up front for the migration order in
§5: a single `pnpm-lock.yaml` now spans `app/` and `packages/hames`, so the
lockfile most CI steps already reference by path
(`cache-dependency-path: app/pnpm-lock.yaml`, the `.dockerignore` note that
`app/node_modules` is per-arch) needs to move to the repo root the same day
the workspace is introduced — there is no incremental halfway state where
`app/` keeps its own lockfile alongside a workspace one.

---

## 3. Production (docker compose) — build from the workspace, not the published registry

This section reverses the mechanism the original draft of this plan proposed
(kept below in §3.4 for the record). Unlike the rest of this doc, that
reversal does not come from the #225/#226 review comments — neither mentions
docker, the registry, or production loading. It traces to an owner Q&A in the
coordination session of 2026-08-23: the owner asked whether "install from
npm in prod" was an implicitly-enforced constraint the plan didn't actually
need; the coordinator answered that publishing exists to serve **external**
developers, that production instead builds from the pnpm workspace, and that
dogfooding survives via a CI `pnpm pack` + install-tarball smoke job
(§3.3/§4.3) rather than a registry install on the deploy path; the owner
accepted that direction in follow-up feedback without objection. As a
session decision rather than a recorded review comment, it carries the same
standing §7 item 4 gives the §1.4 surgery timing — explicitly overridable by
the owner if this doesn't hold: **prod does not need to consume `hames` from
npm.**

### 3.1 Why registry-only was the wrong forcing function

The earlier draft's reasoning was structurally sound — excluding `packages/*`
from the Docker build context would _force_ `--frozen-lockfile` to fetch
`@kg-agent/hames` from the registry, making dev-vs-production loading a
property of the build rather than a flag someone has to remember. But it
solved a problem this repo doesn't have: there is no external-consumer
relationship between the docker-compose deployment and `hames` — both live in
the same monorepo, are versioned together, and the docker image is a build
artifact of _this_ checkout, not a downstream installer of a package this
checkout happens to also produce. Forcing every library fix through a publish
cycle before the deployed app could pick it up added latency and a
version-pin PR for no safety benefit internal to this repo. Publishing to npm
exists to serve **outside** developers who are not running this docker
compose stack at all.

### 3.2 What the image actually needs

1. **Build context.** Docker Compose's `build.context: ./app` becomes
   `build.context: .` (repo root) with `dockerfile: app/Dockerfile`, because
   the workspace's root `pnpm-lock.yaml` (§2.3) lives at the repo root and
   `pnpm install --frozen-lockfile` inside the image needs to see it.
2. **`.dockerignore` at the repo root** (new) excludes the usual
   irrelevancies (`.git`, per-arch `node_modules`, `baml_client`, `.env`) —
   but, unlike the earlier draft, it does **not** exclude `packages/`.
   `packages/hames` needs to be present in the build context so
   `workspace:*` resolves inside the image exactly the way it resolves in
   dev: pnpm symlinks it, no registry round-trip, no separate "production"
   `package.json` to maintain.
3. **`app/package.json` keeps `workspace:*` unconditionally** — in dev and in
   the docker image alike — because `app/` is a workspace member, not an
   external consumer of a package it happens to also build. There is no
   pinned-semver variant of `app/package.json` for a release branch to carry;
   that variant only exists for actual external consumers, who resolve
   `hames` from the registry the normal npm way once it's published (§4).

### 3.3 Dogfooding without forcing a registry dependency

The original plan's registry-only requirement also served a second purpose:
proving a _published_ tarball actually works, not just the workspace-symlinked
source. That value is real and worth keeping — it just doesn't need to sit on
the production deploy path. Instead:

- A CI job runs `pnpm pack` on `hames` (and, once they exist, each other
  publishable package), installs the resulting tarball into a throwaway
  scratch project, and runs a smoke script that imports the package and
  exercises one minimal pattern end to end. This catches the real, common
  first-extraction failure mode — a package that works via `workspace:*`
  symlink but is missing a file in its `files`/`exports` allowlist once
  packed — without needing a fake registry in CI or gating any deploy on it.
- This job (detailed in §4.3) is now the **sole** mechanism proving the
  published artifact installs cleanly; nothing about running the dockerized
  app exercises that path anymore, so it must not be treated as optional
  once there is anything to publish.

### 3.4 Reversed from the original proposal: registry-only production loading

The original draft of this plan required the docker-compose image to install
`hames` exclusively from the published npm registry, using the build-context
exclusion above as the enforcement mechanism, and rejected a
`USE_LOCAL_PACKAGES` build-arg toggle as an alternative to that rule. Kept
here for the record, since it is exactly the kind of considered-and-reversed
decision this repo's docs are supposed to preserve rather than silently drop:

> An earlier idea worth naming so it isn't silently reinvented later: a
> `USE_LOCAL_PACKAGES` build arg that widens the Docker build context and
> skips the registry install when set. Rejected because it reintroduces
> exactly the non-structural "someone has to remember to flip a flag" failure
> mode this plan was trying to remove (the same shape of problem `CLAUDE.md`
> already documents for `USE_MIXED_CHAINS`).

The reversal above doesn't resurrect that toggle — there is no flag, because
there is no registry path for production to opt into or out of. Production
is unconditionally workspace-source; only an external `npm install
@kg-agent/hames` ever touches the registry.

---

## 4. Publish + versioning flow

This flow exists to give **external developers** a versioned, installable
artifact. Per §3.4 it is no longer a gate on production deploys — publishing
and deploying are decoupled.

### 4.1 Tool: Changesets

[Changesets](https://github.com/changesets/changesets) is the standard fit for
a pnpm workspace with independently-versioned packages and is what this plan
assumes; nothing else in the repo currently commits to a versioning tool
(`find . -iname '*.changeset*'` on this branch returns nothing). Flow:

1. A PR that changes `packages/hames/**` includes a changeset file
   (`pnpm changeset` — an interactive prompt that writes a small markdown file
   describing the bump: patch/minor/major + a human summary).
2. Merging to `main` triggers a "Version Packages" PR (bot-authored, via the
   `changesets/action` GitHub Action) that bumps `package.json` versions and
   rolls the changeset files into `CHANGELOG.md`.
3. Merging _that_ PR runs `pnpm changeset publish`, which publishes the
   bumped package to the registry and tags the commit. This is entirely
   independent of whether or when `main` is deployed — see §3.

### 4.2 Version pinning

`app/` never pins a semver range on `hames` — it stays on `workspace:*`
permanently, in dev and in production alike (§3.2), because it is a workspace
member, not an external consumer. Semver pinning only exists on the far side
of the registry, for actual outside consumers doing an ordinary
`npm install @kg-agent/hames@^0.1.0`. Until the package's ergonomics converge,
staying on `0.x` and treating every release as potentially breaking is
appropriate — Changesets' "major" bump inside `0.x` is a convention question
for whoever maintains `hames`'s public API, not this plan.

### 4.3 CI validation

Additions to `.github/workflows/ci.yml`, scoped by path so they don't run on
every app-only PR:

- A `packages` job (parallel to the existing `check` and `image` jobs,
  mirroring their independence-on-purpose pattern) that runs `pnpm -r --filter
'./packages/*' build && pnpm -r --filter './packages/*' test` — each library
  is typechecked and tested standing alone, not only as imported by `app/`.
  This is what catches the §1.4 coupling _before_ a publish attempt fails on
  it.
- A `changeset check` step (or the official `changesets/action` in
  `--dry-run` mode) on PRs that touch `packages/**`, failing the PR if a
  changeset is missing.
- The `pnpm pack` + install-from-tarball smoke step from §3.3. With production
  no longer forcing every package through a registry install, **this step is
  the only place in CI that exercises "does the published tarball actually
  work end-to-end"** — treat it as load-bearing, not optional, once `hames`
  has a `files`/`exports` allowlist to get wrong.

### 4.4 v1 client scope for `harness-baml`

Once `harness-baml` exists (§1.5), its published adapters ship only what the
owner has committed to running: **Anthropic + a generic custom-endpoint
client** (the owner is deploying a Qwen4.8-27B model on a Verda PRO RTX 6000
box and will consume it through the custom-endpoint client). The
mixed-provider fallback chains (`clients.baml`'s `RouterFallback` /
`ControllerFallback` / etc., spread across Groq/OpenRouter/OpenAI) are
legacy/dev-iteration constructs — see §6 — and are **not part of the
published package**. They stay `app/`-only tooling behind `USE_MIXED_CHAINS`.

### 4.5 Private vs. public, and registry choice

Open — see §7. Nothing in §2/§4 depends on the answer: `workspace:*` in
`app/` and a normal `npm install` for external consumers work identically
whether the registry is the public npm registry, a GitHub Packages scoped
registry, or a private registry (Verdaccio, npm Enterprise).

---

## 5. Migration steps, risk-ordered

Each step is independently shippable and leaves the app working end to end at
every commit — mirroring the shipping discipline in
`docs/plan/offline-agent-auth.md` §6. Drafting `docs/plan/hames-guide.md`
(new, this PR) does not gate any step below; it can be filled in incrementally
alongside whichever step is in flight.

**Step 0 — introduce the workspace with zero package moves** _(hours; no
behavior change)_ Add `pnpm-workspace.yaml` listing only `app` as a member (a
one-member workspace is valid pnpm), move `pnpm-lock.yaml` to the repo root,
update `ci.yml`'s `cache-dependency-path` and the Dockerfile's `COPY` paths
accordingly. This step exists purely to prove the CI/Docker plumbing survives
the root-lockfile move (§2.3's flagged consequence) before anything harder
rides on top of it.

**Step 1 — extract `hames`, resolved via `workspace:*`, with the P0 seam work
done in the same PR** _(the biggest single step)_ Move
`app/src/lib/harness-patterns` to `packages/hames`. In this one PR: invert
the sandbox cycle (the `ToolTransport` registry, §1.4), replace the
`baml_client`/`@boundaryml/baml` imports with the injected-function seam and a
neutral `LLMCallSink`, split `HarnessRuntimeConfig` out of `HarnessSettings`,
ship the typed `HarnessError` hierarchy (L7/L17), move `assertServerOnImport`
to `app/src/lib/server-only.ts` (Q4), and switch `patternId` to deterministic
derivation with collision tests (L11). Doing all of §1.4's surgery here, once,
rather than spread across later steps, avoids an intermediate state where the
injected-dependency shape exists without the package split that motivated it
(this was open question 5 in the original draft — this plan now assumes that
answer, though it remains open for the owner to override, see §7). `app/`
depends on `hames` via `workspace:*`. Also widen the Docker build context to
repo root and drop `packages/` from `.dockerignore` here (§3.2) — since
production never gates on a registry, there is no reason to defer this until
after a publish. Exit criterion: the `packages` CI job (§4.3) passes and
`docker compose up -d app` boots against `packages/hames` present in the
build context.

**Step 2 — first publish, decoupled from deployment** _(§4)_ Cut
`hames@0.1.0` and stand up the `pnpm pack` + install-tarball CI smoke job
(§3.3/§4.3). Nothing about the docker-compose deployment changes in this
step — it was already running off workspace source since Step 1. This step
exists purely to make `hames` installable by an external developer.

**Step 3 — extract `harness-baml`** _(depends on Step 1's injected-function
seam landing cleanly)_ Move today's `baml-adapters.server.ts` +
`clients.server.ts` + `baml-version-check.server.ts` out; ship a pre-generated
`baml_client` inside the published tarball; scope the v1 client set to
Anthropic + custom-endpoint only (§4.4); `@boundaryml/baml` becomes a peer
dependency of this package, not of `hames`.

**Step 4 — extract `sandbox-docker`, `stash`, `retriever`** _(can run in
parallel with each other once Step 1 is done; `stash` first in practice since
both of the others declare it as a real dependency, not a peer, per §1.2)_
`sandbox-docker`'s own npm publish may be postponed per §1.4 — it can extract
into `packages/` and stay an unpublished workspace member indefinitely.
Code-mode is **removed entirely** rather than extracted — it is not part of
v1 of any package, and neither is any other tool-reload mechanism: current
agents hardcode their MCP tools, and v1 does not change that (#225 L5).
Code-mode's revival will be tracked by a follow-up issue (`Could` MoSCoW
priority) that the in-flight cleanup PR below will file, pointing at the last
commit containing it. That cleanup PR (also doing the `harness-client/examples`
→ `agents` rename below) is in flight in a parallel lane.

**Step 5 — extract the ready-made-harnesses package (`harness-client` →
`agents`)** _(depends on Step 4)_ Rename `examples/` to `agents/` (already
in flight, see Step 4). Strip the UnoCSS dependency out of this package
entirely (Q7) — the extracted lib stays framework-agnostic; a SolidJS adapter
and/or a consumer-side tutorial section (e.g. wiring a pattern inside a REST
endpoint) ships as an optional extra, not a hard dependency.

**Step 6 — CI hardening + changelog cutover** Add the `packages` CI job and
`changeset check` gate (§4.3) once there's more than one package to validate
independently; backfill `CHANGELOG.md` for steps 1–5's packages retroactively
if desired.

---

## 6. Interaction with `USE_MIXED_CHAINS` and other existing app-level toggles

Worth stating explicitly since `CLAUDE.md`'s build/commands section leads with
it: `USE_MIXED_CHAINS=1 pnpm dev:exposed` and the Anthropic-only default are
both **app-level** concerns (`clients.server.ts` lives in `app/` today, and
moves into `harness-baml` per §1.4/§1.5) and are unaffected by this migration
in either dev or production — they select which BAML client chain a pattern
is bound to, which is orthogonal to which package the pattern _code_ is
loaded from. Per §4.4, the mixed-provider chains never ship in the published
`harness-baml` package at all: they are dev-iteration tooling that stays
behind the `USE_MIXED_CHAINS` flag in `app/`, not part of the v1 client
surface (Anthropic + custom-endpoint) an external consumer gets.

---

## 7. Open questions for the user

Resolved by the owner's 2026-08-23 review, kept here for the record:

- **Scope (was Q1/Q2)** — one package (`hames`) at the start; the full
  companion layout is §1.5, not Step 1. `harness-baml` is a real package,
  not BAML-in-core.
- **`assert.server` (was Q4)** — removed as a dependency of the lib; the
  canonical helper lives in `app/src/lib/server-only.ts`.
- **Ready-made harnesses and UnoCSS (was Q7)** — factored out; the package
  stays framework-agnostic with an optional SolidJS adapter/tutorial.
- **Structure: is `stash` a companion?** — no; it's a dependency of both
  `sandbox-docker` and `retriever` (§1.2/§1.5). No compelling stash+core-only
  flow exists (the SharePoint-download case is already covered by
  chat-message links).
- **OTel (was Q5/L20)** — delete the README section, don't wire it.
- **`patternId` required (was L11)** — derive deterministically instead of
  requiring it or leaving it random; collision tests required.
- **Naming** — leading candidate `hames`; `whiffletree` reserved for a future
  subcomponent. Not yet final.

Still open, ordered by how much they'd change the plan:

1. **Registry: public npm, GitHub Packages, or a private registry?** Drives
   §4.5's `.npmrc`/auth-token detail and whether the org is comfortable with
   `@kg-agent/hames` being publicly installable (it currently contains no
   secrets, but it does encode internal architecture choices).
2. **Package scope name** — `@kg-agent/*` is used as a placeholder throughout
   this doc; confirm the actual npm org/scope before Step 1's `package.json`
   is written. Tied to the `hames` naming question above.
3. **Monorepo (this plan's shape) vs. split repos per package?** A split-repo
   approach would still need the same dev-vs-production loading answer (Git
   submodules or a `link:` protocol standing in for `workspace:*` in dev) but
   changes §5's step ordering substantially and adds cross-repo PR
   coordination overhead. This plan defaults to monorepo because it is the
   lower-migration-cost option.
4. **Timing of the §1.4 surgery relative to Step 1** — Step 1 above assumes
   all of it lands in the same PR as the package move (one disruptive PR, no
   intermediate state where the injected-dependency shape exists without the
   split that motivated it). The alternative — doing it as prep work on
   `main` before any package move — was never explicitly ruled out by the
   owner and remains available if Step 1 turns out too large to review as one
   PR.

---

## 8. Relationships

- `app/src/lib/harness-patterns/README.md` — states the extraction intent and
  the four boundary rules this plan's §1.2 dependency graph is built to
  preserve.
- [#225](https://github.com/mknw/harness-playground/issues/225) — the
  ergonomics review this plan's BAML seam, `ToolTransport` inversion, typed
  errors, `patternId` derivation, `assert.server` removal, OTel deletion, and
  raw-output-on-parse-failure requirement are drawn from; its owner-review
  comment (2026-08-23) is the authoritative source for all of §1.4/§1.5/§7's
  "resolved" items and the `hames`/`whiffletree` naming.
- [#226](https://github.com/mknw/harness-playground/issues/226) — the
  app/infra-side review; its owner-review comment confirms A7 (stash's
  dependency status, matching #225) and B4 (the framework-agnostic
  ready-made-harnesses constraint, §1.5/Step 5).
- `docs/plan/hames-guide.md` — new developer-guide skeleton (this PR); the
  eventual full version ships as a skill alongside the published package,
  per the #225 review's L22 decision.
- `docs/plan/offline-agent-auth.md` — the format this doc follows
  (converged-plan style: numbered sections, a three-sentence answer up front,
  risk-ordered migration steps, an open-questions section ordered by
  plan-changing weight).
- `CLAUDE.md` — commands (`pnpm baml-generate`, `USE_MIXED_CHAINS`), the
  `.server.ts` boundary convention, and the code-minimalism ladder this plan's
  §3.4 rejection (of the build-arg toggle, not of registry-only loading
  itself) leans on ("no abstraction... nobody asked for").
