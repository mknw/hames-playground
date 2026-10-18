# Container egress and cloud metadata: design and offline rules

**Status: design, with an opt-in rule installer; nothing deployed.** This is
[#432 G20 row 11](https://github.com/mknw/hames-playground/pull/432#issuecomment-6238143691),
build step 7. It builds on #639's Engine/daemon and smoke checks and #643's
two-clone shape. The coordinator scoped the executable artifact to metadata
denies; the broader host/LAN policy below remains design only. Required
coordinator-commissioned **Opus security review convergence** and operator packet/reboot
evidence remain outstanding. No host access, provider calls or private-tier
probes are part of this change. Deployment-specific values stay outside the
public repository ([ADR-0008](../adr/0008-deployment-guidance-is-provider-neutral.md)).

## Current behavior, verified in this checkout

| Observation                                                                                                                                                                                                                  | Source                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Neo4j joins only its isolated internal bridge; the relay joins that bridge and `app-network`, with fixed TCP destinations on 7474/7687 and IP forwarding disabled.                                                           | `docker-compose.yaml:35`, `:54`; `docker-compose.prod.yaml:53`, `:61`                          |
| The app has a host-gateway alias and a Docker socket; the gateway also mounts the socket. These are separate consumers.                                                                                                      | `docker-compose.yaml:132`, `:359`, `:366`                                                      |
| The dev clone removes inherited socket mounts by default; a separate explicit overlay restores its socket. That prior decision does not settle staging's decision.                                                           | `docker-compose.clones.yaml:13`, `:43`; `docker-compose.dev-sandbox.yaml:4`                    |
| Current sandboxes apply hardening and enforce offline/proxied profiles. Unknown profiles and unapproved `open` fail closed to no network. The older SD-19/SD-20 description is historical, not evidence of current behavior. | `packages/sandbox/docker-backend.server.ts:525`, `:540`; `packages/sandbox/egress-policy.ts:1` |
| The existing daemon guard rejects disabled firewalling, unsafe routing defaults and the native nftables backend; its network check requires IPv4-only Neo4j isolation.                                                       | `scripts/check-vps.py:50`, `:78`                                                               |
| The existing smoke pairs app reachability with Neo4j negatives, including host SSH, MCP/data peers and external DNS, and separately checks Bolt through the relay.                                                           | `scripts/check-vps.py:151`, `:173`, `:179`                                                     |

The metadata baseline adds a destination deny. It does not claim to contain a
process that controls Docker, protect sibling data on a shared network, or
implement a public-service allowlist. A Docker socket consumer can change host
rules, start a privileged/host-networked container, or read host files. Host
firewall rules are therefore defense in depth against ordinary tool requests,
not a security boundary against a compromised socket holder (SD-19/SD-20).

## Executable baseline

[`scripts/metadata-egress.py`](../../scripts/metadata-egress.py) has no instance
inputs. With no arguments it renders both families entirely offline, without
calling Docker, iptables, a resolver or any endpoint
(`scripts/metadata-egress.py:150`). Only explicit `--apply` enters Linux-root
firewall handling (`:127`); bootstrap and Compose never invoke it.

The host uses Docker's **iptables firewall backend**. The iptables-nft
compatibility frontend is distinct from Docker's native nftables backend;
using the latter is outside this design. Docker documents `DOCKER-USER` as the
forwarding policy point before its other chains, and notes that it sees
destinations after DNAT. These are the reasons to use that chain and match the
conntrack original destination as well as the current destination.
[Docker's packet-path documentation](https://docs.docker.com/engine/network/firewall-iptables/)
is the upstream contract; the installer checks the actual parent chain too.

For **each family**, the filter-table layout is:

```text
FORWARD first rule -> DOCKER-USER first rule -> VPS-METADATA
INPUT first rule ---------------------------> VPS-METADATA
OUTPUT first rule --------------------------> VPS-METADATA

VPS-METADATA:
  DROP each denied current destination (all protocols/ports/states)
  DROP each denied conntrack original destination, original direction
  RETURN to the caller's existing policy
```

`INPUT` covers a metadata destination DNATed to a host listener; `OUTPUT` covers
host processes and host-networked clients. The current-destination match also
covers a non-metadata address DNATed into metadata. This is a filter-table
design: earlier hooks, flow offload, NOTRACK combined with DNAT, encapsulation,
external proxies and network namespaces with a different routing path require
separate operator analysis. It does not inspect HTTP headers, paths or TLS.

The managed chain has no `ACCEPT`, established exception, interface assumption,
subnet allowlist or private-address blanket deny (`scripts/metadata-egress.py:67`).
The jump comes before **every** existing rule, including established accepts
and Docker's terminal return (`:105`). Thus established metadata flows are
blocked too, without flushing global conntrack or disrupting unrelated flows.
Other traffic returns to Docker/UFW; an existing deny remains a deny.

### Destination inventory and alternate forms

The single inventory drives both families (`scripts/metadata-egress.py:18`, `:30`):

| Deny                                                                                                | Reason and boundary                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `169.254.0.0/16`                                                                                    | Includes `169.254.169.254`, ECS-style `169.254.170.2` and other IPv4 link-local variants. This deliberately denies the entire IPv4 link-local range, including non-metadata uses.                                                                                                                                                                             |
| `100.100.100.200/32`                                                                                | Alternate metadata service documented by [Alibaba Cloud](https://www.alibabacloud.com/help/en/ecs/user-guide/view-instance-metadata). Other CGNAT addresses stay under existing policy.                                                                                                                                                                       |
| `fd00:ec2::254/128`, `fd20:ce::254/128`                                                             | IPv6 metadata addresses documented by [AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html) and [Google Cloud](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata). These references are examples, not deployment choices.                                                                 |
| `fe80::a9fe:a9fe/128`                                                                               | [OpenStack's documented IPv6 metadata address](https://docs.openstack.org/nova/latest/admin/metadata-service.html) (zone-scoped link-local). Other IPv6 link-local traffic, including neighbor discovery, stays under existing policy.                                                                                                                        |
| IPv4-mapped `::ffff:0:0/96` and deprecated compatible `::/96` representations of **each IPv4 deny** | Only the corresponding embedded ranges are denied, not these whole /96s. A normal mapped socket uses IPv4 filtering; on-wire representations also receive IPv6 rules.                                                                                                                                                                                         |
| The corresponding ranges under `64:ff9b::/96`; all of `64:ff9b:1::/48`                              | Defensive coverage of the [RFC 6052](https://www.rfc-editor.org/rfc/rfc6052.html) well-known translation form and the [RFC 8215](https://www.rfc-editor.org/rfc/rfc8215.html) local-use translation prefix. The latter intentionally denies all local-use translation, not only metadata; operators needing it must design a narrower policy before adoption. |

Expanded/compressed/case-varied IPv6, URL-encoded hosts and decimal/hex IPv4
spellings are not separate packet destinations. When a client accepts them and
resolves them to a denied binary address, the same rule applies. DNS aliases
and redirects ending at those addresses are covered by destination, without a
hostname list. This is not a URL-parser claim: different HTTP clients accept
different alternate spellings. Unknown provider addresses, custom DNS64
prefixes, proxies relaying metadata from allowed addresses and tunnels are
**not covered**. Inventory provider endpoints, resolvers and routes locally
before adoption; do not infer exhaustive provider coverage from this list.
Azure WireServer `168.63.129.16` is explicitly **not covered**: [Microsoft requires
in-VM outbound access](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16),
so it cannot join the shared deny inventory and could only receive a
`DOCKER-USER`-only deny.

### Apply, failure and idempotency contract

```sh
# Repository-only review and tests; safe without root or a daemon:
python3 scripts/metadata-egress.py
python3 scripts/metadata-egress.test.py
python3 scripts/metadata-egress.test.py --mutations
```

The preview consists of two labeled restore fragments and assumes no previous
managed hooks. **Do not pipe the combined preview into a restore command.**
Future operator invocation is `sudo python3 scripts/metadata-egress.py --apply`
from a reviewed, pinned checkout, only under the rollout conditions below.

The installer reads both filter tables, requires real `DOCKER-USER`, `INPUT`,
`OUTPUT` and `FORWARD` chains, and refuses a parent rule before the unconditional
`FORWARD -> DOCKER-USER` jump (`scripts/metadata-egress.py:89`). Missing IPv6
support is a refusal, never a silent IPv4-only success. It does **not** create
an uncalled `DOCKER-USER` chain. A default IPv4-only Docker installation may
therefore refuse: enabling and validating the IPv6 hook is operator work before
adoption; merely seeing IPv4-only Neo4j does not prove the whole host has no IPv6.

It syntax-tests **both** `*-restore --noflush` transactions before writing
either (`scripts/metadata-egress.py:127`). Each transaction replaces only
`VPS-METADATA`, removes all old managed jumps and inserts one at position 1.
Unrelated chains/rules remain intact; existing foreign references or unmarked
rules in the reserved chain refuse. Readback verifies both policy contents and
first/unique hooks, tolerating xtables' canonical IP and option ordering (`:51`,
`:137`). Repeat application produces the same policy, aside from counters.

Each family has its own transaction; there is **no cross-family atomicity**.
A failure after the IPv4 write can leave IPv6 unchanged. Errors return nonzero,
print fixed labels without command output, and never report success (`:163`).
This is fail-closed **admission to service**, not an automatic global network
shutdown: the installer cannot stop callers. Keep workloads stopped until both
families pass. Run only one installer at a time, with Docker/firewall lifecycle
changes quiesced. The xtables wait lock is per command, not a lock against
changes between snapshot, test, commit and readback. This is why a successful
offline test is not deployment evidence.

## Broader host/LAN policy: design only

This baseline intentionally leaves non-metadata host/LAN destinations to the
existing policy. A later policy needs a local topology inventory, not a public
list of instance addresses.
The destination inventory may need to split into a workload-only set
(`DOCKER-USER`) and a host set (`INPUT`/`OUTPUT`) to preserve host dependencies
such as Azure WireServer. Design its ordering as follows:

1. Keep metadata denies first in both families.
2. At host `INPUT`, match the exact workload bridge interfaces and allow only
   required host services by destination, protocol and port. Return unrelated
   host traffic, so SSH administration is not reclassified as workload traffic.
   Place any established return after metadata and scope it to approved flows;
   broad established returns preserve previously forbidden connections.
3. At `DOCKER-USER`, scope rules by workload ingress bridge and permit required
   same-stack service tuples before host/LAN denies. Preserve app/gateway to
   relay 7474/7687, relay to Neo4j 7474/7687, app to MCP 8811, embedder 8090,
   Postgres/Redis, required DNS and the per-boot proxy path. Identify actual
   bridge membership rather than assuming every `br-*` or RFC1918 destination
   is hostile. Do not add a permit that gives Neo4j a route out.
4. Deny other host destinations (including bridge gateway, primary host address,
   docker0, host-gateway aliases and IPv6 local addresses), then other LAN
   ranges for those workload sources. Mirror IPv6 decisions; handle ICMPv6 and
   configured DNS explicitly. Return remaining traffic to Docker, never grant a
   broad `ACCEPT`. A public-service allowlist needs an outbound proxy/destination
   inventory; rotating SaaS addresses are not a static IP list in this repo.

The G13 smoke's **app-to-host positive controls** would need redesign if that
future policy intentionally denies them. Keep live destinations and an approved
positive namespace for every negative; an unreachable destination is not proof
of a firewall. Today's executable baseline preserves those controls and the
relay/MCP paths. No broader host/LAN denies are installed or selected here.

### Open question: staging agents and sockets

**Does staging retain sandbox agents and the app's `docker.sock` mount after
general-next?** G20 explicitly leaves this open. This change does not decide it
or alter either clone's Compose files.

- **If retained:** apply the same metadata baseline to app, gateway and
  per-boot proxy traffic. Keep the enforced sandbox profiles and their network
  separation. Socket access remains root-equivalent; host rules cannot contain
  its holder. Any stronger boundary requires a separate Docker authority/host
  design and its own approval. Dev's existing socket opt-in remains separate.
- **If removed:** a later change removes the staging app mount and disables
  socket-dependent agents/UI paths with a clear unavailable result. The MCP
  gateway's own socket is a distinct requirement to inventory, not an implied
  removal. Keep the metadata baseline for remaining fetch/tool requests and
  host clients. Recheck the service inventory before selecting broader denies.

## Rollout, reboot persistence and rollback: described, not installed

An operator first validates this on an explicitly approved **throwaway Linux
daemon**, never the owner's default VM or a shared project. Follow the existing
[Engine-upgrade runbook](docker-engine-upgrade.md) and
[G13 test protocol](../testing/neo4j-egress.md) for the baseline prerequisites.
Reuse #639's daemon/network guards before admitting workloads. This installer
does not replace Engine >=28, isolated networking or those daemon guards.

For later adoption, stop service workloads and prevent restart-policy containers
from starting ahead of the firewall. Start the configured Docker daemon without
workload admission; verify both live hooks, run the explicit apply, then run
synthetic dual-stack packet controls and the existing paired G13/relay checks.
Do not call a real metadata endpoint: use synthetic listeners/routes in the
throwaway fixture, including established flows and local DNAT. Test real rule
counters, successful permitted destinations, and failed forbidden connections;
a bare timeout with no positive control is inconclusive.

Persistence should be an **operator-owned systemd prerequisite** at a pinned
path, ordered after Docker and UFW setup/reload and before the Compose workload
unit. Its oneshot runs the explicit installer; the workload unit requires its
success. Docker restarts, UFW reloads and network changes must revalidate/reapply
with `sudo python3 scripts/metadata-egress.py --apply` before workload admission;
this step is idempotent and reads back both families (`scripts/metadata-egress.py:127`,
`:137`). No read-only detector exists, so `smoke` does not prove the baseline is
installed; a read-only `--check` using the existing readback block with zero
restore calls, wired into `smoke`, is owed together with persistence adoption.
`RemainAfterExit` alone does not re-run on a firewall
reload. Prevent Docker's `restart: unless-stopped` containers from bypassing
that gate on reboot, and test restart, reboot and reload separately. A generic
`iptables-save` dump restored before Docker creates its chains is not the
persistence design. No systemd unit, persistent rules or restart policy is
changed by this PR.

Keep an independent console and a local pre-change snapshot for recovery.
On failure keep workloads stopped, inspect the labeled error locally, and
reapply the reviewed policy. An intentional rollback removes only tagged
jumps and the owned chain in both families after stopping workloads; never
flush Docker/UFW tables or blindly restore a stale whole-host snapshot over
running Docker. Removing the baseline reopens metadata access and is not a
successful deployment. Unknown provider/host dependencies that need metadata
must be resolved before adoption, including host agents using OpenStack's
`fe80::a9fe:a9fe` because the `OUTPUT` hook blocks it too
(`scripts/metadata-egress.py:16`, `:31`, `:70`); there is no hidden host-process
exemption.

## Claims and the mutations that break them

Layer 1 evidence is an independent small interpreter of the emitted rule syntax,
plus fake snapshot/test/commit/readback transactions. It validates every generated
managed rule against a complete allowlist of the modeled match forms and refuses
unsupported protocol/port/source/interface restrictions. It models destination,
conntrack original destination/direction, rule order, jumps and state. It does
not emulate kernel routing, netfilter, Docker or persistence. Every mutation
below edits production source in a temporary directory and re-runs the **same**
tests; a syntax/import error does not count as a kill.

| Claim                                                                                                 | Source                                   | Executed source mutation that turns its test red                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPv4 metadata and alternate service are denied.                                                       | `scripts/metadata-egress.py:18`, `:67`   | `metadata-v4`, `alternate-v4` remove a denied range.                                                                                                            |
| Denies have no protocol/port/source/interface restrictions the interpreter silently ignores.          | `scripts/metadata-egress.py:48`          | `tcp-only-denies` prepends `-p tcp` to every DROP rule; the shared interpreter grammar assertion fails.                                                         |
| Forwarded traffic reaches the metadata policy.                                                        | `scripts/metadata-egress.py:16`, `:89`   | `wrong-chain` removes the DOCKER-USER hook; `unreachable-parent` disables parent validation.                                                                    |
| Host output and local DNAT cannot bypass the same policy.                                             | `scripts/metadata-egress.py:16`, `:73`   | `host-output-gap`, `local-dnat-gap` remove their hooks; `post-dnat-gap` changes original-destination matching.                                                  |
| Established/related metadata packets are denied before any existing accept.                           | `scripts/metadata-egress.py:116`         | `established-bypass` appends the jump after existing accepts/returns.                                                                                           |
| Both address families and the declared alternate forms are covered.                                   | `scripts/metadata-egress.py:17`, `:30`   | `ipv6-gap`, `ipv6-service`, `ipv6-gcp`, `ipv6-linklocal`, `mapped-gap`, `compatible-gap`, `nat64-gap`, `local-nat64-gap` each remove a family/address/form.     |
| Required relay/MCP/private-service and public egress keep existing policy; Docker denies stay denied. | `scripts/metadata-egress.py:75`          | `relay-path-cut` adds an RFC1918 blanket deny; `mcp-egress-cut` replaces the final return with drop.                                                            |
| Default invocation performs no host commands; applying requires Linux root.                           | `scripts/metadata-egress.py:155`         | `dry-run-applies` makes apply unconditional; `root-gate` removes the platform/uid check.                                                                        |
| Both syntax preflights precede writes.                                                                | `scripts/metadata-egress.py:131`         | `no-syntax-preflight` removes restore's test flag. Missing IPv6 also causes zero writes.                                                                        |
| Repeated reconciliation leaves one first hook and preserves unrelated rules.                          | `scripts/metadata-egress.py:113`         | `duplicate-hooks` stops deleting old managed jumps; `table-flush` removes the no-flush option.                                                                  |
| Wrong readback cannot report success.                                                                 | `scripts/metadata-egress.py:141`         | `no-readback` accepts any managed policy; `save-canonicalization` stops normalizing option order.                                                               |
| Post-commit readback refuses displaced or duplicate hooks and an unreachable parent in either family. | `scripts/metadata-egress.py:140`, `:143` | `readback-hook-guard-off`, `readback-first-off`, `readback-unique-off`, `readback-hooks-off`, `readback-validate-off` remove each corresponding readback guard. |
| Reserved chains refuse foreign references and foreign comment markers.                                | `scripts/metadata-egress.py:97`, `:100`  | `foreign-ref-hook-any` permits a FORWARD reference; `no-marker-check` accepts a foreign marker.                                                                 |

Run the two Python commands above for the current counts. CI runs both tests
and mutations in the existing daemon-free infrastructure step. All service
addresses in fixtures are synthetic. **Verified by mutation** means the offline
claims above only; packet-path compatibility, actual restore syntax on a target
kernel, provider endpoint completeness, real Docker/UFW interaction, broader
host/LAN policy, reboot ordering and socket removal remain unverified or pending
decisions. DB/browser and live packet/persistence checks are unrun locally by
coordinator instruction; no daemon may be started for this lane. No live model
call or private-tier wake/probe is authorized.

The command seam also pins a bounded subprocess call and fixed command-failure
labels (`scripts/metadata-egress.py:120`): `command-timeout` removes its timeout
and `command-failure` ignores a failed command; both turn the tests red.
