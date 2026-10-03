# ADR-0008: One OVHcloud VPS runs staging; dev and prod are deferred

**Date**: 2026-10-03 — the owner's decision, relayed in the dispatch for the change that records it
**Status**: accepted

[ADR-0007](0007-three-environments-digest-promotion.md) planned three
environments on two Azure VMs, with images built once in CI, pushed to Azure
Container Registry and pulled by each VM's managed identity. The owner narrowed
that to one deployment: "we will actually use this mainly for staging, and
focus on one deployment for now." Staging therefore runs alone on one OVHcloud
VPS (8 vCPU, 24 GB RAM, x86_64, Ubuntu), set up by
`scripts/bootstrap-staging.sh`, and it builds its own images on the box. Dev,
prod, the registry and the CI deploy are deferred. This supersedes ADR-0007.

What replaces ADR-0007's Azure-specific parts:

- **No registry and no managed identity, for now.** The box builds its images
  from a pinned git commit (`docs/PREVIEW.md` §14). The follow-up is a CI build
  that pushes to a private registry. ADR-0007's reason for keeping images
  private still holds, because an image can carry org data.
- **No network security group.** Two layers replace it. `ufw` on the box
  denies incoming traffic except on the SSH port, 80 and 443. The provider's
  edge Network Firewall, an owner action in the Control Panel, mirrors those
  rules for IPv4. Docker-published ports bypass `ufw`, so the production
  overlay's loopback binds are the only control on the data tier. The script
  checks them before boot and checks again with `ss` afterwards.
- **The host is ours to secure.** The provider says so, and the script applies
  its hardening guide: key-only SSH, no root login, the guide's `fail2ban`
  jail, and unattended security upgrades. Moving the SSH port is opt-in, and
  the login account keeps passwordless sudo. `docs/PREVIEW.md` §14 gives the
  reasons for both.
- **The hostname is a parameter, never a committed value.** A company subdomain
  is preferred over the provider's `vps-*.vps.ovh.net` name. `vps.ovh.net` is
  not on the Public Suffix List, so every customer using that name shares one
  Let's Encrypt rate-limit bucket.

What is deferred, and the shape each deferral keeps:

- **Dev.** The intended future shape is the owner's idea of dev as a clone of
  staging over shared data.
- **Prod.** ADR-0007's release rules describe how prod would be fed: a
  protected `app-v*` tag, the same image digest staging ran, and the `prod`
  GitHub Environment gate. Those rules need the registry, so they wait for it.

## Considered options

- **ADR-0007 as written.** Two Azure VMs, ACR, OIDC and managed identities.
  Superseded by the owner's choice to focus on one deployment. A single
  environment also needs none of the shared-VM changes in `docs/PREVIEW.md` §12.
- **A single VM of about €50, with dev and staging as clones over shared
  data.** Superseded for now. Its clone shape is kept as dev's future.
- **CI building and pushing to a registry from the first deploy.** Deferred.
  Without a managed identity, a box that pulls a private image needs a registry
  credential stored on it, which is the secret ADR-0007 designed away. Building
  on the box needs no credential. The cost is that staging runs a local build,
  not a CI digest, so no later promotion can ship "the bytes staging ran" until
  the registry exists.

## Consequences

- **The hosting provider changes.** Staging's graph and conversation store now
  live with OVHcloud rather than in the company's Azure tenancy. Both can hold
  personal data (`docs/data-privacy/plan.md` §"Where the data is"), so the move
  is a hosting-processor decision as well as an infrastructure one.
- **Nothing replaces the disk encryption of `docs/PREVIEW.md` §1.** That layer
  covered the Neo4j store, the Data Stash, `backups/` and `.env`. This change
  sets up no substitute, and the app's own key covers Postgres columns only.
- **The gateway image is digest-pinned, and the deploy depends on the pin.**
  The latest upstream release breaks the stack (#417). #421 pinned the
  `mcp-gateway` image by digest, and the script refuses to pull or boot an
  unpinned one. That digest is one that no upstream tag names any more, so the
  deploy depends on Docker Hub continuing to serve it. The follow-up is to
  mirror the image into the deployment's own registry once CI-built images
  exist.
- **The keys are escrowed before boot** (`docs/PREVIEW.md` §7). The script
  generates the three keys on the box and does not boot until the owner attests
  the escrow.
- **Backups are an owner action.** The provider's `Snapshot` and
  `Automated Backup` options live in the Control Panel. The recommended
  minimum for staging is the escrow plus a manual snapshot after the first
  good boot (`docs/PREVIEW.md` §14). A whole-disk snapshot holds `.env`, and
  with it the keys, beside the data they encrypt.

## Open

- What dev's "shared data" covers: the graph only, or also the conversation
  store that ADR-0007 kept separate per environment.
- Which private registry CI pushes to, and how the box pulls from it without a
  long-lived credential. The same registry is where the pinned gateway image
  gets mirrored.
- The company subdomain for staging, which IT provides.
- Prod's host and hostname.

## Sources

The owner's decisions as the dispatch for this change relayed them on
2026-10-03; no issue records them. The provider's statement and the hardening
steps come from
<https://docs.ovhcloud.com/en/guides/bare-metal-cloud/virtual-private-servers/secure-your-vps>
(updated 2026-01-21). The Public Suffix List (version 2026-10-01) and Let's
Encrypt's rate limits (<https://letsencrypt.org/docs/rate-limits/>) were read on
2026-10-03.
