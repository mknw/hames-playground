# Environment VM network rules (plan)

> **Status: §11 items 1 and 2 are built (installer, overlay, validator); nothing has run on a host.** It answers owner question 9 of
> [#731](https://github.com/mknw/hames-playground/pull/731); the window needs the owner's explicit
> GO and [§11](#11-what-has-to-land-before-the-window). SD-19, SD-20. **No SSH, `sshd`,
> `authorized_keys` or public inbound-firewall change is part of it**: needing one is an escalation
> to the owner **before** the change.

## The plan in one screen

- **One allowed flow.** The dev app container opens TCP to **its own** environment VM's Docker
  port, 2376, where the daemon accepts only mutual TLS
  (`packages/sandbox/incus-environment.server.ts:577-579`). The app is identified by a dedicated
  link bridge **and** a pinned address. Nothing else may open a connection into an environment
  VM, except the host itself, where mutual TLS is the control, and holders of the host Docker
  socket (root-equivalent, [§10](#10-deliberately-left-out)). An environment VM may open an IP
  connection to nothing: not the host, another VM, a container, the cloud metadata address or the
  internet.
- **One nftables table**, `inet env_vm_guard`, holds every rule. It never writes Docker's
  `DOCKER-USER` chain, UFW's rules or Incus's table, and none of them can reopen what it drops
  ([§3](#3-why-one-nftables-table-and-how-it-orders-against-docker-ufw-and-incus)).
- **One systemd unit** loads the table, as a start requirement of the Incus daemon. Incus, and so
  every environment VM, cannot start until the table is loaded and read back. An Incus restart
  re-runs it.
- **Routing without NAT, DHCP, DNS or IPv6** on each VM's bridge. The guest's static address and
  default route come from the package (`incus-environment.server.ts:733-737`).
- **Every change** is journaled before it is made and has an exact undo. It runs under a
  10-minute dead-man switch that restores the previous table unless the operator confirms from a
  new login session.
- **The evidence** is a smoke check in which every refusal must time out, be traced on the host
  to its own named rule, and raise that rule's counter. Its record is the file
  `DEV_SANDBOX_FIREWALL_EVIDENCE` names.

```text
app-dev ──[envapp-dev, <dev-app-address>]──┐
                                           ├── host ──[envvm-dev]── dev VM <dev-vm-address>:2376
every other container ──[app-network]──────┘    (every other flow into or out of envvm-* is dropped)
```

## 1. Flows

| Flow                                                       | Verdict                                                                  | Rule ([§2.1](#21-the-guard-table)) |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| dev app (link bridge **and** pinned address) → dev VM:2376 | allowed                                                                  | `app_to_vm_dev`                    |
| replies within an allowed flow                             | allowed                                                                  | the three reply accepts            |
| any other container, source or port → any environment VM   | refused, except holders of the host Docker socket (root-equivalent, §10) | `to_vm_refused`                    |
| VM → the host (any host address and port, IPv4 or IPv6)    | refused                                                                  | `vm_to_host`                       |
| VM → another environment VM                                | refused                                                                  | `vm_to_vm`                         |
| VM → cloud metadata (`169.254.0.0/16`)                     | refused here, and independently by the existing metadata block           | `vm_to_metadata`                   |
| VM → the internet, a container, anything else              | refused                                                                  | `vm_egress`                        |
| host → VM (the operator's `health` probe)                  | not filtered by this plan; mutual TLS ([§10](#10-deliberately-left-out)) | none                               |

## 2. The rules

### 2.1 The guard table

The installer renders the table from a root-owned config with one entry per environment. An
unknown or missing key is refused. `service` is the environment's Compose service, the link
network's only allowed member; `entryPointConfig` is the entry point's config, which `--check`
compares; `probes` feeds the smoke ([§6](#6-what-the-smoke-check-verifies)):

```json
{
  "environments": [
    {
      "name": "dev",
      "service": "app-dev",
      "guestAddress": "<dev-vm-address>",
      "clientAddress": "<dev-app-address>",
      "entryPointConfig": "<the entry point's config.json>"
    }
  ],
  "probes": {
    "otherGuestAddress": "<an address in another environment's planned subnet>",
    "publicAddress": "<a public address the host reaches>",
    "publicPort": 443,
    "hostPort": "<a port the host listens on for every address>"
  }
}
```

Here is the table for one environment, `dev`. Names in angle brackets are the deployment's own
values.

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
        # From the dev VM to the host: replies within a flow opened toward that VM only.
        iifname "envvm-dev" ip saddr <dev-vm-address> ct original ip daddr <dev-vm-address> ct state established,related accept
        iifname "envvm-*" counter name "vm_to_host" drop
    }

    chain forward {
        type filter hook forward priority filter - 10; policy accept;
        # Leaving an environment bridge: replies within a flow opened toward that VM only.
        iifname "envvm-dev" ip saddr <dev-vm-address> ct original ip daddr <dev-vm-address> ct state established,related accept
        iifname "envvm-*" oifname "envvm-*" counter name "vm_to_vm" drop
        iifname "envvm-*" ip daddr 169.254.0.0/16 counter name "vm_to_metadata" drop
        iifname "envvm-*" counter name "vm_egress" drop
        # Entering an environment bridge: one flow per environment, and that flow's packets.
        iifname "envapp-dev" ip saddr <dev-app-address> oifname "envvm-dev" ip daddr <dev-vm-address> tcp dport 2376 ct state new counter name "app_to_vm_dev" accept
        iifname "envapp-dev" oifname "envvm-dev" ct original ip saddr <dev-app-address> ct original ip daddr <dev-vm-address> ct original proto-dst 2376 ct state established,related accept
        oifname "envvm-*" counter name "to_vm_refused" drop
    }
}
```

What each choice is for:

- **Default deny by name, not by list.** Every environment bridge is named `envvm-<environment>`
  and the drops match the wildcard. A bridge created later and never configured is isolated
  already. The only way in is a per-environment accept.
- **Names fit the 15-character interface limit.** The installer's config validation refuses an
  environment name longer than 8 characters, so that both `envvm-<environment>` and
  `envapp-<environment>` fit. The package itself accepts bridge names of up to 63 characters
  (`incus-environment.server.ts:264`), so the limit is the installer's to enforce.
- **Every accept names one environment's own flow.** Connection tracking finds a packet's entry by
  its address and port tuple, never by the interface it arrived on. So a reply is accepted only
  from the VM's own address and only within a flow whose original destination is that VM
  (`ct original ip daddr`). A guest cannot borrow a host or container flow's state: an ICMP error
  it crafts about such a flow, or a packet it spoofs into one, is dropped. Entering the bridge, a
  packet of the allowed flow must still arrive on the link bridge, so a container elsewhere that
  spoofs app-dev's address into the established session is refused too.
- **`inet` covers IPv4 and IPv6.** The drops name no address family, so a guest's IPv6
  link-local packet to the host is dropped like an IPv4 one. Every accept is IPv4, like the
  endpoint: the clone validator refuses anything but a unicast IPv4 guest address
  (`docs/PREVIEW.md` §12). No IPv6 flow is allowed, so there is no IPv6 accept.
- **The metadata and VM-to-VM rules only attribute probes.** They widen nothing: the `vm_egress`
  drop below them refuses the same packets. A probe whose packets do not meet its own rule is
  inconclusive, not a pass ([§6](#6-what-the-smoke-check-verifies)).
- **Both chains keep policy `accept` on purpose.** They see all of the host's traffic, and
  anything that neither leaves nor enters an environment bridge must reach Docker's and UFW's own
  rules untouched. Every drop is scoped to `envvm-*`.
- **Interface names are matched as strings when a packet arrives** (`iifname`, not `iif`). The
  table therefore loads before Incus or Docker has created the bridges, which is what lets it
  load before the Incus daemon starts ([§4](#4-persistence-across-a-host-and-an-incus-restart)),
  and lets the runbook create every bridge after the table ([§7](#7-operator-runbook)).
- **The source is the link bridge AND the pinned address.** Either alone is weaker. The bridge
  alone admits any container someone attaches to it by hand. The address alone admits whoever
  holds it on another network.

### 2.2 The environment bridge (Incus)

```sh
incus network create envvm-<environment> --project default \
  ipv4.address=<bridge-gateway>/<prefix> ipv4.nat=false ipv4.dhcp=false \
  ipv6.address=none dns.mode=none \
  ipv4.firewall=false ipv6.firewall=false
```

- **In the default project.** The environment's own project has `features.networks=false`
  (`incus-environment.server.ts:497`), so its bridge lives in the default project, and the
  project may use only that bridge (`:518`).
- **One VM per bridge.** The package allows one VM per environment project (`:500`) and restricts
  the project to its own bridge (`:518`). The plan adds the converse: no other instance on that
  bridge, which `--check` enforces. With one guest per bridge, traffic between guests is always
  routed through the host, so it always crosses the `forward` hook. Two guests on one bridge could
  talk at layer 2 past it.
- **No NAT.** Even a forwarding gap would leave a guest with no working return path from the
  internet. **No DHCP or DNS**, so the guest needs no host `INPUT` exception
  (`packages/sandbox/README.md:347-349`).
- **`ipv4.firewall=false` and `ipv6.firewall=false`**: Incus generates no filter rules of its own
  for these bridges, and the guard table is the only filter that names them. This departs from the
  spike, whose measured run had Incus's own rules active
  ([§3](#3-why-one-nftables-table-and-how-it-orders-against-docker-ufw-and-incus), A10).
- **The guest's NIC filters its source.** It carries `security.mac_filtering`,
  `security.ipv4_filtering` and `security.ipv6_filtering` (`incus-environment.server.ts:681-685`).
  Those filters need bridge netfilter support, which the package names as an operator
  precondition (`packages/sandbox/README.md:313-315`). The table's refusals do not rely on them:
  every accept a guest packet can match names the VM's own address as both the source and the
  flow's original destination. The window still records that the filters are in force (A9).
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

In the dev VM overlay, `docker-compose.dev-sandbox-vm.yaml`, where `<dev-app-address>` is the root
input `DEV_SANDBOX_LINK_ADDRESS`:

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
- **`gw_priority` needs a Compose release that supports it.** Docker Engine ≥ 28 is already
  required, but Compose is not pinned. W0 records the Compose version and stops on a release
  without the key, and the validator refuses a render in which app-dev's link network does not
  carry `gw_priority: 1`.
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
- **VM → anywhere.** The guest's seeded default route (`incus-environment.server.ts:733-737`)
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
   whatever order they load in. This holds whether Docker's and UFW's `iptables` runs on its
   nf_tables or its legacy backend, which W0 records. The priority `filter - 10` puts the table
   ahead of their chains only so that its counters see every packet first.
2. **It needs no place in `DOCKER-USER`.** The forwarded metadata block stays first there, as
   `metadata-egress.py --check` requires (`scripts/metadata-egress.py:233-240`). Docker restarts
   rebuild Docker's own chains and never touch this table. A guest's packet to `169.254.169.254`
   is dropped by this table, and would be dropped again by the metadata block, whose rules match
   every forwarded packet without an interface condition (`:198-206`).
3. **The allowed flow still needs every other chain to accept it.** In the `iptables` `FORWARD`
   chain, Docker's own rules accept traffic leaving a non-internal Docker bridge, and accept its
   replies by connection state
   ([Docker packet filtering](https://docs.docker.com/engine/network/firewall-iptables/)). UFW's
   chains come after Docker's and never see the flow. The plan relies on those two Docker rules
   instead of adding an accept of its own. `--check` reads them, read-only, and refuses when they
   are missing; the smoke's positive probe proves the path.

**Two deliberate departures from the spike.** What this plan keeps from the spike is its guard
shape, a priority -10 `input` and `forward` chain per bridge
(`scripts/lib/sandbox_vm.py:660-683`; `docs/deployment/sandbox-vm-spike.md:421`), as one table
with wildcards. That shape passed every isolation check in
[spike run 4](https://github.com/mknw/hames-playground/issues/648#issuecomment-6314943380). Two
things differ from that run, and the window owes the evidence for both
([§9](#9-what-the-plan-relies-on-and-the-window-verifies)):

- **No `DOCKER-USER` or UFW allowances.** The spike added two `DOCKER-USER` accepts below the
  metadata block and one UFW route rule per bridge (`scripts/lib/sandbox_vm.py:684-698`,
  `:710-717`). With the guard table holding every refusal, those rules refuse nothing. Their only
  job was to accept the allowed flow, which Docker's own rules already do (point 3). Leaving them
  out keeps this plan out of `DOCKER-USER` and UFW entirely: no ordering against the metadata
  block, no write to an inbound firewall component, and nothing a Docker restart has to preserve.
  Run 4 had them in place, so the positive path without them is unmeasured (A3).
- **Incus's own bridge filter is off.** Run 4 created its bridges with
  `ipv4.nat=false ipv4.dhcp=false ipv6.address=none dns.mode=none` only
  (`scripts/lib/sandbox_vm.py:657-659`), so Incus's own rules for the bridge were active. This
  plan sets `ipv4.firewall=false` and `ipv6.firewall=false`
  ([§2.2](#22-the-environment-bridge-incus)), so the allowed flow and its replies cross the bridge
  with no Incus filter rules at all (A10).

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
- **Rules in `DOCKER-USER`.** See the first departure above.

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
  through its socket, from `incus-startup.service` (which the spike enabled,
  `docs/deployment/sandbox-vm-spike.md:244`, and W4 checks) or by hand. This is how the metadata
  seed is tied to Docker (`scripts/metadata-egress.py:51-66`;
  `docs/deployment/egress-design.md:204-247`).
- **Fail-closed.** If the guard cannot load and read back its table, the Incus daemon does not
  start, so it starts no environment VM. On a daemon restart, a guest the daemon left running keeps
  the table it already had, because a failed transaction changes nothing. The release app keeps its
  host socket and is unaffected; dev's sandbox is unavailable until the cause is fixed.
- **Incus restart.** Incus manages only its own table, so a daemon restart leaves the guard table
  alone. `PartOf=` still re-runs the guard on every restart, so each restart re-applies the
  reviewed render and reads it back. Re-applying an identical table writes nothing.
- **Docker restart, UFW reload.** Neither writes this table; both manage their own chains through
  `iptables`. No ordering against them exists, and none is needed.
- **No `ExecStop`.** Stopping the unit never removes the table. Removal is the installer's
  `--remove`, which refuses while an environment VM runs
  ([§5](#5-changing-the-rules-install-journal-undo-dead-man)).
- **Never `systemctl restart` or `stop` the guard unit.** Through `RequiredBy=`, stopping it stops
  the Incus daemon. Re-apply with the installer's `--apply`, which is atomic.
- **No mutable checkout runs at boot.** The unit runs a root-owned copy of the reviewed installer
  and reads a root-owned config, as the metadata units do (`scripts/metadata-egress.py:368-394`).
- **Not covered:** a manual `nft flush ruleset`, or a firewall manager started later that flushes
  the ruleset. Either removes this table along with Docker's and UFW's rules, and the unit does not
  watch for it. `--check` and the bootstrap smoke catch it ([§8](#8-failure-modes-and-what-the-operator-does)).

## 5. Changing the rules: install, journal, undo, dead-man

The installer is `scripts/env-vm-guard.py` ([§11](#11-what-has-to-land-before-the-window)). It
follows `scripts/metadata-egress.py`: an
offline render by default, Linux root only for writes, fixed failure labels and bounded
subprocesses. Below, "an environment VM" means any instance attached to an `envvm-*` bridge, not
only the configured ones: every safety check lists them all.

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

- **No change while an environment VM runs.** Replacing the table keeps every connection-tracking
  entry, so a flow the old table admitted, or one that predates the table, would keep flowing
  under the new one. Any `--apply` that would write therefore refuses while an environment VM
  runs; stop the VMs first. A boot never meets one, because no VM runs before the Incus daemon
  starts. The check reads the kernel, any interface enslaved to an `envvm-*` bridge, never the
  Incus CLI: the unit runs while the daemon is down, and the CLI would socket-activate the daemon
  that is waiting on the unit.
- **The render is the source of truth.** A live table that differs from it, for example after a
  hand edit, is replaced on the next plain `--apply`, and the drifted content is kept in the state
  directory for review. Under `--deadman`, a drifted table is refused instead, because the restore
  would put back the previous render rather than what was live, and the undo would not be exact.
  Resolve the drift first, from a separate session. The table name is reserved for the guard, so,
  unlike a shared chain, there is no foreign rule to preserve.
- **Write-ahead journal.** A locked, fsynced journal in a root-only state directory
  (`/var/lib/env-vm-guard/`) records each change **before** it is made: the table's previous
  render (or "absent") and its new one, each persistence file created, each unit enabled, each
  dead-man armed (its id, the arming login session and the arm time) and each one confirmed or
  fired. A killed apply stays reversible. The operator also writes one line per change in the
  host's change journal: the time in UTC, the change, the exact command, its exact undo, and the
  approval it ran under.
- **Exact undo.** `--remove` reverses only journaled entries, newest first. The table is deleted
  only if its live content equals the journaled render, the unit is disabled only if this installer
  enabled it, and files are removed only if they are byte-identical to what it wrote. It **refuses
  while any environment VM is running**: removing the guard under a running guest is the one undo
  that would widen access. The manual equivalent from a console, in this order: stop the VM,
  disable the unit, `nft delete table inet env_vm_guard`. Never `nft flush ruleset`, and never
  restore a saved full ruleset.
- **Dead-man switch.** An operator change runs `--apply --deadman 600`, or
  `--persist --deadman 600`. The installer journals the previous state and the arm, arms a
  transient timer with `systemd-run --on-active=600` that runs the installed copy's
  `--deadman-restore` for that arm id, and only then writes. Unless the operator runs `--confirm`
  **from a new login session** within **10 minutes**, the timer fires the restore. The restore
  force-stops every environment VM, the safe state if the operator has lost access. It then
  restores the table's previous render, or deletes the table if there was none, restores the
  previous persistence state, and journals that it fired. If it cannot confirm that every
  environment VM is stopped, it keeps the current table and journals that it withheld the restore:
  the rules cannot match the public interface, so a lost login is far less likely to come from
  them than an exposed guest would be from removing them. `--confirm` reads the table back first
  and refuses to disarm if the readback differs from the render, so a confirmation cannot approve
  a wrong table.
  - **What counts as a new login.** The arm journals the arming process's logind session id and
    the arm time on the monotonic clock. `--confirm` reads its own session
    (`loginctl show-session self -p Id -p TimestampMonotonic`, the same clock) and refuses unless
    that session is not the arming one and started after the arm time. One SSH connection is one logind session, so a
    second channel multiplexed over the arming connection is the same session and is refused; a
    fresh SSH connection or a console login is a new one and counts. This relies on `sudo`
    keeping the caller in its login session, which the dry-fire verifies (W2, A11).
  - **"The previous ruleset" is the guard table's previous state.** Nothing else is written, so
    nothing else is restored: no Docker chain, no UFW rule, no Incus network. Restoring a whole
    saved ruleset would also undo whatever Docker, UFW or Incus changed in the meantime.
  - **The bound.** Ten minutes covers a fresh login and a readback, a minute or two, with margin,
    and caps an unexpected lockout at that.
  - **A restore that meets the lock waits for it**, for at most 120 s. Every holder it can meet
    while a dead-man is armed (`--check`, `--confirm`) is bounded well below that. Once it holds
    the lock, it re-reads the journal and exits, journaling why, if its arm id was confirmed in
    the meantime, so it never undoes a confirmed change. If the wait ever reaches the limit, it
    notes that it did not run in an append-only log beside the journal, whose lock it cannot
    take, and exits non-zero, and `--check` reports the overdue dead-man.
  - **A reboot while armed.** A transient timer does not survive a reboot. The boot unit's
    `--apply` therefore reads the journal first, and over a dead-man that is armed, unconfirmed
    and unfired it refuses to apply and runs the restore instead. No VM can run before the Incus
    daemon starts, so the restore's every-VM-stopped condition holds. It then exits non-zero, so
    the guard unit fails and the Incus daemon does not start: the environment VMs stay stopped
    until the operator has re-planned. The reboot step (W13) still
    runs only after every change is confirmed, with the console as the fallback.
- **One operator at a time.** Writers (`--install`, `--apply`, `--persist`, `--confirm`,
  `--remove` and the restore) take the installer's lock exclusively, and all but the restore
  refuse at once when it is held. `--check` and `--smoke` take it shared. While a dead-man is
  armed, every writer but `--confirm` and the restore refuses, and so does `--smoke`. Docker, UFW
  and Incus lifecycle changes wait during a change.

## 6. What the smoke check verifies

`--smoke` runs as root on the host. It runs `--check` first, then every probe below, and writes
one result record.

**What `--check` reads.** It is read-only, and every smoke and the bootstrap smoke run it. Besides
the readback, Docker's two forward rules (§3), the link network's sole member and address, and
subnet overlaps, it reads through the Incus API, for each configured environment, the project's
`restricted.networks.access` and its instance's `devices.eth0.network` and `ipv4.address`. It
refuses unless they equal `envvm-<environment>` and the rendered VM address. It also refuses any
instance in a `sandbox-*` project whose NIC is not on an `envvm-*` bridge, and a guard config that
differs from the entry point's config (the file W8 names) in environment, bridge or address. The
entry point accepts any bridge name (`incus-environment.server.ts:264`; its README's example is
`previewbr`, `packages/sandbox/README.md:258`), and its config is a separate file. Without these
reads, a VM could sit wholly outside the table while every check stayed green. That file must
therefore exist from the first `--check` (W3) on; a missing or unreadable one is refused.

**How a probe runs.**

- **Guest-side probes** run inside the VM through the Incus agent, so no network path is used to
  reach the guest. They use the guest's own `python3`
  (`packages/sandbox/scripts/vm-image/build.py:23`). After W9 the guest has run workload code as
  root, so what the guest reports is never the evidence on its own: the host-side attribution
  below is.
- **App-side probes** run either inside app-dev with `docker exec`, or as throwaway containers from
  the already-local app image, as the metadata smoke does (`scripts/metadata-egress.py:276-300`):
  `--pull never`, every capability dropped, read-only, an unprivileged user. No container gains a
  capability. Probe 4b needs a raw SYN, which the app image cannot send: its runtime stage has no
  raw-socket tool (`app/Dockerfile:15`, `:172`), and Node opens no raw socket. Its throwaway only
  sleeps on `app-network`; the host's `python3 -I` enters that container's network namespace
  (`nsenter --net=/proc/<pid>/ns/net`) and sends the SYN, which leaves through the container's
  veth. The record says so.
- **The stand-in for app-dev** (W9) bind-mounts the three delivered TLS files read-only and runs
  as their owner's uid, with every capability dropped. The client key is delivered mode 0600 to
  its owner (`docs/PREVIEW.md:1330`); it is never copied and its mode is never widened. The
  record holds no file content.
- **Bounds.** Each connect times out after 5 s. Each probe is preceded by a quiet baseline of the
  same length. The whole smoke is bounded at 300 s, half the dead-man bound, and fails past it.

**A refusal passes only if all of these hold:**

1. the TCP connect **times out**, or for a datagram, nothing is delivered;
2. every packet the probe sent is traced on the host to its own named rule's drop. Each probe
   uses a fixed, unique source port (the ICMP probe: its type), and the smoke traces that tuple
   alone with `nft monitor trace`. The trace flag is set by a temporary table of the smoke's own,
   `inet env_vm_guard_trace`, which accepts and drops nothing, is deleted when the smoke ends,
   also on failure, and makes `--check` refuse while it exists. The guard table is never edited
   by the smoke;
3. the named counter did not move during the quiet baseline, and rose during the probe by exactly
   the number of packets traced to it. The guest's background traffic (IPv6 neighbour discovery,
   for one) can move a counter, so a noisy baseline makes the probe inconclusive, never a pass.

Probe 8c is the one exception to 2 and 3: the NIC filter may drop its packet on the bridge before
it reaches the table (A9), so it passes on non-delivery alone, and the record says which filter
dropped it.

A reset (`ECONNREFUSED`) proves the packet arrived: it is a failure, not a refusal. A local error
such as "no route" is inconclusive. Anything inconclusive fails the smoke. A connect that
succeeds where a refusal is expected stops the window ([§8](#8-failure-modes-and-what-the-operator-does)).

| #   | Probe                                                                                                                                                                                                                                                                 | Expected                           | Counter                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------ |
| 1   | app-dev → its own VM:2376, with the app's own `SANDBOX_DOCKER_*` settings and the image's Docker CLI (`app/Dockerfile:180`)                                                                                                                                           | the daemon answers, mutual TLS     | `app_to_vm_dev`                      |
| 2   | host → VM:2376: the host's Docker CLI with the delivered TLS files (`docker --host tcp://<guest>:2376 --tlsverify … version`), bounded, no registry fetch. The entry point's `health <config.json> --wait 600` stays a runbook step before every smoke (W8, W12, W13) | the daemon answers                 | none                                 |
| 3   | throwaway on the link network with another address → VM:2376                                                                                                                                                                                                          | refused                            | `to_vm_refused`                      |
| 4   | throwaway on `app-network` → VM:2376 (stands for the release app, the gateway and every other service on its ordinary network path; holders of the host Docker socket: §10)                                                                                           | refused                            | `to_vm_refused`                      |
| 4b  | `app-network` → VM:2376, a raw SYN with app-dev's pinned address as its source, sent by the host from a throwaway's network namespace (no capability added)                                                                                                           | refused; `app_to_vm_dev` unchanged | `to_vm_refused`                      |
| 5   | app-dev → its own VM on another port                                                                                                                                                                                                                                  | refused                            | `to_vm_refused`                      |
| 6   | app-dev → another environment's VM:2376, once one exists                                                                                                                                                                                                              | refused                            | `to_vm_refused`                      |
| 7   | **VM → VM:** guest → another environment's guest:2376                                                                                                                                                                                                                 | refused                            | `vm_to_vm`                           |
| 8   | **VM → host:** guest → its bridge gateway and the host's primary address, on a port the host listens on for every address; and the gateway's IPv6 link-local, if it has one                                                                                           | refused                            | `vm_to_host`                         |
| 8b  | **VM → host:** guest → the host, an ICMP error that embeds the tuple of a flow the smoke opens from the host                                                                                                                                                          | refused                            | `vm_to_host`                         |
| 8c  | **VM → host:** guest → a host listener the smoke opens on the bridge gateway, a datagram with a spoofed source address                                                                                                                                                | never delivered                    | `vm_to_host`, or the NIC filter (A9) |
| 9   | **VM → metadata:** guest → `169.254.169.254:80`                                                                                                                                                                                                                       | refused                            | `vm_to_metadata`                     |
| 10  | **VM → internet:** guest → a public address on 443 that the host itself reaches (the positive control)                                                                                                                                                                | refused                            | `vm_egress`                          |
| 11  | VM → containers: guest → app-dev's link address, and a service on `app-network`                                                                                                                                                                                       | refused                            | `vm_egress`                          |
| 12  | persistence: the unit enabled and ordered before the Incus daemon, files byte-identical to the reviewed copies, readback equal to the render, no flushing firewall manager, no dead-man armed                                                                         | pass                               | none                                 |

- **The five required checks** (app-to-VM allowed; VM-to-VM, VM-to-host, VM-to-metadata and
  VM-to-internet refused) are probes 1, 7, 8, 9 and 10. Probes 1 and 3 together also show that the
  `forward` chain sees app-dev's own address rather than the masqueraded one. Probe 4b tests the
  bridge half of the identity, and probes 8b and 8c the reply accepts' binding
  ([§2.1](#21-the-guard-table)).
- **With one environment** (dev, until release moves), probe 7 targets an address in another
  environment's planned subnet. With no second bridge, the packet would leave through the uplink,
  so `vm_egress` counts it, not `vm_to_vm`. That proves nothing leaves the bridge, but not the
  per-pair rule. Per-pair attribution runs once a second environment exists, and the record says
  which kind of run it was.
- **Before app-dev joins the link network**, the stand-in holding the pinned address takes its
  place in probe 1. That is how the window proves the rule before it enables the overlay that
  needs the evidence (step W9).
- **The record** holds the installer's git blob id (`git log --find-object=<id>` names its
  commit; the installed copy has no git), the render's hash, each probe's outcome, trace and
  counter change, which filter dropped probe 8c, and whether it was a single-environment run.
  `DEV_SANDBOX_FIREWALL_EVIDENCE` names it. Bootstrap only requires that file to exist and be
  non-empty (`scripts/bootstrap-vps.sh:517-523`), so the smoke writes it only when every probe
  passes: a failed run can never satisfy that gate.

## 7. Operator runbook

**Before the window**

1. The implementation in [§11](#11-what-has-to-land-before-the-window) is merged after its own
   reviews. The operator entry point
   ([#732](https://github.com/mknw/hames-playground/pull/732), merged) is
   `packages/sandbox/scripts/incus-environment.ts`, run as in `docs/PREVIEW.md` §12 step 1:
   `corepack pnpm dlx tsx@4.21.0 packages/sandbox/scripts/incus-environment.ts reconcile|health|teardown <config.json>`.
2. Incus is installed persistently, with its API listening on loopback only, a storage pool, the
   manager credential, and the pinned VM image available from its image server. That is a
   prerequisite with its own reviewed plan ([§11](#11-what-has-to-land-before-the-window) item 4),
   not part of this one.
3. The deployment's values are chosen in its private notes, and stay there
   ([ADR-0008](../adr/0008-deployment-guidance-is-provider-neutral.md)): each environment's name
   (at most 8 characters), the environment address block, each bridge's gateway and guest address,
   the link subnet and app-dev's address. None may overlap a host route or Docker's address pools.
4. The owner has given the GO and the window is announced. A console session to the host is
   confirmed to work. An SSH session separate from the one doing the work stays open throughout.

**In the window.** Stop at the first failure. Each step that changes something gets its journal
line and its undo before it runs. The guard is loaded and persisted before any bridge exists, so
no bridge is ever unguarded.

| Step | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Undo                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| W0   | Read-only survey, with private snapshots for diffing only, never replayed: `nft list tables`, `iptables-save`, `ip6tables-save`, `iptables --version` (nf_tables or legacy), `ufw status verbose`, `ip -j route`, `ip -j addr`, `docker compose version`, the host's vsock listeners and packet sockets (`ss -l -p --vsock`, `ss -a -p --packet`), the Incus daemon's units, `nftables.service`, each container's id, start time and health, and an `sshd -T` digest. **Stop** if a firewall manager that flushes the ruleset is enabled, a planned subnet overlaps a route, `FORWARD`'s first rule is not `-j DOCKER-USER`, Docker's firewall backend is not iptables, the Compose release does not support `gw_priority`, or a packet socket is bound to all interfaces. | none                                                 |
| W1   | `--install`: copy the installer and its config to their root-owned places, journaled. From here on, every step runs that copy, never the checkout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `--remove`                                           |
| W2   | Dry-fire the dead-man twice on a no-op, `--deadman 60` alone, armed for 60 s each time. First, a `--confirm` from the arming session is refused, and one from a fresh login disarms it. Then, left unconfirmed, it fires and journals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                                 |
| W3   | `--apply --deadman 600`, before any bridge exists. From a fresh login: `--check`, then `--confirm`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `--remove`                                           |
| W4   | `--persist --deadman 600`. `systemd-analyze verify` on the unit; the Incus daemon's unit lists the guard in `Requires=` and `After=`; `systemctl show incus-startup.service -p After -p Requires` lists `incus.service`, so the guard precedes the unit that restores VMs. From a fresh login: `--confirm`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `--remove`                                           |
| W5   | Restart the Incus daemon, with no bridge and no VM yet. The guard ran first; the readback is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                 |
| W6   | Create the environment bridge in the default project ([§2.2](#22-the-environment-bridge-incus)). It is guarded from its creation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `incus network delete envvm-<env> --project default` |
| W7   | Create the link network ([§2.3](#23-the-dev-apps-link-network-docker)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `docker network rm envapp-dev`                       |
| W8   | Provision the VM with the entry point, `packages/sandbox/scripts/incus-environment.ts`, run as in `docs/PREVIEW.md` §12 step 1: `reconcile <config.json>`, then `health <config.json> --wait 600`. Then `--check`, which now also reads the VM's project, NIC and address against both configs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the entry point's `teardown <config.json>`           |
| W9   | `--smoke`, with the stand-in for app-dev ([§6](#6-what-the-smoke-check-verifies)). It writes the first evidence record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                 |
| W10  | Enable the overlay as in `docs/PREVIEW.md` §12, steps 3–4, with `DEV_SANDBOX_FIREWALL_EVIDENCE` naming the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | remove the overlay and recreate app-dev              |
| W11  | `--smoke` with the real app-dev. It replaces the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                                 |
| W12  | Restart the Incus daemon with the VM running (it may stop and come back, depending on packaging). Then the entry point's `health <config.json> --wait 600`, and `--smoke`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | none                                                 |
| W13  | If the owner chooses it (question 2 on #740): reboot. Afterwards, the guard finished before the daemon started (journal timestamps), then the entry point's `health <config.json> --wait 600`, `--smoke` and `bootstrap-vps.sh --only smoke`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | none                                                 |
| W14  | Post-checks. Diffed against W0, the only differences are the guard table, the bridge, the link network and Docker's own rules for it, and the installer's files and unit. UFW, `DOCKER-USER`, the metadata units, `sshd -T` and the release containers are unchanged (start times aside, after a reboot). A fresh SSH login works.                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                 |

**Rollback**, the reverse of the creation order, so that no bridge outlives the guard: remove the
overlay and recreate app-dev; the entry point's `teardown <config.json>`;
`docker network rm envapp-dev`; `incus network delete envvm-<env> --project default`; `--remove`.
Each step is exact and refuses on state it does not own.

## 8. Failure modes and what the operator does

| Symptom                                                                                                                               | Likely cause                                                                                                                                   | What the operator does                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Incus daemon does not start; the guard unit failed                                                                                | config unreadable or unsafe; `nft` refused the render; the readback differed; a change refused because an environment VM runs                  | `journalctl -u env-vm-guard.service` names the cause. Fix it, then start the Incus daemon. Never mask or disable the guard to get Incus up. Release is unaffected.                |
| Probe 1 fails while every refusal passes                                                                                              | Docker's accept for the link bridge is missing (A3); app-dev is not on the link network or not routed through it; the guest's Docker is not up | `--check` names the missing precondition, and `health <config.json> --wait 600` checks the guest. Recreate app-dev if needed. Never add a broad accept.                           |
| A refusal probe connects, or answers with a reset                                                                                     | the guard is not doing its job                                                                                                                 | Stop the VM at once (`incus stop --force`), keep the overlay off, keep the record, stop the window and escalate. No fixing forward inside the window.                             |
| A refusal times out but its packets are not traced to its rule, or its counter moves by another amount                                | the packet never reached the rule (a wrong name, bridge or route), or another source moved the counter                                         | Treat it as a failure, and investigate before claiming any isolation.                                                                                                             |
| `--check` reports the table missing or changed                                                                                        | a flush, a firewall manager that flushes, a hand edit                                                                                          | Stop the environment VMs, `--apply`, `--check`, start the VMs, `--smoke`. Then find what flushed: if Docker's and UFW's rules went too, that is a host incident beyond this plan. |
| `--check` refuses: a VM's project, NIC bridge or address differs from the guard's config                                              | the guard's and the entry point's configs disagree, or a manual change to the instance                                                         | Stop the VM. Correct the config that is wrong, through a reviewed change, then `--check` and `--smoke`. Never widen the guard to match a VM.                                      |
| The dead-man fired                                                                                                                    | no confirmation from a new login session within 10 minutes                                                                                     | The environment VMs are stopped and the previous table is back. Log in (by console if needed), read both journals and re-plan. Never re-run the same change unexamined.           |
| After a reboot, the guard unit failed, the Incus daemon did not start, the environment VMs are stopped and the previous table is back | a dead-man was armed and unconfirmed when the host went down, so the boot `--apply` ran the restore and exited non-zero                        | As for a fired dead-man. Start the Incus daemon only after re-planning.                                                                                                           |
| SSH lost after a change                                                                                                               | should be impossible: no rule matches the public interface                                                                                     | Wait for the dead-man, at most 10 minutes. If it did not fire, from the console: stop the VMs, disable the unit, `nft delete table inet env_vm_guard`.                            |
| A writer refuses: lock held, or a dead-man armed                                                                                      | another run is in progress, or a change awaits its confirmation                                                                                | Wait for it, confirm it from a new login session, or resolve it from the console. Never delete the lock or the journal.                                                           |
| `--check` refuses: a second instance on a bridge, another member on the link network, an address drift                                | a manual attachment or a Compose edit                                                                                                          | Detach or revert. The validator and `check-vps.py --clones` should have refused it first, so find out why they did not.                                                           |

## 9. What the plan relies on and the window verifies

These are upstream behaviours. The repository cannot pin them, so the window records evidence for
each one.

| Ref | Assumption                                                                                                                                                    | Evidence in the window                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A1  | A `drop` in any base chain is final; an accept in another chain cannot override it                                                                            | probes 3 and 4 refuse flows that Docker's own rules accept                                   |
| A2  | `iifname` wildcards match by name when a packet arrives                                                                                                       | the table loads before the bridges exist (W3); the probes pass after (W9)                    |
| A3  | Docker accepts traffic leaving a non-internal bridge, and its replies                                                                                         | `--check` reads both rules; probe 1                                                          |
| A4  | Incus writes only its own table                                                                                                                               | the W0 and W14 diffs of `nft list tables` and of Incus's own table                           |
| A5  | The Incus daemon restores each VM's last power state when it starts                                                                                           | W12, W13                                                                                     |
| A6  | `RequiredBy=`, `Before=` and `PartOf=` order the guard before every daemon start                                                                              | `systemd-analyze verify`; journal timestamps in W5, W12 and W13                              |
| A7  | Docker masquerades app-dev's traffic at post-routing, after the guard's `forward` chain                                                                       | probes 1 and 3 together                                                                      |
| A8  | Docker and UFW write only their own chains, through `iptables` on the backend W0 records, never this table                                                    | W13: after a reboot, Docker and UFW have loaded and the readback is unchanged                |
| A9  | The guest NIC's IPv4 and IPv6 anti-spoofing is in force                                                                                                       | the persistent Incus install plan's own check; probe 8c                                      |
| A10 | With `ipv4.firewall=false` and `ipv6.firewall=false`, Incus writes no filter rules for the bridge, and the allowed flow and its replies cross it without them | the W0 and W14 diffs of Incus's own table; probes 1 and 3, with Incus's rules absent         |
| A11 | `sudo` keeps the caller in its logind session, and a channel multiplexed over an SSH connection is in that connection's session                               | W2: a `--confirm` from the arming session is refused, and one from a fresh login is accepted |

## 10. Deliberately left out

- **SSH, `sshd`, `authorized_keys`, UFW's rules and port 22.** Untouched; see the status note.
- **Host-originated traffic into a VM.** Not filtered. Any process in the host's network namespace
  reaches the Docker port, whatever its uid, and the daemon's mutual TLS refuses every one that
  cannot present the delivered client key, which is mode 0600 and readable by its owner only
  (`docs/PREVIEW.md:1330`). The operator's `health` probe uses this path. No Compose service
  shares the host's network namespace: the only non-default network mode is `none`
  (`docker-compose.yaml:99`). The exception is a holder of the host's Docker socket, which is
  root-equivalent (`docs/deployment/egress-design.md:27-30`): the release app and the MCP gateway
  hold it (`docker-compose.yaml:366`, `:132`), and either can start a container in the host's
  network namespace and read the delivered key. Owner question 4 on
  [#740](https://github.com/mknw/hames-playground/pull/740) asks whether to narrow this path
  anyway.
- **Traffic that is not IP.** The table filters IP only. Three paths stay outside every `inet`
  hook: the Incus agent's vsock channel to the daemon, whose guest API also exposes the instance's
  `cloud-init.user-data` (`packages/sandbox/README.md:322-324`); ARP, which by default the host
  answers for all its addresses on any interface; and host packet sockets bound to all
  interfaces, which see a guest's frames before netfilter. W0 records the host's vsock listeners
  and packet sockets, and stops on a packet socket bound to all interfaces.
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

## 11. What has to land before the window

1. **The installer**, `scripts/env-vm-guard.py`, with modes `render` (default, offline), `--check`,
   `--install`, `--apply [--deadman N]`, `--persist [--deadman N]`, `--confirm`, `--remove`,
   `--deadman-restore` and `--smoke`. Its test, `scripts/env-vm-guard.test.py`, uses offline fakes
   for `nft`, `systemctl`, `loginctl`, `incus` and `docker` and a mutation runner, as
   `scripts/metadata-egress.test.py` does. Each pin is verified by a mutation that turns it red.
   At least:
   - a drop removed or narrowed (the wildcard reduced to one bridge); the allow widened (its
     address, bridge or port dropped); the replies' accept moved below the drops; a reply accept
     that loses its `ct original` binding or its source address;
   - an environment name longer than 8 characters accepted;
   - an apply that writes when the table is equal; the replacement split across two transactions;
     the readback skipped; an apply that writes while an environment VM runs; a `--deadman` apply
     over a drifted table; a safety check that lists only the configured VMs;
   - `--check` passing with the VM's NIC on a bridge not named `envvm-*`, or with the guard's and
     the entry point's configs disagreeing;
   - the dead-man armed after the write; a confirmation without a readback; a `--confirm` from the
     arming session, or from a session started before the arm, accepted; a restore that touches
     anything but the guard table;
   - a restore that refuses on a held lock instead of waiting; a restore that runs after its arm
     id was confirmed; a boot `--apply` over an armed, unconfirmed and unfired dead-man;
   - a removal while a VM runs; a removal of an edited file;
   - the unit losing `Before=`, `RequiredBy=` or `PartOf=`, or gaining an `ExecStop`;
   - a smoke that accepts a timeout without its counter rise, a counter rise that cannot be traced
     to the probe's tuple, `ECONNREFUSED` or a local error as a refusal, or a run past its bound;
     a stand-in that copies the client key or widens its mode.
2. **The dev overlay, the validator and `check-vps.py --clones`**, as in
   [§2.3](#23-the-dev-apps-link-network-docker), with the validator refusing a render without
   `gw_priority: 1`. In the same PR as the installer: update `docs/PREVIEW.md` §12 to the link
   network as the one allowed source (step 1's proof, the evidence wording in step 2, and "What
   this does not establish"), the matching comment in `scripts/bootstrap-vps.sh:517-519`, and
   the Scripts line in `docs/INDEX.md` for `scripts/env-vm-guard.py`.
3. **The bootstrap smoke**: with the VM overlay selected, `--only smoke` runs the guard's
   `--check`.
4. **The persistent Incus install**, as its own reviewed plan (owner question 3 on
   [#740](https://github.com/mknw/hames-playground/pull/740)), run first in the same window. It
   carries A9 and records which firewall driver Incus selected.
