#!/usr/bin/env bash
# Offline Docker shim for the Neo4j image/outage contract.
set -euo pipefail

SOURCE="${BACKUP_PREVIEW_PATH:-$(cd "$(dirname "$0")" && pwd)/backup-preview.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo/scripts" "$TMP/bin"
cp "$SOURCE" "$TMP/repo/scripts/backup-preview.sh"
cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TRACE"
case "$*" in
  'compose ps --services --status running') printf 'postgres\n' ;;
  'compose exec -T postgres pg_dump '*) printf 'PGDUMP' ;;
  'compose exec -T postgres pg_restore --list') printf 'TABLE DATA public conversations\n' ;;
  'compose ps -q neo4j')
    if [ "${DRIFT:-}" = container ] && grep -q '^commit ' "$TRACE"; then printf 'replacement-container\n'; else printf 'exact-container\n'; fi ;;
  'inspect --format {{.Image}} exact-container')
    if [ "${DRIFT:-}" = expected-image ] || { [ "${DRIFT:-}" = image ] && grep -q '^commit ' "$TRACE"; }; then printf 'sha256:different\n'; else printf 'sha256:exact\n'; fi ;;
  'inspect --format {{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}} exact-container') if [ "${DRIFT:-}" = volume ]; then printf 'other-volume\n'; else printf 'hames_neo4j_data\n'; fi ;;
  'commit --pause=false exact-container '*)
    [ "${FAIL_CAPTURE:-0}" = 0 ] || exit 1
    printf 'sha256:captured\n' ;;
  'image inspect '*) [ "${FAIL_IMAGE:-0}" = 0 ] ;;
  'image rm '*) ;;
  'run --rm --pull never --network none --entrypoint neo4j-admin '*) [ "${FAIL_PROBE:-0}" = 0 ] ;;
  'compose stop neo4j') ;;
  'compose start neo4j') ;;
  'compose ps neo4j --format {{.Health}}') printf 'healthy\n' ;;
  'run --rm --pull never --user root '*)
    [ "${FAIL_DUMP:-0}" = 0 ] || exit 1
    args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
      if [ "${args[$i]}" = '-v' ] && [[ "${args[$((i+1))]}" == *:/backups ]]; then
        printf 'NEO4JDUMP' >"${args[$((i+1))]%:/backups}/neo4j.dump"
      fi
    done
    ;;
  'compose exec -T redis redis-cli SAVE') ;;
  'compose cp redis:/data/dump.rdb '*) printf 'REDIS0009' >"${*: -1}" ;;
  *) printf 'unexpected docker call: %s\n' "$*" >&2; exit 99 ;;
esac
SH
chmod +x "$TMP/bin/docker"

run_case() {
  : >"$TMP/trace"
  local status=0
  TRACE="$TMP/trace" PATH="$TMP/bin:$PATH" BACKUP_DIR="$TMP/backup-$1" \
    NEO4J_IMAGE=sha256:exact FAIL_CAPTURE="${2:-0}" FAIL_IMAGE="${3:-0}" \
    FAIL_PROBE="${4:-0}" FAIL_DUMP="${5:-0}" \
    bash "$TMP/repo/scripts/backup-preview.sh" >"$TMP/out" 2>&1 || status=$?
  return "$status"
}

run_case success
grep -q '^commit --pause=false exact-container hames-neo4j:backup-' "$TMP/trace"
grep -q '^run --rm --pull never --user root .*sha256:captured' "$TMP/trace"
grep -q '^image rm hames-neo4j:backup-' "$TMP/trace"
test "$(grep -c '^image rm ' "$TMP/trace")" -eq 1
test "$(grep -n '^commit ' "$TMP/trace" | cut -d: -f1)" -lt "$(grep -n '^compose stop neo4j$' "$TMP/trace" | cut -d: -f1)"
echo 'PASS exact-container capture, dump, and success cleanup'

if run_case missing-image 0 1; then exit 1; fi
if grep -q '^compose stop neo4j$' "$TMP/trace"; then exit 1; fi
grep -q '^image rm hames-neo4j:backup-' "$TMP/trace"
echo 'PASS missing captured image refuses before Neo4j stop'

if run_case dump-failure 0 0 0 1; then exit 1; fi
grep -q '^compose start neo4j$' "$TMP/trace"
grep -q '^image rm hames-neo4j:backup-' "$TMP/trace"
echo 'PASS dump failure restarts Neo4j and cleans temporary image'

for drift in volume expected-image container image; do
  if DRIFT="$drift" run_case "refuse-$drift"; then exit 1; fi
  if grep -q '^compose stop neo4j$' "$TMP/trace"; then exit 1; fi
  echo "PASS $drift mismatch refuses before stop"
done
