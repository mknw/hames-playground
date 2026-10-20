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
# that. --no-download keeps it offline; it can only use these local files.
apt-get install -y --no-install-recommends --no-download \
  -o Dpkg::Options::=--force-confold ./*.deb
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
# Run the agent the HOST serves on its config drive (copied to /run/incus_agent
# by incus-agent-setup), as upstream's own unit does: it matches the host's
# Incus version, where the packaged binary is the distro's (6.0.x) build.
mkdir -p /etc/systemd/system/incus-agent.service.d
printf '[Service]\nExecStart=\nExecStart=/run/incus_agent/incus-agent\n' \
  > /etc/systemd/system/incus-agent.service.d/host-agent.conf
# Provisioning owns daemon.json and docker.service.d, including socket activation.
# Refuse site configuration rather than adopting it.
test ! -e /etc/docker/daemon.json
# Same classic overlay2 store the provisioners pin at boot. Docker 29 otherwise
# defaults to the containerd snapshotter, and an absent driver must not fall back.
printf '{"features":{"containerd-snapshotter":false},"storage-driver":"overlay2"}\n' > /opt/vm-image/assembly-daemon.json
dockerd --config-file /opt/vm-image/assembly-daemon.json \
  --host unix:///run/vm-image-docker.sock --pidfile /run/vm-image-docker.pid \
  --exec-root /run/vm-image-docker --data-root /var/lib/docker \
  --bridge none --iptables=false --ip6tables=false --ip-forward=false --ip-masq=false \
  > /opt/vm-image/dockerd.log 2>&1 &
daemon_pid=$!
cleanup() {
  kill "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
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
  kill -0 "$daemon_pid"
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
# Remove clone identity and cached cloud-init instance data, never site values.
cloud-init clean --logs --machine-id
rm -f /etc/ssh/ssh_host_*
rm -f /var/lib/docker/engine-id /var/lib/docker/key.json
python3 - <<'PY'
import glob, json
from pathlib import Path
with open('inventory.json') as stream:
    inventory = json.load(stream)
inventory['machine_id_state'] = Path('/etc/machine-id').read_text().strip()
inventory['ssh_host_keys'] = sorted(glob.glob('/etc/ssh/ssh_host_*'))
with open('inventory.json', 'w') as stream:
    json.dump(inventory, stream, sort_keys=True)
PY
# Agent-rendered NoCloud seeds take precedence over the source cloud's driver.
mkdir -p /etc/cloud/cloud.cfg.d
printf 'datasource_list: [NoCloud]\n' > /etc/cloud/cloud.cfg.d/99-sandbox-vm.cfg
rm -f /etc/cloud/cloud-init.disabled
