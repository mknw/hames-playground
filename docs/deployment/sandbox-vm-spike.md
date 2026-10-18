# Nested VM sandbox spike

This is the operator procedure for [#648](https://github.com/mknw/hames-playground/issues/648)
and its [revised spike list](https://github.com/mknw/hames-playground/issues/648#issuecomment-6243408067).
Run it on the target host class, in a quiet window with console access and an independent lifeline SSH session. A local
offline green proves the guards and rendering; it provides no Docker, Incus,
SSH, nested virtualization or performance evidence. The live operator records
that evidence separately. SD-19, SD-20 and SD-21 apply.

All deployment values are arguments. Keep their values, private image inputs,
credentials and raw evidence outside Git, following [ADR-0008](../adr/0008-deployment-guidance-is-provider-neutral.md).
Only `results.json` and `results.md` are intended for posting after review;
they refer to **the target host**. Nothing in this procedure deploys an app,
changes its compose configuration, or authorizes a provider call.

## Operator checklist from the independent review

Current round-2 status: Q5 is recorded on [#648](https://github.com/mknw/hames-playground/issues/648); the owner authorizes the target-host spike, SSH and Incus install only. Confirm the [recorded Q5 ruling](https://github.com/mknw/hames-playground/issues/648#issuecomment-6244307698) and its limits before launch. The following review checklist retains its original point-in-time Q5 status and line references; the package command includes the dnsmasq fix from the [failed reduced run](https://github.com/mknw/hames-playground/issues/648#issuecomment-6244955991). Its snapshot parse command remains an operator diagnostic; the harness no longer parses the forensic nft snapshot (R1). Package mutation now waits for apt to return without a subprocess kill deadline, then delivers a deferred signal (R2); allow apt to finish before stopping the unit. Recovery enforces the recorded launch unit's inactive/failed state and refuses unknown state (R3).

<!-- prettier-ignore-start -->

**Before tonight's run, the operator must confirm all of these. If any one fails, do not run.**
1. **Q5.** Record the owner's authorisation on #648 itself: the target host, SSH and Incus install, this spike only. It is currently only on the PR.
2. **Firewall evidence, from a fresh survey.**
   - FORWARD's first rule is `-j DOCKER-USER`.
   - DOCKER-USER rule 1 is the `VPS-METADATA` jump, or there is no jump.
   - UFW `limit` rules have been reviewed.
   - Pass `--allow-ufw-route`. With UFW active, the default refuses (`sandbox_vm.py:733`).
3. **Snapshot parse check.** Run `nft list ruleset > f && nft --check -f f`, and it must exit 0. If it does not, the run stops harmlessly at `:326` (R1). Do not patch the code on the host to get past it.
4. **Packages.**
   - Review `apt-get --simulate install --no-install-recommends incus="$INCUS_PACKAGE_VERSION" incus-client="$INCUS_PACKAGE_VERSION" dnsmasq-base="$DNSMASQ_PACKAGE_VERSION"`, and pass every `Inst` name with `--allow-package`.
   - The simulation shows no upgrades and no `Remv` lines.
   - `dpkg --audit` prints nothing, and no apt or unattended-upgrades process is running.
   - Host QEMU, OVMF and `qemu-img` are already present. If the operator installs them, that is a separate, recorded change outside the harness journal (runbook `:68-69`).
5. **Launch.** Use only the runbook's `systemd-run` block (`:122`). Never run it in the foreground or inside a tool call. Do not stop the unit while the install step is running (R2).
6. **SSH access.**
   - Test the witness by hand: a fresh key-authenticated login over the public path, not loopback.
   - Keep a second SSH session open.
   - Confirm provider console access before starting.
7. **Window.**
   - `MemAvailable` is at least memory-cap plus reserve (10 GiB at the defaults).
   - No deploy, and no compose recreate or restart, during the run. Either one fails the health checkpoint and triggers rollback, by design.
8. **Recovery.**
   - Run `rollback --apply` by hand only after `systemctl is-active "$LAUNCH_UNIT"` reports inactive (R3).
   - After any rollback, run a fresh SSH check and a container check.
   - Remove the residual packages listed in the manifest from the console.

<!-- prettier-ignore-end -->

## First: survey, without installing anything

From a pinned checkout on the target host, run only the survey first:

```bash
sudo bash scripts/sandbox-vm-survey.sh --state "$PWD/.sandbox-vm-spike/survey"
```

The survey reads OS/kernel, `/dev/kvm`, Intel EPT/nested and AMD NPT/nested
parameters, disk/RAM and UFW/iptables/nftables summaries. Its Docker request is
`ps` with names and status only: no container environments, logs or unfiltered
inspect dumps. It makes no system changes and writes only a fresh private
directory under `.sandbox-vm-spike/`, which is gitignored. Directories are 0700,
files 0600; unavailable probes are explicit. These files contain deployment
detail and are **never** public attachments.

Review every private survey file before proceeding. Missing paging parameters,
unreadable firewall rules or unhealthy containers mean stop and investigate. Flag every SSH `limit` rule during survey review; the fresh-login witness is throttled to at most once per 30 seconds to avoid consuming its connection budget.
The apply preflight separately requires Linux/root, native apt packages, an
unused Incus installation, a non-root `kvm` group member who can open `/dev/kvm`
and issue `KVM_GET_API_VERSION`, and active nested paging. It refuses an
existing Incus/Incus-base/client installation rather than adopting its resources.
Do not reboot or change kernel parameters to make a failed preflight green.

## Prepare the private inputs

Prepare these locally on the target host before the live window. Do not put
their values in an issue, commit, shell transcript or public result.

| Argument / variable in the example                                                              | Operator supplies                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--survey`                                                                                      | The reviewed, completed survey directory                                                                                                |
| `--ssh-probe` / `SSH_WITNESS`                                                                   | An absolute executable path to a trusted fresh-login witness                                                                            |
| `--kvm-user` / `KVM_TEST_USER`                                                                  | Existing non-root member of the host's `kvm` group                                                                                      |
| `--incus-version` / `INCUS_PACKAGE_VERSION`                                                     | Exact version of native `incus` and `incus-client` apt packages                                                                         |
| `--dnsmasq-version` / `DNSMASQ_PACKAGE_VERSION`                                                 | Required exact version of `dnsmasq-base`, which supplies the executable Incus checks for managed bridges                                |
| `--image-metadata` / `VM_METADATA`, `--image-rootfs` / `VM_ROOTFS`                              | Reviewed local Incus VM metadata and disk image; verify their checksums privately                                                       |
| `--network` / `ENV_A_BRIDGE_CIDR`, `ENV_B_BRIDGE_CIDR`                                          | Two unused, distinct private IPv4 subnets, each gateway at network address + 1                                                          |
| `--app-bridge` / `APP_BRIDGE`                                                                   | Actual Linux bridge interface for the app's Docker network                                                                              |
| `--app-network` / `APP_NETWORK`                                                                 | Docker network name used by a fresh app-image probe                                                                                     |
| `--base-image` / `BASE_IMAGE`, `--data-image` / `DATA_IMAGE`, `--office-image` / `OFFICE_IMAGE` | Preloaded, digest-pinned sandbox flavours, identical on host and inside both VM image copies                                            |
| `--app-image` / `APP_IMAGE`                                                                     | Preloaded, digest-pinned app image with Node and the Docker CLI                                                                         |
| `--probe-network` / `PROBE_NETWORK`                                                             | A different existing Docker network for the refused TLS-ingress probe                                                                   |
| `--data-canary` / `DATA_CANARY`                                                                 | A reviewed private `IPv4:port` TCP canary in the app's data network; app positive control must succeed before guest refusal is evidence |
| `--launcher-unit` / `LAUNCH_UNIT`                                                               | A fresh `sbxs-run-` plus random hex transient service name, required for apply                                                          |
| `--allow-ufw-route`                                                                             | Explicit opt-in only after reviewing the active UFW policy; authorizes the exact journaled app-to-guest TLS route rules                 |
| `--state`                                                                                       | Fresh run directory inside the ignored state directory                                                                                  |

Accepted image inputs are an uncompressed metadata tar (regular files/directories only, at most 64 MiB expanded) and a standalone qcow2 disk. Host `qemu-img` must already be available: preflight reads its virtual size, refuses backing chains, encryption and external data files, and requires expansion to fit `--vm-disk`. Unknown or compressed disk formats are refused.

The VM image must have working Incus guest-agent support, Docker (`dockerd`),
systemd, Python 3 and `ip`. It must contain the three sandbox image digests.
Build/import the VM image privately ahead of the run; this harness imports
local image files and uses `--pull=never` for every Docker run. It does not run
image builds or install Kata/Firecracker. Install host QEMU support before the
window if the native Incus package does not provide it. An apt simulation that
would upgrade existing software, remove packages, or install/configure
OpenSSH, UFW, Docker, containerd or runc is refused. Every simulated `Inst` package must also appear in the positive allow-list (`incus`, `incus-base`, `incus-client`, `dnsmasq-base` by default); supply repeated `--allow-package` only for reviewed additional dependencies. Simulation, download and installation explicitly request the same exact Incus and dnsmasq-base versions. `dnsmasq-base` is required even with DHCP/DNS disabled: Incus checks its executable version during bridge setup. Use `dnsmasq-base`, not the `dnsmasq` service package. If newly installed, it stays in `residual_packages` in the private transaction manifest for reviewed console cleanup; rollback removes only the Incus packages and never automatically removes dnsmasq-base or other dependencies. A pre-existing dnsmasq-base is not recorded as a new residual. The download-only phase has its own 180s timeout, before mutation. Installation disables recommends, defers disconnect/termination signals until apt returns, has no subprocess kill timeout during dpkg mutation, and records dependencies left for console cleanup in the private manifest. No automatic autoremove runs. No apt index refresh runs.
Incus installs with `NEEDRESTART_MODE=l` to prevent needrestart restarting
unrelated services.

The witness must attempt a **new key-authenticated SSH connection from an
independent machine** to the existing SSH endpoint, with connection timeout,
strict host-key verification and no connection sharing. It exits zero only
after a successful fresh command, fails nonzero otherwise, and finishes within
20 seconds. A local `ss` check or a still-open SSH session is insufficient.
The script invokes the witness before and after each selected step, as well as
at measurement checkpoints, but at most once per 30 seconds after a successful check. Container health, SSH fingerprints and memory reserve are still checked at every checkpoint. It captures witness output privately. Test the witness
itself, including an intentional unavailable-target failure, before applying.
It must not edit SSH configuration, UFW inbound rules or SSH ports.

Keep a console/recovery session and the independent SSH lifeline open. Coordinate package operations for the transaction. Firewall snapshots are private forensic files only: no recovery code replays them. Each exact spike rule/table is journaled before creation and removed independently, preserving later Docker/UFW/fail2ban and metadata-policy changes.
No reboot, host Docker restart, compose recreation or host stop/rm/kill/prune
command is part of this procedure.

## Render, review, then apply explicit steps

The default is a pure dry-run: no probes, no files, no credential output and no
commands run. With any selected steps, it renders a generic JSON plan.

```bash
bash scripts/sandbox-vm-spike.sh --install --provision --tls --measure --cleanup
```

Set the private variables from the table, and review a dry-run with the full
argument list. Apply only inside a detached transient systemd service, never in a foreground or time-boxed tool invocation. The service must have unlimited runtime, `KillMode=mixed`, a stop budget of at least 900 seconds, and a unique `sbxs-run-` unit name. Preflight checks those properties and the current invocation ID before any installation. `--collect` reaps the launcher unit after it exits; the harness creates no persistent host service units.

First render the full command without `--apply`:

```bash
bash scripts/sandbox-vm-spike.sh \
  --install --provision --tls --measure --cleanup \
  --survey "$PWD/.sandbox-vm-spike/survey" \
  --state "$PWD/.sandbox-vm-spike/run" \
  --ssh-probe "$SSH_WITNESS" --kvm-user "$KVM_TEST_USER" \
  --incus-version "$INCUS_PACKAGE_VERSION" \
  --dnsmasq-version "$DNSMASQ_PACKAGE_VERSION" \
  --image-metadata "$VM_METADATA" --image-rootfs "$VM_ROOTFS" \
  --network "$ENV_A_BRIDGE_CIDR" --network "$ENV_B_BRIDGE_CIDR" \
  --app-bridge "$APP_BRIDGE" --app-network "$APP_NETWORK" \
  --probe-network "$PROBE_NETWORK" --data-canary "$DATA_CANARY" \
  --base-image "$BASE_IMAGE" --data-image "$DATA_IMAGE" \
  --office-image "$OFFICE_IMAGE" --app-image "$APP_IMAGE"
```

Then launch the same reviewed arguments detached (private variables are expanded locally, never published). `LAUNCH_UNIT` must be a fresh name such as `sbxs-run-` followed by random hex. Include the package allow-list and all inputs from the rendered command. For an active UFW deployment, append `--allow-ufw-route` only after the rule review above:

```bash
sudo systemd-run --unit="$LAUNCH_UNIT" --collect \
  -p KillMode=mixed -p TimeoutStopSec=900 -p RuntimeMaxSec=infinity \
  --working-directory="$PWD" \
  /bin/bash "$PWD/scripts/sandbox-vm-spike.sh" --apply \
  --launcher-unit="$LAUNCH_UNIT" \
  --install --provision --tls --measure --cleanup \
  --survey "$PWD/.sandbox-vm-spike/survey" --state "$PWD/.sandbox-vm-spike/run" \
  --ssh-probe "$SSH_WITNESS" --kvm-user "$KVM_TEST_USER" \
  --incus-version "$INCUS_PACKAGE_VERSION" \
  --dnsmasq-version "$DNSMASQ_PACKAGE_VERSION" \
  --image-metadata "$VM_METADATA" --image-rootfs "$VM_ROOTFS" \
  --network "$ENV_A_BRIDGE_CIDR" --network "$ENV_B_BRIDGE_CIDR" \
  --app-bridge "$APP_BRIDGE" --app-network "$APP_NETWORK" \
  --probe-network "$PROBE_NETWORK" --data-canary "$DATA_CANARY" \
  --base-image "$BASE_IMAGE" --data-image "$DATA_IMAGE" \
  --office-image "$OFFICE_IMAGE" --app-image "$APP_IMAGE"
```

Poll `systemctl show "$LAUNCH_UNIT"` and private `transaction.private.json`, `commands.private.jsonl` and eventual `results.json`; do not attach the service to a tool-call deadline. The SSH call that launches it may end while the service continues. After a disconnect, reconnect and inspect the same state directory and unit. Recovery is resumable from the per-entry journal using `rollback --apply` below; never start a second installer over a partially completed transaction.

Every apply is a fresh transaction and needs `--install --provision` together.
`--measure` also needs `--tls`, both distinct Docker networks, the private data-network canary and all image inputs. Resource caps are
explicit flags: `--vm-cpus`, `--vm-memory`, `--cpu-cap`, `--memory-cap`,
`--vm-disk`, `--disk-cap`, `--memory-reserve`; defaults are 2 CPUs/2 GiB/8 GiB disk per VM and
4 CPUs/8 GiB/24 GiB disk per project. Size them for the measured
host headroom before applying. `--tls-port` defaults to 2376 and must be an
unprivileged port. No host listener or port publication is created for it.
The two VM addresses are subnet address + 2. Existing route overlap is refused.
Preflight requires `MemAvailable >= memory-cap + memory-reserve`; the reserve defaults to 2 GiB and is enforced at every health checkpoint. Free space is checked on the resolved `/var/lib/incus/images` and `/var/lib/incus/storage-pools` backing filesystems, including the project disk cap, twice the qcow2 virtual size for import/expansion, input bytes, metadata expansion and a 2 GiB recovery reserve. Checkout free space is irrelevant.

| Step          | What happens and what is checked                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--install`   | Save nftables, IPv4 and IPv6 snapshots for forensics only; syntax-check only the IPv4/IPv6 snapshots; simulate the package plan, then install the pinned native Incus packages and wait for local readiness.                                                                                                                                                                                                       |
| `--provision` | Create a fresh `sbxs-` project, pool and two bridges, with two VM instances and CPU/memory limits. Containers are disallowed in the Incus project. Static guest addresses avoid changes to host DHCP/DNS inbound rules. Record create-to-agent timing.                                                                                                                                                             |
| `--tls`       | Create distinct two-day CAs and client certificates per environment. Push only each guest's CA and server material into that VM. Docker listens on its guest socket and its exact private bridge address with mutual TLS. Create default Docker contexts under private `client0/.docker` and `client1/.docker`. Verify both daemons, then require one environment's client certificate to be refused by the other. |
| `--measure`   | Run the synthetic measurements below, with checkpoints. No user uploads or live inference calls.                                                                                                                                                                                                                                                                                                                   |
| `--cleanup`   | Remove only recorded, prefix-guarded spike resources, reverse only recorded firewall rules/tables first, remove spike resources, then newly installed Incus packages. TLS client artifacts stay private for the operator to erase after review.                                                                                                                                                                    |

Without `--cleanup`, successful provisioning leaves the two VMs and Incus for
the operator to inspect. These credentials are spike credentials, not app
deployment credentials; the server lane must review and rotate them. The app
must receive only its own client context under its actual `$HOME/.docker`,
and must lose its host socket in the same deployment change. This PR changes
neither compose nor application code.

### Coexistence and rollback

The transaction snapshots every pre-existing running container's identity and
health state. Every step checks each original container is still running and
has the same health, the host SSH configuration/key fingerprint is unchanged,
and the independent SSH witness succeeds. Any command or check failure enters rollback; a signal during package mutation is delivered only after apt returns. Long measurement loops also checkpoint between samples and
during the ten-minute stream test. No command writes to `sshd` or the SSH port. UFW writes require the explicit, narrow opt-in below.

The two bridges retain static IPv4 gateways, `ipv4.nat=false`, `ipv4.dhcp=false` and `ipv6.address=none`, and now set `dns.mode=none`, with no uplink allowance. The [Incus bridge reference](https://linuxcontainers.org/incus/docs/main/reference/network_bridge/) defines DNS registration mode separately from address allocation. In [Incus 6.0.5 source](https://github.com/lxc/incus/blob/v6.0.5/internal/server/network/driver_bridge.go#L3401), `UsesDNSMasq()` returns false for this combination, so no bridge dnsmasq daemon is started. The earlier [version check](https://github.com/lxc/incus/blob/v6.0.5/internal/server/network/driver_bridge.go#L1336) is unconditional, so the executable is still required. `ipv4.address=none` would remove the gateway used by the guest route and host canary; retain the reviewed static IPv4 configuration instead. No per-family DNS mode is needed. The server lane must verify daemon absence on its pinned package; these offline checks do not prove live compatibility.

Each NIC's static address carries `security.ipv4_filtering=true` and `security.mac_filtering=true`. A priority -10 nft INPUT chain accepts established/related guest replies before dropping new guest-to-host traffic. The nft FORWARD chain accepts established replies, allows only the app bridge to the exact guest TLS port, drops all other guest ingress, and drops new guest egress. This deny enforcement precedes Docker's broad bridge allowances. The exact two DOCKER-USER allowances per bridge are inserted after a first metadata-policy jump when present; the survey's `iptables -S` is the review evidence for that ordering.

With active UFW, the default refuses before mutation. After private rule review, explicit `--allow-ufw-route` authorizes only app-bridge to exact guest address/TLS-port routed allowances. Each carries the spike token and is journaled before addition; rollback deletes those exact rules. Static addressing requires no DHCP/DNS or host INPUT exception. No pre-existing UFW rule, SSH policy, default routed policy, or #646 jump is changed. If a positive control still fails, stop and recover rather than broadening the rules.

Rollback reverses each journaled firewall entry first, then resources, then packages. It attempts every independent entry/category despite failures, immediately persists successful deletion or confirmed absence, and retains pending entries for retry. It never uses `flush ruleset`, `nft -f` replay or full iptables/ip6tables restoration. Check `rollback.private.json`: an empty array means commands succeeded, not that an external SSH check passed. Perform a fresh witness check and verify every original container after recovery. A nonempty array means recovery is incomplete: inspect the retained journal and resume from the console.
SIGHUP/INT/TERM initiate rollback. SIGKILL, a host crash or a lost execution
process cannot run Python recovery; from the console, inspect the private
journal and run the explicit recovery entry point:

```bash
sudo python3 scripts/lib/sandbox_vm.py rollback --apply --launcher-unit "$LAUNCH_UNIT" \
  --state "$PWD/.sandbox-vm-spike/run"
```

The recovery path refuses a running or unknown launch-unit state, using the unit recorded in the manifest (or explicit `--launcher-unit` for older manifests). It requires root-owned 0700 state under the ignored directory
and validates the recorded project/prefix/token before deleting any instance.
It is not a general Incus cleanup tool. If ownership checks refuse, inspect the
specific recorded resources from the console; never widen a prefix or delete
an entire unrelated project. Firewall snapshots/raw logs contain host details.
Keep them until recovery and independent SSH/container checks are complete.

## Automated measurements

`--measure` requires the same preloaded image content digests on host and in
both guests. Fresh baseline containers have the spike's name/label, memory,
CPU and PID limits, read-only roots, no capabilities, no network and bounded
lifetimes enforced **inside** the container. Every host baseline uses
`--rm`; no destructive host Docker command is sent. Guest deletion and exec
require the exact spike token label; Incus deletion additionally requires the
dedicated project, prefix and instance marker.

| Evidence             | Automated method                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nested KVM           | EPT/NPT plus non-root `kvm` group open/ioctl; guest kernel and host QEMU numeric versions. Full versions stay in private command evidence.                                                                                                                                                                                                                                                                                                                                      |
| VM boot cost         | Time from VM init through guest agent readiness and static-address setup, per environment. This is reported separately from container boot.                                                                                                                                                                                                                                                                                                                                     |
| Container boot       | Twenty host-runc and twenty nested runs in environment 0, same image/resources, from create to successful MCP `listTools` on both filesystem and shell servers; nearest-rank p50/p95.                                                                                                                                                                                                                                                                                           |
| Reset                | Twenty expiration/replacement cycles on the host (includes the self-expiration wait), and twenty guarded destroy/fresh-start cycles inside the VM. Host reset timing is an expiration upper bound, **not** a production force-remove benchmark.                                                                                                                                                                                                                                 |
| Stdio/files          | Two streams held for at least 600 seconds, with repeated listTools; filesystem MCP stages at least 1 MiB as base64 and shell MCP decodes it; destruction closes both streams.                                                                                                                                                                                                                                                                                                   |
| PTY                  | `docker exec -it`, initial 24×80, change to 37×91, verify remote `stty size` before and after.                                                                                                                                                                                                                                                                                                                                                                                  |
| Context routing      | A fresh app-image probe mounts only one environment's default context, has no host socket, and launches both MCP streams with the SDK's limited child environment. Daemon identity must match the intended guest; no `DOCKER_HOST` pass-through is relied upon.                                                                                                                                                                                                                 |
| Workloads            | Twenty samples each of a Python CPU loop, pandas CSV + xlsx, polars CSV and PyMuPDF PDF; synthetic 100k-row CSV/20-page PDF, no user files. Report each workload's p50/p95 on host and VM.                                                                                                                                                                                                                                                                                      |
| Memory/concurrency   | Host baseline PID RSS vs VM QEMU PSS; paired host-runc and nested 4 and 8 simultaneously executing boxes (keys `baseline_concurrency4_*`, `baseline_concurrency8_*`, `nested_concurrency4_*`, `nested_concurrency8_*`), p50/p95 CPU-work latency, sampled peak QEMU PSS and minimum host `MemAvailable`. RSS sums the baseline init process tree while both MCP servers are held open; PSS covers the whole environment VM with an active sandbox, not per-box incremental PSS. |
| Functional isolation | Positive guest-local daemon reachability, negative cross-environment daemon reachability, negative guest-to-host bridge canary reachability, guest metadata/public egress refusal, app-to-non-TLS and other-network-to-TLS refusal, guest-to-app data canary refusal, and a no-network container failing to reach the guest's known-live daemon. Per-environment mTLS cross-refusal is tested separately.                                                                       |

Guest metadata/public refusal uses a known-live guest-local TLS control; the public destination also has a host TCP control. It does not claim that a metadata service is live: #646 may deliberately block host metadata OUTPUT, so the harness never requires a successful host metadata connection. App-to-non-TLS refusal uses a bounded guest-local TCP listener with a guest-local positive control. The other-network-to-TLS negative pairs with the app-to-TLS positive, and the guest-to-data negative pairs with an app-to-data-canary positive. Inconclusive probe errors fail the run.

The network-none probe establishes that mode's isolation against a known-live
target; it is not a general scan of host services. The guest-to-host canary
tests the bridge input drop; it does not enumerate production loopback services.
The app-image probe runs as root inside a disposable container to read the
root-owned spike context. The actual app user's credential permissions and
compose socket removal still require the server lane's deployment check.

If a run is interrupted, only fresh, self-expiring host probe containers may
remain. Read the exact prefix/token in the private transaction journal, then
inspect names/status without changing anything:

```bash
docker --host unix:///var/run/docker.sock ps \
  --filter "label=sandbox-vm-spike=$SPIKE_TOKEN" --format '{{.Names}} {{.Status}}'
```

Wait for their bounded timeout/`--rm` cleanup. Do not stop, recreate or prune
pre-existing containers. Twenty baseline runs plus expiry resets and the
ten-minute stream hold take tens of minutes; do not mistake the quiet interval
for permission to kill the process.

## Operator-run legs that remain unmeasured

The JSON always lists `vm_per_sandbox_q35`, `vm_per_sandbox_minimal`, `kata` and
`firecracker` as unmeasured. No supplied result claims those passed. Under a
separate runtime-install decision, use this protocol for each available variant:

1. Never edit the host's `/etc/docker/daemon.json` and never restart the host's dockerd for Kata. Kata runs only inside a spike VM or on a separate host. Record guest kernel, hypervisor/runtime version, exact local image digest,
   resources and config. For Incus compare q35 against a genuinely supported
   minimal configuration. Do not infer a minimal configuration from a forum
   boot number. For Kata, first establish whether Docker can actually create
   the shim-backed box; if not, record unsupported, not a timing sample.
2. On at least twenty fresh instances, time create through first successful
   MCP listTools on **both** servers. Record p50/p95. Destroy only spike-owned
   instances, then time twenty warm-pool destroy/fresh-boot cycles. Never
   substitute guest-agent readiness for MCP readiness.
3. Hold both exec streams through a ten-minute turn, stage at least 1 MiB via
   the actual base64 transport, resize a PTY, destroy the instance and verify
   stream closure. Verify endpoint identity with no host socket available.
4. Repeat the same synthetic flavour workloads and 4/8-concurrency tests,
   measuring VM PSS, container RSS, latency and memory headroom at the chosen
   `globalCap`. Verify read-only/tmpfs/PID/capability behaviour required by #116.
5. Test no-NIC/no-network egress, host loopback/other-environment isolation,
   cross-certificate rejection and Docker/UFW coexistence with independent
   positive controls. Repeat container-health and fresh-SSH checks around
   every privileged change; use the same rollback discipline.

The full issue's broker/API-wire, rootless-controller, hosted-provider and
other comparison questions remain research items; this Incus-only spike does
not silently install those alternatives or answer them. gVisor-inside-the-VM
is a later decision. Restricted-project VM-per-sandbox semantics and its image
pipeline need their own measurement; this operator-owned project is not a new
app-facing Incus backend.

## Decide and publish

Review only the generic JSON/Markdown for public attachment. The closed result
schema accepts fixed labels, finite nonnegative numbers and booleans; command
output, hostnames, addresses, paths, certificate data and environment values
never enter it. Raw command evidence and recovery inputs stay private.

The result remains `incomplete` (or `failed`) with `owner_review_required`:
no warm-pool overhead budget, acceptable p95, minimum memory headroom or
`globalCap` was specified here. The owner must compare measurements against
those budgets, resolve every isolation failure and explicitly accept or defer
the unmeasured variants. This harness does not choose a substrate on its own.

Attach only reviewed generic results to #648 as evidence from **the target
host**. Record live operator, commit, pass/fail and any unmeasured legs without
publishing a deployment's identifiers. Never attach survey, firewall backups,
private command logs, VM disks or client credential directories.

## Offline gate and mutations

These checks need no daemon, SSH or provider calls:

```bash
shellcheck scripts/sandbox-vm-survey.sh scripts/sandbox-vm-spike.sh
python3 scripts/sandbox-vm.test.py
python3 scripts/sandbox-vm.test.py --mutations
```

The same hermetic tests and mutations also run from
`app/src/__tests__/sandbox-vm-spike.test.ts` in layer 1. The mutation runner
requires the full original suite to pass first, then reruns the named safety test against each temporary source mutation and requires that specific test to turn red. The fix-round PR comment records every author/reviewer mutation and its current named test, including replacements for superseded full-snapshot recovery. The retained cases include: remove rollback; remove the SSH configuration guard; remove the
DOCKER-USER allow; add a host container stop; leak a hostname into results;
widen the Incus cleanup prefix; widen the exec-token match; move the project
flag into guest argv; echo invalid private site input. These are offline
guard tests, not live compatibility evidence.

Implementation map for review (source locations on this change):

| Contract                                         | Source                                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survey and private output                        | [`sandbox_vm.py:210`](../../scripts/lib/sandbox_vm.py#L210), [`sandbox_vm.py:104`](../../scripts/lib/sandbox_vm.py#L104)                                                                                                              |
| Health/SSH checks and transaction failure policy | [`sandbox_vm.py:173`](../../scripts/lib/sandbox_vm.py#L173), [`sandbox_vm.py:192`](../../scripts/lib/sandbox_vm.py#L192), [`sandbox_vm.py:760`](../../scripts/lib/sandbox_vm.py#L760)                                                 |
| Ownership, surgical recovery and forwarding      | [`sandbox_vm.py:315`](../../scripts/lib/sandbox_vm.py#L315), [`sandbox_vm.py:368`](../../scripts/lib/sandbox_vm.py#L368), [`sandbox_vm.py:429`](../../scripts/lib/sandbox_vm.py#L429)                                                 |
| TLS/context setup                                | [`sandbox_vm.py:550`](../../scripts/lib/sandbox_vm.py#L550)                                                                                                                                                                           |
| Generic result schema                            | [`sandbox_vm.py:239`](../../scripts/lib/sandbox_vm.py#L239)                                                                                                                                                                           |
| Storage, memory and detached launch preflight    | [`sandbox_vm.py:665`](../../scripts/lib/sandbox_vm.py#L665), [`sandbox_vm.py:698`](../../scripts/lib/sandbox_vm.py#L698)                                                                                                              |
| Bounded baseline and boot samples                | [`sandbox_vm_measure.py:121`](../../scripts/lib/sandbox_vm_measure.py#L121), [`sandbox_vm_measure.py:203`](../../scripts/lib/sandbox_vm_measure.py#L203)                                                                              |
| Staging, streams, PTY and context proof          | [`sandbox_vm_measure.py:249`](../../scripts/lib/sandbox_vm_measure.py#L249), [`sandbox_vm_measure.py:323`](../../scripts/lib/sandbox_vm_measure.py#L323)                                                                              |
| Memory, concurrency and isolation probes         | [`sandbox_vm_measure.py:401`](../../scripts/lib/sandbox_vm_measure.py#L401), [`sandbox_vm_measure.py:414`](../../scripts/lib/sandbox_vm_measure.py#L414), [`sandbox_vm_measure.py:497`](../../scripts/lib/sandbox_vm_measure.py#L497) |

Upstream operational references:
[Incus firewall coexistence](https://linuxcontainers.org/incus/docs/main/howto/network_bridge_firewalld/),
[Incus VM creation](https://linuxcontainers.org/incus/docs/main/howto/instances_create/),
[Docker mutual TLS](https://docs.docker.com/engine/security/protect-access/).
