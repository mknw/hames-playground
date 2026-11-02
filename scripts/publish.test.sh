#!/usr/bin/env bash
# Pins scripts/publish.sh (the `make publish` target) against stubbed npm and
# pnpm in a throwaway git repo. Nothing is published, no registry is contacted,
# and no tag in the real repo is touched.
#   1. latest-tag selection: v0.5.0 / v0.6.0 / v0.10.0 -> 0.10.0 wins
#   2. missing repo tag (VERSION=9.9.9)                -> refused
#   3. missing package tag                             -> refused, named
#   4. package tag on a different commit               -> refused, named
#   5. fully published on npm                          -> exit 0, no publish
#   6. partially published on npm                      -> non-zero, listed
#   7. --dry-run skips the registry gate, packs with --dry-run, no whoami
#   8. no CONFIRM and a closed stdin                    -> aborted, non-zero
# Run: scripts/publish.test.sh   (no arguments, exits 0 on green)

# shellcheck disable=SC2016 # SC2016: the sh -c bodies are quoted on purpose — $1 is the sh positional, not the test's
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
failures=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# checkrc name want(0|1): the exit code of the last run()
checkrc() {
  local name=$1 want=$2
  if { [ "$want" = 0 ] && [ "$rc" -eq 0 ]; } || { [ "$want" = 1 ] && [ "$rc" -ne 0 ]; }; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $rc): $out"; failures=$((failures + 1))
  fi
}

# check name want(0|1) cmd...: the exit code of cmd
check() {
  local name=$1 want=$2 out rc
  shift 2
  out=$("$@" 2>&1); rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" = 1 ] && [ $rc -ne 0 ]; }; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $rc): $out"; failures=$((failures + 1))
  fi
}

# expect name needle: needle must appear in the last run()'s output ($out)
expect() {
  local name=$1 needle=$2
  case "$out" in
    *"$needle"*) echo "ok   $name" ;;
    *) echo "FAIL $name: missing '$needle': $out"; failures=$((failures + 1)) ;;
  esac
}

# --- fixture repo: four release tags, the v0.10.0 one fully package-tagged ----
repo="$tmp/repo"
mkdir -p "$repo"
g() { git -C "$repo" -c user.name=t -c user.email=t@t "$@"; }
g init -q
for pkg in agents connectors harness-baml harness-patterns sandbox; do
  mkdir -p "$repo/packages/$pkg"
  echo "{\"name\":\"@hames-ai/$pkg\",\"version\":\"0.10.0\"}" > "$repo/packages/$pkg/package.json"
done
g add -A && g commit -qm "v0.5.0" && g tag v0.5.0
echo x > "$repo/README.md"; g add -A; g commit -qm "v0.6.0"; g tag v0.6.0
echo y > "$repo/README.md"; g add -A; g commit -qm "v0.9.0"; g tag v0.9.0
echo z > "$repo/README.md"; g add -A; g commit -qm "v0.10.0"; g tag v0.10.0
for pkg in agents connectors harness-baml harness-patterns sandbox; do
  g tag "@hames-ai/$pkg@0.10.0"
done
# v0.9.0 exists as a repo tag but is deliberately under-tagged: agents@0.9.0 is
# missing at first (check 3), then tagged on an OLDER commit (check 4).
for pkg in connectors harness-baml harness-patterns sandbox; do
  g tag "@hames-ai/$pkg@0.9.0"
done

# --- stubs --------------------------------------------------------------------
# npm: logs every call; `view <name>@<ver> version` succeeds exactly for the
# packages named in PUBLISHED_PKGS (space-separated bare names) at
# CHECK_VERSION; unpinned `view <name> version` echoes NPM_LATEST (the
# post-publish verify); `whoami` answers as a logged-in user.
stub="$tmp/stub"
mkdir -p "$stub"
cat > "$stub/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "${NPM_LOG:?}"
case "${1:-}" in
  whoami) echo "testuser"; exit 0 ;;
  view)
    spec=$2
    case "${spec##*@}" in
      [0-9]*)
        pkg=${spec%@*}; ver=${spec##*@}
        if [ "$ver" = "${CHECK_VERSION:?}" ] && \
           printf '%s\n' "${PUBLISHED_PKGS:-}" | tr ' ' '\n' | grep -Fx "${pkg#@hames-ai/}" >/dev/null; then
          echo "$ver"; exit 0
        fi
        exit 1 ;;
      *) echo "${NPM_LATEST:?}"; exit 0 ;;
    esac ;;
esac
exit 1
EOF
cat > "$stub/pnpm" <<'EOF'
#!/usr/bin/env bash
printf 'pnpm %s\n' "$*" >> "${PNPM_LOG:?}"
exit 0
EOF
chmod +x "$stub/npm" "$stub/pnpm"

run() { # runs publish.sh in the fixture repo with the stubs on PATH; sets out+rc
  # flag --unset-confirm leaves CONFIRM unset in the child; the rest pass through
  local unset_confirm=0 a
  local args=()
  for a in "$@"; do
    if [ "$a" = "--unset-confirm" ]; then unset_confirm=1; else args+=("$a"); fi
  done
  local confirm_spec=""
  [ "$unset_confirm" = 0 ] && confirm_spec="CONFIRM=1"
  : > "$tmp/npm.log"; : > "$tmp/pnpm.log"
  out=$(cd "$repo" && \
    env -u CONFIRM \
      CHECK_VERSION="${CHECK_VERSION:-0.10.0}" NPM_LATEST="${NPM_LATEST:-0.10.0}" \
      PUBLISHED_PKGS="${PUBLISHED_PKGS:-}" VERSION="${VERSION:-}" \
      NPM_LOG="$tmp/npm.log" PNPM_LOG="$tmp/pnpm.log" PATH="$stub:$PATH" \
      $confirm_spec \
      "$ROOT/scripts/publish.sh" ${args[@]+"${args[@]}"} < /dev/null 2>&1)
  rc=$?
}

# --- 1. latest-tag selection: 0.10.0 beats 0.6.0 and 0.5.0 --------------------
run
checkrc "latest v-tag (0.10.0) is selected and published" 0
expect "selection prints the version" "release: v0.10.0"
check "registry pinned check ran for the version" 0 grep -q "npm view @hames-ai/agents@0.10.0 version" "$tmp/npm.log"
check "publish ran with --no-git-checks" 0 grep -q "pnpm -r publish --no-git-checks" "$tmp/pnpm.log"
check "publish did NOT run with --dry-run" 0 sh -c '! grep -q -- --dry-run "$1"' sh "$tmp/pnpm.log"
check "whoami ran before publish" 0 grep -q "npm whoami" "$tmp/npm.log"
check "post-publish verify ran unpinned" 0 grep -q "npm view @hames-ai/sandbox version" "$tmp/npm.log"
expect "verify says all five" "all five verified"

# --- 2. missing repo tag -------------------------------------------------------
export VERSION=9.9.9; run
checkrc "missing repo tag refused" 1
expect "message names the tag" "v9.9.9 does not exist"
check "nothing reached pnpm" 0 sh -c '[ ! -s "$1" ]' sh "$tmp/pnpm.log"
unset VERSION

# --- 3. missing package tag (agents@0.9.0 not tagged yet) ----------------------
export VERSION=0.9.0; run
checkrc "missing package tag refused" 1
expect "message names the missing tag" "@hames-ai/agents@0.9.0 does not exist"

# --- 4. package tag on a different commit ---------------------------------------
g tag -f "@hames-ai/agents@0.9.0" "$(g rev-parse v0.6.0)" >/dev/null 2>&1
run
checkrc "package tag on another commit refused" 1
expect "message names the differing tag" "@hames-ai/agents@0.9.0 points at"
unset VERSION

# --- 5. fully published: exit 0, no publish -------------------------------------
export PUBLISHED_PKGS="agents connectors harness-baml harness-patterns sandbox"; run
checkrc "already published exits 0" 0
expect "says already published" "already published"
check "no publish call happened" 0 sh -c '[ ! -s "$1" ]' sh "$tmp/pnpm.log"
check "no whoami happened" 0 sh -c '! grep -q whoami "$1"' sh "$tmp/npm.log"

# --- 6. partially published: non-zero, lists the offenders ----------------------
PUBLISHED_PKGS="agents connectors"; run
checkrc "partial publish refused" 1
expect "lists @hames-ai/agents" "@hames-ai/agents"
expect "lists @hames-ai/connectors" "@hames-ai/connectors"
check "no publish call happened" 0 sh -c '[ ! -s "$1" ]' sh "$tmp/pnpm.log"
unset PUBLISHED_PKGS

# --- 7. --dry-run: registry gate skipped, packs with --dry-run, no whoami ------
export PUBLISHED_PKGS="agents connectors harness-baml harness-patterns sandbox"; run --dry-run
checkrc "dry-run exits 0 even when the version is already published" 0
check "packs with --dry-run" 0 grep -q "pnpm -r publish --dry-run --no-git-checks" "$tmp/pnpm.log"
check "dry-run does not publish" 0 sh -c '! grep -q "publish --no-git-checks" "$1"' sh "$tmp/pnpm.log"
check "dry-run skips whoami" 0 sh -c '! grep -q whoami "$1"' sh "$tmp/npm.log"
unset PUBLISHED_PKGS

# --- 8. confirmation gate: no CONFIRM, closed stdin -> aborted ------------------
run --unset-confirm
checkrc "unconfirmed run aborts" 1
expect "says aborted" "aborted"
check "nothing reached pnpm" 0 sh -c '[ ! -s "$1" ]' sh "$tmp/pnpm.log"

if [ "$failures" -eq 0 ]; then
  echo "all green"
else
  echo "$failures failure(s)"
  exit 1
fi
