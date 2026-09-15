#!/usr/bin/env bash
# Pins the destructive-import guard in scripts/import-neo4j.sh WITHOUT a Docker
# daemon: a `docker` shim on PATH fakes the container and records every call.
#
# Covers the behaviours the 2026-09-14 independent review of PR #318 verified
# live (issue comment 5672397402) plus its M1:
#   1. populated graph, no --wipe      -> refuse, exit 1, graph untouched
#   2. populated graph, --wipe         -> proceed, wipe + import issued
#   3. unreadable node count, no --wipe -> refuse, exit 1 (fail CLOSED)
#   4. unreadable node count, --wipe   -> STILL refuse (fail closed wins)
#   5. empty graph, no --wipe          -> proceed
#   6. failed DETACH DELETE            -> script fails, import never runs
#                                         (was: reported "Database already
#                                         empty" and imported on top)
# Run: scripts/import-neo4j.test.sh   (no arguments, exits 0 on green)

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT_UNDER_TEST="${SCRIPT_UNDER_TEST:-$ROOT/scripts/import-neo4j.sh}"

failures=0
tmproot=$(mktemp -d)
trap 'rm -rf "$tmproot"' EXIT

# ---------------------------------------------------------------- docker shim
mkdir "$tmproot/bin"
cat > "$tmproot/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# Emulates only the docker subcommands import-neo4j.sh uses. Controlled by
# SHIM_* env vars; every call is recorded as a line in $SHIM_LOG.
set -u
cmd="${1:?}"; shift
case "$cmd" in
    ps)
        # One running container, the compose default name.
        echo "neo4j-mldsgraph"
        ;;
    exec)
        interactive=0
        args=()
        for a in "$@"; do
            case "$a" in
                -i) interactive=1 ;;
                *) args+=("$a") ;;
            esac
        done
        query=""
        for a in "${args[@]}"; do
            case "$a" in MATCH*) query="$a" ;; esac
        done
        case "$query" in
            *"RETURN count"*)
                if [ -n "${SHIM_COUNT:-}" ]; then
                    # --format plain emits a header row then the value.
                    printf 'count(n)\n%s\n' "$SHIM_COUNT"
                    echo "count:OK($SHIM_COUNT)" >> "$SHIM_LOG"
                else
                    echo "shim: count command failed (auth? exec failure?)" >&2
                    echo "count:FAIL" >> "$SHIM_LOG"
                    exit 1
                fi
                ;;
            *"DETACH DELETE"*)
                echo "delete" >> "$SHIM_LOG"
                if [ "${SHIM_DELETE_FAIL:-0}" = "1" ]; then
                    echo "shim: DETACH DELETE failed" >&2
                    exit 1
                fi
                ;;
            "")
                # No MATCH query -> the `exec -i` import path.
                if [ "$interactive" != "1" ]; then
                    echo "shim: unexpected exec without a query and without -i" >&2
                    exit 64
                fi
                echo "import" >> "$SHIM_LOG"
                if [ "${SHIM_IMPORT_FAIL:-0}" = "1" ]; then
                    echo "shim: import failed" >&2
                    exit 1
                fi
                ;;
        esac
        ;;
    *)
        echo "shim: unsupported subcommand: $cmd" >&2
        exit 64
        ;;
esac
SHIM
chmod +x "$tmproot/bin/docker"

# ------------------------------------------------------------------- harness
# run_case <name> <expected-exit> <shim-count|""=count-fails> [--wipe]
#            [SHIM_DELETE_FAIL=n]
# Asserts the exit code and which calls landed in the shim log.
run_case() {
    local name="$1" expected_exit="$2"; shift 2
    local wipe="" count="" delete_fail="${SHIM_DELETE_FAIL:-0}"
    while [ $# -gt 0 ]; do
        case "$1" in
            --wipe) wipe="--wipe" ;;
            SHIM_DELETE_FAIL=*) delete_fail="${1#*=}" ;;
            *) count="$1" ;;
        esac
        shift
    done

    local dir="$tmproot/$name"
    mkdir -p "$dir"
    echo "CREATE (n:Case {name: '$name'});" > "$dir/dump.cypher"

    local log="$dir/shim.log"
    : > "$log"
    local out code
    out=$(cd "$dir" && \
        SHIM_LOG="$log" SHIM_COUNT="$count" SHIM_DELETE_FAIL="$delete_fail" \
        PATH="$tmproot/bin:$PATH" \
        bash "$SCRIPT_UNDER_TEST" $wipe dump.cypher 2>&1)
    code=$?
    echo "--- $name: exit $code (expected $expected_exit)"
    echo "$out" | sed 's/^/    /'

    if [ "$code" -ne "$expected_exit" ]; then
        echo "FAIL $name: exit $code != $expected_exit"
        failures=$((failures + 1))
        return
    fi

    case "$name" in
        refuse-no-wipe)
            assert_log "$name" "$log" "count:OK(50)"
            assert_no_call "$name" "$log" "delete"
            assert_no_call "$name" "$log" "import"
            printf '%s\n' "$out" | grep -q "already holds 50 nodes" \
                || { echo "FAIL $name: refusal message missing"; failures=$((failures + 1)); }
            ;;
        refuse-unreadable-count)
            assert_log "$name" "$log" "count:FAIL"
            assert_no_call "$name" "$log" "delete"
            assert_no_call "$name" "$log" "import"
            printf '%s\n' "$out" | grep -q "could not read a node count" \
                || { echo "FAIL $name: fail-closed message missing"; failures=$((failures + 1)); }
            ;;
        refuse-unreadable-count-with-wipe)
            assert_log "$name" "$log" "count:FAIL"
            assert_no_call "$name" "$log" "delete"
            assert_no_call "$name" "$log" "import"
            ;;
        wipe-populated)
            assert_log "$name" "$log" "count:OK(50)"
            assert_log "$name" "$log" "delete"
            assert_log "$name" "$log" "import"
            ;;
        proceed-empty-graph)
            assert_log "$name" "$log" "count:OK(0)"
            assert_log "$name" "$log" "delete"
            assert_log "$name" "$log" "import"
            ;;
        failed-delete-fails-script)
            assert_log "$name" "$log" "delete"
            assert_no_call "$name" "$log" "import"
            printf '%s\n' "$out" | grep -q "Database already empty" \
                && { echo "FAIL $name: reported failed wipe as success"; failures=$((failures + 1)); } || true
            ;;
    esac
}

assert_log() {
    local name="$1" log="$2" line="$3"
    if ! grep -q "^$line$" "$log"; then
        echo "FAIL $name: expected '$line' in shim log"
        failures=$((failures + 1))
    fi
}

assert_no_call() {
    local name="$1" log="$2" call="$3"
    if grep -q "^$call$" "$log"; then
        echo "FAIL $name: '$call' ran but must not have"
        failures=$((failures + 1))
    fi
}

# --------------------------------------------------------------------- cases
# 1. Reviewer's live finding #1: populated graph, no --wipe -> refuse.
run_case refuse-no-wipe 1 50
# 2. Reviewer's live finding #2: populated graph, --wipe -> proceeds.
run_case wipe-populated 0 50 --wipe
# 3. The fail-closed pin (Blocking 1): unreadable count, no --wipe.
run_case refuse-unreadable-count 1 ""
# 4. Fail closed even when --wipe was passed: an unreadable count must never
#    reach the destructive path, whatever the caller confirmed.
run_case refuse-unreadable-count-with-wipe 1 "" --wipe
# 5. Empty graph is genuinely safe to clear.
run_case proceed-empty-graph 0 0
# 6. M1: a failed DETACH DELETE must fail the script, not read as success.
run_case failed-delete-fails-script 1 50 --wipe SHIM_DELETE_FAIL=1

# ------------------------------------------------------------------- verdict
if [ "$failures" -gt 0 ]; then
    echo ""
    echo "FAILED: $failures failure(s)"
    exit 1
fi
echo ""
echo "All guard cases pass."
exit 0