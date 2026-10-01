# ADR-0007: Three environments on two VMs, with prod promoted by image digest

**Date**: 2026-10-01 — the last of the owner's decisions, taken 2026-09-28 to 2026-10-01
**Status**: accepted

Today the app has one deployment: a VM that builds its own image from a git
checkout (`docker-compose.yaml:164-176`) and rolls back by rebuilding an older
commit (`docs/PREVIEW.md` §10). The owner decided on three environments: dev, a
release candidate called **staging**, and prod. Dev and staging share one Azure
VM in the company's tenancy, as two compose projects behind one Caddy. Prod has
its own VM. Releases are trunk-based, and prod runs **the same image digest
staging ran**, never a rebuild, so the artifact that was approved is the
artifact that ships.

The full set of decisions:

- **Shared VM.** Dev and staging run on two hostnames. Each has its own
  databases, volumes and `DATA_ENCRYPTION_KEY`.
- **Data.** Dev and staging use the org graph the project has now, which is not
  exhaustive yet. Conversation databases are never shared between environments.
- **Inference.** All environments share the one Verda box, a single replica that
  scales to zero. The queueing that causes is accepted.
- **Access.** Each environment admits users through its own
  `VITE_ALLOWED_EMAILS` under Entra sign-in (#119). Staging lists a subset of
  users.
- **Release.** Every merge to `main` builds an image in CI and deploys it to dev.
  A protected tag such as `app-v0.2.0-rc.1` deploys to staging. Promotion to
  prod is gated by a GitHub Environment `prod`. Its only required reviewer is
  the owner, and prevent self-review is off because the owner both triggers and
  approves. The `app-v` prefix keeps app tags apart from the `v<version>` and
  `@hames-ai/<pkg>@<version>` tags that `.github/workflows/release.yml:15-20`
  pushes. A tag ruleset restricts who can create `app-v*` tags.
- **Registry.** Azure Container Registry in the company's tenancy. CI pushes
  through OIDC workload-identity federation, and the VMs pull with their
  managed identity, so no long-lived registry secret exists anywhere. Images
  are private because they can carry org data.
- **Hostnames.** `dev.` and `staging.` under a company subdomain that IT provides
  (placeholder `*.hames.contoso.com`). Until DNS exists, the stopgap is Azure's
  `<label>.<region>.cloudapp.azure.com` names. The label belongs to a public IP,
  so the shared VM needs two public IPs.
- **Testing.** The live layer (the burst and `pnpm eval:harness`) runs against
  the remote environments. The hermetic layers stay local and in CI
  (`docs/testing/pyramid.md`).

## Considered options

- **Three VMs.** The owner said this would also be acceptable. It removes every
  hazard of sharing one Docker daemon (see Consequences), and it lets dev be
  restarted, resized or broken without staging noticing. It costs a third box to
  pay for, patch, and wire into Entra and ACR, for two environments whose users
  are mostly the same few people. Two VMs is the cheaper start. The shared-VM
  prerequisites are the price of that choice, and they are the first thing to
  weigh if it is revisited.
- **Environment branches.** Rejected. Each branch would build its own image, so
  staging would test bytes that prod never runs, and every promotion would be a
  merge that could conflict or drift.
- **GHCR.** Rejected. The images would live outside the company's tenancy, and
  pulling a private image from a VM would need a token stored on that VM.
- **Rebuilding prod from the release tag.** Rejected for the same reason as
  environment branches: nobody would have tested the new artifact.

## Consequences

- **Testing moves to amd64.** The laptop runs colima on aarch64. CI
  (`.github/workflows/ci.yml:23`) and the VMs run linux/amd64. #412 is most
  likely this gap. The remote environments also cover the production bundle
  and the auth gate, which no hermetic layer covers
  (`docs/testing/pyramid.md` §"What none of this covers").
- **One digest serves every allow-list because the runtime value wins**
  (`app/src/lib/auth/allowList.ts:24-28`). The CI build must not set
  `VITE_ALLOWED_EMAILS`. If it did, that value would become the fallback
  allow-list in every environment, prod included.
- **Each environment's cold-start estimate can read low, and that is accepted.**
  The history and the wake dedupe are both process-local
  (`app/src/lib/inference/cold-start.server.ts:71-77`;
  `app/src/lib/inference/wake.server.ts:117,293-303`).
  - The plausibility floor (`cold-start.server.ts:168,222`) stops dev from
    recording a wake that staging has already finished.
  - The floor does **not** stop dev from recording the tail of a wake that
    staging is still paying for. Whether dev records a wait is decided by dev's
    own quiet period alone (`cold-start.server.ts:312,335`). The rule that only
    the turn that started a poll records (`wake.server.ts:353`) cannot work
    across two processes.
  - A dev turn that arrives 100s into staging's 360s cold start records about
    260s, which clears the floor and lowers dev's median.
  - Only the countdown is affected. Routing is not.
- **The shared VM needs changes to compose and code before a second project can
  run on it.** The five places where today's files assume one stack per Docker
  daemon are listed with file and line in `docs/PREVIEW.md` §12, and fixing
  them is follow-up work.
- **Each environment escrows its own three keys** (`docs/PREVIEW.md` §7). No key
  is reused across environments.

## Open

- **The staging name.** "staging" is a placeholder the owner may change in
  review.
- **The domain.** IT has to provide it. The prod hostname is also undecided.
- **The RC user subset.** Which users staging's allow-list names.
- **Left to the work that builds it:** how a workflow reaches a VM, which graph
  prod serves, and the Entra group or app-role check that will later replace
  per-environment email lists.

## Sources

The decisions were taken in conversation with the owner between 2026-09-28 and
2026-10-01. No issue records them. Claims about current behaviour cite files on
`main` at `3bdf787d`. The review that tightened this record is on PR #413.
