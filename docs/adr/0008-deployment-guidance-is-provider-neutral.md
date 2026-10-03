# ADR-0008: Deployment guidance is provider-neutral; a deployment's own decisions live with its operator

**Date**: 2026-10-03 — the owner's decision, relayed in the dispatch for the change that records it
**Status**: accepted

[ADR-0007](0007-three-environments-digest-promotion.md) recorded one
deployment's plan (its provider, hosts, registry and hostnames) as this
repository's decision, but this repository is public and is the code for
anybody's deployment, and a real host's network and hardening detail helps an
attacker more than any reader. So the deployment guidance here is
provider-neutral and keeps only what generalizes (`docs/PREVIEW.md` §§12–14),
while a deployment's own decisions, parameters and runbook live with its
operator, who runs `scripts/bootstrap-vps.sh` at a pinned full commit SHA of
this repository. This supersedes ADR-0007.

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

- ADR-0007's reasoning that is not about one deployment carries on as guidance
  in `docs/PREVIEW.md`: digest promotion and its rejected alternatives (§13),
  per-environment keys and allow-lists and the shared-host prerequisites (§12),
  and the single-box hardening and anti-lockout procedure (§14).
- A change here reaches a deployment only when its operator moves the pin, so
  a breaking change to the bootstrap's arguments is a change for every
  operator, and the script's header and `--help` are its contract.

## Sources

The owner's rule of 2026-10-03, as the dispatch for this change relayed it: the
repository's visitors should see what is relevant to them for deployment;
work for one deployment may be added for others to use, and where it is too
specific it is generalized or left out. No issue records it.
