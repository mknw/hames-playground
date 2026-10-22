# Environment VM network rules (plan)

> **Status: plan only.** Nothing here has run on a host, and this change touches none. It
> answers owner question 9 of [#731](https://github.com/mknw/hames-playground/pull/731): the
> app-to-VM route on the Docker port and the refusals around it are operator-owned, and the
> spike's rules were removed by its own cleanup. The rules are generic; a deployment's own
> addresses and commands stay with its operator
> ([ADR-0008](../adr/0008-deployment-guidance-is-provider-neutral.md)). The live window needs the
> owner's explicit GO and the implementation listed in [§11](#11-what-has-to-land-before-the-window).
> SD-19, SD-20.
>
> **No SSH, `sshd`, `authorized_keys` or public inbound-firewall change is part of this plan.** The
> rules match only environment-VM bridges and the dev app's link bridge: never the host's public
> interface, UFW's rules or port 22. If a step turns out to need such a change, that is an
> escalation to the owner **before** the change, never a report after it.

## The plan in one screen

- **One allowed flow.** The dev app container opens TCP to **its own** environment VM's Docker
  port, 2376, where the daemon accepts only mutual TLS
  (`packages/sandbox/incus-environment.server.ts:495-497`). The app is identified by a dedicated
  link bridge **and** a pinned address. Nothing else may open a connection into an environment
  VM. An environment VM may open a connection to nothing: not the host, another VM, a container,
  the cloud metadata address or the internet.
- **One nftables table**, `inet env_vm_guard`, holds every rule. It never writes Docker's
  `DOCKER-USER` chain, UFW's rules or Incus's table. A `drop` in any netfilter base chain is final,
  so nothing that Docker, UFW or Incus accepts can reopen what it drops.
- **One systemd unit** loads the table, as a start requirement of the Incus daemon. Incus, and so
  every environment VM, cannot start until the table is loaded and read back. An Incus restart
  re-runs it.
- **Routing without NAT, DHCP, DNS or IPv6** on each VM's bridge. The guest's static address and
  default route come from the package (`incus-environment.server.ts:647-659`).
- **Every change** is journaled before it is made and has an exact undo. It runs under a
  10-minute dead-man switch that restores the previous table unless the operator confirms from a
  fresh SSH login.
- **The evidence** is a smoke check in which every refusal must time out **and** raise its own
  named counter in the table. Its record is the file `DEV_SANDBOX_FIREWALL_EVIDENCE` names.

```text
app-dev ──[envapp-dev, <dev-app-address>]──┐
                                           ├── host ──[envvm-dev]── dev VM <dev-vm-address>:2376
every other container ──[app-network]──────┘    (every other flow into or out of envvm-* is dropped)
```

## 1. Flows

| Flow                                                       | Verdict                                                        | Rule ([§2.1](#21-the-guard-table))  |
| ---------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| dev app (link bridge **and** pinned address) → dev VM:2376 | allowed                                                        | `app_to_vm_dev`                     |
| replies within an allowed flow                             | allowed                                                        | the two `established,related` rules |
| any other container, source or port → any environment VM   | refused                                                        | `to_vm_refused`                     |
| VM → the host (any host address and port, IPv4 or IPv6)    | refused                                                        | `vm_to_host`                        |
| VM → another environment VM                                | refused                                                        | `vm_to_vm`                          |
| VM → cloud metadata (`169.254.0.0/16`)                     | refused here, and independently by the existing metadata block | `vm_to_metadata`                    |
| VM → the internet, a container, anything else              | refused                                                        | `vm_egress`                         |
| host → VM (the operator's `health` probe)                  | not filtered by this plan ([§10](#10-deliberately-left-out))   | none                                |

## 2. The rules

### 2.1 The guard table

The installer renders the table from a root-owned config with one entry per environment. Here it
is for one environment, `dev`. Names in angle brackets are the deployment's own values.

```text
table inet env_vm_guard {
    comment "managed by env-vm-guard; do not edit"

    counter vm_to_host {}
    counter vm_to_vm {}
    counter vm_to_metadata {}
    counter vm_egress {}
    counter to_vm_refused {}
    counter app_to_vm_dev {}

    chain input {
        type filter hook input priority filter - 10; policy accept;
        iifname "envvm-*" ct state established,related accept
        iifname "envvm-*" counter name "vm_to_host" drop
    }

    chain forward {
        type filter hook forward priority filter - 10; policy accept;
        # Leaving an environment bridge: replies only.
        iifname "envvm-*" ct state established,related accept
        iifname "envvm-*" oifname "envvm-*" counter name "vm_to_vm" drop
        iifname "envvm-*" ip daddr 169.254.0.0/16 counter name "vm_to_metadata" drop
        iifname "envvm-*" counter name "vm_egress" drop
        # Entering an environment bridge: replies, then one allow per environment.
        oifname "envvm-*" ct state established,related accept
        iifname "envapp-dev" ip saddr <dev-app-address> oifname "envvm-dev" ip daddr <dev-vm-address> tcp dport 2376 ct state new counter name "app_to_vm_dev" accept
        oifname "envvm-*" counter name "to_vm_refused" drop
    }
}
```

What each choice is for:

- **Default deny by name, not by list.** Every environment bridge is named `envvm-<environment>`,
  at most 15 characters (the Linux interface limit), and the drops match the wildcard. A bridge
  created later and never configured is isolated already. The only way in is a per-environment
  allow.
- **`inet` covers IPv4 and IPv6.** The drops name no address family, so a guest's IPv6
  link-local packet to the host is dropped like an IPv4 one. The single allow is IPv4, like the
  endpoint: the clone validator refuses anything but a unicast IPv4 guest address
  (`docs/PREVIEW.md` §12).
- **The metadata and VM-to-VM rules only attribute probes.** They widen nothing: the `vm_egress`
  drop below them refuses the same packets. A probe that times out without raising its own counter
  is inconclusive, not a pass ([§6](#6-what-the-smoke-check-verifies)).
- **Both chains keep policy `accept` on purpose.** They see all of the host's traffic, and
  anything that neither leaves nor enters an environment bridge must reach Docker's and UFW's own
  rules untouched. Every drop is scoped to `envvm-*`.
- **Interface names are matched as strings when a packet arrives** (`iifname`, not `iif`). The
  table therefore loads before Incus or Docker has created the bridges, which is what lets it
  load before the Incus daemon starts ([§4](#4-persistence-across-a-host-and-an-incus-restart)).
- **The source is the link bridge AND the pinned address.** Either alone is weaker. The bridge
  alone admits any container someone attaches to it by hand. The address alone admits whoever
  holds it on another network.

### 2.2 The environment bridge (Incus)

```sh
incus network create envvm-<environment> \
  ipv4.address=<bridge-gateway>/<prefix> ipv4.nat=false ipv4.dhcp=false \
  ipv6.address=none dns.mode=none \
  ipv4.firewall=false ipv6.firewall=false
```

- **One VM per bridge.** The package allows one VM per environment project
  (`incus-environment.server.ts:418`) and restricts the project to its own bridge (`:436`). The
  plan adds the converse: no other instance on that bridge, which `--check` enforces. With one
  guest per bridge, traffic between guests is always routed through the host, so it always
  crosses the `forward` hook. Two guests on one bridge could talk at layer 2 past it.
- **No NAT.** Even a forwarding gap would leave a guest with no working return path from the
  internet. **No DHCP or DNS**, so the guest needs no host `INPUT` exception
  (`packages/sandbox/README.md:340-343`).
- **`ipv4.firewall=false` and `ipv6.firewall=false`**: Incus generates no filter rules of its own
  for these bridges, and the guard table is the only filter that names them. The table would hold
  with Incus's defaults too, since an accept there cannot override a drop here. One place is just
  easier to read back.
- **The guest cannot spoof its address.** Its NIC carries `security.mac_filtering`,
  `security.ipv4_filtering` and `security.ipv6_filtering` (`incus-environment.server.ts:596-604`).
  The allow's address match depends on that.
- The bridge subnet must not overlap a host route or Docker's address pools. `--check` refuses an
  overlap.

### 2.3 The dev app's link network (Docker)

This section assumes the recommended answer to owner question 1 on
[#740](https://github.com/mknw/hames-playground/pull/740), the PR that added this plan. With
answer (b), this section drops out and the allow matches the shared network's bridge instead.

```sh
docker network create --driver bridge \
  --subnet <link-subnet> --gateway <link-gateway> \
  --opt com.docker.network.bridge.name=envapp-dev \
  envapp-dev
```

In the dev VM overlay, a follow-up change ([§11](#11-what-has-to-land-before-the-window)):

```yaml
services:
  app-dev:
    networks:
      envapp-dev:
        ipv4_address: <dev-app-address>
        gw_priority: 1
networks:
  envapp-dev:
    external: true
```

**Why a network of its own.** The shared `app-network` is a plain bridge with no fixed subnet or
bridge name (`docker-compose.yaml:401-402`). Its host interface is `br-` plus the first 12
characters of the network's id (`scripts/check-vps.py:108`), which changes whenever the network is
recreated. App-dev's address on it is whatever Docker's allocator hands out at each recreate, and
a later container can inherit it. And every container on it, the release app, the MCP gateway and
the data services included, would match a rule keyed on it. A network with one member, a fixed
bridge name, a fixed subnet and a pinned address gives app-dev an identity that survives
recreates, daemon restarts and reboots. It does so without recreating `app-network`, which would
stop the release app.

- **`external: true`.** The operator creates the network once. `docker compose down` does not
  remove it, and it exists before the overlay is enabled, so the window can prove the rule before
  app-dev moves (step W9 in [§7](#7-operator-runbook)).
- **`gw_priority: 1` makes the link network app-dev's default route.** Traffic to the VM follows
  the default route. Without it, app-dev would leave through `app-network`, match nothing and be
  refused: the misconfiguration fails closed. The consequence is that app-dev's other off-subnet
  traffic, to the internet and the host-gateway alias, also leaves through the link bridge. The
  policies on that traffic (Docker's NAT, the metadata block in `DOCKER-USER`, UFW's `INPUT`
  rules) have no interface condition, so they apply unchanged. The follow-up change checks this
  against the smoke's existing app checks. Peers on `app-network` (Postgres, Redis, the Neo4j
  relay, the gateway, Caddy) stay on-link and are unaffected.
- **The validator refuses** any other service on the link network, and an app-dev without the
  pinned address. `check-vps.py --clones` compares the live network (bridge name, subnet, sole
  member, address) with the render.

### 2.4 Routing, end to end

- **app-dev → VM.** The packet leaves by app-dev's default route (the link gateway), the host
  routes it onto `envvm-dev`, and it reaches the guest. The guard's `forward` chain sees app-dev's
  own source address and the link bridge, because Docker masquerades traffic leaving its bridges
  later, at post-routing. The guest therefore sees every connection come from its bridge gateway
  and cannot tell clients apart by address. The host table is the only place where the source is
  checked.
- **VM → anywhere.** The guest's seeded default route (`incus-environment.server.ts:647-659`)
  points at the host. It exists so replies can leave; the table refuses everything else that uses
  it.
- **Nothing else.** No static routes, proxy ARP or policy routing on the host. IP forwarding is
  already on, because Docker requires it.

## 3. Why one nftables table, and how it orders against Docker, UFW and Incus

Netfilter runs every base chain registered on a hook, in priority order. An `accept` ends only the
chain it is in; a `drop` ends the packet
([nftables wiki, base chain priority](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains)).
Three consequences:

1. **Docker, UFW and Incus cannot reopen what this table drops**, whatever they accept and
   whatever order they load in. The priority `filter - 10` puts the table ahead of the
   `iptables-nft` chains only so that its counters see every packet first. The refusals would hold
   at any priority.
2. **It needs no place in `DOCKER-USER`.** The forwarded metadata block stays first there, as
   `metadata-egress.py --check` requires (`scripts/metadata-egress.py:233-240`). Docker restarts
   rebuild Docker's own chains and never touch this table. A guest's packet to `169.254.169.254`
   is dropped by this table, and would be dropped again by the metadata block, whose rules match
   every forwarded packet without an interface condition (`:198-206`).
3. **The allowed flow still needs every other chain to accept it.** In the `iptables-nft` `FORWARD`
   chain, Docker's own rules accept traffic leaving a non-internal Docker bridge, and accept its
   replies by connection state
   ([Docker packet filtering](https://docs.docker.com/engine/network/firewall-iptables/)). UFW's
   chains come after Docker's and never see the flow. The plan relies on those two Docker rules
   instead of adding an accept of its own. `--check` reads them, read-only, and refuses when they
   are missing; the smoke's positive probe proves the path.

**Why not the spike's allowances.** The spike added two `DOCKER-USER` accepts below the metadata
block and one UFW route rule per bridge (`scripts/lib/sandbox_vm.py:684-698`, `:710-717`). With
the guard table holding every refusal, those rules refuse nothing. Their only job was to accept the
allowed flow, which Docker's own rules already do (point 3). Leaving them out keeps this plan out
of `DOCKER-USER` and UFW entirely: no ordering against the metadata block, no write to an inbound
firewall component, and nothing a Docker restart has to preserve. What this plan keeps from the
spike is its guard shape, a priority -10 `input` and `forward` chain per bridge
(`scripts/lib/sandbox_vm.py:660-683`; `docs/deployment/sandbox-vm-spike.md:421`), as one table
with wildcards. That shape passed every isolation check in
[spike run 4](https://github.com/mknw/hames-playground/issues/648#issuecomment-6314943380). That
run also had the `DOCKER-USER` and UFW allowances in place, so the positive path without them is
evidence the window still owes ([§9](#9-what-the-plan-relies-on-and-the-window-verifies), A3).

**Alternatives considered and rejected:**

- **Incus network ACLs on the bridge.** They are native and Incus persists them. But they put the
  only barrier inside the daemon whose start the barrier has to precede, and nothing in this
  repository has measured how they treat traffic to the host. The host-table shape has a measured
  run.
- **`nftables.service` with `/etc/nftables.conf`.** The Debian-family default configuration
  begins with `flush ruleset`. Run after Docker and UFW, it deletes their rules. The unit is also
  ordered against the network, not against Incus.
- **A full ruleset saved and restored at boot** (`netfilter-persistent` and similar). Restoring
  whole tables fights the state that Docker, UFW and Incus manage. This repository never restores
  a full table (`docs/deployment/egress-design.md:341-342`).
- **Rules in `DOCKER-USER`.** See the spike paragraph above.

## 4. Persistence across a host and an Incus restart

```ini
# Managed by env-vm-guard; do not edit.
[Unit]
Description=Environment VM network guard
Before=incus.service
PartOf=incus.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 -I /usr/local/lib/env-vm-guard.py --apply --config /etc/env-vm-guard/config.json

[Install]
RequiredBy=incus.service
```

`incus.service` stands for the unit that runs the Incus daemon. Confirm its name read-only before
installing (step W0).

- **Loaded before the first guest packet.** Guests are started only by the Incus daemon, which
  restores each VM's last power state when it starts. `RequiredBy=` with `Before=` makes the guard
  a start requirement of that unit and orders it first, however the daemon starts: at boot,
  through its socket, from a startup unit or by hand. This is how the metadata seed is tied to
  Docker (`scripts/metadata-egress.py:51-66`; `docs/deployment/egress-design.md:204-247`).
- **Fail-closed.** If the guard cannot load and read back its table, the Incus daemon does not
  start, so it starts no environment VM. On a daemon restart, a guest the daemon left running keeps
  the table it already had, because a failed transaction changes nothing. The release app keeps its
  host socket and is unaffected; dev's sandbox is unavailable until the cause is fixed.
- **Incus restart.** Incus manages only its own table, so a daemon restart leaves the guard table
  alone. `PartOf=` still re-runs the guard on every restart, so each restart re-applies the
  reviewed render and reads it back. Re-applying an identical table writes nothing.
- **Docker restart, UFW reload.** Neither writes this table; both manage their own chains through
  `iptables-nft`. No ordering against them exists, and none is needed.
- **No `ExecStop`.** Stopping the unit never removes the table. Removal is the installer's
  `--remove`, which refuses while a configured environment VM runs
  ([§5](#5-changing-the-rules-install-journal-undo-dead-man)).
- **Never `systemctl restart` or `stop` the guard unit.** Through `RequiredBy=`, stopping it stops
  the Incus daemon. Re-apply with the installer's `--apply`, which is atomic.
- **No mutable checkout runs at boot.** The unit runs a root-owned copy of the reviewed installer
  and reads a root-owned config, as the metadata units do (`scripts/metadata-egress.py:368-394`).
- **Not covered:** a manual `nft flush ruleset`, or a firewall manager started later that flushes
  the ruleset. Either removes this table along with Docker's and UFW's rules, and the unit does not
  watch for it. `--check` and the bootstrap smoke catch it ([§8](#8-failure-modes-and-what-the-operator-does)).

## 5. Changing the rules: install, journal, undo, dead-man

The installer is proposed as `scripts/env-vm-guard.py`, which does not exist yet
([§11](#11-what-has-to-land-before-the-window)). It follows `scripts/metadata-egress.py`: an
offline render by default, Linux root only for writes, fixed failure labels and bounded
subprocesses.

- **Idempotent install.** `--apply` renders the table from the config and compares it with
  `nft -j list table inet env_vm_guard`, ignoring rule handles and counter values. If they are
  equal, nothing is written. If they differ, or the table is absent, it syntax-checks the render
  with `nft -c -f` and then replaces the table in one transaction:

  ```text
  table inet env_vm_guard
  delete table inet env_vm_guard
  table inet env_vm_guard { … }
  ```

  There is never a moment without the table, and a failed transaction leaves the previous one in
  place. The readback must then equal the render.

- **The render is the source of truth.** A live table that differs from it, for example after a
  hand edit, is replaced on the next apply, and the drifted content is kept in the state directory
  for review. The table name is reserved for the guard, so, unlike a shared chain, there is no
  foreign rule to preserve.
- **Write-ahead journal.** A locked, fsynced journal in a root-only state directory
  (`/var/lib/env-vm-guard/`) records each change **before** it is made: the table's previous
  render (or "absent") and its new one, each persistence file created, each unit enabled, each
  dead-man armed and confirmed. A killed apply stays reversible. The operator also writes one line
  per change in the host's change journal: the time in UTC, the change, the exact command, its
  exact undo, and the approval it ran under.
- **Exact undo.** `--remove` reverses only journaled entries, newest first. The table is deleted
  only if its live content equals the journaled render, the unit is disabled only if this installer
  enabled it, and files are removed only if they are byte-identical to what it wrote. It **refuses
  while any configured environment VM is running**: removing the guard under a running guest is the
  one undo that would widen access. The manual equivalent from a console, in this order: stop the
  VM, disable the unit, `nft delete table inet env_vm_guard`. Never `nft flush ruleset`, and never
  restore a saved full ruleset.
- **Dead-man switch.** An operator change runs `--apply --deadman 600`, or
  `--persist --deadman 600`. The installer records the previous state, arms a transient timer with
  `systemd-run --on-active=600`, and only then writes. Unless the operator runs `--confirm` **from
  a new SSH login** within **10 minutes**, the timer runs `--deadman-restore`. It force-stops every
  configured environment VM, the safe state if the operator has lost access. It then restores the
  table's previous render, or deletes the table if there was none, restores the previous
  persistence state, and journals that it fired. If it cannot confirm that every environment VM is
  stopped, it keeps the current table and journals that it withheld the restore: the rules cannot
  match the public interface, so a lost login is far less likely to come from them than an exposed
  guest would be from removing them. `--confirm` reads the table back first and refuses to disarm
  if the readback differs from the render, so a confirmation cannot approve a wrong table.
  - **"The previous ruleset" is the guard table's previous state.** Nothing else is written, so
    nothing else is restored: no Docker chain, no UFW rule, no Incus network. Restoring a whole
    saved ruleset would also undo whatever Docker, UFW or Incus changed in the meantime.
  - **The bound.** Ten minutes covers a fresh login and a readback, a minute or two, with margin,
    and caps an unexpected lockout at that.
  - **Boot is not covered.** The boot unit runs plain `--apply`, with no timer: it only re-applies
    a render that was confirmed when installed. A transient timer does not survive a reboot, so the
    reboot step (W13) runs only after every change is confirmed, with the console as the fallback.
- **One operator at a time.** The installer's lock refuses at once when another run holds it.
  Docker, UFW and Incus lifecycle changes wait during a change.

## 6. What the smoke check verifies

`--smoke` runs as root on the host. It runs every probe below, reads the table's named counters
before and after each one, and writes one result record.

- **Guest-side probes** run inside the VM through the Incus agent, so no network path is used to
  reach the guest. They use the guest's own `python3`
  (`packages/sandbox/scripts/vm-image/build.py:23`).
- **App-side probes** run either inside app-dev with `docker exec`, or as throwaway containers from
  the already-local app image, as the metadata smoke does (`scripts/metadata-egress.py:276-300`):
  `--pull never`, every capability dropped, read-only, an unprivileged user.

**A refusal passes only if** the TCP connect **times out** (a local error such as "no route" is
inconclusive) **and** its named counter rises. Anything inconclusive fails the smoke. A connect that
succeeds where a refusal is expected stops the window ([§8](#8-failure-modes-and-what-the-operator-does)).

| #   | Probe                                                                                                                                                                       | Expected                       | Counter          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------- |
| 1   | app-dev → its own VM:2376, with the app's own `SANDBOX_DOCKER_*` settings and the image's Docker CLI (`app/Dockerfile:180`)                                                 | the daemon answers, mutual TLS | `app_to_vm_dev`  |
| 2   | host → VM:2376 (the entry point's `health`, [#732](https://github.com/mknw/hames-playground/pull/732))                                                                      | `ready`                        | none             |
| 3   | throwaway on the link network with another address → VM:2376                                                                                                                | refused                        | `to_vm_refused`  |
| 4   | throwaway on `app-network` → VM:2376 (stands for the release app, the gateway and every other service)                                                                      | refused                        | `to_vm_refused`  |
| 5   | app-dev → its own VM on another port                                                                                                                                        | refused                        | `to_vm_refused`  |
| 6   | app-dev → another environment's VM:2376, once one exists                                                                                                                    | refused                        | `to_vm_refused`  |
| 7   | **VM → VM:** guest → another environment's guest:2376                                                                                                                       | refused                        | `vm_to_vm`       |
| 8   | **VM → host:** guest → its bridge gateway and the host's primary address, on a port the host listens on for every address; and the gateway's IPv6 link-local, if it has one | refused                        | `vm_to_host`     |
| 9   | **VM → metadata:** guest → `169.254.169.254:80`                                                                                                                             | refused                        | `vm_to_metadata` |
| 10  | **VM → internet:** guest → a public address on 443 that the host itself reaches (the positive control)                                                                      | refused                        | `vm_egress`      |
| 11  | VM → containers: guest → app-dev's link address, and a service on `app-network`                                                                                             | refused                        | `vm_egress`      |
| 12  | persistence: the unit enabled and ordered before the Incus daemon, files byte-identical to the reviewed copies, readback equal to the render, no flushing firewall manager  | pass                           | none             |

- **The five required checks** (app-to-VM allowed; VM-to-VM, VM-to-host, VM-to-metadata and
  VM-to-internet refused) are probes 1, 7, 8, 9 and 10. Probes 1 and 3 together also show that the
  `forward` chain sees app-dev's own address rather than the masqueraded one.
- **With one environment** (dev, until release moves), probe 7 targets an address in another
  environment's planned subnet. With no second bridge, the packet would leave through the uplink,
  so `vm_egress` counts it, not `vm_to_vm`. That proves nothing leaves the bridge, but not the
  per-pair rule. Per-pair attribution runs once a second environment exists, and the record says
  which kind of run it was.
- **Before app-dev joins the link network**, a throwaway holding the pinned address stands in for
  it in probe 1. That is how the window proves the rule before it enables the overlay that needs
  the evidence (step W9).
- **The record** holds the installer's commit, the render's hash, each probe's outcome and counter
  change, and whether it was a single-environment run. `DEV_SANDBOX_FIREWALL_EVIDENCE` names it.
  Bootstrap only requires that file to exist and be non-empty (`scripts/bootstrap-vps.sh:516-522`).

## 7. Operator runbook

**Before the window**

1. The implementation in [§11](#11-what-has-to-land-before-the-window) is merged after its own
   reviews, and so is the operator entry point
   ([#732](https://github.com/mknw/hames-playground/pull/732)).
2. Incus is installed persistently, with its API listening on loopback only, a storage pool, the
   manager credential, and the pinned VM image available from its image server. That is a
   prerequisite with its own reviewed plan, not part of this one.
3. The deployment's values are chosen in its private notes: the environment address block, each
   bridge's gateway and guest address, the link subnet and app-dev's address. None may overlap a
   host route or Docker's address pools.
4. The owner has given the GO and the window is announced. A console session to the host is
   confirmed to work. An SSH session separate from the one doing the work stays open throughout.

**In the window.** Stop at the first failure. Each step that changes something gets its journal
line and its undo before it runs.

| Step | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Undo                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| W0   | Read-only survey, with private snapshots for diffing only, never replayed: `nft list tables`, `iptables-save`, `ip6tables-save`, `ufw status verbose`, `ip -j route`, `ip -j addr`, the Incus daemon's units, `nftables.service`, each container's id, start time and health, and an `sshd -T` digest. **Stop** if a firewall manager that flushes the ruleset is enabled, a planned subnet overlaps a route, `FORWARD`'s first rule is not `-j DOCKER-USER`, or Docker's firewall backend is not iptables. | none                                    |
| W1   | Dry-fire the dead-man: arm it for 60 s on a no-op; it fires and journals.                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                    |
| W2   | Create the environment bridge ([§2.2](#22-the-environment-bridge-incus)).                                                                                                                                                                                                                                                                                                                                                                                                                                   | `incus network delete envvm-<env>`      |
| W3   | Create the link network ([§2.3](#23-the-dev-apps-link-network-docker)).                                                                                                                                                                                                                                                                                                                                                                                                                                     | `docker network rm envapp-dev`          |
| W4   | `--install`: copy the installer and its config to their root-owned places, journaled. The dead-man and the unit run that copy, never the checkout.                                                                                                                                                                                                                                                                                                                                                          | `--remove`                              |
| W5   | `--apply --deadman 600`. From a fresh login: `--check`, then `--confirm`.                                                                                                                                                                                                                                                                                                                                                                                                                                   | `--remove`                              |
| W6   | `--persist --deadman 600`. `systemd-analyze verify` on the unit; the Incus daemon's unit lists the guard in `Requires=` and `After=`. From a fresh login: `--confirm`.                                                                                                                                                                                                                                                                                                                                      | `--remove`                              |
| W7   | Restart the Incus daemon, with no VM yet. The guard ran first; the readback is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                    |
| W8   | Provision the VM with the entry point: `reconcile`, then `health --wait`.                                                                                                                                                                                                                                                                                                                                                                                                                                   | the entry point's `teardown`            |
| W9   | `--smoke`, with a throwaway standing in for app-dev. It writes the first evidence record.                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                    |
| W10  | Enable the overlay as in `docs/PREVIEW.md` §12, steps 3–5, with `DEV_SANDBOX_FIREWALL_EVIDENCE` naming the record.                                                                                                                                                                                                                                                                                                                                                                                          | remove the overlay and recreate app-dev |
| W11  | `--smoke` with the real app-dev. It replaces the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                    |
| W12  | Restart the Incus daemon with the VM running (it may stop and come back, depending on packaging). Then `health --wait` and `--smoke`.                                                                                                                                                                                                                                                                                                                                                                       | none                                    |
| W13  | If the owner chooses it (question 2 on #740): reboot. Afterwards, the guard finished before the daemon started (journal timestamps), then `health --wait`, `--smoke` and `bootstrap-vps.sh --only smoke`.                                                                                                                                                                                                                                                                                                   | none                                    |
| W14  | Post-checks. Diffed against W0, the only differences are the guard table, the bridge, the link network and Docker's own rules for it, and the installer's files and unit. UFW, `DOCKER-USER`, the metadata units, `sshd -T` and the release containers are unchanged (start times aside, after a reboot). A fresh SSH login works.                                                                                                                                                                          | none                                    |

**Rollback**, in this order: remove the overlay and recreate app-dev; the entry point's
`teardown`; `--remove`; `docker network rm envapp-dev`; `incus network delete envvm-<env>`. Each
step is exact and refuses on state it does not own.

## 8. Failure modes and what the operator does

| Symptom                                                                                                | Likely cause                                                                                                                                   | What the operator does                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Incus daemon does not start; the guard unit failed                                                 | config unreadable or unsafe; `nft` refused the render; the readback differed                                                                   | `journalctl -u env-vm-guard.service` names the cause. Fix it, then start the Incus daemon. Never mask or disable the guard to get Incus up. Release is unaffected.                |
| Probe 1 fails while every refusal passes                                                               | Docker's accept for the link bridge is missing (A3); app-dev is not on the link network or not routed through it; the guest's Docker is not up | `--check` names the missing precondition, and `health --wait` checks the guest. Recreate app-dev if needed. Never add a broad accept.                                             |
| A refusal probe connects                                                                               | the guard is not doing its job                                                                                                                 | Stop the VM at once (`incus stop --force`), keep the overlay off, keep the record, stop the window and escalate. No fixing forward inside the window.                             |
| A refusal times out but its counter does not rise                                                      | the packet never reached the rule: a wrong name, bridge or route                                                                               | Treat it as a failure, and investigate before claiming any isolation.                                                                                                             |
| `--check` reports the table missing or changed                                                         | a flush, a firewall manager that flushes, a hand edit                                                                                          | Stop the environment VMs, `--apply`, `--check`, start the VMs, `--smoke`. Then find what flushed: if Docker's and UFW's rules went too, that is a host incident beyond this plan. |
| The dead-man fired                                                                                     | no confirmation within 10 minutes                                                                                                              | The environment VMs are stopped and the previous table is back. Log in (by console if needed), read both journals and re-plan. Never re-run the same change unexamined.           |
| SSH lost after a change                                                                                | should be impossible: no rule matches the public interface                                                                                     | Wait for the dead-man, at most 10 minutes. If it did not fire, from the console: stop the VMs, disable the unit, `nft delete table inet env_vm_guard`.                            |
| The installer refuses: lock held                                                                       | another run is in progress                                                                                                                     | Wait for it, or resolve it from the console. Never delete the lock or the journal.                                                                                                |
| `--check` refuses: a second instance on a bridge, another member on the link network, an address drift | a manual attachment or a Compose edit                                                                                                          | Detach or revert. The validator and `check-vps.py --clones` should have refused it first, so find out why they did not.                                                           |

## 9. What the plan relies on and the window verifies

These are upstream behaviours. The repository cannot pin them, so the window records evidence for
each one.

| Ref | Assumption                                                                                     | Evidence in the window                                                        |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A1  | A `drop` in any base chain is final; an accept in another chain cannot override it             | probes 3 and 4 refuse flows that Docker's own rules accept                    |
| A2  | `iifname` wildcards match by name when a packet arrives                                        | the table loads before the bridges exist (W5); the probes pass after (W9)     |
| A3  | Docker accepts traffic leaving a non-internal bridge, and its replies                          | `--check` reads both rules; probe 1                                           |
| A4  | Incus writes only its own table, and with `ipv4.firewall=false` no filter rules for the bridge | the W0 and W14 diffs of `nft list tables` and of Incus's own table            |
| A5  | The Incus daemon restores each VM's last power state when it starts                            | W12, W13                                                                      |
| A6  | `RequiredBy=`, `Before=` and `PartOf=` order the guard before every daemon start               | `systemd-analyze verify`; journal timestamps in W7, W12 and W13               |
| A7  | Docker masquerades app-dev's traffic at post-routing, after the guard's `forward` chain        | probes 1 and 3 together                                                       |
| A8  | Docker and UFW write only their own chains, through `iptables-nft`, never this table           | W13: after a reboot, Docker and UFW have loaded and the readback is unchanged |

## 10. Deliberately left out

- **SSH, `sshd`, `authorized_keys`, UFW's rules and port 22.** Untouched; see the status note.
- **Host-originated traffic into a VM.** Not filtered. The host's root already holds the CA key
  and the Incus manager credential, the operator's `health` probe uses this path, and no Compose
  service shares the host's network namespace: the only non-default network mode is `none`
  (`docker-compose.yaml:99`). A holder of the host's Docker socket could start a container in the
  host's network namespace and reach the port this way. It would still need the client key, and a
  socket holder is root-equivalent in any case (`docs/deployment/egress-design.md:27-30`). Owner
  question 4 on [#740](https://github.com/mknw/hames-playground/pull/740) asks whether to narrow
  this path anyway.
- **The MCP gateway's host socket**, and its sharing `app-network` with app-dev (#731 question 10).
- **The release environment.** Release keeps the host socket until its own VM lands
  ([#648](https://github.com/mknw/hames-playground/issues/648) Q2). The table takes more
  environments, but adding one is its own reviewed change.
- **Any egress for the guest**: no allowlist, proxy, DNS or NTP. The images are preloaded. The
  guest's clock depends on the hypervisor, which is one reason backdating certificate validity is
  being considered (#731 question 4).
- **Watching for drift.** No daemon re-applies after arbitrary firewall changes. `--check`, the
  bootstrap smoke and every Incus start do.
- **Docker's native nftables backend**, refused by the daemon guard
  (`scripts/check-vps.py:58-59`), and flow offload, macvlan, ipvlan and tunnels, as in the egress
  design (`docs/deployment/egress-design.md:66-69`, `:154-155`).
- **Inside the guest.** Dev is root in its own VM by design, and the guest's own firewall is not
  relied on.
- **The persistent Incus install**, a prerequisite ([§7](#7-operator-runbook)).

## 11. What has to land before the window

1. **The installer**, `scripts/env-vm-guard.py`, with modes `render` (default, offline), `--check`,
   `--install`, `--apply [--deadman N]`, `--persist [--deadman N]`, `--confirm`, `--remove`,
   `--deadman-restore` and `--smoke`. Its test, `scripts/env-vm-guard.test.py`, uses offline fakes for `nft`,
   `systemctl`, `incus` and `docker` and a mutation runner, as `scripts/metadata-egress.test.py`
   does. Each pin is verified by a mutation that turns it red. At least:
   - a drop removed or narrowed (the wildcard reduced to one bridge); the allow widened (its
     address, bridge or port dropped); the replies' accept moved below the drops;
   - an apply that writes when the table is equal; the replacement split across two transactions;
     the readback skipped;
   - the dead-man armed after the write; a confirmation without a readback; a restore that touches
     anything but the guard table;
   - a removal while a VM runs; a removal of an edited file;
   - the unit losing `Before=`, `RequiredBy=` or `PartOf=`, or gaining an `ExecStop`;
   - a smoke that accepts a timeout without a counter rise, or a local error as a refusal.
2. **The dev overlay, the validator and `check-vps.py --clones`**, as in
   [§2.3](#23-the-dev-apps-link-network-docker).
3. **The bootstrap smoke**: with the VM overlay selected, `--only smoke` runs the guard's
   `--check`.
