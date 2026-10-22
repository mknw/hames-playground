# Persistent Incus install (plan)

> **Status: plan only, not built or run.** It is item 4 of the network plan's
> [§11](env-vm-network.md#11-what-has-to-land-before-the-window). The owner answered question 3 on
> [#740](https://github.com/mknw/hames-playground/pull/740) with (a), its own short reviewed host
> plan, run first in the same window
> ([answer](https://github.com/mknw/hames-playground/pull/740#issuecomment-6342211593)). The window
> needs the owner's explicit GO, the answers to this plan's questions and
> [§1](#1-what-has-to-land-before-the-window). SD-19, SD-20, SD-22. **No SSH, `sshd`,
> `authorized_keys`, UFW inbound rule or port 22 change is part of it**: needing one is an
> escalation to the owner **before** the change.

## The plan in one screen

- **What it leaves behind.** Incus 7.3 or later from the maintainers' upstream apt repository,
  installed persistently and **held**. Its pinned source stays, because it is the only upgrade path
  for the hypervisor the package bundles ([§11](#11-upgrades-the-patch-path-for-the-bundled-hypervisor)).
  The daemon runs with fresh state, one storage pool, one HTTPS listener on a loopback address, and
  one trusted client certificate, the manager credential. It has **no network, no instance, no
  image and no project** beyond `default` when this plan ends.
- **What it cannot finish today.** The merged entry point pulls its VM image from an HTTPS
  simplestreams server on port 443 (`packages/sandbox/incus-environment.server.ts:693-702`), and
  no such server exists. How the image reaches Incus is owner question 2, and every answer needs
  work that is not merged ([§1](#1-what-has-to-land-before-the-window),
  [§7](#7-the-vm-image)). The image carries **no signature**: its identity is its pinned Incus
  fingerprint.
- **Where it sits in the window.** Steps I0–I12 run before the network plan's W0. The network
  plan's guard does not exist yet, so the one invariant is that **no managed network and no
  instance exists until the guard is loaded and persisted** (W3, W4). The guard matches bridges
  by name, so it does not need the daemon stopped ([§9](#9-the-runbook)).
- **Every management path is counted.** One loopback TCP listener, the root-only unix socket,
  and nothing else: no other `*_address` key, no trust token, no OIDC, no member of `incus` or
  `incus-admin`, and `incus-user.socket` masked ([§4](#4-management-paths-one-loopback-listener-and-nothing-else)).
- **Every change** is journaled before it runs, with its exact undo. Every check names the
  command, the expected result and the rehearsal change that turns it red
  ([§10](#10-checks-expected-results-and-what-turns-each-red)).

## 1. What has to land before the window

1. **The owner's answers** to this plan's six questions, in the PR that adds it
   ([#743](https://github.com/mknw/hames-playground/pull/743)). Question 5 includes the approval of
   a **persistent** third-party apt trust root. The upstream source was approved for the spike, and
   run 4 removed it again; a persistent install keeps it, and that approval is not on the record.
2. **The image delivery the answer to question 2 needs.** Nothing merged can satisfy the entry
   point today ([§7](#7-the-vm-image)). With the recommended answer, that is a package PR:
   - **Scope.** The entry point's `image` option gains a local-files form: the two files and the
     pinned fingerprint. Before it creates the VM, `reconcile` uploads both files into the
     environment's own project with the project-restricted certificate. It refuses, and creates no
     instance, unless the fingerprint Incus computes equals the pin. It then creates the instance
     from that local image with no remote server. That PR decides what
     `restricted.images.servers` names when no server is used. Teardown keeps deleting the image.
   - **Pins, each with the mutation that turns it red:** an upload with one byte of the disk
     altered is refused and leaves no instance; a create that names a remote server; the
     fingerprint comparison removed; an upload with the manager credential instead of the
     restricted one.
3. **The network plan's own §11 items 1–3** (the installer, the overlay and validator, the
   bootstrap smoke). This plan's steps do not need them; the network plan's W-steps do.
4. **The rehearsal record.** Every check in [§10](#10-checks-expected-results-and-what-turns-each-red)
   marked "rehearsal" is turned red once, on a disposable machine, **never the target host**, and
   the record is attached to the review of this plan's GO.
5. **One sentence in `docs/PREVIEW.md` §12 step 1**, with the answer to question 1: who runs the
   entry point. With the recommended answer it runs as root, and step 1 shows it without `sudo`.
   That line belongs in the network plan's §11 item 2 PR, which already edits that section.
6. **The deployment's values**, chosen in its private notes and kept there
   ([ADR-0008](../adr/0008-deployment-guidance-is-provider-neutral.md)): the exact package
   versions, the pool's name, driver and source, the listener port, the four directories in
   [§9](#9-the-runbook), the credential's name and lifetime, and the reviewed dependency list.

## 2. Packages, source and the persistent end state

**The source** is `scripts/lib/sandbox_vm.py source`, merged in
[#719](https://github.com/mknw/hames-playground/pull/719) and used by spike run 4
([#648](https://github.com/mknw/hames-playground/issues/648#issuecomment-6314943380)). The
maintainers' armored key is parsed in pure Python, and its primary-key fingerprints must equal
exactly the pinned one (`sandbox_vm.py:39`, `:254`). One armor block, v4 only, and a secret-key,
compressed, partial or truncated packet is refused (`:183-221`). It writes three files,
exclusive-create, 0644 (`:271-279`): the keyring, a deb822 source for the host's codename with
`Signed-By`, and a preferences file that admits **only** `incus`, `incus-base` and
`incus-client` from that origin and pins everything else it publishes to -1 (`:224-231`). It
records each file's SHA-256 under `.sandbox-vm-spike/` beside the script (`:29`, `:237`) and
refreshes only that source's index. **It is run from a root-owned copy of the reviewed commit**
(step I1), so that record lives outside every checkout.

**The version** is exact, in the shape `1:<major>.<minor>[.<patch>]-<ubuntu|debian><release>-<12-digit build>`,
at 7.3 or later (`sandbox_vm.py:177-180`). `apt-cache madison` must list it for all three packages,
and only from the pinned URI. The repository keeps only recent builds, so an older pin fails at
that check (`docs/deployment/sandbox-vm-spike.md:258-261`), and the plan keeps the downloaded
`.deb` files for a reinstall.

**`dnsmasq-base` is installed too**, pinned. Incus checks its executable during bridge setup even
with DHCP and DNS off (`sandbox-vm-spike.md:167`). If it is already installed, its installed
version is the pin, because any other value is an upgrade or a downgrade.

**The merged install step is spike-only.** `sandbox_vm.py` has the modes `survey`, `source`,
`spike` and `rollback` (`:874`). Its `--install` step needs `--provision` too, a detached
`sbxs-run-*` launcher, an SSH witness, a non-root KVM user, two bridge subnets and local image
files (`:951-1010`). It creates bridges, nft tables and `DOCKER-USER` rules (`:651-699`), refuses
a pre-existing Incus (`:965-966`), and its rollback removes the packages (`:595-600`). This plan
therefore runs the same gates as exact commands, with expected results
([§9](#9-the-runbook), step I5), and does not call that step.

**What the package does to the host**, from `sandbox-vm-spike.md:228-250`. All of it stays,
except as question 5 decides:

| Change                                                                                                                   | Before        | Undo, in a full removal ([§12](#12-undo-and-how-it-composes-with-the-network-plans-rollback))       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| `/usr/lib/sysctl.d/50-incus.conf`: ten sysctls (`PACKAGE_SYSCTLS` in `sandbox_vm.py:47-51`)                              | recorded (I0) | removal deletes the file; `sysctl -w <key>=<before>` for each, because the values stay until reboot |
| the same file: `kernel.apparmor_restrict_unprivileged_unconfined=0`, which relaxes Ubuntu's host-wide userns restriction | recorded (I0) | as above; with question 5 (a) the relaxation is never in force (I3)                                 |
| subordinate UID and GID ranges for `root` in `/etc/subuid` and `/etc/subgid`                                             | recorded (I0) | delete the added lines                                                                              |
| the `incus` user, the `incus` and `incus-admin` groups                                                                   | recorded (I0) | `userdel incus`, `groupdel incus-admin`, `groupdel incus`, if nothing else uses them                |
| `incus.socket`, `incus-user.socket`, `incus-lxcfs.service`, `incus-startup.service` enabled and started                  | recorded (I0) | stopped by removal; I6 masks `incus-user.socket`, and its undo unmasks it                           |
| the upstream source, its pin and the hold                                                                                | absent        | `apt-mark unhold`, then `source --apply --remove` after the packages are gone                       |

**The bundled hypervisor.** The upstream package bundles QEMU, OVMF and virtiofsd under
`/opt/incus` (`sandbox-vm-spike.md:261-262`). That QEMU is the boundary of every environment VM,
and distribution security updates never reach it. The hold freezes it on purpose, so its only
patch path is the reviewed upgrade in [§11](#11-upgrades-the-patch-path-for-the-bundled-hypervisor).

## 3. Daemon state: start fresh

The spike's runs left Incus daemon state under `/var/lib/incus`, conffiles of a removed
`incus-base`, two empty Incus-created nftables tables and a stale `incus-lxcfs` unit state
([run 4's residue](https://github.com/mknw/hames-playground/issues/648#issuecomment-6314943380)).
Retained state is reused by a reinstall (`sandbox-vm-spike.md:75`), and the postinst starts the
daemon at once (`:243-244`), on whatever that state holds: a server keypair, `core.*` addresses, a
trust store, networks, profiles and projects.

**So the old state is moved aside, not reused** (step I2): the persistent daemon starts with a
fresh server keypair and an empty database. The move is journaled, and its undo moves it back.
The removed package's conffiles are purged after the move, so a maintainer script cannot touch
the moved copy. I7 then audits the fresh state before anything is added.

## 4. Management paths: one loopback listener and nothing else

Every path to the API is root or root-equivalent, so every one is counted:

- **TCP.** `core.https_address` names an explicit loopback address and port, never a bare
  `:<port>`. Every other listener key is unset: `cluster.https_address`, `core.metrics_address`,
  `core.debug_address`, `core.storage_buckets_address`, `core.bgp_address` and `core.dns_address`.
  The trust token list is empty, because a pending token lets any process that reaches the
  listener enrol a client. Every `oidc.*` key is unset.
- **The unix socket.** `/var/lib/incus/unix.socket` gives full control to root and to members of
  `incus-admin`. Both `incus-admin` and `incus` stay without members.
- **The guest-facing path** is the Incus agent's vsock channel to the daemon, which this plan
  does not touch; the network plan's [§10](env-vm-network.md#10-deliberately-left-out) leaves it
  out too.
- **`incus-user.socket`** gives every member of `incus` a project of its own. Nothing in this
  design uses it, so I6 masks it.
- **The residual**, as in the network plan's [§10](env-vm-network.md#10-deliberately-left-out):
  a holder of the host Docker socket (the release app and the MCP gateway) can start a container
  in the host's network namespace and reach the loopback listener, or mount the host filesystem
  and read the manager credential. Such a holder is root-equivalent already. This plan does not
  narrow that path.

## 5. Storage pool

The entry point names one existing pool, `storagePool`, and its project may use only that pool
(`incus-environment.server.ts:519`). The size cap Incus enforces is the project's `limits.disk`,
`quota.diskGiB`, set by the entry point (`:503`), not a pool property. Incus counts the image
volume toward it, beside the root disk (`sandbox-vm-spike.md:380-382`). The entry point only checks
that `rootDiskGiB` is below `diskGiB` (`incus-environment.server.ts:277-278`), and the spike's
arithmetic lives in its private `storage_preflight` (`sandbox_vm.py:915-948`), which no mode
exposes. So I11 checks both by hand, read-only, before creating the pool, from the image staged at I8:

- **The cap**: `rootDiskGiB` plus the image's virtual size is at most `diskGiB` (the one-VM form
  of `sandbox_vm.py:926`).
- **The backing filesystem's free space** is at least `diskGiB` plus twice the virtual size, plus
  the two input files and the metadata's expanded size, plus 2 GiB (the budget of `:946`).

The pool is created explicitly. `incus admin init` is never run with its defaults, because they
create a managed bridge with NAT, DHCP and DNS and attach it to the default profile, outside the
guard. Run 4 measured a `dir` pool (`sandbox_vm.py:638`); another driver is its own reviewed
choice.

## 6. The manager credential

**What it is.** `manager: { url, ca, cert, key }`, three PEM files named by path in the entry
point's operator-private config (`docs/PREVIEW.md` §12 step 1;
`packages/sandbox/scripts/incus-environment.ts:74`, read at `:274-282`). The client certificate
must be trusted with rights to create projects and register certificates
(`incus-environment.server.ts:24`), so it is unrestricted and **root-equivalent on the host**. It
is never sent to the guest (`packages/sandbox/README.md:307`). No firewall driver holds a
credential.

**What I10 does.** It generates the client key and a self-signed client certificate, adds the
certificate to the daemon's trust store, and copies the daemon's own server certificate as
`manager.ca`, which pins it. Node's TLS client checks the URL's host against that certificate's
subject alternative names, so I10 reads them and stops unless they list the loopback address in
`manager.url`. It then authenticates with the same TLS options the entry point uses
(`incus-environment.server.ts:123-133`): the daemon must report the client as trusted.

**Where it lives** is question 1. The recommended answer: a root-only directory outside both
checkouts, every `configs/` directory, `delivery.directory`, the entry point's `stateDirectory`
and `/var/lib/incus`. The entry point then runs as root. Four bind mounts reach containers today:

- `./configs` (`docker-compose.yaml:370`);
- the dev clone's `configs` (`docker-compose.clones.yaml:50`, `docker-compose.dev-sandbox-vm.yaml:19`);
- the delivered TLS files (`docker-compose.dev-sandbox-vm.yaml:20-37`,
  `docker-compose.sandbox-vm.yaml:12-15`), from `delivery.directory`.

I10 checks that no running container's mount source is the credential, its directory or any parent
of it. The environment VMs cannot mount host paths: their project blocks disk devices other than
the root disk (`incus-environment.server.ts:506`), and the instance has no profiles (`:693`).

**What the network plan's `--check` uses.** The network plan says it reads through the Incus API
without naming a credential ([§6](env-vm-network.md#6-what-the-smoke-check-verifies)). This plan
provides none for it: `--check` runs as root on the host, where the daemon's unix socket needs no
TLS credential. Which path the installer takes is its own PR's decision (network plan §11
item 1), with one constraint from here: a check run as root never reads a value from a worktree
file.

## 7. The VM image

**What the entry point needs.** It creates the VM with
`source: { type: 'image', mode: 'pull', protocol: 'simplestreams', server, fingerprint }`
(`incus-environment.server.ts:693-702`). It takes `image: { server, fingerprint }` (`:33`),
refuses a server with any port but 443 (`:259-261`), and sets `restricted.images.servers` to that
host name (`:520`). The project has its own image namespace (`features.images=true`, `:494`), so
an image imported into the default project by hand is not visible to it. The image pipeline's
README says the same: the transport "still needs an operator-provided image server; this pipeline
does not publish one or add local-file import to that controller"
(`packages/sandbox/scripts/vm-image/README.md:70-72`).

**What each answer to question 2 costs.**

- **An outbound HTTPS image host** on 443, with a publicly trusted certificate, serving only the
  simplestreams tree. No code change, no inbound rule and no new unit on this host. The image
  becomes downloadable by whoever learns the URL, and another party is on the provisioning path.
- **An HTTPS server on this host.** The release proxy already publishes the host's port 443
  (`docker-compose.prod.yaml:185`), and the daemon trusts the system certificate store, so this
  needs a dedicated address, a new unit and a private CA in the host's trust store. That is a new
  network component with its own exposure, outside the guard table, and its own reviewed plan.
- **A local-files source in the entry point** (recommended): the prerequisite PR in
  [§1](#1-what-has-to-land-before-the-window). No network component and no trust-store change, and
  Incus computes the fingerprint of the bytes it was handed.

**No signature exists.** The pipeline checks signatures only on its build inputs
(`vm-image/README.md:10-19`). Its output's identity is the Incus fingerprint, the SHA-256 of
`metadata.tar` followed by `disk.qcow2` (`:27`), recorded in the build's `manifest.json`
(`build.py:283-286`). The control against substitution is that pin, taken from the **reviewed build's
`manifest.json`**, copied root-owned, never from an image server, and compared with the bytes
before they reach Incus.

**What the window can do today**, in step I8: stage the reviewed build's two files and its
manifest root-owned, and check the staged bytes against the pin. The image enters Incus only at
the network plan's W8, through `reconcile`, once question 2's prerequisite has landed. With an
image host instead, I8 checks the files that host serves, by the same command, before W8.

## 8. A9: the firewall driver Incus selected

Network plan assumption [A9](env-vm-network.md#9-what-the-plan-relies-on-and-the-window-verifies)
is that the guest NIC's IPv4 and IPv6 anti-spoofing is in force, and its evidence is "the
persistent Incus install plan's own check; probe 8c". This plan's part is a **read-only record**,
not a proof:

- **What.** The firewall driver the daemon selected, from `GET /1.0`'s `environment.firewall`,
  and whether the host's bridge netfilter support is loaded. The package names that support as an
  operator precondition for the NIC filters (`packages/sandbox/README.md:313-315`).
- **When.** In I12, after the daemon has started, because the driver is chosen at daemon start
  from the firewall tooling the host has loaded. It is read again after the network plan's W5,
  and must not change.
- **What stops the window.** A driver other than `nftables`, or no bridge netfilter support.
  Nothing in either plan has been reasoned against the other driver, and loading the module
  changes how every Docker bridge's traffic is filtered: both are reviewed changes of their own.
- **The proof** that the filters are in force needs a VM on a bridge. It is the network plan's
  probe 8c at W9, which records which filter dropped the packet.

## 9. The runbook

**Order.** After the GO and the network plan's other "before the window" items (1, 3 and 4),
and before its W0.
Stop at the first failure. Each step that changes something gets its line in the host's change
journal before it runs: the time in UTC, the change, the exact command, its exact undo and the
approval it ran under (the network plan's
[§5](env-vm-network.md#5-changing-the-rules-install-journal-undo-dead-man)). This plan's own files
go in `<record-dir>`, whose place is question 3.

**Access.** No step changes `sshd`, UFW, a public interface or the firewall. Where a lost session
could cut a step in half (the source, the packages), the step runs with the safeguards the
spike's runbook binds to `source --apply` (`sandbox-vm-spike.md:179-184`): a fresh SSH login from
an independent machine and a container health check immediately before and after, and a console
session confirmed beforehand. The package transaction runs in a detached transient unit, so a
dropped session cannot kill `apt` mid-transaction (`sandbox-vm-spike.md:333`). **There is no
dead-man switch in this plan, deliberately**: a timer that runs `apt remove` can fire into a held
dpkg lock or a half-configured package, and no step here changes anything a lost login could come
from. Lost access is recovered from the console.

| Step | What it changes                                                                                     | Undo                                                                       |
| ---- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| I0   | creates `<record-dir>`; then a read-only snapshot                                                   | `rm -r <record-dir>`, only after a full removal and with the evidence kept |
| I1   | a root-owned copy of the reviewed commit's `scripts/lib`                                            | `rm -r <copy-dir>`, only after `source --remove`                           |
| I2   | moves the old daemon state aside; purges the removed package's conffiles; clears a stale unit state | move the state back, after a full removal; the purge has none              |
| I3   | with question 5 (a): an override that keeps Ubuntu's userns restriction                             | delete the file; `systemctl restart systemd-sysctl` re-applies the rest    |
| I4   | adds the upstream source                                                                            | `source --apply --remove`, which refuses while an Incus package is present |
| I5   | installs and holds the packages                                                                     | [§12](#12-undo-and-how-it-composes-with-the-network-plans-rollback)        |
| I6   | masks `incus-user.socket`                                                                           | `systemctl unmask incus-user.socket`                                       |
| I7   | nothing: audits the fresh state                                                                     | none                                                                       |
| I8   | stages the image files                                                                              | remove `<image-dir>`                                                       |
| I9   | sets the loopback listener                                                                          | `incus config unset core.https_address`                                    |
| I10  | creates and trusts the manager credential                                                           | `incus config trust remove <fingerprint>`; remove `<credential-dir>`       |
| I11  | creates the storage pool                                                                            | `incus storage delete <pool>`, which refuses while the pool is used        |
| I12  | nothing: records A9 and diffs against I0                                                            | none                                                                       |

**I0. Record directory, then a read-only snapshot.** `install -d -m 0700 -o root -g root <record-dir>`,
then, into it: `dpkg-query -W`, `apt-mark showhold`, `dpkg --audit`, `systemctl list-unit-files`,
`systemctl list-units --all 'incus*'`, `getent passwd incus`, `getent group incus incus-admin`,
`grep '^root:' /etc/subuid /etc/subgid`, `sysctl -n` for the eleven keys in
`sandbox_vm.py:47-51`, `nft list tables`, `iptables-save`, `ip6tables-save`, `ufw status verbose`,
`ss -ltunp`, `command -v qemu-img` (the host's own, which I11 uses; the bundled QEMU is not on `PATH`), `ls -la /var/lib/incus`, the residue check in `sandbox-vm-spike.md:79-87`, each
container's id, start time, restart count, mounts and health, and an `sshd -T` digest. The
snapshots are for diffing only and are never replayed. **Stop** if `dpkg --audit` prints anything,
an apt or unattended-upgrades process runs, any Incus package is in a state other than absent or
`config-files`, a residue entry is foreign or unexplained, or a container is not healthy.

**I1. A root-owned copy of the reviewed tooling.**

```sh
install -d -m 0755 -o root -g root <copy-dir>
git -C <reviewed checkout> archive <reviewed commit> scripts/lib | tar -x -C <copy-dir>
chown -R root:root <copy-dir> && chmod -R go-w <copy-dir>
```

The source's record then lands in `<copy-dir>/.sandbox-vm-spike/`, outside every checkout, and the
copy must stay as long as the source does.

**I2. Fresh daemon state.** Only while no Incus package is installed (I0):

```sh
mv /var/lib/incus /var/lib/incus.pre-<UTC stamp>
dpkg --purge incus-base            # only if dpkg-query reports it "deinstall ok config-files"
systemctl reset-failed incus-lxcfs.service
```

The purge's maintainer script may remove further leftovers; I12's diff records what it removed.

**I3. Keep Ubuntu's userns restriction** (question 5 (a)). Before the package exists, write
`/etc/sysctl.d/<NN>-<name>.conf`, mode 0644, with the one line
`kernel.apparmor_restrict_unprivileged_unconfined = <value recorded in I0>`. `<NN>` sorts after
`50-incus.conf`, so the override is applied last (`sysctl.d(5)`), also when the postinst restarts
`systemd-sysctl`: the relaxation is never in force.

**I4. The upstream source**, with the access safeguards above:

```sh
KEY="$(mktemp)" && curl -fsSLo "$KEY" https://pkgs.zabbly.com/key.asc
python3 -I <copy-dir>/scripts/lib/sandbox_vm.py source --key "$KEY"          # dry run: matches_pin true
python3 -I <copy-dir>/scripts/lib/sandbox_vm.py source --apply --key "$KEY"
apt-cache madison incus incus-base incus-client
```

`madison` must list `<exact version>` for each of the three, and only from the pinned URI. A
version also offered elsewhere, or not offered at all, stops the window.

**I5. The packages**, with the access safeguards above. `<packages>` is
`incus=<exact version> incus-base=<exact version> incus-client=<exact version> dnsmasq-base=<dnsmasq version>`:

```sh
apt-get --simulate install --no-install-recommends --no-remove --no-upgrade <packages>
apt-get install --download-only -y --no-install-recommends --no-remove --no-upgrade <packages>
install -d -m 0700 <record-dir>/debs && cp /var/cache/apt/archives/<each planned .deb> <record-dir>/debs/
systemd-run --unit=<unit> --wait -p KillMode=mixed -p TimeoutStopSec=900 -p RuntimeMaxSec=infinity \
  --setenv=DEBIAN_FRONTEND=noninteractive --setenv=NEEDRESTART_MODE=l \
  apt-get install -y --no-install-recommends --no-remove --no-upgrade <packages>
apt-mark hold incus incus-base incus-client
incus admin waitready --timeout=60
incus query /1.0
```

The simulation must show 0 upgraded and 0 to remove, no `Remv` line, no `Inst <package> [` line (an
upgrade), nothing for OpenSSH, UFW, Docker, containerd, runc or the `dnsmasq` service package, and
every `Inst` name in the reviewed dependency list: the rules the spike enforces in code
(`sandbox_vm.py:609-616`). A newly installed `dnsmasq-base` and every new dependency are recorded.
`journalctl -u <unit>` holds the result if the session dropped. `GET /1.0` must list both
`projects_restricted_virtual_machines_nesting` and `projects_restricted_storage_pool_access`
(`sandbox_vm.py:52-53`), or the window stops and I5 is undone.

**I6. Close the per-user path.** `systemctl mask --now incus-user.socket`, and
`incus-user.service` too if the package ships one (`systemctl list-unit-files 'incus*'`).

**I7. Audit the fresh state**, read-only: `incus config show`, `incus config trust list`,
`incus config trust list-tokens`, `incus network list`, `incus project list`,
`incus profile show default`, `incus image list --all-projects` and `incus storage list`. Expected
in [§10](#10-checks-expected-results-and-what-turns-each-red).

**I8. Stage the image** in `<image-dir>` (root, 0700): the reviewed build's `metadata.tar`,
`disk.qcow2` and `manifest.json`, then

```sh
cat <image-dir>/metadata.tar <image-dir>/disk.qcow2 | sha256sum
```

which must equal the Incus fingerprint in that `manifest.json` and the `image.fingerprint` of the
entry point's config.

**I9. The loopback listener.** `incus config set core.https_address 127.0.0.1:<port>`, then the
listener checks in [§10](#10-checks-expected-results-and-what-turns-each-red).

**I10. The manager credential**, in `<credential-dir>` (question 1):

```sh
install -d -m 0700 -o root -g root <credential-dir>
umask 077
openssl req -x509 -newkey rsa:3072 -nodes -days <days> -subj "/CN=<name>" \
  -addext extendedKeyUsage=clientAuth \
  -keyout <credential-dir>/manager-key.pem -out <credential-dir>/manager.pem
incus config trust add-certificate <credential-dir>/manager.pem --name <name>
install -m 0600 /var/lib/incus/server.crt <credential-dir>/server.pem
openssl x509 -in <credential-dir>/server.pem -noout -ext subjectAltName
node -e '
const fs = require("node:fs"), https = require("node:https")
const [url, ca, cert, key] = process.argv.slice(1)
const read = (f) => fs.readFileSync(f, "utf8")
https.get(new URL("/1.0", url), { ca: read(ca), cert: read(cert), key: read(key), rejectUnauthorized: true }, (res) => {
  let body = ""
  res.on("data", (c) => (body += c)).on("end", () => console.log(JSON.parse(body).metadata.auth))
}).on("error", (e) => { console.error(e.code); process.exit(1) })
' https://127.0.0.1:<port>/ <credential-dir>/server.pem <credential-dir>/manager.pem <credential-dir>/manager-key.pem
docker ps -q | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}'
```

Compare each mount source the last command printed with `<credential-dir>`: for the directory and each of its parents, `grep -Fx <path>` over the listing must match nothing, and a source that is a parent of `<credential-dir>` is found the same way. Empty output (no running container) passes.

The entry point's config names `server.pem` as `manager.ca`, `manager.pem` as `manager.cert` and
`manager-key.pem` as `manager.key`. Rotation, before `<days>` run out: add a new certificate,
verify it the same way, then remove the old one.

**I11. The storage pool.** First the two checks in [§5](#5-storage-pool):
`qemu-img info --output=json <image-dir>/disk.qcow2` (the host's own binary, recorded at I0) for the virtual size, and
`df -B1 --output=avail <the pool's backing path>`. Then:

```sh
incus storage create <pool> <driver> [source=<path>]
incus storage show <pool>
```

**I12. A9 and the post-check.** `incus query /1.0` (its `environment.firewall`), `lsmod` for
`br_netfilter`, and `sysctl net.bridge.bridge-nf-call-iptables net.bridge.bridge-nf-call-ip6tables`,
recorded in `<record-dir>`. Then I0's snapshot again, diffed against I0. Only the differences listed
in [§10](#10-checks-expected-results-and-what-turns-each-red) may appear, and any other stops the
window. **The network plan's W0 is taken after I12**, so its W0/W14 diffs (A4, A10) start from
the daemon's own tables already in place.

**With question 4 (a) only**, a last step stops the daemon until W5:
`systemctl stop incus.service incus.socket incus-startup.service` (`incus-user.socket` is masked
since I6), because socket activation otherwise restarts it on the next `incus` call. Verify with `systemctl is-active` on all three.
Undo: `systemctl start incus.socket incus.service incus-startup.service`.

## 10. Checks: expected results, and what turns each red

"Rehearsal" means the change is made on the disposable machine in [§1](#1-what-has-to-land-before-the-window)
item 4, never on the target host. "Here" means the red case is harmless and runs on the target
host, in its step.

| Step | Read-only check                                                                                             | Expected                                                     | Red when                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| I3   | `sysctl -n kernel.apparmor_restrict_unprivileged_unconfined` after I5                                       | the I0 value                                                 | rehearsal: I3 skipped, so the value reads 0                                               |
| I4   | `apt-cache madison incus incus-base incus-client`                                                           | `<exact version>` for all three, from the pinned URI only    | rehearsal: a second source offering the version                                           |
| I5   | `apt-mark showhold`                                                                                         | exactly `incus`, `incus-base`, `incus-client`                | rehearsal: one left unheld                                                                |
| I6   | `systemctl is-enabled incus-user.socket`; `getent group incus-admin incus`                                  | `masked`; both member lists empty                            | rehearsal: a user added to `incus-admin`                                                  |
| I7   | `incus config show`                                                                                         | no `*_address` and no `oidc.*` key                           | rehearsal: state not moved aside, with an address set in it                               |
| I7   | `incus config trust list`; `incus config trust list-tokens`                                                 | both empty                                                   | rehearsal: `incus config trust add <name>` leaves a token                                 |
| I7   | `incus network list`; `incus project list`; `incus profile show default`; `incus image list --all-projects` | no managed network; only `default`; `devices: {}`; empty     | rehearsal: `incus admin init --auto`, which creates a bridge and a profile device         |
| I8   | `cat metadata.tar disk.qcow2 \| sha256sum`                                                                  | the manifest's fingerprint and the config's pin              | here: a copy with one byte of the disk altered                                            |
| I9   | `incus config show`                                                                                         | one `*_address` key, `core.https_address: 127.0.0.1:<port>`  | rehearsal: `core.https_address=:<port>`; and `core.metrics_address` set                   |
| I9   | `ss -H -ltunp`, filtered to incusd                                                                          | one line, TCP, `127.0.0.1:<port>`                            | rehearsal: `core.https_address=[::]:<port>`                                               |
| I10  | `openssl x509 … -ext subjectAltName`                                                                        | lists the loopback address in `manager.url`                  | rehearsal: a server certificate without that address                                      |
| I10  | the Node probe                                                                                              | `trusted`                                                    | here: a throwaway certificate prints `untrusted`; another CA file fails the TLS handshake |
| I10  | the mount listing                                                                                           | no source is `<credential-dir>`, inside it or a parent of it | rehearsal: a container bind-mounting the directory's parent                               |
| I10  | `stat -c '%U %G %a' <credential-dir> <credential-dir>/*`                                                    | `root root 700`, then `root root 600` for each file          | here: a copy with mode 0644 is reported                                                   |
| I11  | `incus storage list`                                                                                        | only `<pool>`, with the reviewed driver and source           | rehearsal: a second pool                                                                  |
| I12  | `environment.firewall`; bridge netfilter                                                                    | `nftables`; loaded                                           | none: a recorded value; the proof is probe 8c                                             |
| I12  | the I0 snapshot again, diffed                                                                               | only the differences below                                   | rehearsal: an unrelated package installed between I0 and I12                              |

**The expected differences at I12**, and nothing else:

- **Packages**: `incus`, `incus-base` and `incus-client` at `<exact version>`, held; `dnsmasq-base`
  if it was new; the reviewed dependency list; the purged conffiles gone.
- **Files**: the three source files and the source record; the I3 override; the package's files,
  `/usr/lib/sysctl.d/50-incus.conf` among them; the `root` lines in `/etc/subuid` and
  `/etc/subgid`; `/var/lib/incus` fresh and `/var/lib/incus.pre-<UTC stamp>` beside it;
  `<record-dir>`, `<copy-dir>`, `<credential-dir>` and `<image-dir>`.
- **Users and groups**: the `incus` user; the `incus` and `incus-admin` groups, with no members.
- **Units**: `incus.socket`, `incus-startup.service` and `incus-lxcfs.service` enabled and active,
  `incus.service` active, `incus-user.socket` masked.
- **Sysctls**: the ten package values, recorded; the apparmor key at its I0 value.
- **Firewall**: the daemon's own nftables tables in `nft list tables`. `iptables-save`,
  `ip6tables-save` and `ufw status verbose` unchanged.
- **Listeners**: one, incusd on `127.0.0.1:<port>`.
- **Incus**: one pool; one trusted certificate, the manager's; nothing else from I7's list.
- **Unchanged**: every container's id, start time, restart count, mounts and health; the `sshd -T`
  digest; `authorized_keys`; the metadata units.

**Hand-off checks the network plan runs** (its W-steps carry them): no managed network before
W6, and only `envvm-*` after it; no instance in any project before W8; the A9 record unchanged
after W5; and both groups still without members at W14.

## 11. Upgrades: the patch path for the bundled hypervisor

**The end state keeps the source, its pin and the hold.** Removing the source would leave the
bundled QEMU with no update path at all, and `source --remove` refuses while an Incus package is
installed anyway (`sandbox_vm.py:239-240`).

An upgrade is its own reviewed change, run in a window of its own:

1. Choose the new exact version, `apt-cache madison` as in I4, and keep its `.deb` files as in I5.
2. `apt-mark unhold incus incus-base incus-client`.
3. The I5 simulation, except that the three Incus packages are expected to upgrade and nothing
   else may. Then the install, in a detached unit, and the `GET /1.0` extension gate.
4. Restart each environment VM, since a running VM keeps the QEMU it started with:
   `incus restart --project sandbox-<environment> docker`. Then the entry point's
   `health <config.json> --wait 600`, and the network plan's `--check` and `--smoke`.
5. `apt-mark hold incus incus-base incus-client`, and I12's diff.

Its undo is the same commands with the previous version, from the kept `.deb` files. **Who
watches upstream for security fixes, and how often**, is owner question 6.

## 12. Undo, and how it composes with the network plan's rollback

**This plan's undo** runs newest first, I12 back to I0, with each row's undo from §9. It
**refuses** while any instance, any managed network, any project other than `default`, or any
image exists: `incus list --all-projects`, `incus network list`,
`incus project list` and `incus image list --all-projects` must all show nothing of the
environment's. Undoing I5 then means, in order:

```sh
systemctl disable --now incus.service incus.socket incus-startup.service incus-lxcfs.service
apt-mark unhold incus incus-base incus-client
apt-get remove -y incus incus-base incus-client
```

Then `apt-get purge dnsmasq-base` if it was new, a reviewed console removal of the new
dependencies, `sysctl -w <key>=<I0 value>` for each of the eleven keys, the `root` lines removed
from `/etc/subuid` and `/etc/subgid`, `userdel incus`, `groupdel incus-admin` and
`groupdel incus` if unused, `source --apply --remove` from `<copy-dir>`, and the old state moved
back.

**The network plan's rollback** ends with `--remove`, which removes the guard
([§7](env-vm-network.md#7-operator-runbook)). After it, a daemon left running would make every
later `incus network create` an unguarded bridge. So when Incus stays installed, that rollback is
followed by:

```sh
systemctl disable --now incus.service incus.socket incus-startup.service
systemctl is-active incus.service incus.socket incus-startup.service   # inactive, all three
```

## 13. Failure modes and what the operator does

| Symptom                                                                | Likely cause                                                    | What the operator does                                                                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `madison` does not list the version, or lists it from elsewhere        | the repository pruned the build; a second source                | Choose a fresh pin after a new review. Never widen the preferences file.                                                 |
| The simulation upgrades, removes or plans an unreviewed package        | a dependency change upstream                                    | Stop. A new dependency list is its own review.                                                                           |
| The detached unit failed, or the session dropped during I5             | a dpkg error; a lost connection                                 | Read `journalctl -u <unit>` from a fresh login or the console. Fix forward only with `dpkg --audit` clean, else undo I5. |
| `GET /1.0` lacks an API extension                                      | a build without the project restrictions                        | Undo I5. The entry point would be refused at project creation anyway.                                                    |
| I7 finds an address, a token, a network, a project or a profile device | the state was not moved aside, or the package seeded it         | Stop. Read the cause; never delete Incus state that this plan did not create.                                            |
| The server certificate does not name the loopback address              | the daemon's generated certificate                              | Stop. Replacing the daemon's certificate is not part of this plan.                                                       |
| The Node probe prints `untrusted`                                      | the trust add did not apply, or the wrong certificate was named | Compare fingerprints with `incus config trust list`. Never trust a second certificate to get past it.                    |
| The firewall driver is not `nftables`, or bridge netfilter is missing  | the host's firewall tooling                                     | Stop and escalate (A9).                                                                                                  |
| I12's diff shows another difference                                    | a concurrent change, a maintainer script                        | Stop the window. Explain it before W0.                                                                                   |
| SSH lost                                                               | should be impossible: no step touches access                    | Console. Read the change journal and the unit's journal.                                                                 |

## 14. Deliberately left out

- **SSH, `sshd`, `authorized_keys`, UFW's rules and port 22.** Untouched; see the status note.
- **The guard table, the bridges, the link network and the smoke**: the network plan's steps.
- **Any provisioning run.** `reconcile` and `health` are the network plan's W8.
- **The image delivery itself**, which needs question 2's prerequisite
  ([§1](#1-what-has-to-land-before-the-window)).
- **A dead-man switch**, for the reason in [§9](#9-the-runbook).
- **Earlier spike runs' leftover packages**, listed in the deployment's private notes. This plan
  does not remove them; that is a reviewed console cleanup of its own.
- **Holders of the host Docker socket**, root-equivalent, who can reach the loopback listener and
  read the manager credential ([§4](#4-management-paths-one-loopback-listener-and-nothing-else)).
- **Instance values**: every value in angle brackets, chosen in the deployment's private notes.
