#!/usr/bin/env bash
#
# The one-time move of the compose Postgres from postgres:16-alpine to the
# digest-pinned pgvector/pgvector bookworm image (#419 M8), by DUMP AND RESTORE
# into a NEW volume. Run by the OWNER, one mode at a time, following
# docs/deployment/pgvector-migration.md — the runbook says when and why.
#
#   ./scripts/migrate-postgres-pgvector.sh dump                 # 1. on the OLD image, still running
#   ./scripts/migrate-postgres-pgvector.sh volume-backup        # 2. optional, after `stop postgres`: copy the old volume aside
#   ./scripts/migrate-postgres-pgvector.sh restore <dump-dir>   # 4. on the NEW image, new empty volume
#
# The new image keeps its cluster in a NEW volume (hames_pg16_glibc_data), so the
# old one (hames_postgres_data) is never mounted by the glibc image and is never
# touched by anything here. What this script will not do, by design: remove or
# stop anything, drop or truncate anything, or write to the old volume.
# scripts/migrate-postgres-pgvector.test.sh pins that against a docker shim: it
# allow-lists the docker calls this file may make.
#
#   dump           pg_dump (custom format) of the running database into
#                  pgvector-migration-dump/<UTC ts>/ (OUTSIDE backups/, which
#                  backup-preview.sh rotates), plus counts.tsv (table, exact row
#                  count and a collation-independent content checksum of every
#                  public table), collation.txt (the collation and libc being
#                  left behind) and a pg_restore --list check. Refuses when the
#                  cluster holds a database this dump would leave behind.
#   volume-backup  copies the OLD data volume to <volume>_alpine_backup with a
#                  throwaway container (source mounted read-only), then checks
#                  the copy: `shut down` per pg_controldata, same file count and
#                  bytes. Refuses an existing target and ANY running container
#                  that mounts the source, whatever its compose project.
#   restore        into the NEW image's empty database: refuses unless postgres
#                  is running on the new volume, the vector extension is
#                  available and the database holds no tables; restores in ONE
#                  transaction, then diffs counts and checksums against
#                  counts.tsv. Exit 0 means every table matched.
#
# Addressing: like backup-preview.sh this runs `docker compose` from the repo
# root, so COMPOSE_FILE / COMPOSE_PROJECT_NAME / COMPOSE_PROFILES from the root
# `.env` (or the environment) pick the stack. The service must be called
# `postgres`. Override POSTGRES_DB / POSTGRES_USER / POSTGRES_DATA_VOLUME /
# POSTGRES_OLD_VOLUME / MIGRATION_DUMP_DIR if yours differ.

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# NOT under backups/: backup-preview.sh `rm -rf`s every depth-1 directory there
# older than RETENTION_DAYS, and this dump must live until the owner deletes it.
MIGRATION_DUMP_DIR="${MIGRATION_DUMP_DIR:-$REPO_ROOT/pgvector-migration-dump}"
POSTGRES_DB="${POSTGRES_DB:-hames}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
# docker-compose.yaml pins `name: hames`: the NEW cluster's volume is
# `hames_pg16_glibc_data`, the alpine-era one `hames_postgres_data`.
POSTGRES_DATA_VOLUME="${POSTGRES_DATA_VOLUME:-hames_pg16_glibc_data}"
POSTGRES_OLD_VOLUME="${POSTGRES_OLD_VOLUME:-hames_postgres_data}"
# The throwaway image for the volume copy: pinned by index digest, because it
# runs with the whole old cluster mounted and a floating tag would let a
# registry change what touches it. Same major as the cluster it copies.
COPY_IMAGE="postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"

log() { printf '[pgvector-migration %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
  printf '[pgvector-migration] FAILED: %s\n' "$*" >&2
  exit 1
}

compose() { docker compose "$@"; }
psql_q() { compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -F $'\t' "$@"; }

# One `table<TAB>count<TAB>checksum` line per public table, sorted. Exact
# count(*), not the planner's estimate, and a checksum of the rows' text form
# that does not depend on collation (rows are ordered by the md5 of their own
# text, hex digits sort the same under musl and glibc): the numbers the restore
# is held to. Counts alone prove cardinality, not content.
table_counts() {
  psql_q <<'SQL'
SELECT format('SELECT %L, count(*), coalesce(md5(string_agg(md5(t::text), %L ORDER BY md5(t::text))), %L) FROM %I.%I t', tablename, '', '-', schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
SQL
}

# `linux-musl` / `linux-gnu` out of a version() string: the libc the cluster ran on.
libc_of() { grep -o 'linux-[a-z]*' <<<"$1" | head -n1; }

require_running() {
  command -v docker >/dev/null || fail "docker not on PATH"
  compose ps --services --status running 2>/dev/null | grep -qx postgres \
    || fail "the postgres service is not running in this compose project (COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-<from compose file>})"
}

mode_dump() {
  require_running

  # pg_dump of one database leaves every other database in the cluster behind.
  local extra
  extra="$(psql_q -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres', '$POSTGRES_DB') ORDER BY datname")"
  [ -z "$extra" ] || fail "this cluster holds databases the dump would leave behind: $(tr '\n' ' ' <<<"$extra")— dump them separately (or clear them out yourself) first"

  local out
  out="$MIGRATION_DUMP_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$out"
  chmod 700 "$MIGRATION_DUMP_DIR" "$out"
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
  log "KEEP THIS DIRECTORY. It is a full copy of every conversation, and unreadable without DATA_ENCRYPTION_KEY — escrow that separately. Nothing rotates it; you delete it."
}

mode_volume_backup() {
  command -v docker >/dev/null || fail "docker not on PATH"
  local src="$POSTGRES_OLD_VOLUME" dst="${POSTGRES_OLD_VOLUME}_alpine_backup"
  docker volume inspect "$src" >/dev/null 2>&1 \
    || fail "volume $src does not exist"
  if docker volume inspect "$dst" >/dev/null 2>&1; then
    fail "$dst already exists — refusing to overwrite it"
  fi
  # Volume names are global to the daemon, compose projects are not: ask the
  # daemon which containers mount THIS volume, whatever project started them.
  local users
  users="$(docker ps -q --filter "volume=$src")"
  [ -z "$users" ] || fail "a running container still mounts $src ($users) — stop it first so the copy is of a clean shutdown"

  log "copying $src -> $dst"
  docker volume create "$dst" >/dev/null
  # One container does the copy AND the check, so a copy that is not whole fails
  # here and not on the day it is needed. The source is read-only.
  docker run --rm -v "$src:/from:ro" -v "$dst:/to" --entrypoint sh "$COPY_IMAGE" -c '
    set -eu
    sig() { (cd "$1" && find . -type f -exec stat -c %s {} + | awk "{ n++; s += \$1 } END { print n + 0, s + 0 }"); }
    cp -a /from/. /to/
    state="$(pg_controldata /to | sed -n "s/^Database cluster state: *//p")"
    [ "$state" = "shut down" ] || { echo "copy reports cluster state: $state" >&2; exit 1; }
    [ "$(sig /from)" = "$(sig /to)" ] || { echo "file count / bytes differ: $(sig /from) vs $(sig /to)" >&2; exit 1; }
  ' || fail "copy or its verification failed ($dst was created and is left in place — inspect it, do not rely on it)"
  log "volume backup OK: $dst (verified shut down, same file count and bytes; rollback = the old commit — see the runbook)"
}

mode_restore() {
  local dir="${1:-}"
  [ -n "$dir" ] || fail "usage: restore <dump-dir> (the directory the dump mode printed)"
  [ -s "$dir/postgres.dump" ] && [ -s "$dir/counts.tsv" ] || fail "$dir has no postgres.dump / counts.tsv"
  require_running
  [ -n "$(docker ps -q --filter "volume=$POSTGRES_DATA_VOLUME")" ] \
    || fail "no running container mounts $POSTGRES_DATA_VOLUME — restore only into the postgres that runs on the new volume"

  # Both refusals protect a database that already has something in it.
  psql_q -c "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'" | grep -qx 1 \
    || fail "this Postgres has no vector extension — it is not the pgvector image"
  local existing
  existing="$(psql_q -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  [ "$existing" = "0" ] || fail "$POSTGRES_DB already has $existing public tables — restore only into a fresh, empty volume"

  log "pg_restore into $POSTGRES_DB (one transaction)"
  compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --single-transaction --exit-on-error <"$dir/postgres.dump" \
    || fail "pg_restore failed — it ran in one transaction, so $POSTGRES_DB is still empty"

  local got
  got="$(mktemp)"
  trap 'rm -f "'"$got"'"' EXIT
  table_counts >"$got"
  if diff -u "$dir/counts.tsv" "$got"; then
    log "restore OK: every table's row count and content checksum matches the dump ($(wc -l <"$got" | tr -d ' ') tables)"
  else
    fail "restored counts / checksums differ from the dump (diff above) — do not point the app at this database"
  fi
  local was_ver now_ver
  was_ver="$(tail -n1 "$dir/collation.txt")"
  now_ver="$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c 'SELECT version()')"
  log "collation: now $(psql_q -c "SELECT datcollate FROM pg_database WHERE datname = '$POSTGRES_DB'") on $(libc_of "$now_ver"), was $(awk -F'\t' -v db="$POSTGRES_DB" '$1 == db { print $2 }' "$dir/collation.txt") on $(libc_of "$was_ver")"
}

case "${1:-}" in
  dump) mode_dump ;;
  volume-backup) mode_volume_backup ;;
  restore) mode_restore "${2:-}" ;;
  -h | --help | "") sed -n '2,42p' "${BASH_SOURCE[0]}" ;;
  *)
    echo "unknown mode: $1 (try --help)" >&2
    exit 2
    ;;
esac
