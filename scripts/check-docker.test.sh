#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Pins scripts/check-docker.sh's version gate with a `docker` shim on PATH —
# no daemon is ever contacted. Run: scripts/check-docker.test.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="${CHECK_DOCKER_SCRIPT:-$ROOT/scripts/check-docker.sh}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0

cat >"$tmp/docker" <<'SHIM'
#!/usr/bin/env bash
[[ -n ${SHIM_DOCKER_DOWN:-} ]] && exit 1
echo "$SHIM_DOCKER_VERSION"
SHIM
chmod +x "$tmp/docker"

# run VERSION — exit status of the script against a daemon reporting VERSION.
run() { PATH="$tmp:$PATH" SHIM_DOCKER_VERSION="$1" bash "$SCRIPT" >"$tmp/out" 2>&1; }
expect() { # want-rc version
  run "$2"; local rc=$?
  if ((rc == $1)); then printf 'ok   %s -> %s\n' "$2" "$rc"
  else printf 'FAIL %s -> %s (wanted %s)\n' "$2" "$rc" "$1"; failures=$((failures + 1)); fi
}

expect 1 "27.4.0"
expect 1 "9.9.9"
expect 1 "garbage"
expect 1 ""
expect 0 "28.0.0"
expect 0 "28.0.1-rd"
expect 0 "29.2.1"
expect 0 "28.5.2"
expect 0 "28.0.0-rc1"
expect 1 "27.99.99"
expect 1 "28.0"
expect 0 "100.0.0"

PATH="$tmp:$PATH" SHIM_DOCKER_DOWN=1 bash "$SCRIPT" >"$tmp/out" 2>&1
rc=$?
if ((rc == 1)) && grep -q unavailable "$tmp/out"; then echo "ok   unreachable daemon fails closed"
else echo "FAIL unreachable daemon (rc=$rc)"; failures=$((failures + 1)); fi

# docker missing from PATH entirely (empty dir + absolute bash)
mkdir "$tmp/empty"
PATH="$tmp/empty" "$(command -v bash)" "$SCRIPT" >"$tmp/out" 2>&1
rc=$?
if ((rc == 1)) && grep -q unavailable "$tmp/out"; then echo "ok   missing docker fails closed"
else echo "FAIL missing docker (rc=$rc)"; failures=$((failures + 1)); fi

# an inherited env var must never turn the gate off
HAMES_CHECK_DOCKER_SOURCED=1 run "27.4.0"; rc=$?
if ((rc == 1)); then echo "ok   no env switch bypasses the gate"
else echo "FAIL env var bypassed the gate (rc=$rc)"; failures=$((failures + 1)); fi

run "27.4.0"
if grep -q "colima update" "$tmp/out"; then echo "ok   refusal names the fix"
else echo "FAIL refusal does not name colima update"; failures=$((failures + 1)); fi

((failures)) && { echo "$failures check(s) failed"; exit 1; }
echo "all checks passed"
