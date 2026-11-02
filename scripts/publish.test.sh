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
#   9. no release tag at all                            -> refused
# Review tests (PR #916, adapted from the reviewer's uncommitted
# scripts/publish-review.test.sh; each carries its mutation in a comment):
#   R1  semver ordering: v0.10.0 must beat v0.9.0       (mutation: sort mode)
#   R2  prerelease / odd tags are never selected        (mutation: grep relaxed)
#   R2b VERSION=0.11.0-rc.1 override is refused         (mutation: regex removed)
#   R3  trap removes the worktree when publish fails    (mutation: trap removed)
#   R4  VERSION override to a nonexistent tag: refused  (mutation: exit dropped)
#       and named, nothing published, no release line
#   R5  tags are FETCHED before the latest tag is chosen (the finding itself:
#       red on the pre-#916-fix code, where selection preceded the fetch)
# Run: scripts/publish.test.sh   (no arguments, exits 0 on green)

# shellcheck disable=SC2016 # SC2016: the sh -c bodies are quoted on purpose — $1 is the sh positional, not the test's
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# PUBLISH_SH: the script under test; overriding it runs the suite against a
# different tree — that is how the mutation proofs above are reproduced
# (e.g. the pre-fix publish.sh for R5).
PUBLISH_SH=${PUBLISH_SH:-$ROOT/scripts/publish.sh}
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

# expect_absent name needle: needle must NOT appear in the last run()'s output
expect_absent() {
  local name=$1 needle=$2
  case "$out" in
    *"$needle"*) echo "FAIL $name: unexpected '$needle': $out"; failures=$((failures + 1)) ;;
    *) echo "ok   $name" ;;
  esac
}
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
case "$*" in *publish*) exit "${PNPM_PUBLISH_RC:-0}" ;; esac
exit 0
EOF
chmod +x "$stub/npm" "$stub/pnpm"

run() { # runs publish.sh in the fixture repo with the stubs on PATH; sets out+rc
  # flags: --unset-confirm leaves CONFIRM unset in the child; repo=<path> runs
  # in a different repo; the rest pass through as script arguments
  local unset_confirm=0 a run_repo="$repo"
  local args=()
  for a in "$@"; do
    case $a in
      --unset-confirm) unset_confirm=1 ;;
      repo=*) run_repo="${a#repo=}" ;;
      *) args+=("$a") ;;
    esac
  done
  local confirm_spec=""
  [ "$unset_confirm" = 0 ] && confirm_spec="CONFIRM=1"
  : > "$tmp/npm.log"; : > "$tmp/pnpm.log"
  out=$(cd "$run_repo" && \
    env -u CONFIRM \
      CHECK_VERSION="${CHECK_VERSION:-0.10.0}" NPM_LATEST="${NPM_LATEST:-0.10.0}" \
      PUBLISHED_PKGS="${PUBLISHED_PKGS:-}" VERSION="${VERSION:-}" \
      NPM_LOG="$tmp/npm.log" PNPM_LOG="$tmp/pnpm.log" PATH="$stub:$PATH" \
      $confirm_spec \
      "$PUBLISH_SH" ${args[@]+"${args[@]}"} < /dev/null 2>&1)
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

# --- 9. no release tag at all: a repo with no v* tag ---------------------------
mkdir -p "$tmp/repo-no-tag"
git -C "$tmp/repo-no-tag" init -q
git -C "$tmp/repo-no-tag" -c user.name=t -c user.email=t@t commit -q --allow-empty -m "no tags"
run repo="$tmp/repo-no-tag"
checkrc "no v* tag refused" 1
expect "says no release found" "no release found"
check "nothing reached pnpm" 0 sh -c '[ ! -s "$1" ]' sh "$tmp/pnpm.log"

# ==========================================================================
# Review tests for PR #916 (adapted from the reviewer's uncommitted
# scripts/publish-review.test.sh). Each mutation named below is a change to
# scripts/publish.sh (or the pre-fix state for R5) that turns the test red;
# all were verified.
# ==========================================================================

# mkrepo: a fully-tagged release at $2 (repo tag v$2 + the five package tags),
# optionally with earlier commits each carrying its own tag so tag ordering
# can be observed. No packages/ tree — publish.sh never reads one through
# the stubs.
mkrepo() { # mkrepo <dir> <fully-tagged-version> [earlier-tag...]
  local r=$1 ver=$2 t pkg
  shift 2
  git -C "$r" init -q
  for t in "$@"; do
    echo t > "$r/f"; git -C "$r" add -A
    git -C "$r" -c user.name=t -c user.email=t@t commit -qm "$t"; git -C "$r" tag "$t"
  done
  echo final > "$r/f"; git -C "$r" add -A
  git -C "$r" -c user.name=t -c user.email=t@t commit -qm "v$ver"; git -C "$r" tag "v$ver"
  for pkg in agents connectors harness-baml harness-patterns sandbox; do
    git -C "$r" tag "@hames-ai/$pkg@$ver"
  done
}

# --- R1. semver ordering: v0.10.0 must beat v0.9.0 -----------------------------
# mutation: --sort=-v:refname -> --sort=-refname (lexicographic) turns this red
# (v0.9.0 sorts above v0.10.0 as a string).
r1="$tmp/r1"; mkdir -p "$r1"
mkrepo "$r1" 0.10.0 v0.9.0
run repo="$r1"
checkrc "R1 publish succeeds" 0
check "R1 selects 0.10.0 over 0.9.0" 0 grep -qF "npm view @hames-ai/agents@0.10.0 version" "$tmp/npm.log"
check "R1 v0.9.0 never selected" 0 sh -c '! grep -qF "agents@0.9.0" "$1"' sh "$tmp/npm.log"

# --- R2. prerelease / malformed tags are never selected ------------------------
# mutation: relax the selector grep to ^v?[0-9.]+ -> R2 red (0.11.0-rc.1 is
# selected and its tag check fails).
r2="$tmp/r2"; mkdir -p "$r2"
mkrepo "$r2" 0.10.0
git -C "$r2" tag v0.11.0-rc.1
git -C "$r2" tag v2            # malformed two-part tag
git -C "$r2" tag not-a-tag
# the rc version is FULLY tagged (repo tag + the five package tags), so the
# only thing refusing a prerelease override is the version-shape check
for pkg in agents connectors harness-baml harness-patterns sandbox; do
  git -C "$r2" tag "@hames-ai/$pkg@0.11.0-rc.1"
done
run repo="$r2"
checkrc "R2 publish succeeds with odd tags present" 0
check "R2 still selects 0.10.0" 0 grep -qF "npm view @hames-ai/agents@0.10.0 version" "$tmp/npm.log"
check "R2 prerelease never selected" 0 sh -c '! grep -qF "0.11.0-rc.1" "$1"' sh "$tmp/npm.log"

# R2b: a prerelease VERSION override is refused (the contract says x.y.z).
# mutation: neutralise the version-shape regex (grep -Eq '') -> R2b red (the
# fully-tagged rc version then publishes).
export VERSION=0.11.0-rc.1; run repo="$r2"
unset VERSION
checkrc "R2b prerelease VERSION refused" 1
check "R2b nothing reached pnpm" 0 sh -c '[ ! -s "$1" ]' sh "$tmp/pnpm.log"

# --- R3. the trap removes the worktree when the publish fails ------------------
# mutation: delete the `trap cleanup EXIT` line -> both assertions red (the
# temp dir and the worktree registration survive).
r3="$tmp/r3"; mkdir -p "$r3"
mkrepo "$r3" 0.10.0
mkdir -p "$tmp/wtbox"
export PNPM_PUBLISH_RC=1 TMPDIR="$tmp/wtbox"
run repo="$r3"
unset PNPM_PUBLISH_RC TMPDIR
checkrc "R3 failed publish exits non-zero" 1
leftover=$(find "$tmp/wtbox" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
check "R3 worktree directory removed" 0 test "$leftover" = 0
reg=$(git -C "$r3" worktree list --porcelain | grep -c '^worktree' || true)
check "R3 no worktree left registered" 0 test "$reg" = 1

# --- R4. VERSION override to a nonexistent tag: refused and named --------------
# mutation: delete the whole missing-repo-tag `if` block -> the naming and the
# no-release-line assertions both go red (the script then prints
# `release: v0.12.3 at ` with an empty commit; only the package-tag check still
# refuses).
r4="$tmp/r4"; mkdir -p "$r4"
mkrepo "$r4" 0.10.0
export VERSION=0.12.3; run repo="$r4"
unset VERSION
checkrc "R4 nonexistent-tag override refused" 1
expect "R4 names the missing tag" "v0.12.3 does not exist"
expect_absent "R4 no release line for a nonexistent tag" "release: v0.12.3"
check "R4 nothing reached pnpm" 0 sh -c '[ ! -s "$1" ]' sh "$tmp/pnpm.log"

# --- R5. tags are FETCHED before the latest tag is chosen ----------------------
# The contract (CONTRIBUTING.md) reads "it fetches tags" and then chooses the
# highest v<semver>: a release tagged elsewhere after the last local fetch must
# still be selected. This test is the mutation proof for the reorder itself:
# RED against the pre-fix publish.sh, where selection preceded the fetch (run
# it with PUBLISH_SH pointing at a checkout of the old script) — the stale
# release was selected and the previous version published instead.
r5o="$tmp/r5-origin"; r5c="$tmp/r5-clone"
mkdir -p "$r5o"
mkrepo "$r5o" 0.10.0
git -C "$r5o" init -q --bare "$tmp/r5-bare.git"
git -C "$r5o" push -q "$tmp/r5-bare.git" --all >/dev/null 2>&1
git -C "$r5o" push -q "$tmp/r5-bare.git" --tags >/dev/null 2>&1
git clone -q "$tmp/r5-bare.git" "$r5c"
# the maintainer (elsewhere) tags v0.11.0 and pushes it — the clone has not
# fetched yet
echo new > "$r5o/f"; git -C "$r5o" add -A
git -C "$r5o" -c user.name=t -c user.email=t@t commit -qm "v0.11.0"; git -C "$r5o" tag v0.11.0
for pkg in agents connectors harness-baml harness-patterns sandbox; do
  git -C "$r5o" tag "@hames-ai/$pkg@0.11.0"
done
git -C "$r5o" push -q "$tmp/r5-bare.git" --tags >/dev/null 2>&1
export CHECK_VERSION=0.11.0 NPM_LATEST=0.11.0
run repo="$r5c"
unset CHECK_VERSION NPM_LATEST
checkrc "R5 publish succeeds" 0
check "R5 fetched tag selected" 0 grep -qF "npm view @hames-ai/agents@0.11.0 version" "$tmp/npm.log"

if [ "$failures" -eq 0 ]; then
  echo "all green"
else
  echo "$failures failure(s)"
  exit 1
fi
