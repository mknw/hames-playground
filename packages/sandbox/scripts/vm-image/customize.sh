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
dpkg --unpack ./*.deb
dpkg --configure -a
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
systemctl enable incus-agent.service docker.service cloud-init-local.service cloud-init.service cloud-config.service cloud-final.service
# This image has no endpoint, certificate or site configuration. Provisioning
# owns daemon.json and docker.service.d. Disable socket activation until then.
systemctl disable docker.socket
test ! -e /etc/docker/daemon.json
printf '{}\n' > /opt/vm-image/empty-daemon.json
dockerd --config-file /opt/vm-image/empty-daemon.json \
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
    json.dump({'images': images, 'packages': packages}, stream, sort_keys=True)
PY
cleanup
trap - EXIT
rm -f ./*.deb ./*.tar ./dockerd.log ./empty-daemon.json
# Remove clone identity and cached cloud-init instance data, never site values.
cloud-init clean --logs --machine-id
