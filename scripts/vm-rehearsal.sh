#!/usr/bin/env bash
# Rehearse the VM track end to end on a DISPOSABLE GitHub-hosted runner (#648):
# the image pipeline (fetch + verify, grow, closure, flavours, save, verify,
# build), then Incus from the pinned upstream source, then the spike's
# --install --provision --tls --measure --cleanup, then the source's undo.
#
# Refuses anywhere else: it installs packages, changes the firewall and starts
# VMs with none of the live host's safeguards (its witness always passes, it
# allow-lists the package plan it finds, and it moves /var/lib/incus to /mnt).
# Everything it pins is public; nothing it uses is secret.
set -euo pipefail

if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted ]]; then
  echo "refused: this rehearsal runs only on a disposable GitHub-hosted runner" >&2
  exit 2
fi
[[ $EUID == 0 ]] || exec sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,REHEARSAL_STOP_AFTER "$0" "$@"

REPO=$(cd "$(dirname "$0")/.." && pwd)
PIPE=$REPO/packages/sandbox/scripts/vm-image
W=/mnt/rehearsal
STATE=$REPO/.sandbox-vm-spike
# Public pins: the same base serial as run 4's inputs.
SERIAL=20260927
IMAGES=https://cloud-images.ubuntu.com/releases/resolute/release-$SERIAL
BASE=ubuntu-26.04-server-cloudimg-amd64
BASE_SHA=8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2
GROW=10G
NODE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
DOCKER_CLI=docker:29.9.1-cli@sha256:6fae2214c3121a28d5aa639d09032f61310b7c9c75ffbad1025f261a1b621800
BUILDER=sbxs-vmimage-builder:rehearsal

group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
stop_after() { [[ ${REHEARSAL_STOP_AFTER:-} == "$1" ]] && { echo "stopping after $1 as requested"; exit 0; } || true; }
builder() { # offline libguestfs stage; KVM required, no TCG fallback
  docker run -i --rm --network none --device /dev/kvm --cap-drop ALL --security-opt no-new-privileges \
    --memory 6g --memory-swap 6g --pids-limit 4096 \
    -v "$PIPE":/pipe:ro -v "$W":/w -w /w "$BUILDER" "$@"
}

group "capacity"
test -c /dev/kvm || { echo "no /dev/kvm on this runner" >&2; exit 1; }
grep -cE 'vmx|svm' /proc/cpuinfo
cat /sys/module/kvm_*/parameters/{ept,npt,nested} 2>/dev/null || true
nproc; free -g; df -h / /mnt
docker version --format '{{.Server.Version}}'; docker info --format '{{.Driver}}'
mkdir -p "$W" && chmod 0700 "$W"
endgroup

group "1. base image: signed checksums, pinned sha256"
apt-get install -y -qq ubuntu-cloudimage-keyring gpgv >/dev/null
mkdir -p "$W/inputs"
for file in "$BASE.img" "$BASE.manifest" SHA256SUMS SHA256SUMS.gpg; do
  curl -fsSL --retry 3 -o "$W/inputs/$file" "$IMAGES/$file"
done
gpgv --keyring /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg "$W/inputs/SHA256SUMS.gpg" "$W/inputs/SHA256SUMS"
grep -F "$BASE_SHA *$BASE.img" "$W/inputs/SHA256SUMS"
(cd "$W/inputs" && grep -E " \*$BASE\.(img|manifest)\$" SHA256SUMS | sed 's/ \*/  /' | sha256sum -c -)
endgroup

group "2. builder image"
docker build --progress=plain -t "$BUILDER" -f "$PIPE/builder.Dockerfile" "$PIPE"
endgroup

group "3. grow the base disk (R0)"
mkdir -p "$W/derived"
builder python3 /pipe/grow_base.py --stock "/w/inputs/$BASE.img" --output /w/derived/base.qcow2 --size $GROW --apply \
  > "$W/derived/provenance.json"
python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["derived_sha256"], p["before"]["count"], p["after"]["root_bytes"])' "$W/derived/provenance.json"
endgroup
stop_after grow

group "4. guest .deb closure, resolved against the base image's own dpkg status"
mkdir -p "$W/debs"
builder guestfish --ro --format=qcow2 -a "/w/inputs/$BASE.img" -i download /var/lib/dpkg/status /w/inputs/dpkg.status
docker run --rm -v "$PIPE":/pipe:ro -v "$W/inputs/dpkg.status":/status:ro -v "$W/debs":/out "$BUILDER" \
  python3 /pipe/closure.py --status /status --out /out --codename resolute --apply
endgroup

group "5. flavours, then save"
docker build -q -t kg-sandbox:base -t sbxs-rehearsal/base:run -f "$REPO/rootfs/Dockerfile" "$REPO/rootfs"
docker build -q -t sbxs-rehearsal/data:run -f "$REPO/rootfs/Dockerfile.data" "$REPO/rootfs"
docker build -q -t sbxs-rehearsal/office:run -f "$REPO/rootfs/Dockerfile.office" "$REPO/rootfs"
docker build -q -t sbxs-rehearsal/app:run - <<EOF
FROM $NODE
COPY --from=$DOCKER_CLI /usr/local/bin/docker /usr/local/bin/docker
EOF
DRIVER=$(docker info --format '{{.Driver}}')
selector() { # config ID on the classic store; immutable name@manifest on containerd
  local id; id=$(docker image inspect --format '{{.Id}}' "$1")
  if [[ $DRIVER == overlayfs || $DRIVER == *containerd* ]]; then echo "${1%:*}@$id"; else echo "$id"; fi
}
BASE_IMAGE=$(selector sbxs-rehearsal/base:run); DATA_IMAGE=$(selector sbxs-rehearsal/data:run)
OFFICE_IMAGE=$(selector sbxs-rehearsal/office:run); APP_IMAGE=$(selector sbxs-rehearsal/app:run)
echo "store=$DRIVER base=$BASE_IMAGE"
python3 "$PIPE/build.py" save --apply --docker "$(command -v docker)" --docker-host unix:///var/run/docker.sock \
  --work-dir "$W/save" --architecture x86_64 \
  --base-image "$BASE_IMAGE" --data-image "$DATA_IMAGE" --office-image "$OFFICE_IMAGE"
endgroup

group "6. lock (tool hashes and versions read inside the builder)"
builder python3 - <<'PY'
import hashlib, json, os, subprocess
def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()
provenance = json.load(open("/w/derived/provenance.json"))
debs = json.load(open("/w/debs/packages.json"))["packages"]
flavours = json.load(open("/w/save/flavours.json"))["flavours"]
tools = {}
for name in ("qemu-img", "virt-customize", "guestfish"):
    path = os.path.realpath("/usr/bin/" + name)  # the lock refuses symlinked inputs
    version = subprocess.run([path, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    tools[name] = {"path": path, "sha256": sha(path), "version": version}
lock = {"schema": 1, "architecture": "x86_64", "epoch": 1760000000,
        "max_virtual_bytes": 10 * 1024 ** 3,
        "base": {"name": "ubuntu-resolute-cloudimg-amd64-grown", "version": "20260927+grow-10G",
                 "path": "derived/base.qcow2", "sha256": provenance["derived_sha256"]},
        "packages": [{**p, "path": "debs/" + p["path"]} for p in debs],
        "flavours": {k: {**v, "path": "save/" + v["path"]} for k, v in flavours.items()},
        "tools": tools}
json.dump(lock, open("/w/lock.json", "w"), indent=2)
print(len(debs), "packages;", ", ".join(sorted(flavours)))
PY
test -s "$W/lock.json"
endgroup

group "7. verify, then build (offline, KVM)"
builder python3 /pipe/build.py verify --apply --lock /w/lock.json --work-dir /w/verify
rm -rf "$W/verify"
if ! builder python3 /pipe/build.py build --apply --lock /w/lock.json --work-dir /w/build; then
  cat "$W/build/failed-stage.log" 2>/dev/null | tail -c 20000
  exit 1
fi
python3 -c 'import json,sys; i=json.load(open(sys.argv[1])); print(i["docker_driver"], i["enabled_units"])' "$W/build/guest-inventory.json"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["incus_fingerprint"])' "$W/build/manifest.json"
endgroup
stop_after build

group "8. Incus from the pinned upstream source"
docker image rm "$BUILDER" >/dev/null
rm -rf "$W/derived" "$W/debs" "$W/inputs"
mkdir -p /mnt/incus /var/lib/incus && mount --bind /mnt/incus /var/lib/incus  # runner-only: disk lives on /mnt
mkdir -p "$STATE" && chmod 0700 "$STATE"
curl -fsSL -o "$STATE/upstream-key.asc" https://pkgs.zabbly.com/key.asc
python3 "$REPO/scripts/lib/sandbox_vm.py" source --apply --key "$STATE/upstream-key.asc"
INCUS_VERSION=$(apt-cache madison incus | awk -F'|' 'NR == 1 { gsub(/ /, "", $2); print $2 }')
DNSMASQ_VERSION=$(dpkg-query -W -f='${Version}' dnsmasq-base 2>/dev/null \
  || apt-cache policy dnsmasq-base | awk '/Candidate:/ { print $2 }')
echo "incus=$INCUS_VERSION dnsmasq-base=$DNSMASQ_VERSION"
ALLOW=()
while read -r package; do ALLOW+=(--allow-package "$package"); done < <(
  apt-get --simulate install --no-install-recommends "incus=$INCUS_VERSION" "incus-base=$INCUS_VERSION" \
    "incus-client=$INCUS_VERSION" "dnsmasq-base=$DNSMASQ_VERSION" | awk '/^Inst/ { print $2 }')
echo "plan: ${ALLOW[*]}"
endgroup

group "9. site inputs a live host would supply"
command -v ufw >/dev/null || apt-get install -y -qq ufw >/dev/null  # installed inactive, as preflight reads it
apt-get install -y -qq qemu-utils >/dev/null  # host qemu-img: preflight reads the image (live host: change A)
id sbxs-kvm >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -G kvm sbxs-kvm
printf '#!/bin/sh\n# Rehearsal only: a runner has no independent SSH path to witness.\nexit 0\n' > /usr/local/sbin/sbxs-witness
chmod 0755 /usr/local/sbin/sbxs-witness
docker network create -o com.docker.network.bridge.name=sbxsapp0 sbxs-app >/dev/null
docker network create sbxs-probe >/dev/null
docker pull -q "$NODE" >/dev/null
docker run -d --name sbxs-canary --network sbxs-app --pull=never "$NODE" \
  node -e "require('net').createServer(s => s.end('ok')).listen(5432)" >/dev/null
CANARY=$(docker inspect -f '{{(index .NetworkSettings.Networks "sbxs-app").IPAddress}}' sbxs-canary):5432
bash "$REPO/scripts/sandbox-vm-survey.sh" --state "$STATE/survey"
endgroup

group "10. spike: install, provision, TLS, measure, cleanup"
UNIT=sbxs-run-$(openssl rand -hex 6)
ARGS=(--install --provision --tls --measure --cleanup
  --survey "$STATE/survey" --state "$STATE/run"
  --ssh-probe /usr/local/sbin/sbxs-witness --kvm-user sbxs-kvm
  --incus-version "$INCUS_VERSION" --dnsmasq-version "$DNSMASQ_VERSION" "${ALLOW[@]}"
  --image-metadata "$W/build/metadata.tar" --image-rootfs "$W/build/disk.qcow2"
  --network 10.231.0.1/24 --network 10.232.0.1/24
  --app-bridge sbxsapp0 --app-network sbxs-app --probe-network sbxs-probe --data-canary "$CANARY"
  --base-image "$BASE_IMAGE" --data-image "$DATA_IMAGE" --office-image "$OFFICE_IMAGE" --app-image "$APP_IMAGE"
  --vm-disk 10GiB --disk-cap 30GiB)
bash "$REPO/scripts/sandbox-vm-spike.sh" "${ARGS[@]}"
systemd-run --unit="$UNIT" --collect -p KillMode=mixed -p TimeoutStopSec=900 -p RuntimeMaxSec=infinity \
  --working-directory="$REPO" /bin/bash "$REPO/scripts/sandbox-vm-spike.sh" --apply --launcher-unit="$UNIT" "${ARGS[@]}"
while systemctl is-active -q "$UNIT"; do
  sleep 60
  echo "$(date -u +%H:%MZ) $(cat "$STATE/run/commands.private.jsonl" 2>/dev/null | wc -l) commands"
done

journalctl -u "$UNIT" --no-pager -o cat | tail -n 40
endgroup

group "11. results"
status=0
cat "$STATE/run/results.json" || status=1
if [[ -f $STATE/run/failure.private.txt ]]; then
  status=1
  cat "$STATE/run/failure.private.txt"
  echo "rollback: $(cat "$STATE/run/rollback.private.json" 2>/dev/null)"
  # Synthetic runner values only; the last failed commands are the diagnosis.
  python3 - "$STATE/run/commands.private.jsonl" <<'PY'
import json, sys
entries = [json.loads(line) for line in open(sys.argv[1])]
# Rollback starts with the firewall reversals; show what ran just before it.
start = next((i for i, e in enumerate(entries) if e["argv"][:3] in (["iptables", "-w", "-D"], ["nft", "delete", "table"])
              or e["argv"][:3] == ["ufw", "route", "delete"]), len(entries))
for entry in entries[max(0, start - 15):start]:
    print(entry["exit"], " ".join(entry["argv"])[:400], "|", (entry["stderr"] or entry["stdout"])[-600:].strip())
PY
fi
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r["completed_steps"] == ["install","provision","tls","measure","cleanup"] else 1)' \
  "$STATE/run/results.json" || status=1
endgroup

group "12. undo the upstream source"
python3 "$REPO/scripts/lib/sandbox_vm.py" source --apply --remove || status=1
endgroup
exit $status
