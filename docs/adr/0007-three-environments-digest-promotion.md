# ADR-0007: Three environments on two VMs, with prod promoted by image digest

**Date**: 2026-10-01 — the last of the owner's decisions, taken 2026-09-28 to 2026-10-01
**Status**: accepted

Today there is one deployment shape: a single VM that builds its own image from
a git checkout (`docker-compose.yaml:164-176` builds `kg-agent-app:local`) and
rolls back by checking out an older commit and rebuilding
(`docs/PREVIEW.md` §10). The only workflows are CI and the Changesets release
job, which tags npm package versions and deploys nothing
(`.github/workflows/release.yml:3-20`). The owner decided on three environments
— **dev**, a release candidate called **staging**, and **prod** — on two Azure
VMs in DTSC's tenancy, released trunk-based. Prod runs **the same image digest
staging ran**, never a rebuild, because that is the only way the thing being
approved is the thing being shipped.

## Decision

- **Environments and VMs.** Dev and staging share one VM, as two compose
  projects behind one Caddy on two hostnames, each with its own databases,
  volumes and `DATA_ENCRYPTION_KEY`. Prod has its own VM.
- **Data.** Dev and staging both use the org graph the project has now, which
  is not exhaustive yet. Conversation databases are never shared between
  environments.
- **Inference.** All three share the one Verda GPU box for now: one replica that
  scales to zero, so the environments queue behind each other, and that
  queueing is accepted.
- **Access.** Entra sign-in (#119) gates every environment, and each admits
  users through its own `VITE_ALLOWED_EMAILS`. Staging lists only a subset of
  users.
- **Branching and release.** Trunk-based, with no environment branches. Every
  merge to `main` builds an image in CI and deploys it to dev. A protected tag
  such as `app-v0.2.0-rc.1` deploys to staging. Prod is promoted from the
  digest staging ran. A GitHub Environment `prod` gates the promotion, with the
  owner as its only required reviewer and **prevent self-review off**, because
  the owner both triggers and approves. App tags carry the `app-v` prefix so
  they cannot collide with the repo-level `v<version>` tag and the per-package
  `@hames-ai/<pkg>@<version>` tags that `release.yml` pushes
  (`release.yml:15-20`, `:92-115`). A tag ruleset restricts who can create
  `app-v*` tags.
- **Registry.** Azure Container Registry in DTSC's tenancy. GitHub Actions
  pushes through OIDC workload-identity federation, and the VMs pull with their
  managed identity, so no registry secret is stored anywhere. Images are
  private because they can carry org data.
- **Hostnames.** The placeholders are `dev.` and `staging.` under a DTSC
  subdomain that IT provides (for example `*.hames.dtsc.be`). Until DNS exists,
  the stopgap is Azure's `<label>.<region>.cloudapp.azure.com` names. That
  label belongs to a public IP, so the shared VM needs **two public IPs** to
  get two names.
- **Testing.** The remote environments become the place for the live layer: the
  coordinated burst and `pnpm eval:harness`. The hermetic layers stay where
  they are, locally and in CI (`docs/testing/pyramid.md`).

## Consequences

- **What is hermetic stays hermetic, and what the laptop cannot see moves to
  amd64.** The laptop runs colima on aarch64, while CI runners
  (`.github/workflows/ci.yml:23`, `ubuntu-latest`) and every target VM run
  linux/amd64. #412 was this gap: an amd64-only MCP image added 0 tools on the
  laptop, and the gateway swallowed the failure. That class of difference only
  shows up on the target architecture. The remote environments also cover two
  gaps `docs/testing/pyramid.md` §"What none of this covers" lists against
  every hermetic layer: the production bundle and the auth gate.
- **One digest serves several allow-lists only because the runtime value wins.**
  `getAllowedEmails` reads `process.env` before the build-time inlined value
  (`app/src/lib/auth/allowList.ts:24-28`). The CI build must therefore **not**
  set `VITE_ALLOWED_EMAILS`. If it did, that list would be the fallback in every
  environment the digest reaches, prod included.
- **Each environment keeps its own cold-start estimate and its own wake.** The
  cold-start history is process-local (`app/src/lib/inference/cold-start.server.ts:71-77`,
  `:191-193`), and so is the in-flight wake dedupe
  (`app/src/lib/inference/wake.server.ts:117`, `:293-303`). Dev's poll and
  staging's poll do not merge, even though both wait on one replica, and a box
  that staging just warmed still reads as cold to dev. The plausibility floor
  (`cold-start.server.ts:168`) is what stops dev from recording that short wait
  as a cold start.
- **Sharing one Docker daemon breaks five assumptions in today's files, and the
  compose and code changes that fix them are follow-up work, not this record.**
  As committed:
  1. Every service pins a `container_name` (`docker-compose.yaml:23,97,125,151,177`;
     `docker-compose.prod.yaml:150`). Those names are global to the daemon, so
     a second project cannot create its containers. The top-level
     `name: kg-agent` (`docker-compose.yaml:4`) also has to differ per project.
  2. Each project publishes the same loopback ports (`docker-compose.yaml:26-180`),
     and the prod overlay gives Caddy `80`/`443` per project
     (`docker-compose.prod.yaml:155-158`). Only one process can bind each port,
     so the shared Caddy has to live outside both projects. It needs two site
     blocks, because the Caddyfile has one (`configs/Caddyfile:18`).
  3. The sandbox reaper force-removes **every** `kg-sandbox=1` container on the
     host when a process starts (`packages/sandbox/docker-backend.server.ts:394-408`,
     called from `packages/sandbox/with-sandbox.server.ts:160`). A staging
     restart would kill dev's in-flight sandboxes, and the reverse. The caveat
     is already recorded there (#97).
  4. The gateway starts the `memory` server with a named volume,
     `claude-memory` (`configs/custom-catalog.yaml:103-104`). The gateway runs
     that container itself rather than through compose, so the name is not
     scoped to a project, and as configured both environments would share one
     memory graph. That contradicts "own volumes". The sandbox cache volume
     has the same shape (`docker-backend.server.ts:142`), but it can be
     overridden per environment through `SANDBOX_CACHE_VOLUME`.
  5. `docs/PREVIEW.md` §1 sizes one stack at 16 GiB and calls that "not
     generous". Two stacks on one VM have not been measured.
- **Three sets of keys to escrow.** Each environment's `AUTH_SESSION_SECRET`,
  `TOKEN_ENCRYPTION_KEY` and `DATA_ENCRYPTION_KEY` go into escrow separately
  (`docs/PREVIEW.md` §7), and none may be reused across environments.
- **The VM gains a dependency.** Pulling with the managed identity means the VM
  logs in to ACR as itself, which `docs/PREVIEW.md` deliberately avoided ("No
  Azure CLI"). The runbook records that change.

## Considered options

- **Three VMs, one per environment.** The owner said this would also be
  acceptable. It removes every shared-daemon hazard listed above, needs one
  public IP per box for a stopgap name, and lets dev be restarted, resized or
  broken without staging noticing. Against it: a third box to pay for, patch
  and wire into Entra and ACR, for an environment pair whose users are mostly
  the same few people. Two VMs was chosen as the cheaper start. The shared-VM
  prerequisites above are the cost of that choice, and they are the first thing
  to weigh if it is revisited.
- **Environment branches (`dev` / `staging` / `prod`).** Rejected. Each branch
  builds its own image, so staging would test bytes that prod never runs, and
  promotion becomes a merge that can conflict or drift. Trunk plus tags plus
  digest promotion makes the prod artifact byte-identical to the one approved
  on staging.
- **GitHub Container Registry.** Rejected. Images that can carry org data would
  live outside DTSC's tenancy, and pulling a private GHCR image from a VM needs
  a token stored on that VM. ACR with OIDC push and a managed-identity pull
  needs no stored registry secret at all.
- **Rebuilding for prod from the release tag.** Rejected for the same reason as
  environment branches: the rebuild is a new artifact that nobody tested.

## Open

- **The staging name.** "staging" is a placeholder the owner may change in
  review.
- **The domain.** IT has to provide the DTSC subdomain. The prod hostname is
  also to be decided.
- **The RC user subset.** Which users staging's `VITE_ALLOWED_EMAILS` lists.
- **Not decided here, and left to the work that builds it:** how a workflow
  reaches a VM to deploy; which graph prod serves; and the Entra group or
  app-role check that will later replace per-environment email lists as the
  access control.

## Sources

Recorded from the owner's decisions of 2026-09-28 to 2026-10-01, which were
relayed in the dispatch for this record. Every claim about current behaviour
above cites the file it was read from on `main` at `3bdf787d`.
