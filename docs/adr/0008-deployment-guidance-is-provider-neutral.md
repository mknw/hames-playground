# ADR-0008: Deployment guidance is provider-neutral; a deployment's own decisions live with its operator

**Date**: 2026-10-03 — the owner's decision, relayed in the dispatch for the change that records it
**Status**: accepted

[ADR-0007](0007-three-environments-digest-promotion.md) recorded one
deployment's plan as this repository's decision: three environments on two VMs
in one company's cloud tenancy, with that tenancy's registry and hostnames.
This repository is public, and it is the code for anybody's deployment. A
decision about one real deployment (its provider, its hosts, its network and
its hardening choices) is irrelevant to every other reader, and the network and
hardening detail of a real host helps an attacker more than a reader. So this
repository keeps what generalizes, and a deployment's own decisions, parameters
and runbook live with its operator, outside it. The seam is a pinned commit: a
deployment runs `scripts/bootstrap-vps.sh` at a full SHA of this repository,
with its own parameters. This supersedes ADR-0007.

What carries over from ADR-0007 and the bootstrap's review, as guidance rather
than as anyone's plan:

- **Promote by image digest.** An environment that pulls runs the digest the
  environment before it ran, never a rebuild, so the artifact that was approved
  is the artifact that ships (`docs/PREVIEW.md` §13). ADR-0007's rejected
  options still stand: environment branches and rebuilding prod from a tag
  both ship bytes nobody tested.
- **A single host may start by building its own image from a pinned full
  commit SHA**, which needs no registry credential on the box. The cost is that
  nothing can promote "the bytes staging ran" until CI builds the images.
- **One image serves every allow-list because the runtime value wins**, so a
  CI build must not set `VITE_ALLOWED_EMAILS` (`docs/PREVIEW.md` §12).
- **Each environment has its own databases, volumes and three keys**, escrowed
  separately before the first boot (`docs/PREVIEW.md` §7, §12).
- **Two environments on one Docker daemon need the compose and code changes
  `docs/PREVIEW.md` §12 lists first.**
- **Host hardening and the anti-lockout procedure are scripted and
  parameterized** (`docs/PREVIEW.md` §14). The hostname, the ACME mailbox and
  the operator's addresses are arguments, never committed values.

## Considered options

- **Keep recording one deployment's decisions here** (ADR-0007 as written, and
  a provider-specific successor to it). Rejected: it publishes the network and
  hardening detail of a real host, and it reads as this repository's plan to
  everyone who is not that deployment.
- **Delete ADR-0007.** Rejected: [`README.md`](README.md) supersedes rather
  than deletes, and the record that the question was settled is worth keeping.
- **Keep nothing about deployment public.** Rejected: the runbook and the
  bootstrap are useful to anyone deploying this stack, and they are where the
  security-relevant defaults (loopback binds, the gateway pin, key escrow,
  key-only SSH) are pinned by tests.

## Consequences

- ADR-0007 stays readable as history and is no longer the plan of record for
  any deployment of this repository.
- `docs/PREVIEW.md` §§12–13 describe more than one environment generically, and
  §14 the single-VPS bootstrap. Provider names appear only as examples.
- A change here that a deployment depends on reaches it only when that
  deployment moves its pin, so a breaking change to the bootstrap's arguments
  is a change for every operator, and the script's header and `--help` are its
  contract.

## Sources

The owner's rule of 2026-10-03, as the dispatch for this change relayed it: the
repository's visitors should see what is relevant to them for deployment;
work for one deployment may be added for others to use, and where it is too
specific it is generalized or left out. No issue records it. The carried-over
points come from ADR-0007 and from the review of the bootstrap script before it
was made provider-neutral.
