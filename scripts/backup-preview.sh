#!/usr/bin/env bash
#
# Nightly backup of the three data stores behind the preview deployment.
#
#   ./scripts/backup-preview.sh              # back up, verify, rotate
#   ./scripts/backup-preview.sh --no-neo4j   # skip the one step that has downtime
#
# Runs entirely inside the VM: docker, coreutils, and nothing else. No cloud
# credentials, no network egress, no Azure CLI — so it works today, on the box,
# before any managed-backup story exists.
#
# Output: backups/<UTC timestamp>/ holding
#   postgres.dump  pg_dump custom format (conversations, users, sessions, tokens)
#   neo4j.dump     neo4j-admin dump of the `neo4j` database (graph content)
#   redis.rdb      a forced RDB snapshot (Data Stash documents, chunks, vectors)
#   MANIFEST       sizes + sha256 of each file, and the verification verdicts
#   INCOMPLETE     present only while the run is unfinished — see below
# with directories older than RETENTION_DAYS removed.
#
# ⚠️  THESE FILES NEVER LEAVE THE VM. They land on the same disk as the data
#     they copy, and nothing here uploads them anywhere. That covers a bad
#     migration or a corrupted volume; it does NOT cover losing the box, which
#     is the threat the key escrow below is about. Backups are optional for the
#     alpha preview by owner decision — see docs/PREVIEW.md §9.
#
# ⚠️  EXIT STATUS IS THE SIGNAL. Every failure path writes to stderr and exits
#     non-zero, and an unfinished run leaves an `INCOMPLETE` file in its output
#     directory so a partial set cannot be mistaken for a good one in `ls`. Do
#     not run this from cron as `>> log 2>&1` — that redirects the failure into
#     a file nobody reads. docs/PREVIEW.md §9 has the cron line that mails it.
#
# ⚠️  THIS SCRIPT DELIBERATELY DOES NOT BACK UP `.env`.
#     `user_tokens` is AES-256-GCM ciphertext whose key is TOKEN_ENCRYPTION_KEY
#     (HKDF-derived from AUTH_SESSION_SECRET when unset). A backup carrying both
#     the ciphertext and its key protects nothing that the ciphertext alone did
#     not. The keys must be escrowed SEPARATELY — a password manager or Key
#     Vault — and they must exist somewhere, because restoring this dump onto a
#     rebuilt VM without them leaves the token cache permanently undecryptable.
#     See docs/PREVIEW.md §"Backups".
#
# ⚠️  THE GRAPH IS UNAVAILABLE FOR ROUGHLY 1.5-2 MINUTES PER RUN. The dump
#     itself takes seconds; almost all of that window is Neo4j's own startup
#     after the restart (measured on a preview-sized graph: ~10s for
#     stop+dump+start, then ~80s before the healthcheck goes green). Neo4j
#     Community has no online backup — `neo4j-admin database backup` is an
#     Enterprise feature — and copying a live store directory yields a file that
#     restores, sometimes. A short, scheduled, honest outage beats an
#     unverifiable backup. Schedule it when nobody is using the app, and use
#     `--no-neo4j` for an ad-hoc run that must not interrupt anyone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
POSTGRES_DB="${POSTGRES_DB:-kgagent}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
# Must match the neo4j service's image in docker-compose.yaml: the dump runs in
# a throwaway container against the stopped store, and a newer Neo4j would try
# to upgrade the store format rather than read it.
NEO4J_IMAGE="${NEO4J_IMAGE:-neo4j:5.26}"
NEO4J_DATA_VOLUME="${NEO4J_DATA_VOLUME:-kg-agent_neo4j_data}"
# Seconds to wait for Neo4j's healthcheck after the dump before declaring the
# graph down. Measured startup on a preview-sized graph is ~80s; this is that
# with room, not a guess to tune down.
NEO4J_RESTART_TIMEOUT="${NEO4J_RESTART_TIMEOUT:-180}"

SKIP_NEO4J=0
for arg in "$@"; do
  case "$arg" in
    --no-neo4j) SKIP_NEO4J=1 ;;
    -h | --help)
      # The header block above, minus the shebang. Keep this range in step with
      # it — the last line is the `--no-neo4j` sentence.
      sed -n '2,49p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/$TS"
MANIFEST="$OUT/MANIFEST"

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
  printf '[backup] FAILED: %s\n' "$*" >&2
  exit 1
}

# `docker compose` here picks up COMPOSE_FILE / COMPOSE_PROFILES from the repo
# root `.env`, exactly as the bring-up does, so this addresses the same stack.
compose() { docker compose "$@"; }

# --- preflight ---------------------------------------------------------------

command -v docker >/dev/null || fail "docker not on PATH"
compose ps --services --status running 2>/dev/null | grep -qx postgres \
  || fail "the postgres service is not running — nothing to back up"

case "$BACKUP_DIR" in
  "$REPO_ROOT" | "$REPO_ROOT/") fail "BACKUP_DIR must not be the repo root (it would sit next to .env)" ;;
esac

mkdir -p "$OUT"
# The dumps are a full copy of every conversation, the graph, and the stash.
chmod 700 "$BACKUP_DIR" "$OUT"
# A run that dies part-way leaves a directory `ls` cannot tell from a good one.
# This marker is written first and removed last, so an unfinished set is
# identifiable without reading MANIFEST — and `find backups -name INCOMPLETE`
# is the no-MTA way to notice a cron run that quietly stopped working.
echo "this backup did not finish — do not restore from it" >"$OUT/INCOMPLETE"
log "writing to $OUT"

# sha256sum on Linux, shasum on a macOS box running this by hand.
sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

record() { # name file  ->  append size + sha256 to MANIFEST
  local name="$1" file="$2"
  printf '%-10s %12s bytes  sha256:%s\n' \
    "$name" "$(wc -c <"$file" | tr -d ' ')" "$(sha256 "$file")" >>"$MANIFEST"
}

{
  echo "kg-agent preview backup"
  echo "taken:  $TS (UTC)"
  echo "host:   $(hostname)"
  echo "commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo
} >"$MANIFEST"

# --- 1. Postgres -------------------------------------------------------------
# Custom format: compressed, and restorable selectively with pg_restore.

log "postgres: pg_dump $POSTGRES_DB"
compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  >"$OUT/postgres.dump" || fail "pg_dump failed"
[ -s "$OUT/postgres.dump" ] || fail "pg_dump produced an empty file"

# Verification that means something: parse the archive's table of contents back
# and confirm the one table whose loss would be unrecoverable is actually in it.
# A dump that merely exists is not a backup.
log "postgres: verifying archive"
PG_TOC="$(compose exec -T postgres pg_restore --list <"$OUT/postgres.dump" 2>&1)" \
  || fail "pg_restore --list rejected the archive"
grep -q 'TABLE DATA public conversations' <<<"$PG_TOC" \
  || fail "archive has no conversations table data"
record postgres "$OUT/postgres.dump"
echo "postgres   verify: pg_restore --list OK, conversations present" >>"$MANIFEST"

# --- 2. Neo4j ----------------------------------------------------------------

if [ "$SKIP_NEO4J" -eq 1 ]; then
  log "neo4j: skipped (--no-neo4j)"
  echo "neo4j      SKIPPED (--no-neo4j)" >>"$MANIFEST"
else
  log "neo4j: stopping (brief outage)"
  compose stop neo4j >/dev/null

  # Two different jobs, and they must not share one function.
  #
  # On the way out of a FAILED run — a dump error, a Ctrl-C — this is
  # best-effort: we are already exiting non-zero for a reason the operator will
  # see, and swallowing a second error here keeps that reason on screen.
  # Leaving the graph down until someone notices is worse than a missing
  # night's backup, so it is attempted whatever happened.
  restart_neo4j_besteffort() { compose start neo4j >/dev/null 2>&1 || true; }
  trap restart_neo4j_besteffort EXIT

  log "neo4j: neo4j-admin database dump"
  # --user root so the throwaway container can read the store (owned by the
  # image's neo4j uid) and write the host bind mount; the chown hands the result
  # back to whoever runs this script, so rotation below can delete it later.
  #
  # neo4j-admin writes a per-file progress bar to stderr — several hundred lines
  # that would drown a nightly cron log. Captured to a file and echoed only when
  # the command fails, so a failure still shows its reason.
  NEO4J_LOG="$OUT/.neo4j-admin.log"
  if ! docker run --rm --user root \
    -v "$NEO4J_DATA_VOLUME":/data \
    -v "$OUT":/backups \
    --entrypoint sh "$NEO4J_IMAGE" -c \
    "neo4j-admin database dump neo4j --to-path=/backups --overwrite-destination=true \
       && chown $(id -u):$(id -g) /backups/neo4j.dump" \
    >"$NEO4J_LOG" 2>&1; then
    tail -20 "$NEO4J_LOG" >&2
    fail "neo4j-admin dump failed (full log: $NEO4J_LOG)"
  fi
  rm -f "$NEO4J_LOG"

  # On the HAPPY path it is the opposite: nothing else is going to report a
  # failure, so a swallowed `compose start` would leave the graph down, let the
  # script run on, and finish with a green MANIFEST that says the opposite.
  # Start it, then wait for the service to actually be back, and fail loudly if
  # it is not — the outage this script causes is only acceptable because it
  # ends.
  #
  # `compose ps --status running` is NOT the check: the container is "running"
  # the instant `start` returns, while Neo4j itself needs ~80s more. The
  # service's healthcheck (`wget --spider localhost:7474`) is what "the graph is
  # back" means, so that is what is polled.
  trap - EXIT
  compose start neo4j >/dev/null || fail "neo4j did not restart after the dump — THE GRAPH IS DOWN"
  log "neo4j: started, waiting up to ${NEO4J_RESTART_TIMEOUT}s for its healthcheck"
  NEO4J_UP=0
  for _ in $(seq 1 "$NEO4J_RESTART_TIMEOUT"); do
    if [ "$(compose ps neo4j --format '{{.Health}}' 2>/dev/null)" = healthy ]; then
      NEO4J_UP=1
      break
    fi
    sleep 1
  done
  [ "$NEO4J_UP" -eq 1 ] \
    || fail "neo4j is still not healthy ${NEO4J_RESTART_TIMEOUT}s after the dump — THE GRAPH IS DOWN"
  log "neo4j: restarted and healthy"

  [ -s "$OUT/neo4j.dump" ] || fail "neo4j dump is empty"
  record neo4j "$OUT/neo4j.dump"
  # There is no offline integrity check for a Neo4j dump short of loading it.
  # Say so rather than implying a verification that did not happen — the restore
  # drill in docs/PREVIEW.md is where this file actually gets proven.
  echo "neo4j      verify: non-empty only; load-restore is the real check (docs/PREVIEW.md)" >>"$MANIFEST"
fi

# --- 3. Redis ----------------------------------------------------------------
# SAVE is synchronous: it returns once the RDB on disk is current, so the copy
# below is a point-in-time snapshot rather than whatever the last autosave left.

log "redis: SAVE + copy dump.rdb"
compose exec -T redis redis-cli SAVE >/dev/null || fail "redis SAVE failed"
compose cp redis:/data/dump.rdb "$OUT/redis.rdb" >/dev/null || fail "copying dump.rdb failed"
[ -s "$OUT/redis.rdb" ] || fail "redis rdb is empty"
# Every RDB starts with the magic string REDISnnnn. A truncated or HTML-error
# copy would not.
head -c 5 "$OUT/redis.rdb" | grep -q REDIS || fail "redis rdb has no REDIS magic header"
record redis "$OUT/redis.rdb"
echo "redis      verify: RDB magic header OK" >>"$MANIFEST"

# --- 4. Rotation -------------------------------------------------------------
# Whole timestamped directories, so a rotation can never strip one store out of
# an otherwise complete set.

log "rotating: removing backups older than $RETENTION_DAYS days"
REMOVED=0
while IFS= read -r -d '' old; do
  rm -rf "$old"
  REMOVED=$((REMOVED + 1))
done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -print0)
log "rotating: removed $REMOVED old backup(s)"

{
  echo
  echo "NOTE: .env is NOT in this backup, by design. AUTH_SESSION_SECRET and"
  echo "TOKEN_ENCRYPTION_KEY must be escrowed separately, or the per-user"
  echo "Microsoft token cache in postgres.dump cannot be decrypted on restore."
} >>"$MANIFEST"

# Last, and only here: every store is captured, verified and recorded. Anything
# that exits before this point leaves the marker behind on purpose.
rm -f "$OUT/INCOMPLETE"

log "done"
cat "$MANIFEST"
