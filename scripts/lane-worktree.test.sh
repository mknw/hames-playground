#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
#
# Proves scripts/lane-worktree.sh on a scratch clone, without a real repo, a
# runtime or a registry:
#
#   1. the worktree is created on its own branch at the requested base
#   2. the required gitignored seeds (app/.env, configs/mcp-config.yaml) are
#      copied; the optional ones (.env, docker-compose.override.yml) are copied
#      when the source exists
#   3. deploy/modal/*.local.* is LINKED to the main checkout, never copied
#   4. .claude/settings.json is copied
#   5. `pnpm install --frozen-lockfile` ran (app/node_modules exists)
#   6. refusals: the main checkout as target, a target inside it, a non-empty
#      target, an unknown argument — each exits non-zero and quotes the path
#   7. the main checkout's tree is untouched by a successful run
#   8. a failed install aborts loudly: a fixture whose install runs a failing
#      postinstall makes the script exit non-zero quoting the worktree path and
#      calling the checkout half-bootstrapped
#   9. a missing required seed aborts: a fixture without app/.env makes the
#      script exit non-zero quoting "app/.env" and creates no worktree
#
# Needs git and pnpm on PATH (the fixture installs have no dependencies and
# run offline). Run: scripts/lane-worktree.test.sh   (no args, exits 0 on green)

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/lane-worktree.sh"

failures=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pass() { echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

assert_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected [$2], got [$3])"; fi
}
assert_contains() { # <label> <needle> <haystack>
  case "$3" in *"$2"*) pass "$1" ;;
    *) fail "$1 (output does not contain [$2]): $3" ;;
  esac
}
assert_not_contains() { # <label> <needle> <haystack>
  case "$3" in *"$2"*) fail "$1 (output contains [$2]): $3" ;;
    *) pass "$1" ;;
  esac
}
assert_fails() { # <label> <needle-in-output> <cmd...> (run in a subshell)
  local label=$1 needle=$2 out rc
  shift 2
  out=$("$@" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    fail "$label (exited 0, expected non-zero): $out"
  elif [ -z "$needle" ]; then
    pass "$label"
  else
    assert_contains "$label (refusal quotes the path)" "$needle" "$out"
  fi
}

command -v git >/dev/null 2>&1 || { echo "lane-worktree.test.sh needs git" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "lane-worktree.test.sh needs pnpm on PATH" >&2; exit 1; }

# --- fixture: a minimal main checkout whose workspace installs offline -------
# make_fixture <dir> [--no-app-env] [--postinstall-fails]
make_fixture() {
  local dir=$1 app_pkg
  shift
  mkdir -p "$dir/app" "$dir/packages/shared" "$dir/configs" "$dir/.claude" "$dir/deploy/modal"
  cat > "$dir/package.json" <<'JSON'
{ "name": "fixture-root", "private": true }
JSON
  cat > "$dir/pnpm-workspace.yaml" <<'YAML'
packages:
  - app
  - packages/shared
YAML
  app_pkg='{ "name": "fixture-app", "private": true, "dependencies": { "shared": "workspace:*" } }'
  case " $* " in
    *" --postinstall-fails "*)
      # Kills a swallowed install failure: this postinstall fails on every machine.
      app_pkg='{ "name": "fixture-app", "private": true, "dependencies": { "shared": "workspace:*" }, "scripts": { "postinstall": "exit 1" } }'
      ;;
  esac
  printf '%s\n' "$app_pkg" > "$dir/app/package.json"
  cat > "$dir/.gitignore" <<'EOF'
node_modules/
app/.env
.env
docker-compose.override.yml
deploy/modal/*.local.*
.claude/settings.json
.claude/settings.local.json
EOF
  case " $* " in *" --no-app-env "*) ;; *) echo "APPENV" > "$dir/app/.env" ;; esac
  echo "ROOTENV" > "$dir/.env"
  echo "MCP" > "$dir/configs/mcp-config.yaml"
  echo "OVERRIDE" > "$dir/docker-compose.override.yml"
  echo "CREDS" > "$dir/deploy/modal/creds.local.env"
  echo '{"name":"shared","private":true,"main":"index.js"}' > "$dir/packages/shared/package.json"
  echo 'export {};' > "$dir/packages/shared/index.js"
  echo '{}' > "$dir/.claude/settings.json"

  git -C "$dir" init -q -b main
  git -C "$dir" add -A
  git -C "$dir" -c user.email=fixture@example.invalid -c user.name=fixture commit -qm init
  # A committed lockfile the worktree inherits, so --frozen-lockfile passes offline.
  # --ignore-scripts: the lockfile must exist even when the fixture's postinstall fails.
  (cd "$dir" && pnpm install --ignore-scripts >/dev/null 2>&1)
  [ -f "$dir/pnpm-lock.yaml" ] || { echo "fixture setup failed: no pnpm-lock.yaml in $dir" >&2; exit 1; }
  git -C "$dir" add -A
  git -C "$dir" -c user.email=fixture@example.invalid -c user.name=fixture commit -qm lockfile
}

main="$tmp/main"
make_fixture "$main"

# --- 1-5, 7: a successful run -------------------------------------------------
wt="$tmp/wt"
out=$(bash "$SCRIPT" --repo "$main" --branch lane-test --path "$wt" 2>&1) \
  || fail "happy path exited non-zero: $out"

assert_eq "worktree is on its own branch" "lane-test" "$(git -C "$wt" rev-parse --abbrev-ref HEAD)"
assert_eq "worktree is at the requested base" \
  "$(git -C "$main" rev-parse main)" "$(git -C "$wt" rev-parse HEAD)"
assert_contains "creation names the quoted target" "\"$wt\"" "$out"

for f in app/.env .env configs/mcp-config.yaml docker-compose.override.yml .claude/settings.json; do
  if [ -f "$wt/$f" ] && [ "$(cat "$wt/$f")" = "$(cat "$main/$f")" ]; then
    pass "copied \"$f\""
  else
    fail "copied \"$f\" (missing or differs)"
  fi
done

link="$wt/deploy/modal/creds.local.env"
if [ -L "$link" ] && [ "$(cat "$link")" = "CREDS" ] \
  && [ "$(readlink "$link")" = "$main/deploy/modal/creds.local.env" ]; then
  pass "deploy/modal credential is a link to the main checkout"
else
  fail "deploy/modal credential is a link to the main checkout (readlink: $(readlink "$link" 2>/dev/null || echo none))"
fi

[ -d "$wt/app/node_modules" ] && pass "pnpm install ran (app/node_modules exists)" \
  || fail "pnpm install ran (app/node_modules exists)"

assert_eq "the main checkout tree is untouched" "" "$(git -C "$main" status --porcelain)"

# --- 6: refusals ---------------------------------------------------------------
assert_fails "refuses the main checkout as target" "\"$main\"" \
  bash "$SCRIPT" --repo "$main" --branch lane-x --path "$main"
assert_fails "refuses a target inside the main checkout" "\"$main/sub\"" \
  bash "$SCRIPT" --repo "$main" --branch lane-x --path "$main/sub"
assert_not_contains "refused targets created no worktree" "$tmp/main/sub" "$(git -C "$main" worktree list)"

mkdir -p "$tmp/full"
echo x > "$tmp/full/keepme"
assert_fails "refuses a non-empty target" "\"$tmp/full\"" \
  bash "$SCRIPT" --repo "$main" --branch lane-x --path "$tmp/full"
assert_eq "refused non-empty target keeps its file" "x" "$(cat "$tmp/full/keepme")"

assert_fails "refuses an unknown argument" "" \
  bash "$SCRIPT" --repo "$main" --branch lane-x --path "$tmp/nope" --wat
assert_fails "refuses a missing --branch" "" \
  bash "$SCRIPT" --repo "$main" --path "$tmp/nope2"
assert_fails "refuses a missing --path" "" \
  bash "$SCRIPT" --repo "$main" --branch lane-x

# --- 8: a failed install aborts loudly (MUST-1: never a half-bootstrapped lane) -
broken="$tmp/main-broken-install"
make_fixture "$broken" --postinstall-fails
wtbroken="$tmp/wt-broken"
assert_fails "a failing install aborts the script" "\"$wtbroken\"" \
  bash "$SCRIPT" --repo "$broken" --branch lane-broken --path "$wtbroken"
assert_contains "the failure names the checkout half-bootstrapped" "half-bootstrapped" \
  "$(bash "$SCRIPT" --repo "$broken" --branch lane-broken2 --path "$tmp/wt-broken2" 2>&1 || true)"
assert_contains "the failure names the recovery command" 'git worktree remove' \
  "$(bash "$SCRIPT" --repo "$broken" --branch lane-broken3 --path "$tmp/wt-broken3" 2>&1 || true)"

# --- 9: a missing required seed aborts, quoting it, creating no worktree -------
noenv="$tmp/main-no-env"
make_fixture "$noenv" --no-app-env
wtnoenv="$tmp/wt-noenv"
assert_fails "a missing app/.env aborts the script" '"app/.env"' \
  bash "$SCRIPT" --repo "$noenv" --branch lane-noenv --path "$wtnoenv"
assert_not_contains "the refused seed created no worktree" "$wtnoenv" "$(git -C "$noenv" worktree list)"

# The scratch worktree is gone with $tmp; nothing to clean up.
if [ "$failures" -eq 0 ]; then
  echo "lane-worktree.test.sh: green"
  exit 0
fi
echo "lane-worktree.test.sh: $failures failure(s)" >&2
exit 1
