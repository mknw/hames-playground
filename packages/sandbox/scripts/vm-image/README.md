# Offline sandbox VM image pipeline

Operator tooling for [#648](https://github.com/mknw/hames-playground/issues/648),
owned by `@hames-ai/sandbox`. These scripts stay outside its published tarball
and TypeScript API. They produce a split Incus VM image (`metadata.tar` and
`disk.qcow2`) containing systemd, cloud-init, the Incus agent, Docker, Python 3,
`ip`, and the same three sandbox image configs as the input archives. SD-19,
SD-20 and SD-21 apply; an assembled disk is not isolation evidence.

Every invocation is a pure dry-run unless `--apply` is present. There is no
download, registry login/push, server connection, Incus operation, host package
installation or cloud operation. Values, input locks, private images and output
manifests belong outside Git, per [ADR-0008](../../../../docs/adr/0008-deployment-guidance-is-provider-neutral.md).
Run against synthetic/public inputs only. The operator reviews the base and
package provenance before approving their hashes; hashing alone does not
establish trust.

## Three different pins

| Pin                                                | Meaning and consumer                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sha256:<64 lowercase hex>` Docker image config ID | With Docker's **classic image store**, `docker image inspect --format '{{.Id}}' IMAGE`; survives `docker save` / `docker load`, is accepted directly by `docker run --pull=never`, and needs no registry. Use it for the spike's `--base-image`, `--data-image`, `--office-image` and optionally `--app-image`. |
| SHA256 of the saved archive                        | Verifies transfer/staging of that exact tar; **never** a Docker run selector. Different tar serializations can contain the same image config. The builder also hashes the config bytes and every uncompressed layer against its config's `rootfs.diff_ids`.                                                     |
| Incus fingerprint                                  | SHA256 of `metadata.tar` followed by `disk.qcow2`, in that order; identifies the complete split VM image. Supply this to #654's `image.fingerprint`. It is unrelated to a flavour's config ID.                                                                                                                  |

The config-ID invariant requires Docker's **classic image store** on the save
daemon, the guest build daemon and the boot daemon. Containerd snapshotters
are refused by name in `save` and guest customization; their inspect IDs are
not the config IDs this pipeline pins. Both stages record
`docker info --format '{{.Driver}}'`. Compare the boot daemon's driver with
`guest-inventory.json` before accepting the owed boot evidence.

The spike accepts config IDs additively alongside `name@sha256:<digest>`:
only its host-run admission and measure preflight validators change. Before
workloads, config inputs must equal host `inspect .Id`, and host/guest IDs
must match in both guests. Mutable tags and abbreviated IDs stay refused.
Existing flags, registry-pin behavior and `--pull=never` are unchanged. A
registry digest names a manifest; it must not be guessed from a config ID.

#654's environment controller selects a **VM image**, not individual flavour
images. Its existing 64-hex Incus fingerprint input needs no change. That PR's
HTTPS image-server transport still needs an operator-provided image server;
this pipeline does not publish one or add local-file import to that controller.
The spike can import the two local files directly. The builder does not issue
TLS certificates or write daemon endpoints. Both the spike and #654 provision
those after image assembly via `/etc/docker/daemon.json` and a systemd override.
The guest provides `/usr/bin/dockerd` for both consumers, adding a symlink to
the distro's `/usr/sbin/dockerd` when necessary.
Local `kg-sandbox:base`, `:data` and `:office` tags are also restored inside the
disk for the runtime's existing defaults; measurements use immutable IDs.

## Prepare pinned inputs outside the build

Use an operator-reviewed **Debian-family, native-architecture cloud qcow2**
with a kernel, bootloader and a sufficiently large root filesystem already
installed. Obtain it separately, verify the publisher's authenticated checksum,
then put that exact SHA256, image name and release/version in the local lock.
An unverified mirror checksum is insufficient. No mutable URL or release
alias is resolved by this builder. Supply a standalone disk without backing,
encryption or external data files. The builder refuses virtual sizes above
`max_virtual_bytes` and does not resize partitions or filesystems.

Prepare a complete offline `.deb` closure for that exact distro/architecture.
It must include `incus-agent`, `docker.io` (including the Docker CLI), `systemd`,
`python3`, `iproute2`, `cloud-init` and every dependency not already satisfied
by the base. Record each package name, exact dpkg version and file hash. Missing
dependencies fail `dpkg --configure -a`; no apt update/install/download or
fallback is available. The base must have no custom `/usr/sbin/policy-rc.d` or
`/etc/docker/daemon.json`; the builder refuses either instead of adopting it.
An Incus-compatible `incus-agent.service` and its virtio/vsock support must be
provided by that package/base combination. Distribution support is a Linux
boot-validation obligation below, not an offline test claim.

The sandbox flavours must already be built from reviewed source in a separate
process. The repo's current `rootfs/Dockerfile*` use mutable upstream package
repositories; this pipeline does **not** call those Dockerfiles or claim their
builds are reproducible. It consumes their exact config IDs and save archives.

To save from an explicitly selected **disposable** local daemon, review the
plan first; append `--apply` only when ready. The command performs three image
inspections and three saves, plus CLI version and daemon driver inspection,
never pull/build/run/tag on that daemon. Supply an absolute reviewed Docker CLI
path; its staged copy is hashed and its version recorded:

```bash
python3 packages/sandbox/scripts/vm-image/build.py save \
  --docker "$DOCKER_CLI" --docker-host "$DISPOSABLE_DOCKER_SOCKET" --work-dir "$FRESH_SAVE_DIR" \
  --architecture x86_64 \
  --base-image "$BASE_CONFIG_ID" --data-image "$DATA_CONFIG_ID" \
  --office-image "$OFFICE_CONFIG_ID"
```

Use `--architecture aarch64` only for a native ARM64 target. Each save archive
contains exactly one Linux image of the selected architecture; multi-image
archives, compressed archives, symlinks, duplicate members, traversal members,
config-ID mismatches and layer-hash mismatches are refused. No archive is
extracted to the host. `flavours.json` contains a `flavours` lock fragment with the three archive
hashes/IDs, plus the save daemon driver and Docker CLI path/hash/version.
The outer save tar must be uncompressed. Individual layer blobs may be raw or
gzip-compressed; verification also accepts separately prepared containerd-style
layer archives, but this does not enable a containerd daemon. Hashes use the
**uncompressed** bytes, with
an 8 GiB total expansion cap per image. Other layer codecs fail verification.
Copy its `flavours` object into the complete build lock. Add absolute paths to those
archives when placing the final lock elsewhere.

## Local lock schema (version 1)

Create the JSON lock privately. Every `path` is an existing local regular file
(absolute or relative to the lock), with no symlink in its path. No field
below has a network-resolved default:

| Field               | Required value                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`            | `1`                                                                                                                                                                                |
| `architecture`      | `x86_64` or `aarch64`, equal to the Linux runner architecture                                                                                                                      |
| `epoch`             | Fixed nonnegative integer timestamp for metadata; below 2³²                                                                                                                        |
| `max_virtual_bytes` | Positive integer cap, compatible with the target's VM disk budget                                                                                                                  |
| `base`              | `{ "name": "reviewed-cloud-image", "version": "exact-release", "path": "/local/cloud.qcow2", "sha256": "…64 lowercase hex…" }`                                                     |
| `packages`          | Array of `{ "name": "package-name", "version": "exact-dpkg-version", "path": "/local/package.deb", "sha256": "…64 lowercase hex…" }`, complete closure, no duplicate package names |
| `flavours`          | Object with exactly `base`, `data`, `office`; each value `{ "path": "/local/flavour.tar", "sha256": "…64 lowercase hex…", "image_id": "sha256:…64 lowercase hex…" }`               |
| `tools`             | Object with exactly `qemu-img`, `virt-customize`, `guestfish`; each value `{ "path": "/local/tool", "sha256": "…64 lowercase hex…", "version": "exact trimmed --version output" }` |

Pin the disposable Linux runner's OS/tool dependency closure separately (for
example an immutable runner-image checksum). Executable hashes alone do not
pin dynamic libraries, the kernel, supermin or the libguestfs appliance. The
pipeline pins and verifies its direct inputs; it does not claim byte-identical
qcow2 filesystem allocation/daemon databases across different runner images.
Incus fingerprints are calculated from each actual output, never predicted.

## Verify, then assemble on Linux

The work directory's parent must exist; the work directory itself must be
fresh. Reuse, overwrite, symlinks and escaping output paths are refused.
Every input is verified before staging and again after copying. Linux tools
run from private executable copies in that directory. Subprocesses receive only
a fixed system PATH, HOME/TMPDIR/cache paths in the work directory, the direct
libguestfs backend and `LC_ALL=C`; inherited loader settings are excluded. Partial state
is retained for private inspection on failure; no complete manifest is written.
Use a **different fresh directory** for each command; `build` repeats verify.

```bash
python3 packages/sandbox/scripts/vm-image/build.py verify \
  --lock "$LOCAL_LOCK" --work-dir "$FRESH_VERIFY_DIR"
# After review, append --apply. This stage works on macOS and never runs tools.

python3 packages/sandbox/scripts/vm-image/build.py build \
  --lock "$LOCAL_LOCK" --work-dir "$FRESH_BUILD_DIR"
# After review, append --apply on the disposable native Linux runner only.
```

The build converts the copied base to a standalone qcow2 and customizes only
that disk through `virt-customize --no-network`. Package service starts are
suppressed during offline installation. A temporary guest dockerd uses a Unix
socket, no bridge, no forwarding/NAT/iptables and the normal `/var/lib/docker`
data root. It loads and checks the three archives and tags, then shuts down;
the **image store is populated during assembly**, not deferred to first boot.
The same pinned guest Docker version uses its default image/storage backend
at assembly and boot. No custom storage driver is baked into daemon.json.
The actual appliance must support that Docker storage backend; failure is
fatal rather than falling back to another driver. Package/image inputs and
temporary logs are removed from the guest after loading. Cloud-init state
and machine identity are cleaned for cloning. SSH host keys and Docker engine
identity files are removed after daemon shutdown. The guest inventory records
`machine_id_state` and `ssh_host_keys`; assembly refuses a machine-id other than
empty/`uninitialized` or any SSH host key. Socket activation remains owned by
the provisioners; disabling a socket alone would not clear Docker
service dependencies.

The completed `manifest.json` records the complete lock (base identity/version
and all input hashes), tool versions/hashes, builder hash/Python version,
actual guest package inventory, flavour IDs, output hashes and Incus split
fingerprint. `guest-inventory.json` contains all installed package versions, the Docker
storage driver and clone-identity state. The manifest explicitly labels
`runner_closure` as `operator-pinned, not recorded`; it does not record the
runner appliance/library closure.
The metadata tar uses a fixed timestamp and five regular files: `metadata.yaml`
and four agent-rendered cloud-init seed templates (meta-data, user-data,
vendor-data, network-config). They consume `cloud-init.*`; the guest selects
NoCloud and clears any cloud-init-disabled marker. The default network seed
uses DHCPv4 on `eth0`, with IPv6 disabled; provisioning can supply its own
`cloud-init.network-config`. The spike still applies its reviewed static
address itself. Incus applies seed templates on create/copy and may reboot the
guest once; the owed readiness check must wait for that transition to settle.
Manifest status remains `assembled-not-boot-validated`; verify-only produces
`verified.json`, which must never be treated as a built-image manifest.

## Offline evidence and owed Linux evidence

```bash
python3 packages/sandbox/scripts/vm-image/build.test.py
python3 packages/sandbox/scripts/vm-image/build.test.py --mutations
shellcheck packages/sandbox/scripts/vm-image/customize.sh
```

The package's layer-1 vitest suite runs these hermetic Python tests and source
mutations. They use tiny synthetic archives, real file hashing/staging and
metadata assembly, subprocess shims for Linux stages, and the actual embedded
guest Python. Shell sections execute against fake roots and argv-recording
shims, including the real dockerd fragment. They do not run Docker or boot a VM.

The committed `mutations()` matrix names each edit and its discriminating test.
It retains all 22 authored mutations and adds stage-entry refusals for image
identity and disk checks, archive structure, private modes, environment and
provenance, guest loads/tags/store, adoption and clone cleanup. Every mutation
must cause an assertion failure in its named test, rather than an import or
subprocess error. The root harness matrix also pins 12/63-character config-ID
refusals and full equality when the first 12 hex characters match.

**Still owed to a disposable native Linux runner:** supply authenticated real
base/deb archives and pinned tools/appliance; run conversion and offline dpkg;
prove temporary dockerd starts, loads and shuts down with its actual storage
backend; inspect the resulting image store at boot; import metadata+disk into
a fresh Incus VM; prove agent exec, systemd/cloud-init readiness, Python and
`ip`, and all three `inspect .Id` values after provisioning's Docker mTLS
configuration. Compare `docker info --format '{{.Driver}}'` with the recorded
guest build driver. Then run the separately authorized spike to establish the
host/guest paired measurements and isolation controls. No real base/deb/image
build, Docker-side daemon stage, disk customization, Incus import or boot was
performed on macOS for this change. No default colima VM was touched or
throwaway profile created.

Sources: [Incus split image format](https://linuxcontainers.org/incus/docs/main/reference/image_format/),
[virt-customize](https://libguestfs.org/virt-customize.1.html),
[Incus cloud-init seed requirements](https://linuxcontainers.org/incus/docs/main/cloud-init/),
[Docker save](https://docs.docker.com/reference/cli/docker/image/save/) and
[Docker load](https://docs.docker.com/reference/cli/docker/image/load/).
