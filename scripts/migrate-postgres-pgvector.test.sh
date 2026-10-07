#!/usr/bin/env bash
# Pins scripts/migrate-postgres-pgvector.sh WITHOUT a Docker daemon: a `docker`
# shim on PATH fakes the stack, records every call and ALLOW-LISTS what the
# script may ask of docker — anything else is logged DISALLOWED and fails the
# case, so a `docker rm` / `stop` / `find -delete` added to the script goes red
# instead of passing a deny-list regex (#419 M8 review, #505 finding 3).
#
# What each block holds the script to:
#   dump           refuses an extra database; refuses a torn dump (counts moved,
#                  no conversations in the archive); aborts on a failed command
#                  (set -e); writes outside backups/ with 0700/0600 modes.
#   volume-backup  refuses a target that exists and ANY running container that
#                  mounts the source, whatever its compose project; exactly one
#                  `docker run`, source mounted :ro, pinned image, copy forward,
#                  verified (pg_controldata + file count/bytes).
#   restore        refuses a postgres not on the new volume, without the vector
#                  extension, or into a database that has tables; never
#                  --clean/--create; one transaction; diffs counts + checksums.
# Run: scripts/migrate-postgres-pgvector.test.sh   (no arguments, exits 0 on green)

# shellcheck disable=SC2015  # `cond && pass || flunk`: pass/flunk only count and print, they never fail
set -u
umask 022

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT_UNDER_TEST="${SCRIPT_UNDER_TEST:-$ROOT/scripts/migrate-postgres-pgvector.sh}"

failures=0
passes=0
tmproot=$(mktemp -d)
trap 'rm -rf "$tmproot"' EXIT

pass() { passes=$((passes + 1)); echo "ok   $1"; }
flunk() {
  failures=$((failures + 1))
  echo "FAIL $1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/       /'
}
# t <label> <command...> — passes when the command succeeds.
t() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$label"; else flunk "$label"; fi
}

# ---------------------------------------------------------------- docker shim
mkdir "$tmproot/bin"
cat >"$tmproot/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# Emulates only what migrate-postgres-pgvector.sh may call. Everything else is
# DISALLOWED. State lives in $SHIM_DIR; every call is one line in its `log`.
set -u
log() { echo "$*" >>"$SHIM_DIR/log"; }
deny() { log "DISALLOWED $*"; echo "shim: disallowed docker call: $*" >&2; exit 99; }
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }

case "${1:-}" in
  compose)
    shift
    sub="${1:-}"; shift
    case "$sub" in
      ps)
        log "compose ps"
        [ "${SHIM_PG_RUNNING:-1}" = 1 ] && echo postgres
        exit 0
        ;;
      exec)
        [ "${1:-}" = "-T" ] && [ "${2:-}" = "postgres" ] || deny "compose exec $*"
        shift 2
        tool="${1:-}"; shift
        case "$tool" in
          psql)
            q=""; prev=""
            for a in "$@"; do [ "$prev" = "-c" ] && q="$a"; prev="$a"; done
            [ -n "$q" ] || q=$(cat)
            log "psql $(printf '%s' "$q" | tr '\n' ' ' | cut -c1-70)"
            case "$q" in
              *datistemplate*) printf '%s' "${SHIM_EXTRA_DBS:-}" ;;
              *"SELECT datname, datcollate"*)
                [ "${SHIM_COLLATION_FAIL:-0}" = 1 ] && exit 1
                printf 'hames\ten_US.utf8\ten_US.utf8\n' ;;
              *"SELECT version()"*) echo "${SHIM_VERSION:-PostgreSQL 16.11 on x86_64-pc-linux-musl, compiled by gcc}" ;;
              *string_agg*)
                n=$(($(cat "$SHIM_DIR/n" 2>/dev/null || echo 0) + 1)); echo "$n" >"$SHIM_DIR/n"
                f="$SHIM_DIR/counts.$n"; [ -f "$f" ] || f="$SHIM_DIR/counts.1"
                cat "$f" ;;
              *pg_available_extensions*) [ "${SHIM_HAS_VECTOR:-1}" = 1 ] && echo 1 ;;
              *"count(*) FROM pg_tables"*) echo "${SHIM_EXISTING:-0}" ;;
              *"SELECT datcollate FROM"*) echo "en_US.utf8" ;;
              *) deny "psql $q" ;;
            esac
            ;;
          pg_dump) log "pg_dump $*"; printf 'PGDMP-shim' ;;
          pg_restore)
            cat >/dev/null
            case " $* " in
              *" --list "*)
                log "pg_restore --list"
                [ "${SHIM_TOC_NO_CONV:-0}" = 1 ] || echo "1; 0 1 TABLE DATA public conversations postgres"
                ;;
              *) log "pg_restore $*"; exit "${SHIM_RESTORE_RC:-0}" ;;
            esac
            ;;
          *) deny "compose exec $tool $*" ;;
        esac
        ;;
      *) deny "compose $sub $*" ;;
    esac
    ;;
  volume)
    shift
    case "${1:-}" in
      inspect) log "volume inspect $2"; in_list "$2" "${SHIM_VOLUMES:-}" ;;
      create) log "volume create $2"; echo "$2" ;;
      *) deny "volume $*" ;;
    esac
    ;;
  ps)
    shift
    [ "${1:-}" = "-q" ] && [ "${2:-}" = "--filter" ] && [ $# -eq 3 ] || deny "ps $*"
    log "ps $*"
    vol="${3#volume=}"
    in_list "$vol" "${SHIM_BUSY_VOLUMES:-}" && echo abc123
    exit 0
    ;;
  run)
    shift
    log "run $*"
    printf '%s\n' "$@" >"$SHIM_DIR/run.args"
    exit "${SHIM_RUN_RC:-0}"
    ;;
  *) deny "$*" ;;
esac
SHIM
chmod +x "$tmproot/bin/docker"

# ------------------------------------------------------------------- harness
OLDVOL=hames_postgres_data
NEWVOL=hames_pg16_glibc_data
COUNTS_A=$'conversations\t4\taaaa\nusers\t2\tbbbb'

# fresh <name> — a clean case directory exported as the shim's state dir.
fresh() {
  case_dir="$tmproot/$1"
  rm -rf "$case_dir"
  mkdir -p "$case_dir/dumps"
  : >"$case_dir/log"
  export SHIM_DIR="$case_dir"
  unset SHIM_PG_RUNNING SHIM_EXTRA_DBS SHIM_COLLATION_FAIL SHIM_VERSION SHIM_HAS_VECTOR \
    SHIM_EXISTING SHIM_TOC_NO_CONV SHIM_RESTORE_RC SHIM_RUN_RC SHIM_VOLUMES SHIM_BUSY_VOLUMES
  printf '%s\n' "$COUNTS_A" >"$case_dir/counts.1"
}

# go <args...> — run the script under the shim; sets $out and $rc.
go() {
  out=$(
    cd "$ROOT" &&
      PATH="$tmproot/bin:$PATH" MIGRATION_DUMP_DIR="$case_dir/dumps" \
        bash "$SCRIPT_UNDER_TEST" "$@" 2>&1
  )
  rc=$?
}

has() { grep -q -- "$1" "$case_dir/log"; }
count_of() { grep -c -- "$1" "$case_dir/log" || true; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
# Every case: nothing outside the allow-list reached docker.
no_disallowed() { ! has '^DISALLOWED'; }

check() { # check <label> <expect-rc: 0|nz> — plus the allow-list
  local label="$1" want="$2"
  if [ "$want" = 0 ] && [ "$rc" -ne 0 ]; then flunk "$label (rc=$rc)" "$out"; return 1; fi
  if [ "$want" = nz ] && [ "$rc" -eq 0 ]; then flunk "$label (rc=0, expected a refusal)" "$out"; return 1; fi
  if ! no_disallowed; then flunk "$label — a disallowed docker call" "$(grep DISALLOWED "$case_dir/log")"; return 1; fi
  pass "$label"
}

# ==================================================================== the file
t "set -euo pipefail is the first statement" \
  bash -c "grep -v '^#' '$SCRIPT_UNDER_TEST' | grep -v '^\$' | head -n1 | grep -qx 'set -euo pipefail'"
t "umask 077 is set" grep -qx 'umask 077' "$SCRIPT_UNDER_TEST"
# backup-preview.sh rm -rf's every depth-1 directory under backups/ older than
# RETENTION_DAYS; the migration dump must never default into that tree.
t "the default dump directory is outside backups/" \
  bash -c "grep '^MIGRATION_DUMP_DIR=' '$SCRIPT_UNDER_TEST' | grep -qv backups"
t "the copy verification can fail the script (state and size)" \
  bash -c "grep -qF '[ \"\$state\" = \"shut down\" ] ||' '$SCRIPT_UNDER_TEST' && grep -qF '[ \"\$(sig /from)\" = \"\$(sig /to)\" ] ||' '$SCRIPT_UNDER_TEST'"

# ======================================================================== dump
fresh dump-ok
mkdir -p "$case_dir/dumps" && chmod 755 "$case_dir/dumps" # an existing, too-open parent
go dump
if check "dump: happy path" 0; then
  dumpdir=$(printf '%s\n' "$out" | grep "^$case_dir/dumps/" | head -n1)
  t "dump: lands in the migration dir, not under backups/" bash -c "[ -d '$dumpdir' ] && case '$dumpdir' in */backups/*) exit 1 ;; esac"
  t "dump: writes counts.tsv with the shim's counts" grep -q 'conversations' "$dumpdir/counts.tsv"
  t "dump: archive, collation and toc are written" bash -c "[ -s '$dumpdir/postgres.dump' ] && [ -s '$dumpdir/collation.txt' ] && [ -s '$dumpdir/toc.txt' ]"
  [ "$(mode_of "$dumpdir")" = 700 ] && pass "dump: directory is 0700" || flunk "dump: directory is $(mode_of "$dumpdir"), not 700"
  [ "$(mode_of "$case_dir/dumps")" = 700 ] && pass "dump: a too-open parent is tightened to 0700" || flunk "dump: parent is $(mode_of "$case_dir/dumps"), not 700"
  [ "$(mode_of "$dumpdir/postgres.dump")" = 600 ] && pass "dump: the archive is 0600" || flunk "dump: archive is $(mode_of "$dumpdir/postgres.dump"), not 600"
  [ "$(mode_of "$dumpdir/counts.tsv")" = 600 ] && pass "dump: counts.tsv is 0600" || flunk "dump: counts.tsv is $(mode_of "$dumpdir/counts.tsv"), not 600"
fi

fresh dump-extra-db
SHIM_EXTRA_DBS=$'otherdb\n' go dump
check "dump: an extra database refuses" nz
has 'pg_dump' && flunk "dump: pg_dump ran despite an extra database" || pass "dump: nothing was dumped"
[ -z "$(ls "$case_dir/dumps")" ] && pass "dump: no dump directory was created" || flunk "dump: a directory was created before the refusal"
printf '%s' "$out" | grep -q otherdb && pass "dump: the refusal names the database" || flunk "dump: refusal does not name it" "$out"

fresh dump-counts-moved
printf '%s\n' "$COUNTS_A" >"$case_dir/counts.1"
printf 'conversations\t5\taaaa\nusers\t2\tbbbb\n' >"$case_dir/counts.2"
go dump
check "dump: counts that move while dumping refuse" nz

fresh dump-no-conversations
SHIM_TOC_NO_CONV=1 go dump
check "dump: an archive with no conversations table refuses" nz

fresh dump-collation-fails
SHIM_COLLATION_FAIL=1 go dump
check "dump: a failing command aborts the script (set -e)" nz

fresh dump-not-running
SHIM_PG_RUNNING=0 go dump
check "dump: postgres not running refuses" nz

# =============================================================== volume-backup
fresh vb-ok
SHIM_VOLUMES="$OLDVOL" go volume-backup
if check "volume-backup: happy path" 0; then
  [ "$(count_of '^run ')" = 1 ] && pass "volume-backup: exactly one docker run" || flunk "volume-backup: $(count_of '^run ') docker run calls"
  args="$case_dir/run.args"
  grep -qx -- "$OLDVOL:/from:ro" "$args" && pass "volume-backup: the source is mounted :ro" || flunk "volume-backup: source mount is not <old>:/from:ro" "$(cat "$args")"
  grep -qx -- "${OLDVOL}_alpine_backup:/to" "$args" && pass "volume-backup: only the new backup volume is writable" || flunk "volume-backup: /to is not the backup volume" "$(cat "$args")"
  [ "$(grep -c -- '^-v$' "$args")" = 2 ] && pass "volume-backup: exactly two mounts" || flunk "volume-backup: not exactly two mounts"
  grep -Eqx 'postgres:16-alpine@sha256:[0-9a-f]{64}' "$args" && pass "volume-backup: the helper image is digest-pinned" || flunk "volume-backup: image is not digest-pinned" "$(cat "$args")"
  grep -q 'cp -a /from/. /to/' "$args" && pass "volume-backup: copies source → backup" || flunk "volume-backup: copy direction is not /from → /to"
  grep -q 'pg_controldata /to' "$args" && grep -q 'shut down' "$args" && pass "volume-backup: verifies the copy is a clean shutdown" || flunk "volume-backup: no pg_controldata check"
  grep -q 'sig /from' "$args" && grep -q 'sig /to' "$args" && pass "volume-backup: compares file count and bytes" || flunk "volume-backup: no size comparison"
  if grep -Eq '(^|[ ;&|])(rm|mv|dd|truncate|shred)( |$)|-delete|-exec rm|>[ ]*/from|/to/\. /from' "$args"; then
    flunk "volume-backup: the container script can modify or remove data" "$(cat "$args")"
  else pass "volume-backup: the container script has no rm/mv/-delete/redirect into the source"; fi
  [ "$(count_of 'volume create')" = 1 ] && has "volume create ${OLDVOL}_alpine_backup" && pass "volume-backup: creates only the backup volume" || flunk "volume-backup: unexpected volume create"
fi

fresh vb-target-exists
SHIM_VOLUMES="$OLDVOL ${OLDVOL}_alpine_backup" go volume-backup
check "volume-backup: an existing target refuses" nz
has '^run ' && flunk "volume-backup: copied over an existing backup" || pass "volume-backup: nothing was copied"

fresh vb-other-project-running
SHIM_VOLUMES="$OLDVOL" SHIM_PG_RUNNING=0 SHIM_BUSY_VOLUMES="$OLDVOL" go volume-backup
check "volume-backup: a container under ANOTHER compose project refuses" nz
has '^run ' && flunk "volume-backup: copied a live PGDATA" || pass "volume-backup: nothing was copied"
has 'volume create' && flunk "volume-backup: created the backup volume before refusing" || pass "volume-backup: no volume was created"
has "ps -q --filter volume=$OLDVOL" && pass "volume-backup: asks the daemon which containers mount the volume" || flunk "volume-backup: does not ask the daemon"

fresh vb-no-source
go volume-backup
check "volume-backup: a missing source refuses" nz

fresh vb-copy-fails
SHIM_VOLUMES="$OLDVOL" SHIM_RUN_RC=1 go volume-backup
check "volume-backup: a failing copy/verification refuses" nz
printf '%s' "$out" | grep -q 'volume backup OK' && flunk "volume-backup: printed OK after a failed copy" || pass "volume-backup: no OK line after a failed copy"

# ====================================================================== restore
DUMP="$tmproot/dump-fixture"
mkdir -p "$DUMP"
printf 'PGDMP-shim' >"$DUMP/postgres.dump"
printf '%s\n' "$COUNTS_A" >"$DUMP/counts.tsv"
printf 'hames\ten_US.utf8\ten_US.utf8\nPostgreSQL 16.11 on x86_64-pc-linux-musl, compiled by gcc\n' >"$DUMP/collation.txt"

fresh rs-ok
SHIM_BUSY_VOLUMES="$NEWVOL" SHIM_VERSION='PostgreSQL 16.10 on x86_64-pc-linux-gnu, compiled by gcc' go restore "$DUMP"
if check "restore: happy path" 0; then
  line=$(grep '^pg_restore ' "$case_dir/log" | grep -v -- '--list' | head -n1)
  bad=""
  for tok in $line; do
    case "$tok" in --clean | --create) bad="$bad $tok" ;; --*) ;; -*[cC]*) bad="$bad $tok" ;; esac
  done
  [ -z "$bad" ] && pass "restore: never --clean / --create (short forms included)" || flunk "restore: destructive pg_restore flag:$bad" "$line"
  case "$line" in *--single-transaction*) pass "restore: runs in one transaction" ;; *) flunk "restore: not --single-transaction" "$line" ;; esac
  case "$line" in *--exit-on-error*) pass "restore: stops on the first error" ;; *) flunk "restore: no --exit-on-error" "$line" ;; esac
  printf '%s' "$out" | grep -q 'was en_US.utf8 on linux-musl' && printf '%s' "$out" | grep -q 'now en_US.utf8 on linux-gnu' \
    && pass "restore: the collation line names the libc on both sides" || flunk "restore: libc missing from the collation line" "$out"
fi

fresh rs-not-on-new-volume
SHIM_BUSY_VOLUMES="$OLDVOL" go restore "$DUMP"
check "restore: a postgres that is not on the new volume refuses" nz
has '^pg_restore ' && flunk "restore: restored into the wrong volume's postgres" || pass "restore: nothing was restored"

fresh rs-no-vector
SHIM_BUSY_VOLUMES="$NEWVOL" SHIM_HAS_VECTOR=0 go restore "$DUMP"
check "restore: no vector extension refuses" nz
has '^pg_restore ' && flunk "restore: ran without the extension" || pass "restore: nothing was restored"

fresh rs-populated
SHIM_BUSY_VOLUMES="$NEWVOL" SHIM_EXISTING=3 go restore "$DUMP"
check "restore: a database that has tables refuses" nz
has '^pg_restore ' && flunk "restore: ran into a populated database" || pass "restore: nothing was restored"

fresh rs-counts-differ
printf 'conversations\t3\taaaa\nusers\t2\tbbbb\n' >"$case_dir/counts.1"
SHIM_BUSY_VOLUMES="$NEWVOL" go restore "$DUMP"
check "restore: a differing row count fails" nz

fresh rs-checksum-differs
printf 'conversations\t4\tzzzz\nusers\t2\tbbbb\n' >"$case_dir/counts.1"
SHIM_BUSY_VOLUMES="$NEWVOL" go restore "$DUMP"
check "restore: same counts, different content checksum fails" nz

fresh rs-restore-fails
SHIM_BUSY_VOLUMES="$NEWVOL" SHIM_RESTORE_RC=1 go restore "$DUMP"
check "restore: a failing pg_restore fails" nz

fresh rs-no-dir
go restore
check "restore: no dump directory refuses" nz

# ================================================================== the modes
fresh unknown-mode
go frobnicate
[ "$rc" = 2 ] && pass "an unknown mode exits 2" || flunk "an unknown mode exits $rc"

echo
echo "$passes passed, $failures failed"
[ "$failures" -eq 0 ]
