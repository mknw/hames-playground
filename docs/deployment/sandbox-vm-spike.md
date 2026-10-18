# Nested VM sandbox spike

This is the operator procedure for [#648](https://github.com/mknw/hames-playground/issues/648)
and its [revised spike list](https://github.com/mknw/hames-playground/issues/648#issuecomment-6243408067).
Run it on the target host class, in a quiet window with console access. A local
offline green proves the guards and rendering; it provides no Docker, Incus,
SSH, nested virtualization or performance evidence. The live operator records
that evidence separately. SD-19, SD-20 and SD-21 apply.

All deployment values are arguments. Keep their values, private image inputs,
credentials and raw evidence outside Git, following [ADR-0008](../adr/0008-deployment-guidance-is-provider-neutral.md).
Only `results.json` and `results.md` are intended for posting after review;
they refer to **the target host**. Nothing in this procedure deploys an app,
changes its compose configuration, or authorizes a provider call.

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
unreadable firewall rules or unhealthy containers mean stop and investigate.
The apply preflight separately requires Linux/root, native apt packages, an
unused Incus installation, a non-root `kvm` group member who can open `/dev/kvm`
and issue `KVM_GET_API_VERSION`, and active nested paging. It refuses an
existing Incus/Incus-base/client installation rather than adopting its resources.
Do not reboot or change kernel parameters to make a failed preflight green.

## Prepare the private inputs

Prepare these locally on the target host before the live window. Do not put
their values in an issue, commit, shell transcript or public result.

| Argument / variable in the example                                                              | Operator supplies                                                                            |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--survey`                                                                                      | The reviewed, completed survey directory                                                     |
| `--ssh-probe` / `SSH_WITNESS`                                                                   | An absolute executable path to a trusted fresh-login witness                                 |
| `--kvm-user` / `KVM_TEST_USER`                                                                  | Existing non-root member of the host's `kvm` group                                           |
| `--incus-version` / `INCUS_PACKAGE_VERSION`                                                     | Exact version of native `incus` and `incus-client` apt packages                              |
| `--image-metadata` / `VM_METADATA`, `--image-rootfs` / `VM_ROOTFS`                              | Reviewed local Incus VM metadata and disk image; verify their checksums privately            |
| `--network` / `ENV_A_BRIDGE_CIDR`, `ENV_B_BRIDGE_CIDR`                                          | Two unused, distinct private IPv4 subnets, each gateway at network address + 1               |
| `--app-bridge` / `APP_BRIDGE`                                                                   | Actual Linux bridge interface for the app's Docker network                                   |
| `--app-network` / `APP_NETWORK`                                                                 | Docker network name used by a fresh app-image probe                                          |
| `--uplink` / `UPLINK`                                                                           | Actual outbound host interface, distinct from the app bridge                                 |
| `--base-image` / `BASE_IMAGE`, `--data-image` / `DATA_IMAGE`, `--office-image` / `OFFICE_IMAGE` | Preloaded, digest-pinned sandbox flavours, identical on host and inside both VM image copies |
| `--app-image` / `APP_IMAGE`                                                                     | Preloaded, digest-pinned app image with Node and the Docker CLI                              |
| `--state`                                                                                       | Fresh run directory inside the ignored state directory                                       |

The VM image must have working Incus guest-agent support, Docker (`dockerd`),
systemd, Python 3 and `ip`. It must contain the three sandbox image digests.
Build/import the VM image privately ahead of the run; this harness imports
local image files and uses `--pull=never` for every Docker run. It does not run
image builds or install Kata/Firecracker. Install host QEMU support before the
window if the native Incus package does not provide it. An apt simulation that
would upgrade existing software, remove packages, or install/configure
OpenSSH, UFW, Docker, containerd or runc is refused. No apt index refresh runs.
Incus installs with `NEEDRESTART_MODE=l` to prevent needrestart restarting
unrelated services.

The witness must attempt a **new key-authenticated SSH connection from an
independent machine** to the existing SSH endpoint, with connection timeout,
strict host-key verification and no connection sharing. It exits zero only
after a successful fresh command, fails nonzero otherwise, and finishes within
20 seconds. A local `ss` check or a still-open SSH session is insufficient.
The script invokes the witness before and after each selected step, as well as
at measurement checkpoints. It captures its output privately. Test the witness
itself, including an intentional unavailable-target failure, before applying.
It must not edit SSH configuration, UFW inbound rules or SSH ports.

Keep a console/recovery session open. Freeze unrelated package, firewall and
container lifecycle changes for the transaction: rollback restores full saved
firewall rules, and cannot safely reconcile concurrent administrator changes.
No reboot, host Docker restart, compose recreation or host stop/rm/kill/prune
command is part of this procedure.

## Render, review, then apply explicit steps

The default is a pure dry-run: no probes, no files, no credential output and no
commands run. With any selected steps, it renders a generic JSON plan.

```bash
bash scripts/sandbox-vm-spike.sh --install --provision --tls --measure --cleanup
```

Set the private variables from the table, and review a dry-run with the full
argument list before repeating it with `--apply`:

```bash
sudo bash scripts/sandbox-vm-spike.sh \
  --install --provision --tls --measure --cleanup \
  --survey "$PWD/.sandbox-vm-spike/survey" \
  --state "$PWD/.sandbox-vm-spike/run" \
  --ssh-probe "$SSH_WITNESS" --kvm-user "$KVM_TEST_USER" \
  --incus-version "$INCUS_PACKAGE_VERSION" \
  --image-metadata "$VM_METADATA" --image-rootfs "$VM_ROOTFS" \
  --network "$ENV_A_BRIDGE_CIDR" --network "$ENV_B_BRIDGE_CIDR" \
  --app-bridge "$APP_BRIDGE" --app-network "$APP_NETWORK" --uplink "$UPLINK" \
  --base-image "$BASE_IMAGE" --data-image "$DATA_IMAGE" \
  --office-image "$OFFICE_IMAGE" --app-image "$APP_IMAGE"
```

Every apply is a fresh transaction and needs `--install --provision` together.
`--measure` also needs `--tls` and all image/network inputs. Resource caps are
explicit flags: `--vm-cpus`, `--vm-memory`, `--cpu-cap`, `--memory-cap`,
`--vm-disk`, `--disk-cap`; defaults are 2 CPUs/2 GiB/8 GiB disk per VM and
4 CPUs/8 GiB/24 GiB disk per project. Size them for the measured
host headroom before applying. `--tls-port` defaults to 2376 and must be an
unprivileged port. No host listener or port publication is created for it.
The two VM addresses are subnet address + 2. Existing route overlap is refused.
Free disk must cover the disk cap, local image inputs and a 2 GiB recovery
reserve. The imported image and both VM disks must fit the selected budgets.

| Step          | What happens and what is checked                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--install`   | Save and validate nftables, IPv4 and IPv6 iptables rollback inputs first; simulate the package plan, then install the pinned native Incus packages and wait for local readiness.                                                                                                                                                                                                                                   |
| `--provision` | Create a fresh `sbxs-` project, pool and two bridges, with two VM instances and CPU/memory limits. Containers are disallowed in the Incus project. Static guest addresses avoid changes to host DHCP/DNS inbound rules. Record create-to-agent timing.                                                                                                                                                             |
| `--tls`       | Create distinct two-day CAs and client certificates per environment. Push only each guest's CA and server material into that VM. Docker listens on its guest socket and its exact private bridge address with mutual TLS. Create default Docker contexts under private `client0/.docker` and `client1/.docker`. Verify both daemons, then require one environment's client certificate to be refused by the other. |
| `--measure`   | Run the synthetic measurements below, with checkpoints. No user uploads or live inference calls.                                                                                                                                                                                                                                                                                                                   |
| `--cleanup`   | Remove only recorded, prefix-guarded spike resources, remove newly installed Incus packages and restore the saved firewall. TLS client artifacts stay private for the operator to erase after review.                                                                                                                                                                                                              |

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
and the independent SSH witness succeeds. Any command, signal or check failure
enters rollback. Long measurement loops also checkpoint between samples and
during the ten-minute stream test. No command writes to `sshd`, UFW rules or
the SSH port.

Bridge forwarding is explicit in `DOCKER-USER`: allow the app bridge to the
specific VM's TLS port, established replies, and bridge-to-uplink/established
return traffic. It does not change Docker's FORWARD policy or daemon config.
Separate nftables input rules drop packets arriving from each guest bridge to
the host, and forwarding rules prevent guests reaching other local bridges.
The script does not relax UFW. If UFW or an nft-only Docker backend prevents
the required route, the spike fails; record it, roll back, and obtain a
separate reviewed plan rather than changing host inbound policy.

Rollback attempts resource cleanup, package removal and firewall restoration
independently; restoration still runs if cleanup fails. Check
`rollback.private.json`: an empty array means the rollback commands succeeded,
not that an external SSH check has independently passed. Perform a new witness
check and verify all original containers after recovery. A nonempty array
requires console intervention; the script exits nonzero and never claims GO.
SIGHUP/INT/TERM initiate rollback. SIGKILL, a host crash or a lost execution
process cannot run Python recovery; from the console, inspect the private
journal and run the explicit recovery entry point:

```bash
sudo python3 scripts/lib/sandbox_vm.py rollback --apply \
  --state "$PWD/.sandbox-vm-spike/run"
```

The recovery path requires root-owned 0700 state under the ignored directory
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

| Evidence             | Automated method                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nested KVM           | EPT/NPT plus non-root `kvm` group open/ioctl; guest kernel and host QEMU numeric versions. Full versions stay in private command evidence.                                                                                                                                                                                            |
| VM boot cost         | Time from VM init through guest agent readiness and static-address setup, per environment. This is reported separately from container boot.                                                                                                                                                                                           |
| Container boot       | Twenty host-runc and twenty per-env-VM runs, same image/resources, from create to successful MCP `listTools` on both filesystem and shell servers; nearest-rank p50/p95.                                                                                                                                                              |
| Reset                | Twenty expiration/replacement cycles on the host (includes the self-expiration wait), and twenty guarded destroy/fresh-start cycles inside the VM. Host reset timing is an expiration upper bound, **not** a production force-remove benchmark.                                                                                       |
| Stdio/files          | Two streams held for at least 600 seconds, with repeated listTools; filesystem MCP stages at least 1 MiB as base64 and shell MCP decodes it; destruction closes both streams.                                                                                                                                                         |
| PTY                  | `docker exec -it`, initial 24×80, change to 37×91, verify remote `stty size` before and after.                                                                                                                                                                                                                                        |
| Context routing      | A fresh app-image probe mounts only one environment's default context, has no host socket, and launches both MCP streams with the SDK's limited child environment. Daemon identity must match the intended guest; no `DOCKER_HOST` pass-through is relied upon.                                                                       |
| Workloads            | Twenty samples each of a Python CPU loop, pandas CSV + xlsx, polars CSV and PyMuPDF PDF; synthetic 100k-row CSV/20-page PDF, no user files. Report each workload's p50/p95 on host and VM.                                                                                                                                            |
| Memory/concurrency   | Host baseline PID RSS vs VM QEMU PSS; 4 and 8 simultaneously executing boxes, p50/p95 CPU-work latency, sampled peak QEMU PSS and minimum host `MemAvailable`. RSS sums the baseline init process tree while both MCP servers are held open; PSS covers the whole environment VM with an active sandbox, not per-box incremental PSS. |
| Functional isolation | Positive guest-local daemon reachability, negative cross-environment daemon reachability, negative guest-to-host bridge canary reachability, and a no-network container failing to reach the guest's known-live daemon. Per-environment mTLS cross-refusal is tested separately.                                                      |

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

1. Record guest kernel, hypervisor/runtime version, exact local image digest,
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
requires a green original first and the named safety test to turn red for each
source change: remove rollback; remove the SSH configuration guard; remove the
DOCKER-USER allow; add a host container stop; leak a hostname into results;
widen the Incus cleanup prefix; widen the exec-token match; move the project
flag into guest argv; echo invalid private site input. These are offline
guard tests, not live compatibility evidence.

Implementation map for review (source locations on this change):

| Contract                                         | Source                                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survey and private output                        | [`sandbox_vm.py:118`](../../scripts/lib/sandbox_vm.py#L118), [`sandbox_vm.py:60`](../../scripts/lib/sandbox_vm.py#L60)                                                                                                                |
| Health/SSH checks and transaction failure policy | [`sandbox_vm.py:99`](../../scripts/lib/sandbox_vm.py#L99), [`sandbox_vm.py:544`](../../scripts/lib/sandbox_vm.py#L544)                                                                                                                |
| Ownership, rollback and forwarding               | [`sandbox_vm.py:213`](../../scripts/lib/sandbox_vm.py#L213), [`sandbox_vm.py:249`](../../scripts/lib/sandbox_vm.py#L249), [`sandbox_vm.py:344`](../../scripts/lib/sandbox_vm.py#L344)                                                 |
| TLS/context setup                                | [`sandbox_vm.py:385`](../../scripts/lib/sandbox_vm.py#L385)                                                                                                                                                                           |
| Generic result schema                            | [`sandbox_vm.py:145`](../../scripts/lib/sandbox_vm.py#L145)                                                                                                                                                                           |
| Bounded baseline and boot samples                | [`sandbox_vm_measure.py:72`](../../scripts/lib/sandbox_vm_measure.py#L72), [`sandbox_vm_measure.py:158`](../../scripts/lib/sandbox_vm_measure.py#L158)                                                                                |
| Staging, streams, PTY, default-context proof     | [`sandbox_vm_measure.py:207`](../../scripts/lib/sandbox_vm_measure.py#L207), [`sandbox_vm_measure.py:274`](../../scripts/lib/sandbox_vm_measure.py#L274)                                                                              |
| Memory, concurrent workload and isolation probes | [`sandbox_vm_measure.py:336`](../../scripts/lib/sandbox_vm_measure.py#L336), [`sandbox_vm_measure.py:360`](../../scripts/lib/sandbox_vm_measure.py#L360), [`sandbox_vm_measure.py:382`](../../scripts/lib/sandbox_vm_measure.py#L382) |

Upstream operational references:
[Incus firewall coexistence](https://linuxcontainers.org/incus/docs/main/howto/network_bridge_firewalld/),
[Incus VM creation](https://linuxcontainers.org/incus/docs/main/howto/instances_create/),
[Docker mutual TLS](https://docs.docker.com/engine/security/protect-access/).
