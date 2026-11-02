#!/usr/bin/env bash
# Offline first-mutation gate test: Docker and git are stubs, no host touched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat >"$TMP/.env" <<'ENV'
COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml
COMPOSE_PROFILES=app
ENV
cat >"$TMP/bin/git" <<'SH'
#!/bin/sh
case "$*" in
  'show '*) printf 'services: {}\n' ;;
  *) exit 99 ;;
esac
SH
cat >"$TMP/bin/docker" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$TRACE"
case "$*" in
  *'config --format json')
    printf '{"name":"hames","services":{"app":{},"caddy":{},"mcp-gateway":{},"embedder":{"mem_limit":"3221225472"},"mcp-config":{}}}\n' ;;
  *'config --hash *')
    for service in app caddy mcp-gateway embedder mcp-config; do
      printf '%s %064d\n' "$service" 0
    done ;;
  *'--dry-run --progress json up -d --remove-orphans')
    printf '{"dry-run":true,"id":"Container hames-app-1","status":"Starting"}\n' >&2 ;;
  'compose stop app') ;;
  *) printf 'unexpected docker call: %s\n' "$*" >&2; exit 99 ;;
esac
SH
chmod +x "$TMP/bin/git" "$TMP/bin/docker"
TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
GATE="${APP_UPGRADE_GATE_PATH:-$ROOT/scripts/app-upgrade-gate.py}"
export TRACE="$TMP/trace" PATH="$TMP/bin:$PATH"
python3 - "$ROOT/docs/deployment/app-upgrade.md" >"$TMP/first-mutation.sh" <<'PY'
import re, sys
blocks = re.findall(r"```sh\n(.*?)\n```", open(sys.argv[1]).read(), re.S)
block = next(block for block in blocks if "docker compose stop app" in block)
lines = block.splitlines()
assert lines[:2] == [
    'python3 "$gate_copy" prestop "$TARGET_SHA" "$prediction" || exit 1',
    'docker compose stop app || exit 1',
]
print("\n".join(lines[:2]))
PY
cd "$TMP"

# Execute the runbook's first mutating command pair in a fake shell.
stop_block() {
  gate_copy="$GATE" prediction="$TMP/prediction.json" TARGET_SHA="$TARGET_SHA" \
    bash "$TMP/first-mutation.sh"
}
: >"$TRACE"
if stop_block >"$TMP/out" 2>&1; then exit 1; fi
if grep -q '^compose stop app$' "$TRACE"; then exit 1; fi
echo 'PASS first mutation refuses missing prediction artifact'

python3 "$GATE" predict "$TARGET_SHA" "$TMP/prediction.json" >"$TMP/out"
python3 - "$TMP/prediction.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["target_hashes"]["caddy"] = "f" * 64
with open(path, "w") as output:
    json.dump(data, output)
PY
: >"$TRACE"
if stop_block >"$TMP/out" 2>&1; then exit 1; fi
if grep -q '^compose stop app$' "$TRACE"; then exit 1; fi
echo 'PASS first mutation refuses altered prediction artifact'

rm "$TMP/prediction.json"
python3 "$GATE" predict "$TARGET_SHA" "$TMP/prediction.json" >"$TMP/out"
: >"$TRACE"
stop_block >"$TMP/out"
grep -q '^compose stop app$' "$TRACE"
echo 'PASS first mutation follows valid pinned prediction'
