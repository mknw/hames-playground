# Persistent Incus install — plan for the environment VMs

> **Plan, not built.** Owner question 3 on [#740](https://github.com/mknw/hames-playground/pull/740) accepted this
> as its own short reviewed host plan ([§11 item 4](env-vm-network.md#11-what-has-to-land-before-the-window)
> of the network plan), run first in the same window. It installs Incus persistently and
> prepares everything the network plan's steps need; it touches no network policy itself.

## The plan in one screen

Incus 7.3+ is installed **persistently** from its maintainers' upstream apt repository, pinned
and signature-verified, together with a dedicated storage pool, an API listener that only ever
binds the loopback address, the manager credential in its reviewed place, and the pinned signed
VM image made available to the daemon. It is the prerequisite the network plan's operator
runbook needs before its first step, and it is run first in the same window.

Everything is installed with an idempotent command, a journal line, an exact undo, a
verification after, and a dead-man switch where a step can cut access. **No SSH, `sshd`,
`ufw` inbound rule, `authorized_keys` entry or port 22 change is part of this plan**: any such
need is an escalation before a change, never a step.

The packages and their pin are the ones merged in
[#719](https://github.com/mknw/hames-playground/pull/719) and exercised by spike run 4
([#648](https://github.com/mknw/hames-playground/issues/648)), and the VM image is the pinned
signed one from [#718](https://github.com/mknw/hames-playground/pull/718). The private
companion file in the `pm-server` worktree (`ops-run4-plan.local.md`,
`ops-b-build-plan.local.md`, `ops-q9-network-window.local.md`) holds the instance values and
the exact commands; nothing from it is copied here.

## 1. Packages and their pinned source

Incus 7.3 or later, from the upstream repository, pinned so that no other package the host may
have can slip in:

- **Source pin** (`scripts/lib/sandbox_vm.py source`, from #719, exercised on the host in
  run 4): the maintainers' armored key is parsed in pure Python and its primary-key
  fingerprints must equal exactly the pinned one. One armor block only, v4 only, truncated or
  partial packets refused. Three files are written, exclusive-create, 0644:
  the keyring; a deb822 source for the host codename with `Signed-By`; and an apt preferences
  file that admits **only** `incus`, `incus-base` and `incus-client` from that origin and pins
  everything else it publishes to **-1**. Each file's SHA-256 is recorded privately, then only
  that source's index is refreshed.
- **Version gate**: `--incus-version` must be an exact upstream version at 7.3 or later.
  Before simulating, `apt-cache madison` must list that version for all three packages and
  **only** from the pinned URI. A version also offered elsewhere, a lookalike path, plain http,
  a missing package or an expired build is refused with no apt mutation. `incus-base` is pinned
  explicitly in simulate, download and install.
- **Post-install gate**: after `waitready`, `GET /1.0` must list both API extensions the
  environment VMs' restricted project needs (`projects_restricted_virtual_machines_nesting`,
  Incus 7.3; `projects_restricted_storage_pool_access`), or the step fails into rollback.
- **Bundled tooling**: the upstream package bundles QEMU, OVMF and virtiofsd under
  `/opt/incus`, so the distro QEMU-module pins that the distribution's 6.0.x needed are
  removed.

## 2. Storage pool

A dedicated Incus storage pool holds each environment VM's root disk. Incus 7 counts the
imported image volume toward `limits.disk`, so the pool's cap must hold **both VM disks plus
the imported image**; the preflight refuses an insufficient cap. The pool's backend, name and
size are instance values in the private companion file, not here.

## 3. The API on loopback only

The daemon's HTTPS listener binds the loopback address only — never a non-loopback address —
and the daemon's own firewall table stays the daemon's. The environment bridge the network plan
creates is the only path to a VM's guest Docker port, and it is guarded from its creation
([§8](#8-guard-before-incus-ordering)). No port is published and no UFW rule is touched.

## 4. The manager credential

The manager credential (the daemon's client certificate/key and its CA) is the secret the
operator entry point uses to reach the API, and the daemon's own firewall driver uses to reach
the guest agent. It lives in the reviewed place: root-owned, mode 0600, read by the operator
entry point and by the guard's `--check`, never by any process that is not explicitly granted.
Its path, owner and mode are instance values in the private companion file; nothing in this
plan hardcodes one.

## 5. The pinned signed VM image

The pinned signed VM image from [#718](https://github.com/mknw/hames-playground/pull/718) is
made available to the daemon locally, so no image fetch happens at provisioning time: the
image's fingerprint is pinned (the `sha256` of its metadata and disk), and the manager
credential's config names it. Whether it arrives through a local image server or a direct local
import is a private choice, not a property of this plan — but the image is verified against the
pin either way, and the provisioning step refuses an image that does not match.

## 6. A9: the firewall driver Incus selected

Network plan assumption [A9](env-vm-network.md#9-what-the-plan-relies-on-and-the-window-verifies)
is that the guest NIC's IPv4 and IPv6 anti-spoofing is in force. That is a property of the
bridge netfilter support the daemon's own firewall driver supplies. This plan records, in its
evidence record, which firewall driver Incus selected (its `nftables` vs `xtables` driver) and
confirms the guest NIC's anti-spoofing is in force with it. If Incus selected `nftables`, the
network plan's own table and the daemon's own rules coexist; if `xtables`, the same holds
through the compat layer. The recorded driver is an evidence value in the private companion
file, and the network plan's smoke check is the one that proves the flows.

## 7. Guard-before-Incus ordering

The network plan's guard must be loaded and persisted **before any bridge exists**, so no
bridge is ever unguarded. Within this plan's own window, the exact order is:

1. **Guard** (network plan W1–W5): the guard's installer, config, apply, persistence and
   restart are done first — before any `incus network` command. The guard's unit precedes the
   daemon's, so a daemon restart always reloads the table before the daemon's own driver can
   write anything.
2. **Incus packages** (this plan): the upstream source, the version gate, the install, the API
   listener and the manager credential are laid down under the guard's protection.
3. **Storage pool and image** (this plan): the pool is created and the pinned image imported;
   the preflight refuses an insufficient cap.
4. **Bridges and VMs** (network plan W6–W14): the environment bridge is created only after
   both the guard and the daemon are in place, and is guarded from its creation.

## 8. Operator runbook

Every step is idempotent, journaled, reversible, and verified after. The journal line format
and the dead-man rules are the network plan's
([§5](env-vm-network.md#5-changing-the-rules-install-journal-undo-dead-man) and its
[runbook](env-vm-network.md#7-operator-runbook)); this plan inherits them rather than inventing
its own.

| Step | Action | Undo | Dead-man | Verification | Failure modes |
| --- | --- | --- | --- | --- | --- |
| S1  | Upstream Incus source: `scripts/lib/sandbox_vm.py source --apply --key <armored key>` (fingerprint refused unless exact). Writes three 0644 files, exclusive-create, hashes each, refreshes only that source's index. | `source --remove` (refuses while an Incus package is installed; verifies every file's hash before deleting any; a missing file is already removed). | not needed (no access can be cut) | each file's hash re-checked; `apt-cache policy` lists the three packages only from the pinned URI | foreign key refused; an existing source refused; an expired build refused; a missing package refused with no apt mutation |
| S2  | Incus packages: `sandbox_vm.py install --incus-version <exact version>`. Preflight refuses anything but 7.3+ offered only by the pinned URI; `apt-get --simulate` must show 0 upgraded, 0 removed, no conffile prompt; every `Inst` reviewed into `--allow-package`. | automatic rollback on any failure; journal records the exact undo | yes: armed before the install, fires if no fresh login confirms within its bound; the rollback restores the pre-install package state | `waitready`, then `GET /1.0` lists both API extensions, or the step fails into rollback; the daemon's unit file lists the guard in `Requires=` and `After=` | a version also offered elsewhere refused; a lookalike path refused; plain http refused; a missing package refused; the API-extension gate fails the install into rollback; a dead-man fire rolls the package state back |
| S3  | Storage pool: create the pool with the reviewed cap; preflight refuses a cap that cannot hold both VM disks plus the imported image (Incus 7 counts the image volume). | delete the pool (only with no instance attached) | not needed | `incus storage show` matches the reviewed values; the preflight's cap arithmetic is in the journal | insufficient cap refused; a pool name that collides refused |
| S4  | API on loopback only: the daemon's listener binds the loopback address; the manager credential is laid down root-owned, 0600, in its reviewed place. | restore the previous listener state and credential | not needed | `incus config show` and `ss -ltnp` show the listener on loopback only; the credential's mode and owner are as reviewed | a listener on a non-loopback address refused; a credential with the wrong mode or owner refused |
| S5  | Pinned VM image: import the pinned signed image (or name it from the local server) and record its fingerprint. The provisioning step refuses an image that does not match. | remove the image (only with no instance attached) | not needed | the recorded fingerprint equals the pin; the daemon lists the image | a fingerprint mismatch refused; a truncated or partial import refused |
| S6  | Post-checks: diff the whole host package set, the daemon's units, the pool, the listener and the credential against the pre-window snapshot. Only this plan's own entries differ. | n/a | not needed | the diff is empty apart from the entries above | any other difference stops the window |

## 9. Host-package hygiene, as measured in run 4

Run 4's post-checks measured the host package state the plan leaves behind:

- **Apt sources**: the upstream source's three files are removed by `source --remove` as part
  of the same rollback grammar, once the daemon no longer needs them — **added then removed**,
  never left behind.
- **Sysctls**: none are added by this plan. The guest's `cgroup2` mounting and `machine-id`
  handling are properties of the pinned VM image (#718) and the guest's cloud-init, not of the
  host's sysctls; nothing here touches `/etc/sysctl.d` or `/etc/sysctl.conf`.
- **Residue**: the upstream package bundles QEMU, OVMF and virtiofsd under `/opt/incus`, so no
  distro QEMU-module pins are left behind. Any residue the daemon's own packages leave is
  recorded in the journal with its undo.

## 10. Deliberately left out

- **SSH, `sshd`, `authorized_keys`, UFW's inbound rules and port 22.** Untouched; see the
  network plan's status note. Any such need is an escalation before a change, never a step.
- **The network plan's guard table, bridges and smoke checks.** Installed and run by the
  network plan's own steps; this plan only lays the daemon down under them.
- **Instance values.** The pool's backend, name and size; the API listener's exact address;
  the credential's path, owner and mode; the image's fingerprint; the firewall driver Incus
  selected; the exact commands. All of these are instance values in the private companion file
  in the `pm-server` worktree, not here.
- **Docker's daemon, containers or networks.** Never started, stopped, recreated or
  reconfigured; the Docker side is the network plan's link-network step, not this plan's.
- **Any provisioning run.** This plan prepares the daemon; the entry point's `reconcile` and
  `health` are the network plan's W8 step, not this plan's.
