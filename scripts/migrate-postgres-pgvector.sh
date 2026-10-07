#!/usr/bin/env bash
#
# The one-time move of the compose Postgres from postgres:16-alpine to the
# digest-pinned pgvector/pgvector bookworm image (#419 M8), by DUMP AND RESTORE
# into a fresh volume. Run by the OWNER, one mode at a time, following
# docs/deployment/pgvector-migration.md — the runbook says when and why.
#
#   ./scripts/migrate-postgres-pgvector.sh dump                 # 1. on the OLD image, running
#   ./scripts/migrate-postgres-pgvector.sh volume-backup        # 2. after `stop postgres`: copy the old volume aside
#   ./scripts/migrate-postgres-pgvector.sh restore <dump-dir>   # 4. on the NEW image, fresh empty volume
#
# What it will not do, by design: it never removes a volume, never stops a
# container and never drops or truncates anything. Between 2 and 4 the runbook
# has you remove the old volume yourself — that is the only destructive step in
# the whole migration, and it stays a command you type, not a mode here.
#
#   dump           pg_dump (custom format) of the running database into
#                  backups/pgvector-migration/<UTC ts>/, plus counts.tsv (exact
#                  row count of every public table), collation.txt (the
#                  datcollate being left behind) and a pg_restore --list check.
#   volume-backup  copies the data volume to <volume>_alpine_backup with a
#                  throwaway container, so the old cluster survives the removal
#                  of the original name. Refuses an existing target.
#   restore        into the NEW image's empty database: refuses unless the
#                  vector extension is available and the database holds no
#                  tables, restores with --exit-on-error, then diffs the
#                  restored row counts against counts.tsv. Exit 0 means every
#                  count matched.
#
# Addressing: like backup-preview.sh this runs `docker compose` from the repo
# root, so COMPOSE_FILE / COMPOSE_PROJECT_NAME / COMPOSE_PROFILES from the root
# `.env` (or the environment) pick the stack. The service must be called
# `postgres`. Override POSTGRES_DB / POSTGRES_USER / POSTGRES_DATA_VOLUME /
# BACKUP_DIR if yours differ.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
POSTGRES_DB="${POSTGRES_DB:-hames}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
# docker-compose.yaml pins `name: hames`, so the volume is `hames_postgres_data`.
POSTGRES_DATA_VOLUME="${POSTGRES_DATA_VOLUME:-hames_postgres_data}"

log() { printf '[pgvector-migration %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
  printf '[pgvector-migration] FAILED: %s\n' "$*" >&2
  exit 1
}

compose() { docker compose "$@"; }
psql_q() { compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -F $'\t' "$@"; }

# One `table<TAB>count` line per public table, sorted. Exact count(*), not the
# planner's estimate: this is the number the restore is held to.
table_counts() {
  psql_q <<'SQL'
SELECT format('SELECT %L, count(*) FROM %I.%I', tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
SQL
}

require_running() {
  command -v docker >/dev/null || fail "docker not on PATH"
  compose ps --services --status running 2>/dev/null | grep -qx postgres \
    || fail "the postgres service is not running in this compose project (COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-<from compose file>})"
}

mode_dump() {
  require_running
  local out
  out="$BACKUP_DIR/pgvector-migration/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$out"
  chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/pgvector-migration" "$out"
  log "writing to $out"

  # The collation being left behind is the reason this is dump-and-restore
  # rather than an in-place image swap (musl -> glibc changes text ordering).
  psql_q -c "SELECT datname, datcollate, datctype FROM pg_database ORDER BY datname" >"$out/collation.txt"
  compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c 'SELECT version()' >>"$out/collation.txt"

  table_counts >"$out/counts.tsv"
  [ -s "$out/counts.tsv" ] || fail "no public tables found in $POSTGRES_DB — wrong database?"

  log "pg_dump $POSTGRES_DB (custom format)"
  compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom >"$out/postgres.dump" \
    || fail "pg_dump failed"
  [ -s "$out/postgres.dump" ] || fail "pg_dump produced an empty file"

  # The same verification backup-preview.sh does: parse the archive back.
  compose exec -T postgres pg_restore --list <"$out/postgres.dump" >"$out/toc.txt" \
    || fail "pg_restore --list rejected the archive"
  grep -q 'TABLE DATA public conversations' "$out/toc.txt" \
    || fail "archive has no conversations table data"

  # A dump taken while the app writes is a dump of an earlier moment. Counting
  # again after it catches the one way the numbers above could be stale.
  table_counts >"$out/counts-after.tsv"
  cmp -s "$out/counts.tsv" "$out/counts-after.tsv" \
    || fail "row counts changed while dumping — stop the app and run again (counts.tsv vs counts-after.tsv in $out)"
  rm "$out/counts-after.tsv"

  log "dump OK: $(wc -l <"$out/counts.tsv" | tr -d ' ') tables, $(wc -c <"$out/postgres.dump" | tr -d ' ') bytes"
  printf '%s\n' "$out"
  log "KEEP THIS DIRECTORY. It is a full copy of every conversation, and unreadable without DATA_ENCRYPTION_KEY — escrow that separately."
}

mode_volume_backup() {
  command -v docker >/dev/null || fail "docker not on PATH"
  local dst="${POSTGRES_DATA_VOLUME}_alpine_backup"
  docker volume inspect "$POSTGRES_DATA_VOLUME" >/dev/null 2>&1 \
    || fail "volume $POSTGRES_DATA_VOLUME does not exist"
  docker volume inspect "$dst" >/dev/null 2>&1 && fail "$dst already exists — refusing to overwrite it"
  compose ps --services --status running 2>/dev/null | grep -qx postgres \
    && fail "postgres is still running — stop it first so the copy is of a clean shutdown"
  log "copying $POSTGRES_DATA_VOLUME -> $dst"
  docker volume create "$dst" >/dev/null
  docker run --rm -v "$POSTGRES_DATA_VOLUME:/from:ro" -v "$dst:/to" --entrypoint sh \
    postgres:16-alpine -c 'cp -a /from/. /to/' || fail "copy failed ($dst was created and is left in place)"
  log "volume backup OK: $dst (rollback = point the old image at it; see the runbook)"
}

mode_restore() {
  local dir="${1:-}"
  [ -n "$dir" ] || fail "usage: restore <dump-dir> (the directory the dump mode printed)"
  [ -s "$dir/postgres.dump" ] && [ -s "$dir/counts.tsv" ] || fail "$dir has no postgres.dump / counts.tsv"
  require_running

  # Both refusals protect a database that already has something in it.
  psql_q -c "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'" | grep -qx 1 \
    || fail "this Postgres has no vector extension — it is not the pgvector image"
  local existing
  existing="$(psql_q -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  [ "$existing" = "0" ] || fail "$POSTGRES_DB already has $existing public tables — restore only into a fresh, empty volume"

  log "pg_restore into $POSTGRES_DB"
  compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error <"$dir/postgres.dump" \
    || fail "pg_restore failed — the database is now partial; remove the volume and start again"

  local got
  got="$(mktemp)"
  trap 'rm -f "'"$got"'"' EXIT
  table_counts >"$got"
  if diff -u "$dir/counts.tsv" "$got"; then
    log "restore OK: every table's row count matches the dump ($(wc -l <"$got" | tr -d ' ') tables)"
  else
    fail "restored row counts differ from the dump (diff above) — do not point the app at this database"
  fi
  log "collation: now $(psql_q -c "SELECT datcollate FROM pg_database WHERE datname = '$POSTGRES_DB'"), was $(awk -F'\t' -v db="$POSTGRES_DB" '$1 == db { print $2 }' "$dir/collation.txt")"
}

case "${1:-}" in
  dump) mode_dump ;;
  volume-backup) mode_volume_backup ;;
  restore) mode_restore "${2:-}" ;;
  -h | --help | "") sed -n '2,32p' "${BASH_SOURCE[0]}" ;;
  *)
    echo "unknown mode: $1 (try --help)" >&2
    exit 2
    ;;
esac
