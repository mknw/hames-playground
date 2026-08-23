# Extracting harness-patterns to npm — package layout and dev-vs-production loading

**Status:** proposal, awaiting user sign-off on scope (§7). No code changes in
this PR — it adds this plan doc and its `docs/INDEX.md` entry only.

The `harness-patterns/README.md` banner has said since it was written that the
directory is "the testbed" for a library "intended to be extracted as a
standalone npm package once the core API has been validated" (four boundary
rules already enforced: no imports from `harness-client/`/`components/`, no
SolidJS in the library, runtime settings only via
`settings-context.server.ts`, UI logic stays in the consumer). This plan is
about turning that intent into a workspace someone can actually build,
develop against, and ship from — **package layout, and critically, how the
libraries get loaded in dev vs. production.** A sibling lane is reviewing the
library's own API ergonomics and the exact module boundaries (what belongs in
`harness-patterns` proper vs. a companion package); this plan does not
pre-empt that — it assumes _some_ multi-package split close to §1 and focuses
on the mechanics that are true regardless of exactly where the lines fall:
workspace wiring, the dev/production loading split, and the publish flow.

Three-sentence answer:

1. **Today there is no workspace root** — `rootfs/mcp-shell/package.json`
   also exists (it is a sandbox image build input, not a workspace member),
   but there is no `pnpm-workspace.yaml` and no root `package.json`; the
   lockfile lives at `app/pnpm-lock.yaml`. The Docker build context is `app/`
   with `app/node_modules` `.dockerignore`'d, and CI's
   `defaults.run.working-directory` is `app/`. Introducing packages means
   promoting the repo root to a pnpm workspace root and moving `app/` to be
   one workspace member among several.
2. **Dev must keep editing-a-library-and-seeing-it-live** — pnpm's
   `workspace:*` protocol symlinks a package straight out of
   `packages/<name>/src`, so Vite/vinxi's dev server picks up an edit the same
   way it already does for `app/src` today; no build step, no publish loop.
3. **Production (docker compose) must NOT use that symlink** — the image is
   built from a clean `pnpm install --frozen-lockfile` inside a build context
   that does not even contain the sibling packages, so it is structurally
   forced to resolve `@scope/harness-patterns` from the **published npm
   registry** version pinned in the lockfile, never from local source. That
   separation is the crux of this plan and is detailed in §3.

Before any of that: §1.4 names a piece of ground truth the layout must design
around — `harness-patterns/` today imports directly from the **generated,
gitignored** `baml_client/`, which cannot be extracted as-is.

---

## 1. Package layout

### 1.1 Proposed workspace structure

```
kg-agent/                          (repo root — becomes the workspace root)
├── pnpm-workspace.yaml            (new)
├── package.json                   (new — root-level scripts/tooling only)
├── packages/
│   ├── harness-patterns/          ← app/src/lib/harness-patterns/
│   │   ├── src/
│   │   ├── package.json
│   │   └── README.md              (moves with it)
│   ├── harness-client/            ← app/src/lib/harness-client/
│   │   ├── src/
│   │   └── package.json
│   ├── harness-sandbox/           ← app/src/lib/sandbox/
│   │   └── package.json
│   ├── harness-stash/             ← app/src/lib/stash/  (+ document-store.server.ts,
│   │   └── package.json             document-ingest.server.ts, chunking.server.ts —
│   │                                 today siblings of stash/, not inside it)
│   └── harness-retriever/         ← app/src/lib/retriever/
│       └── package.json
├── app/                            (unchanged app skeleton: routes, components,
│   ├── package.json                 baml_src/, settings, auth, db, MCP tool
│   ├── Dockerfile                   wiring, sandbox rootfs images)
│   └── docker-compose.yaml          (or stays at repo root — unchanged either way)
└── docs/
```

### 1.2 Dependency direction

```
harness-patterns   (target: leaf — no dependency on any other extracted package)
       ↑
harness-client     (depends on harness-patterns)
       ↑
harness-sandbox ── harness-stash ── harness-retriever   (each depends on
       ↑               ↑                 ↑                harness-patterns for
       └───────────────┴─────────────────┘                shared types only)
                        │
                       app/  (depends on all five; the only place BAML,
                              settings, auth, Neo4j, MCP wiring, and the
                              SolidStart UI live)
```

This is the **target** shape, not what exists on this branch today.
`harness-patterns` is not currently a leaf — it is one half of a real
circular package dependency with `harness-sandbox`: `baml-adapters.server.ts:39`,
`mcp-client.server.ts:9`, `patterns/actorCritic.server.ts:32`, and
`patterns/simpleLoop.server.ts:33` import the runtime value `getActiveSandbox`
from `sandbox/scope.server`, while `sandbox/{scope,index,warm-pool,with-sandbox,
scheduler,work-artifacts,docker-backend,attachment-table,work-sync}.server.ts`
and `sandbox/types.ts` import back from `harness-patterns/assert.server`,
`harness-patterns/types`, and `harness-patterns/context.server`. §1.4 tables
this as its own coupling row with the same injected-dependency remedy used for
the `baml_client`/`settings` rows, because it is not optional cleanup: two
packages that import each other cannot both be `pnpm pack`-ed, since whichever
publishes second would need the other already on the registry.

The rest of the graph (below `harness-patterns`, once that cycle is broken)
mirrors the import graph already `grep`-confirmed on this branch:
`harness-client/examples/*` imports both `harness-patterns` and
`baml_client`; `sandbox/work-artifacts.server.ts` imports
`document-store.server.ts` and `stash/upload-service.server.ts` — i.e.
**sandbox already depends on stash**, so `harness-sandbox`'s `package.json`
must declare `harness-stash` as a real dependency, not a peer the app happens
to also install. `harness-patterns/README.md`'s existing rule 1 ("must not
import from `harness-client/` or any other consumer") is exactly the
no-back-edges constraint this graph needs to keep holding once each box is a
separately versioned package — a cycle here is a circular npm dependency, not
just a lint nit, and the `harness-patterns` ⇄ `harness-sandbox` edge above is
that violation already in effect, not a hypothetical future risk.

### 1.3 What stays in `app/`

Everything that is inherently app-specific: `baml_src/` (and the generated
`baml_client/`), `settings.ts` / `settings-store.ts` / `settings-context.server.ts`,
`auth/`, `db/`, `neo4j/` (the direct-driver wrapper, as opposed to the neo4j
_tool namespace_ which is MCP-side config), `app-tools/` (the MCP tool
registry and `KNOWN_TOOL_SERVERS`), `graph/`, `privacy/`, `routines/`,
`turn-utils.ts` / `turn-colors.ts` / `agent-palette.ts` (UI-facing), all
SolidStart routes/components, and both Docker artifacts. None of this moves.

### 1.4 Coupling that must be broken before extraction — the hard part

Grepping the actual imports on this branch surfaces the thing that makes this
more than a `git mv`:

| File                                                                                                                                                                                                                                    | Imports                                                                                                                                                                                                                                                                                                   | Why it blocks extraction as-is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-patterns/{baml-adapters,mcp-client}.server.ts`, `patterns/{actorCritic,simpleLoop}.server.ts`                                                                                                                                  | `../sandbox/scope.server` (`getActiveSandbox`, a **runtime value**, not a type) — while `sandbox/{scope,index,warm-pool,with-sandbox,scheduler,work-artifacts,docker-backend,attachment-table,work-sync}.server.ts` + `types.ts` import back from `harness-patterns/{assert.server,types,context.server}` | **Circular package dependency**, both directions verified. Neither `harness-patterns` nor `harness-sandbox` can publish first — whichever does needs the other already on the registry. Fix: `harness-patterns` declares a sandbox-provider seam (a typed interface for "get the active sandbox scope") that `harness-sandbox` or `app/` implements and injects at the call site — the same injected-dependency shape as the `baml_client`/`settings` rows below — so the runtime edge inverts and the graph in §1.2 becomes real. |
| `harness-patterns/baml-adapters.server.ts`, `types.ts`, `controller-action.ts`, `routing.server.ts`, `baml-version-check.server.ts`, `patterns/{planner,compactExecution,with-references,simpleLoop,compactIntent,retriever}.server.ts` | `../../../baml_client/types`, `../../../baml_client/inlinedbaml`                                                                                                                                                                                                                                          | `baml_client/` is **generated per-consumer** from that consumer's own `baml_src/` and is gitignored — there is no version of it to publish. A published `@scope/harness-patterns` cannot contain a relative import into a directory that only exists inside whichever app happens to run `baml-generate`.                                                                                                                                                                                                                          |
| `harness-patterns/harness.server.ts`, `patterns/{router,simpleLoop,actorCritic,compactBulkData}.server.ts`                                                                                                                              | `../settings-context.server` (`getRequestSettings`)                                                                                                                                                                                                                                                       | Runtime request-scoped settings via AsyncLocalStorage. `settings-context.server.ts` stays in `app/` per §1.3, so this is a live `harness-patterns` → `app/` coupling in 5 files, not just the `settings.ts` one below — both need the same seam.                                                                                                                                                                                                                                                                                   |
| `harness-patterns/{compactBulkData,baml-adapters,token-budget}.server.ts`                                                                                                                                                               | `../settings` (`CLIENT_MAX_OUTPUT_TOKENS`, `estimateLlmCostUsd`, `MODEL_CONTEXT_WINDOWS`)                                                                                                                                                                                                                 | App-level config module, not a library concern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sandbox/pty-manager.server.ts`                                                                                                                                                                                                         | `../settings` (`DEFAULT_SETTINGS`)                                                                                                                                                                                                                                                                        | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sandbox/work-artifacts.server.ts`                                                                                                                                                                                                      | `../document-store.server` (app `lib/`, not inside `stash/`)                                                                                                                                                                                                                                              | Confirms `harness-stash` as proposed in §1.1 must absorb `document-store.server.ts` / `document-ingest.server.ts` / `chunking.server.ts`, or `harness-sandbox` needs a narrower interface than the concrete module today.                                                                                                                                                                                                                                                                                                          |

The fix is the same shape in every row: replace the direct import with an
**injected dependency** — a typed interface the package declares and the
consumer (`app/`, or in the sandbox cycle's case whichever package wires the
two together) supplies at the call site — exactly the pattern `README.md`
rule 3 already uses for runtime settings (`settings-context.server.ts`,
AsyncLocalStorage) rather than function parameters. Concretely for BAML: the
package should accept the _shape_ of a BAML-generated client (the function
signatures it calls, e.g. a `ControllerFn` type) as a generic/parameter,
never the literal `baml_client` import — which is also exactly what the
"pass BAML functions directly... bind to preserve `this`" calling convention
in the README already does at the call site (`b.Neo4jController.bind(b)`);
the type import is the one piece that still reaches into the generated tree
and needs to move to a declared interface. **This is squarely the sibling
ergonomics lane's job to resolve** — it is called out here only because it
gates whether `harness-patterns` can be `pnpm pack`-ed at all, which this
plan's §3/§4 depend on. The `harness-patterns` ⇄ `harness-sandbox` cycle
gates it even harder: it isn't a lint nit deferred to later, it is the
difference between a publishable graph and one that cannot resolve at all.

---

## 2. Dev mode — local workspace source, no publish loop

### 2.1 `pnpm-workspace.yaml` (new, repo root)

```yaml
packages:
  - "app"
  - "packages/*"
```

### 2.2 Each package's `package.json` (example: `harness-patterns`)

```json
{
  "name": "@kg-agent/harness-patterns",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@boundaryml/baml": "0.224.0"
  }
}
```

No build step in the package during dev: `main`/`exports` point straight at
`src/`, the same way `app/src/lib/harness-patterns` is consumed today. This
matters because vinxi/Vite resolve TypeScript source directly — adding a
`tsc`/`tsup` build step here would reintroduce exactly the compile-then-reload
loop this plan exists to avoid. (A build step is still needed for the
_published_ artifact — see §4 — it just should not sit in the dev resolution
path.)

### 2.3 `app/package.json` — consuming the workspace

```json
{
  "dependencies": {
    "@kg-agent/harness-patterns": "workspace:*",
    "@kg-agent/harness-client": "workspace:*",
    "@kg-agent/harness-sandbox": "workspace:*",
    "@kg-agent/harness-stash": "workspace:*",
    "@kg-agent/harness-retriever": "workspace:*"
  }
}
```

`workspace:*` tells pnpm "always resolve to whatever is in `packages/<name>`
of this checkout" — pnpm symlinks `app/node_modules/@kg-agent/harness-patterns`
straight to `packages/harness-patterns`, so editing a file there is
indistinguishable, from the dev server's point of view, from editing a file
under `app/src/lib` today. `CLAUDE.md`'s command surface is unaffected:
`pnpm dev` / `pnpm dev:exposed` still run from `app/`, and `pnpm baml-generate`
after any `baml_src/` edit is still the one thing a workspace does not
automate (the library packages don't own `baml_src/` — see §1.4).

One immediate consequence worth flagging up front for the migration order in
§6: a single `pnpm-lock.yaml` now spans `app/` and every `packages/*` member,
so the lockfile most CI steps already reference by path
(`cache-dependency-path: app/pnpm-lock.yaml`, the `.dockerignore` note that
`app/node_modules` is per-arch) needs to move to the repo root the same day
the workspace is introduced — there is no incremental halfway state where
half the packages share a root lockfile and `app/` keeps its own.

---

## 3. Production (docker compose) — install from the published registry, never workspace source

This is the part the task explicitly flags as critical, so it is worth being
precise about _why_ the current Dockerfile already gets this almost right by
accident, and what one thing has to change.

### 3.1 Why the existing image is (mostly) already safe

`app/Dockerfile`'s `deps` stage does:

```dockerfile
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
```

and the build stage's `COPY . .` only copies the `app/` build context — the
Dockerfile's own header is explicit that "Build context is `app/`... nothing
outside it is needed." **If `packages/*` never enters that build context at
all, `workspace:*` cannot resolve** — pnpm has no local package to symlink to,
so `--frozen-lockfile` is _forced_ to fetch `@kg-agent/harness-patterns` from
whatever registry the lockfile recorded, at the exact version the lockfile
pinned. This is the mechanism this plan leans on: **the separation is
structural (the sibling packages are outside the build context), not a flag
someone has to remember to pass.**

### 3.2 What has to change

Two things, both small:

1. **Build context.** Docker Compose's `build.context: ./app` must become
   `build.context: .` (repo root) with `dockerfile: app/Dockerfile`, because
   the workspace's root `pnpm-lock.yaml` (§2.3) now lives at the repo root,
   not inside `app/`, and `pnpm install --frozen-lockfile` inside the image
   needs to see it. This is the one place the build context _does_ need to
   widen — immediately followed by the `.dockerignore` tightening below so
   that widening doesn't leak local package source into the image.
2. **`.dockerignore` at the repo root** (new, since the build context moved)
   must explicitly exclude the workspace-local package sources so a `COPY . .`
   inside the image can never accidentally see them, even if a future change
   to the Dockerfile got careless about what it copies:

   ```gitignore
   # Workspace-local package source — production images resolve
   # @kg-agent/* from the npm registry via pnpm-lock.yaml, never from local
   # workspace source. This entry is a second line of defense: the real
   # guarantee is that pnpm-lock.yaml pins registry tarballs and
   # --frozen-lockfile refuses to substitute anything else.
   packages/
   ```

   with `app/.dockerignore`'s existing entries (`node_modules`, `baml_client`,
   `.env`, etc.) carried forward unchanged, now understood as relative to the
   new root context.

3. **`pnpm-lock.yaml` must actually contain registry resolutions, not
   `workspace:` links, for the published packages** — which is automatically
   true the moment `app/package.json` depends on a real published semver
   range (`^0.1.0`) instead of `workspace:*` in whatever branch/tag production
   deploys from. This is why §4's versioning flow matters: **dev's
   `package.json` and production's `package.json` are not the same text.**
   The cleanest way to keep that from being a hand-maintained fork is
   `pnpm publish` from the workspace itself, which pnpm already knows how to
   do: pnpm's publish step _rewrites_ `workspace:*` to the real version being
   published (`workspace:*` → `0.1.0`) inside the tarball's own
   `package.json`, so the awkward step is not maintaining two versions of
   `app/package.json` — it's a `pnpm changeset version` bump to
   `"@kg-agent/harness-patterns": "^0.1.0"` in `app/package.json` on the
   release branch, checked in in the same PR that runs `changeset publish`
   (§4). Dev branches keep `workspace:*`.

### 3.3 What this buys, and what it costs

**Buys:** an image that is byte-for-byte the same whether the sibling
packages are 2 lines or 20,000 lines of local, uncommitted, mid-refactor code
— because the image never sees them. It also forces the discipline the task
description is really asking for: a docker-compose deploy is a _release_
artifact, and it should only ever run code that has cleared the publish gate
in §4, not whatever happens to be on disk in a worktree.

**Costs:** a library bug found while running the dockerized app can no longer
be fixed and re-tested by editing a file and refreshing — it has to go through
publish (or a throwaway prerelease tag, see §4.3) before the image sees it.
That tradeoff is deliberate and is what "dev vs. production" in the task title
is asking for; it is _not_ a reason to add a source-vs-registry toggle
(considered and rejected below).

### 3.4 Rejected alternative: a build-arg toggle

An earlier idea worth naming so it isn't silently reinvented later: a
`USE_LOCAL_PACKAGES` build arg that widens the Docker build context and skips
the registry install when set. Rejected because it reintroduces exactly the
non-structural "someone has to remember to flip a flag" failure mode this
plan is trying to remove (the same shape of problem `CLAUDE.md` already
documents for `USE_MIXED_CHAINS` — that one is an intentional, narrow,
documented escape hatch for a real need; this one would just be a way to
accidentally ship unpublished code). If a genuine need for
image-from-local-source arises (e.g. testing a library change against the
full docker-compose stack before publishing), the answer is §4.3's prerelease
tag, not a build-time source switch.

---

## 4. Publish + versioning flow

### 4.1 Tool: Changesets

[Changesets](https://github.com/changesets/changesets) is the standard fit for
a pnpm workspace with independently-versioned packages and is what this plan
assumes; nothing else in the repo currently commits to a versioning tool
(`find . -iname '*.changeset*'` on this branch returns nothing). Flow:

1. A PR that changes `packages/harness-patterns/**` includes a changeset file
   (`pnpm changeset` — an interactive prompt that writes a small markdown file
   describing the bump: patch/minor/major + a human summary).
2. Merging to `main` triggers a "Version Packages" PR (bot-authored, via the
   `changesets/action` GitHub Action) that bumps `package.json` versions and
   rolls the changeset files into `CHANGELOG.md` per package.
3. Merging _that_ PR runs `pnpm changeset publish`, which publishes every
   bumped package to the registry and tags the commit.

### 4.2 Version pinning the app depends on

`app/package.json` pins a real semver range once a package has a first
release (`"@kg-agent/harness-patterns": "^0.1.0"`), same as any third-party
dependency. Bumping it is an ordinary PR that changes one line and (per §3.2)
is exactly the point at which `pnpm-lock.yaml` gets a new registry
resolution. Until a package's ergonomics converge (the sibling lane's work),
staying on `0.x` and treating every release as potentially breaking is
appropriate — Changesets' "major" bump inside `0.x` is a convention question
for that lane, not this plan.

### 4.3 CI validation

Two additions to `.github/workflows/ci.yml`, both scoped by path so they don't
run on every app-only PR:

- A `packages` job (parallel to the existing `check` and `image` jobs, mirroring
  their independence-on-purpose pattern) that runs `pnpm -r --filter
'./packages/*' build && pnpm -r --filter './packages/*' test` — i.e. each
  library is typechecked and tested standing alone, not only as imported by
  `app/`. This is what catches the §1.4 coupling _before_ a publish attempt
  fails on it.
- A `changeset check` step (or the official `changesets/action` in `--dry-run`
  mode) on PRs that touch `packages/**`, failing the PR if a changeset is
  missing — the same "gate answers is this SHA sound" philosophy the
  `ci.yml` header already states for the existing jobs.
- For "does the published tarball actually work end-to-end before merging a
  version bump", a `pnpm pack` + install-from-tarball smoke step is cheaper
  and more honest than trying to fake a registry in CI, and covers the same
  risk (a package that works via `workspace:*` symlink but is missing a file
  in its `files`/`exports` allowlist once packed — a real and common failure
  mode for a first extraction).

### 4.4 Private vs. public, and registry choice

Open — see §7. Nothing in §2/§3 depends on the answer: `workspace:*` in dev
and `--frozen-lockfile` against _some_ registry in production work identically
whether that registry is the public npm registry, a GitHub Packages scoped
registry, or a private registry (Verdaccio, npm Enterprise). The only
production-image change if the registry is private is an `.npmrc` with an
auth token available at build time (a build secret, not baked into the image
layer) — worth flagging now because it changes the `deps` stage's `COPY` list
by one file, not because it changes anything else in this plan.

---

## 5. Migration steps, risk-ordered

Each step is independently shippable and leaves the app working end to end at
every commit — mirroring the shipping discipline in
`docs/plan/offline-agent-auth.md` §6.

**Step 0 — introduce the workspace with zero package moves** _(hours; no
behavior change)_ Add `pnpm-workspace.yaml` listing only `app` as a member (a
one-member workspace is valid pnpm), move `pnpm-lock.yaml` to the repo root,
update `ci.yml`'s `cache-dependency-path` and the Dockerfile's `COPY` paths
accordingly. This step exists purely to prove the CI/Docker plumbing survives
the root-lockfile move (§2.3's flagged consequence) before anything harder
rides on top of it.

**Step 1 — extract `harness-patterns` only, resolved via `workspace:*`**
_(the biggest single step; do the §1.4 dependency-injection surgery here,
once, rather than in every package)_ Move `app/src/lib/harness-patterns` to
`packages/harness-patterns`, fix the `baml_client`/`settings` imports per
§1.4, add its `package.json`. `app/` depends on it via `workspace:*`. No
publish yet — this step only has to prove the package _can_ stand alone
(the §4.3 CI job existing and passing is the exit criterion), not that
production loads it from a registry.

**Step 2 — first publish + docker-compose registry loading** _(§3, §4)_ Cut
`harness-patterns@0.1.0`, switch `app/package.json` to the pinned range on a
release branch, move the Docker build context to repo root with the
`.dockerignore` tightening. This is the step that actually exercises "dev vs.
production loading" end to end and is the natural point to `docker compose up
-d app` and confirm the image boots against the published package with the
workspace directory entirely absent from the build context (delete
`packages/` locally and rebuild, as a manual check, before trusting the
`.dockerignore` alone).

**Step 3 — extract `harness-client`** _(depends on Step 1 landing cleanly;
same shape, smaller surface)_

**Step 4 — extract `harness-sandbox`, `harness-stash`, `harness-retriever`**
_(can run in parallel with each other once Step 1 is done; ordered last
because §1.4 already shows `harness-sandbox` → `harness-stash` is a real
runtime dependency that must be declared correctly, which is easiest to get
right when both packages exist to depend on each other)_

**Step 5 — CI hardening + changelog cutover** Add the `packages` CI job and
`changeset check` gate (§4.3) once there's more than one package to validate
independently; backfill `CHANGELOG.md` for step 1–4's packages retroactively
if desired.

---

## 6. Interaction with `USE_MIXED_CHAINS` and other existing app-level toggles

Worth stating explicitly since `CLAUDE.md`'s build/commands section leads with
it: `USE_MIXED_CHAINS=1 pnpm dev:exposed` and the Anthropic-only default are
both **app-level** concerns (`clients.server.ts` lives in `app/`, not in
`harness-patterns`) and are unaffected by this migration in either dev or
production — they select which BAML client chain a pattern is bound to, which
is orthogonal to which package the pattern _code_ is loaded from.

---

## 7. Open questions for the user

Ordered by how much they change the plan.

1. **Scope: which packages actually get extracted, and in what order?** §5
   assumes all five from §1.1; the user may want to ship only
   `harness-patterns` (the one the README already calls out as
   validation-complete) and leave `harness-client`/sandbox/stash/retriever in
   `app/` indefinitely.
2. **Registry: public npm, GitHub Packages, or a private registry?** Drives
   §4.4's `.npmrc`/auth-token detail and whether the org is comfortable with
   `@kg-agent/harness-patterns` being publicly installable (it currently
   contains no secrets, but it does encode internal architecture choices).
3. **Package scope name** — `@kg-agent/*` is used as a placeholder throughout
   this doc; confirm the actual npm org/scope before Step 1's `package.json`
   is written.
4. **Monorepo (this plan's shape) vs. split repos per package?** A split-repo
   approach would still need the same dev-vs-production loading answer (Git
   submodules or a `link:` protocol standing in for `workspace:*` in dev) but
   changes §5's step ordering substantially and adds cross-repo PR
   coordination overhead. This plan defaults to monorepo because it is the
   lower-migration-cost option and because the sibling ergonomics lane is
   already operating inside this repo.
5. **How much of §1.4's dependency-injection surgery happens before vs. after
   Step 1 ships?** It could be done as prep work on `main` before any package
   move (lower risk per commit, but touches `harness-patterns/` twice), or
   folded into the Step 1 PR itself (one disruptive PR, but no intermediate
   state where the injected-dependency shape exists without the package split
   that motivated it).

---

## 8. Relationships

- `app/src/lib/harness-patterns/README.md` — states the extraction intent and
  the four boundary rules this plan's §1.2 dependency graph is built to
  preserve.
- `docs/plan/offline-agent-auth.md` — the format this doc follows
  (converged-plan style: numbered sections, a three-sentence answer up front,
  risk-ordered migration steps, an open-questions section ordered by
  plan-changing weight).
- `CLAUDE.md` — commands (`pnpm baml-generate`, `USE_MIXED_CHAINS`), the
  `.server.ts` boundary convention, and the code-minimalism ladder this plan's
  §3.4 rejection leans on ("no abstraction... nobody asked for").
- Sibling lane (unnamed at time of writing) — reviewing `harness-patterns`'
  own API ergonomics and exact package boundaries; this plan's §1.1 layout and
  §1.4 coupling list are inputs to that review, not conclusions that pre-empt
  it.
