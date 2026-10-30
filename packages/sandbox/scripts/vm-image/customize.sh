#!/bin/sh
# Runs ONLY in the offline libguestfs appliance against the copied guest disk.
set -eu
cd /opt/vm-image
test ! -e /usr/sbin/policy-rc.d
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
# apt, not dpkg --unpack + --configure -a: a Pre-Depends upgrade (systemd on
# its shared library) needs the dependency CONFIGURED first, and only apt orders
# that. Its ONLY source is a flat file: repository over these hash-verified
# debs (the appliance has no network either); the lock's exact versions install.
mkdir -p /opt/vm-image/repo-lists/partial
for deb in /opt/vm-image/*.deb; do
  dpkg-deb -f "$deb"
  printf 'Filename: %s\nSize: %s\nSHA256: %s\n\n' "${deb##*/}" "$(wc -c < "$deb" | tr -d ' ')" \
    "$(sha256sum "$deb" | cut -d ' ' -f 1)"
done > /opt/vm-image/Packages
printf 'deb [trusted=yes] file:/opt/vm-image ./\n' > /opt/vm-image/local.list
set -- -o Dir::Etc::SourceList=/opt/vm-image/local.list -o Dir::Etc::SourceParts=/opt/vm-image/repo-lists \
  -o Dir::State::Lists=/opt/vm-image/repo-lists
apt-get "$@" update >&2
# shellcheck disable=SC2046 # one name=version word per lock package
apt-get "$@" install -y --no-install-recommends --no-remove -o Dpkg::Options::=--force-confold \
  $(python3 -c 'import json; print(" ".join(p["name"] + "=" + p["version"] for p in json.load(open("guest-lock.json"))["packages"]))') \
  >&2  # stderr reaches failed-stage.log
apt-get "$@" clean
set --
python3 - <<'PY'
import json, subprocess
with open('guest-lock.json') as stream:
    lock = json.load(stream)
for package in lock['packages']:
    actual = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', package['name']], text=True)
    if actual != package['version']:
        raise SystemExit('guest package version mismatch')
PY
for binary in dockerd docker systemctl python3 ip; do
  command -v "$binary"
done
# Both provisioning consumers use this fixed path; Debian ships it in sbin.
if [ ! -e /usr/bin/dockerd ]; then
  test -x /usr/sbin/dockerd
  ln -s /usr/sbin/dockerd /usr/bin/dockerd
fi
test -x /usr/bin/dockerd
# The package/base must supply the agent unit and virtio/vsock support.
test -x /usr/libexec/incus/incus-agent || command -v incus-agent
# Discover the installed layout, never guess it from a distro/version label.
has_unit() {
  test -f "/usr/lib/systemd/system/$1" || test -f "/lib/systemd/system/$1"
}
set --
for unit in cloud-init.service cloud-init-main.service cloud-init-network.service; do
  if has_unit "$unit"; then
    set -- "$@" "$unit"
  fi
done
case "$*" in
  'cloud-init.service' | 'cloud-init-main.service cloud-init-network.service') ;;
  *) printf 'Unsupported cloud-init unit layout (found: %s)\n' "${*:-none}" >&2; exit 1 ;;
esac
set -- incus-agent.service docker.service cloud-init-local.service cloud-config.service cloud-final.service "$@"
# The target is static: cloud-init-generator pulls it in at boot.
for unit in "$@" cloud-init.target; do
  if ! has_unit "$unit"; then
    printf 'Missing required guest unit: %s\n' "$unit" >&2
    exit 1
  fi
done
systemctl enable "$@"
printf '%s\n' "$@" > enabled-units.txt
# incus-agent is the only guest agent. Ubuntu's lxd-agent-loader wants
# lxd-agent.service on the LXD-compatible virtio port Incus also exposes; its
# setup starts a second incus-agent, which rewrites the running agent's binary
# and then crash-loops on the vsock port. Masked (the running environments carry
# this same link), not purged, and masked whether or not the base ships it.
systemctl mask lxd-agent.service
# Run the agent the HOST serves on its config drive (copied to /run/incus_agent
# by incus-agent-setup), as upstream's own unit does: it matches the host's
# Incus version, where the packaged binary is the distro's (6.0.x) build.
# The drop-in relies on the unit's ExecStartPre copying it there: refuse without.
grep -qs '^ExecStartPre=.*incus-agent-setup' /usr/lib/systemd/system/incus-agent.service \
  /lib/systemd/system/incus-agent.service \
  || { echo 'incus-agent.service does not run incus-agent-setup' >&2; exit 1; }
mkdir -p /etc/systemd/system/incus-agent.service.d
printf '[Service]\nExecStart=\nExecStart=/run/incus_agent/incus-agent\n' \
  > /etc/systemd/system/incus-agent.service.d/host-agent.conf
# Provisioning owns daemon.json and docker.service.d, including socket activation.
# Refuse site configuration rather than adopting it.
test ! -e /etc/docker/daemon.json
# Same classic overlay2 store the provisioners pin at boot. Docker 29 otherwise
# defaults to the containerd snapshotter, and an absent driver must not fall back.
printf '{"features":{"containerd-snapshotter":false},"storage-driver":"overlay2"}\n' > /opt/vm-image/assembly-daemon.json
# Diagnostics (stderr reaches failed-stage.log only on failure): moby panics in
# Shutdown before printing a NewDaemon error, so show the storage preconditions.
{
  printf 'appliance kernel: %s\n' "$(uname -r)"
  grep -w overlay /proc/filesystems || echo 'overlay: not registered'
  mkdir -p /run/vm-image-probe/l /run/vm-image-probe/u /run/vm-image-probe/w /run/vm-image-probe/m
  if mount -t overlay overlay -o lowerdir=/run/vm-image-probe/l,upperdir=/run/vm-image-probe/u,workdir=/run/vm-image-probe/w /run/vm-image-probe/m; then
    echo 'overlay mount: ok'; umount /run/vm-image-probe/m
  else
    echo 'overlay mount: failed'
  fi
  rm -rf /run/vm-image-probe
  printf 'cgroup: %s\n' "$(stat -f -c %T /sys/fs/cgroup 2>/dev/null || echo absent)"
} >&2
# dockerd requires a cgroup hierarchy; the appliance does not mount one.
cgroup_mounted=
if [ "$(stat -f -c %T /sys/fs/cgroup 2>/dev/null)" != cgroup2fs ]; then
  mkdir -p /sys/fs/cgroup
  mount -t cgroup2 none /sys/fs/cgroup
  cgroup_mounted=1
fi
dockerd --debug --config-file /opt/vm-image/assembly-daemon.json \
  --host unix:///run/vm-image-docker.sock --pidfile /run/vm-image-docker.pid \
  --exec-root /run/vm-image-docker --data-root /var/lib/docker \
  --bridge none --iptables=false --ip6tables=false --ip-forward=false --ip-masq=false \
  > /opt/vm-image/dockerd.log 2>&1 &
daemon_pid=$!
cleanup() {
  kill "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
  if [ -n "$cgroup_mounted" ]; then umount /sys/fs/cgroup || true; fi
  rm -f /usr/sbin/policy-rc.d
}
trap cleanup EXIT
ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  attempt=$((attempt + 1))
  if docker --host unix:///run/vm-image-docker.sock info > /dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$daemon_pid" 2>/dev/null || { tail -c 20000 /opt/vm-image/dockerd.log >&2; exit 1; }
  sleep 1
done
test "$ready" = 1
python3 - <<'PY'
import hashlib, json, subprocess
with open('guest-lock.json') as stream:
    lock = json.load(stream)
docker = ['docker', '--host', 'unix:///run/vm-image-docker.sock']
driver = subprocess.check_output([*docker, 'info', '--format', '{{.Driver}}'], text=True).strip()
if driver != 'overlay2':
    raise SystemExit('containerd snapshotter unsupported; classic overlay2 Docker image store required')
images = {}
for flavour, record in lock['flavours'].items():
    path = flavour + '.tar'
    value = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    if value.hexdigest() != record['sha256']:
        raise SystemExit('guest archive checksum mismatch')
    subprocess.run([*docker, 'load', '--input', path], check=True)
    actual = subprocess.check_output([*docker, 'image', 'inspect', '--format', '{{.Id}}', record['image_id']], text=True).strip()
    if actual != record['image_id']:
        raise SystemExit('guest image ID mismatch')
    images[flavour] = actual
# Restore every runtime tag after ALL loads, so archive tags cannot overwrite
# an earlier flavour's final tag. The harness measures by config ID.
for flavour, actual in images.items():
    subprocess.run([*docker, 'tag', actual, 'kg-sandbox:' + flavour], check=True)
packages = dict(line.split('\t', 1) for line in subprocess.check_output(
    ['dpkg-query', '-W', '-f=${Package}\t${Version}\n'], text=True).splitlines())
with open('inventory.json', 'w') as stream:
    with open('enabled-units.txt') as units:
        json.dump({'images': images, 'packages': packages, 'docker_driver': driver,
                   'enabled_units': units.read().splitlines()}, stream, sort_keys=True)
PY
cleanup
trap - EXIT
rm -f ./*.deb ./*.tar ./dockerd.log ./assembly-daemon.json ./enabled-units.txt
rm -rf ./repo-lists ./Packages ./local.list
# Remove clone identity and cached cloud-init instance data, never site values.
cloud-init clean --logs
# machine-id: EMPTY, never absent. The guest root is read-only when PID 1 sets
# the ID, and systemd cannot create a missing file there, so the guest would run
# every boot with no machine ID (networkd's DHCPv6 DUID then fails the whole
# link). An empty file is not a first boot: PID 1 over-mounts a fresh ID and
# systemd-machine-id-commit writes it once / is writable. (cloud-init's own
# --machine-id deletes the file here: no systemd runs in the appliance.)
rm -f /etc/machine-id
: > /etc/machine-id
chmod 444 /etc/machine-id
rm -f /etc/ssh/ssh_host_*
rm -f /var/lib/docker/engine-id /var/lib/docker/key.json
python3 - <<'PY'
import glob, json, os
from pathlib import Path
with open('inventory.json') as stream:
    inventory = json.load(stream)
# Record every state distinctly: an absent file once read as '' and passed.
machine_id = Path('/etc/machine-id')
if machine_id.is_symlink():
    inventory['machine_id_state'] = 'symlink'
elif not machine_id.exists():
    inventory['machine_id_state'] = 'absent'
elif not machine_id.is_file():
    inventory['machine_id_state'] = 'not-regular'
elif machine_id.stat().st_size == 0:
    inventory['machine_id_state'] = 'empty'
else:
    inventory['machine_id_state'] = 'uninitialized' if machine_id.read_text().strip() == 'uninitialized' else 'populated'
# systemd takes the D-Bus ID first when /etc/machine-id is empty: a real file
# here would hand every clone the same machine ID.
dbus = '/var/lib/dbus/machine-id'
inventory['dbus_machine_id'] = ('link' if os.path.islink(dbus) and os.readlink(dbus) == '/etc/machine-id'
                                else 'absent' if not os.path.lexists(dbus) else 'other')
lxd_agent = '/etc/systemd/system/lxd-agent.service'
inventory['lxd_agent_masked'] = os.path.islink(lxd_agent) and os.readlink(lxd_agent) == '/dev/null'
inventory['ssh_host_keys'] = sorted(glob.glob('/etc/ssh/ssh_host_*'))
with open('inventory.json', 'w') as stream:
    json.dump(inventory, stream, sort_keys=True)
PY
# Agent-rendered NoCloud seeds take precedence over the source cloud's driver.
mkdir -p /etc/cloud/cloud.cfg.d
printf 'datasource_list: [NoCloud]\n' > /etc/cloud/cloud.cfg.d/99-sandbox-vm.cfg
rm -f /etc/cloud/cloud-init.disabled
