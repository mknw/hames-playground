# Container egress and cloud metadata: design and offline rules

**Status: opt-in rule installers; broader egress policy remains design only.** This is
[#432 G20 row 11](https://github.com/mknw/hames-playground/pull/432#issuecomment-6238143691),
build step 7. It builds on #639's Engine/daemon and smoke checks and #643's
two-clone shape. The coordinator scoped the executable artifact to metadata
denies; the broader host/LAN policy below remains design only.
The #646 installer passed independent Codex and Opus delta reviews; #676 adds
the forwarded-only mode below, which needs its own commissioned reviews.
Operator packet/reboot evidence remains outstanding. No host access, provider calls or private-tier
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
(`scripts/metadata-egress.py:418`). Only explicit `--apply` enters Linux-root
firewall writes (`:156`, `:380`); bootstrap checks the forwarded-only mode but
never applies it. The original mode below includes host traffic; deployments
that must preserve host metadata use `--docker-user-only` instead.

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
subnet allowlist or private-address blanket deny (`scripts/metadata-egress.py:96`).
The jump comes before **every** existing rule, including established accepts
and Docker's terminal return (`:134`). Thus established metadata flows are
blocked too, without flushing global conntrack or disrupting unrelated flows.
Other traffic returns to Docker/UFW; an existing deny remains a deny.

### Destination inventory and alternate forms

The single inventory drives both families (`scripts/metadata-egress.py:24`, `:59`):

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
`FORWARD -> DOCKER-USER` jump (`scripts/metadata-egress.py:118`). Missing IPv6
support is a refusal, never a silent IPv4-only success. It does **not** create
an uncalled `DOCKER-USER` chain. A default IPv4-only Docker installation may
therefore refuse: enabling and validating the IPv6 hook is operator work before
adoption; merely seeing IPv4-only Neo4j does not prove the whole host has no IPv6.

It syntax-tests **both** `*-restore --noflush` transactions before writing
either (`scripts/metadata-egress.py:156`). Each transaction replaces only
`VPS-METADATA`, removes all old managed jumps and inserts one at position 1.
Unrelated chains/rules remain intact; existing foreign references or unmarked
rules in the reserved chain refuse. Readback verifies both policy contents and
first/unique hooks, tolerating xtables' canonical IP and option ordering (`:80`,
`:166`). Repeat application produces the same policy, aside from counters.

Each family has its own transaction; there is **no cross-family atomicity**.
A failure after the IPv4 write can leave IPv6 unchanged. Errors return nonzero,
print fixed labels without command output, and never report success (`:435`).
This is fail-closed **admission to service**, not an automatic global network
shutdown: the installer cannot stop callers. Keep workloads stopped until both
families pass. Run only one installer at a time, with Docker/firewall lifecycle
changes quiesced. The xtables wait lock is per command, not a lock against
changes between snapshot, test, commit and readback. This is why a successful
offline test is not deployment evidence.

## Forwarded-only deployment mode (#676)

`--docker-user-only` shares the complete destination inventory and original-
destination matches above, but installs direct tagged `DROP` rules only in
`DOCKER-USER` (`scripts/metadata-egress.py:179`, `:380`). It creates no chain,
changes no policy and never writes host `INPUT`/`OUTPUT`. Host agents retain
their existing metadata access. Forwarded non-metadata traffic falls through
to existing rules. A metadata request DNATed to a host-local listener follows
`INPUT` and is deliberately outside this mode; host networking, metadata
proxies, Docker authority and the other exclusions above also remain outside it.

```sh
# Entirely offline previews, including the proposed unit:
python3 scripts/metadata-egress.py --docker-user-only --persist
python3 scripts/metadata-egress.py --docker-user-only --remove
# Operator only, from a reviewed pinned artifact:
sudo python3 scripts/metadata-egress.py --docker-user-only --apply --persist
sudo python3 scripts/metadata-egress.py --docker-user-only --check
```

Apply validates both live `FORWARD -> DOCKER-USER` paths before firewall writes.
Missing IPv6 refuses; this tool does not manufacture an uncalled chain. Each
exact rule is checked with `-C` before insertion with `-I DOCKER-USER 1`, ahead
of established accepts and returns (`scripts/metadata-egress.py:192`, `:380`).
Repeated application inserts nothing. Dual-family readback requires every deny
exactly once in the first block of rules (`:210`). Existing displaced/duplicate
managed rules refuse admission rather than silently trusting `-C`. Operations
are incremental, not atomic across rules or families: keep workloads stopped
until readback succeeds. Failure is nonzero, with fixed labels and bounded
subprocesses; no global conntrack flush or full-ruleset restore is used (`:149`).

The private state directory `/var/lib/vps-metadata-egress` contains a locked,
fsynced write-ahead journal. Only newly inserted exact rules, newly created
persistence files and enablement performed by this installer are recorded
(`scripts/metadata-egress.py:271`, `:317`). `--docker-user-only --apply --remove`
reverses those entries, checks rule existence and deletes each by its complete
argv; it never deletes by line number or restores a historical table (`:359`).
Foreign/manual rules survive. An edited persistence file or an invalid journal
entry refuses undo. Do not delete the journal or change its mode/ownership;
another install/undo holding its lock causes immediate refusal. Serialize host
firewall changes too: the tool's lock cannot serialize unrelated operators.

### Persistence and its boot-window limit

There was no custom-rule persistence installer in this deployment: UFW persists
its own host policy, while the old design described a future systemd prerequisite.
`--persist --apply` now installs a root-owned copy of the reviewed script at
`/usr/local/lib/vps-metadata-egress.py` and enables
`/etc/systemd/system/vps-metadata-egress.service` (`scripts/metadata-egress.py:323`).
Files are published complete without overwriting raced-in files and their directory entries are synced. It refuses foreign/different existing files, so a later script upgrade requires
operator review and a stopped-workload remove/reinstall. It never executes a
mutable checkout on boot and adds no package dependency or saved-rules restore.

The oneshot has `After=docker.service ufw.service`, `Requires=docker.service`,
`PartOf=docker.service`, `Before=hames-app.service`, and
`WantedBy=docker.service` (`scripts/metadata-egress.py:31`). The enablement pulls
it into Docker starts; `PartOf` propagates Docker restarts. `RemainAfterExit`
alone would not provide that propagation. An operator's separate workload unit
must also **require** this unit's success; `Before` alone is only ordering.
[systemd's dependency semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)
define these relationships. The repo's Compose startup stays manual.

[Docker documents DOCKER-USER's forwarding and post-DNAT position](https://docs.docker.com/engine/network/firewall-iptables/).
Its [upstream implementation explicitly preserves existing rules across daemon
operations/restarts](https://github.com/moby/moby/blob/v28.5.2/libnetwork/firewall_linux.go#L45-L53).
The reapply unit nevertheless validates both parents and rules after Docker
starts. Reboot loses kernel rules and requires reapplication. UFW/other firewall
reloads and manual flushes are separate events: quiesce workloads, restart the
oneshot and recheck before admitting them; this unit does not watch every reload.

**Known residual:** Docker may start `restart: unless-stopped` containers before
an `After=docker.service` oneshot runs on boot. Exposure lasts from those starts
until successful dual-family readback; its duration is **unmeasured**, and a
failed unit can leave it open indefinitely. This is persistence, not a guaranteed
boot admission barrier. Changing the workload startup mechanism is deferred per
the #676 scope decision. Until that follow-up lands, stop workloads explicitly
before reboot or Docker maintenance, verify that restart policies will not
auto-admit them, then start Docker, start/check this unit and only then admit
workloads. Keep an independent console. Never claim an unattended reboot has
zero exposure based on this unit; record separate boot/restart/reload evidence
on an approved throwaway host before relying on it.

### Smoke and evidence boundary

`bootstrap-vps.sh --only smoke` invokes `--docker-user-only --smoke`
(`scripts/bootstrap-vps.sh:1796`). This first runs the read-only rule check,
verifies the pinned persistence files and enabled unit, checks app liveness,
then runs a throwaway container on the default bridge using the already-local
app image ID, `--pull never`, `--cap-drop ALL`, no new privileges and no mounts
(`scripts/metadata-egress.py:234`). Node attempts TCP to **169.254.169.254:80**
with a three-second timeout. No HTTP metadata body, DNS, configurable endpoint
or provider/model request is sent. TCP success fails smoke; a start/runtime
error or unexpected output is inconclusive and also fails. App liveness must
still pass after refusal. The existing relay, isolation and embedder checks
remain independent.

The probe is safe without internet or a live metadata service: known network
refusal/timeout is expected, but is **not by itself evidence the firewall bites**.
Readback supplies installation evidence; synthetic live listeners, counters,
dual-stack packet controls and restart/reboot trials remain operator evidence.
The smoke probes the default bridge's IPv4 path; IPv6 and alternate forms are
verified by readback/offline policy tests, not by this one network probe.

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

## Operator adoption and temporary-rule replacement

No live host access is part of this PR. First validate packet paths on an
approved throwaway Linux daemon using synthetic listeners/routes, including
established flows and forwarded DNAT. Follow the existing
[Engine-upgrade runbook](docker-engine-upgrade.md) and
[G13 test protocol](../testing/neo4j-egress.md); do not start the owner's default
VM or a shared project. Run the daemon/network guards before admitting workloads.

For the live replacement, keep an independent console, quiesce workloads/builds,
and keep the existing temporary rules through the new rule checks. Take local
`iptables-save`/`ip6tables-save` snapshots for **diff/forensics only**, never for a
full-table rollback over running Docker. Keep these host-specific artifacts off
GitHub. In a pinned reviewed checkout:

```sh
# Root-owned artifact also gives the dead-man timer a stable undo executable.
sudo install -o root -g root -m 0644 scripts/metadata-egress.py /root/metadata-egress-reviewed.py
sudo systemd-run --unit=vps-metadata-undo --on-active=5m \
  /usr/bin/python3 /root/metadata-egress-reviewed.py --docker-user-only --apply --remove
sudo python3 /root/metadata-egress-reviewed.py --docker-user-only --apply --persist
sudo systemctl start vps-metadata-egress.service
sudo python3 /root/metadata-egress-reviewed.py --docker-user-only --check
```

Now verify that the **new tagged** rules bite: use a capped throwaway probe and
local before/after counters, with an independent known-live synthetic endpoint
for packet proof. The offline-safe metadata smoke is a required check but a
negative endpoint result alone cannot prove which rule denied it. Confirm app,
relay and permitted traffic still work. Only after this evidence remove the
old manual rules. If the local snapshots show exactly these untagged rules,
the exact replacements are:

```sh
sudo iptables -w 5 -C DOCKER-USER -d 169.254.0.0/16 -j DROP
sudo iptables -w 5 -D DOCKER-USER -d 169.254.0.0/16 -j DROP
sudo ip6tables -w 5 -C DOCKER-USER -d fe80::a9fe:a9fe/128 -j DROP
sudo ip6tables -w 5 -D DOCKER-USER -d fe80::a9fe:a9fe/128 -j DROP
```

If those exact checks fail, stop and use the **actual complete argv** from the
local snapshots, retaining any interface/comment/match options; do not guess,
flush, delete by line number, or delete the new tagged rules. Re-save/re-diff
both tables: only the new tagged `DOCKER-USER` denies and the intended old-rule
removals may differ, apart from counters. Host `INPUT`/`OUTPUT`, unrelated rules
and policies must remain unchanged. Re-run the read-only check and complete
`bootstrap-vps.sh --only smoke` (with the deployment's normal required flags).
Then cancel the dead-man timer:

```sh
sudo systemctl stop vps-metadata-undo.timer
```

Undo while that timer is armed removes only journaled changes and leaves the
old manual rules if they are still present. Once the old rules are deleted,
undo reopens container metadata access: keep workloads stopped and reinstate
the exact old rules if rolling back. Never call that a successful deployment.
The full-host legacy `--apply` mode remains separate and unpersisted; it blocks
host metadata too and requires its original host-agent inventory and rollout
review. This forwarded-only mode does not migrate or remove any pre-existing
legacy host hooks.

## Claims and the mutations that break them

Layer 1 evidence is an independent small interpreter of the emitted rule syntax,
plus fake snapshot/test/commit/readback transactions. The forwarded-only mode
also has a fake direct-rule/systemctl table, private filesystem fixtures and an
executed Node probe program with synthetic sockets. It validates every generated
managed rule against a complete allowlist of the modeled match forms and refuses
unsupported protocol/port/source/interface restrictions. It models destination,
conntrack original destination/direction, rule order, jumps and state. It does
not emulate kernel routing, netfilter, Docker or persistence. Every mutation
below edits production source in a temporary directory and re-runs the **same**
tests; a syntax/import error does not count as a kill.

The forwarded-only pins add these production-source mutations (all run by the
same committed runner). Bootstrap's two integration mutations run through
`python3 scripts/check-vps.test.py --mutations`:

| Forwarded-only claim                                                                                                   | Source                                           | Mutation                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both families deny forwarded metadata while host chains stay intact                                                    | `scripts/metadata-egress.py:179`, `:380`         | `forward-v6-missing`, `forward-host-touched`; the shared address/form mutations below also run                                                                         |
| Every insert is first and preceded by an exact existence check; repeat apply writes no rule                            | `scripts/metadata-egress.py:192`, `:380`         | `forward-appended`, `forward-not-idempotent`                                                                                                                           |
| Parent, first block, complete/unique policy and lookup errors fail closed                                              | `scripts/metadata-egress.py:186`, `:196`, `:210` | `forward-parent-off`, `forward-readback-off`, `forward-first-off`, `forward-unique-off`, `forward-lookup-error-is-absence`                                             |
| Dry-run does no work; writes require Linux root                                                                        | `scripts/metadata-egress.py:259`, `:380`         | `forward-dry-run-applies`, `forward-root-off`                                                                                                                          |
| Journaled undo deletes exact owned rules and refuses foreign state                                                     | `scripts/metadata-egress.py:271`, `:317`, `:359` | `forward-removal-not-exact`, `forward-journal-write-off`, `forward-journal-rule-validation-off`, `forward-journal-file-validation-off`, `forward-state-ownership-off`  |
| Persistence is installed, enabled, ordered after Docker/before the app and participates in restarts                    | `scripts/metadata-egress.py:31`, `:323`          | `persistence-missing`, `persistence-order-wrong`, `persistence-before-missing`, `persistence-restart-off`, `persistence-disabled`                                      |
| Persistence installation/undo refuses foreign or edited files                                                          | `scripts/metadata-egress.py:323`, `:359`         | `persistence-file-clobber`, `persistence-undo-clobber`, `persistence-partial-write`                                                                                    |
| Smoke detects policy/unit absence, requires app health, uses no pulls/all caps dropped and rejects inconclusive output | `scripts/metadata-egress.py:234`                 | `smoke-rules-unchecked`, `smoke-unit-unchecked`, `smoke-enabled-unchecked`, `smoke-caps-kept`, `smoke-image-pull`, `smoke-refusal-unchecked`, `smoke-health-unchecked` |
| The actual TCP program refuses success and enforces a short deadline                                                   | `scripts/metadata-egress.py:220`                 | `smoke-probe-false-success`, `smoke-probe-unbounded`                                                                                                                   |
| Bootstrap invokes this smoke and propagates failure                                                                    | `scripts/bootstrap-vps.sh:1796`                  | `metadata-smoke-wiring`, `metadata-smoke-failure-ignored`                                                                                                              |

The original full-host mode retains these pins:

| Claim                                                                                                 | Source                                   | Executed source mutation that turns its test red                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPv4 metadata and alternate service are denied.                                                       | `scripts/metadata-egress.py:24`, `:96`   | `metadata-v4`, `alternate-v4` remove a denied range.                                                                                                            |
| Denies have no protocol/port/source/interface restrictions the interpreter silently ignores.          | `scripts/metadata-egress.py:77`          | `tcp-only-denies` prepends `-p tcp` to every DROP rule; the shared interpreter grammar assertion fails.                                                         |
| Forwarded traffic reaches the metadata policy.                                                        | `scripts/metadata-egress.py:22`, `:118`  | `wrong-chain` removes the DOCKER-USER hook; `unreachable-parent` disables parent validation.                                                                    |
| Host output and local DNAT cannot bypass the same policy.                                             | `scripts/metadata-egress.py:22`, `:102`  | `host-output-gap`, `local-dnat-gap` remove their hooks; `post-dnat-gap` changes original-destination matching.                                                  |
| Established/related metadata packets are denied before any existing accept.                           | `scripts/metadata-egress.py:145`         | `established-bypass` appends the jump after existing accepts/returns.                                                                                           |
| Both address families and the declared alternate forms are covered.                                   | `scripts/metadata-egress.py:23`, `:59`   | `ipv6-gap`, `ipv6-service`, `ipv6-gcp`, `ipv6-linklocal`, `mapped-gap`, `compatible-gap`, `nat64-gap`, `local-nat64-gap` each remove a family/address/form.     |
| Required relay/MCP/private-service and public egress keep existing policy; Docker denies stay denied. | `scripts/metadata-egress.py:104`         | `relay-path-cut` adds an RFC1918 blanket deny; `mcp-egress-cut` replaces the final return with drop.                                                            |
| Default invocation performs no host commands; applying requires Linux root.                           | `scripts/metadata-egress.py:437`         | `dry-run-applies` makes apply unconditional; `root-gate` removes the platform/uid check.                                                                        |
| Both syntax preflights precede writes.                                                                | `scripts/metadata-egress.py:160`         | `no-syntax-preflight` removes restore's test flag. Missing IPv6 also causes zero writes.                                                                        |
| Repeated reconciliation leaves one first hook and preserves unrelated rules.                          | `scripts/metadata-egress.py:142`         | `duplicate-hooks` stops deleting old managed jumps; `table-flush` removes the no-flush option.                                                                  |
| Wrong readback cannot report success.                                                                 | `scripts/metadata-egress.py:170`         | `no-readback` accepts any managed policy; `save-canonicalization` stops normalizing option order.                                                               |
| Post-commit readback refuses displaced or duplicate hooks and an unreachable parent in either family. | `scripts/metadata-egress.py:169`, `:172` | `readback-hook-guard-off`, `readback-first-off`, `readback-unique-off`, `readback-hooks-off`, `readback-validate-off` remove each corresponding readback guard. |
| Reserved chains refuse foreign references and foreign comment markers.                                | `scripts/metadata-egress.py:126`, `:129` | `foreign-ref-hook-any` permits a FORWARD reference; `no-marker-check` accepts a foreign marker.                                                                 |

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
labels (`scripts/metadata-egress.py:149`): `command-timeout` removes its timeout
and `command-failure` ignores a failed command; both turn the tests red.
