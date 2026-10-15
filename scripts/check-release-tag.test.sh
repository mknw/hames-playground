#!/usr/bin/env bash
# Pins the release-tag guard (scripts/check-release-tag.mjs) as each publishable
# package actually wires it: the REAL `prepublishOnly` string from every
# packages/*/package.json runs in a scripted throwaway git repo. Nothing is
# published, no registry is contacted, and no tag in the real repo is touched.
#   1. HEAD is the tag                 -> exit 0
#   2. a commit past the tag (RED)     -> exit non-zero, tells you to checkout the tag
#   3. HEAD tagged for another version -> exit non-zero
#   4. npm user agent                  -> still refused (the npm-vs-pnpm guard stays)
# Run: scripts/check-release-tag.test.sh   (no arguments, exits 0 on green)

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
failures=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

check() { # name expected-nonzero(0|1) cmd...
  local name=$1 want=$2 out rc
  shift 2
  out=$("$@" 2>&1); rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" = 1 ] && [ $rc -ne 0 ]; }; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $rc): $out"; failures=$((failures + 1))
  fi
}

for pkgjson in "$ROOT"/packages/*/package.json; do
  pkg=$(basename "$(dirname "$pkgjson")")
  script=$(node -p "require('$pkgjson').scripts.prepublishOnly")
  name=$(node -p "require('$pkgjson').name")
  repo="$tmp/$pkg"
  mkdir -p "$repo/scripts" "$repo/packages/$pkg"
  cp "$ROOT/scripts/check-release-tag.mjs" "$repo/scripts/"
  echo "{\"name\":\"$name\",\"version\":\"1.2.3\"}" > "$repo/packages/$pkg/package.json"
  g() { git -C "$repo" -c user.name=t -c user.email=t@t "$@"; }
  g init -q && g add -A && g commit -qm release && g tag -a "$name@1.2.3" -m release
  run() { (cd "$repo/packages/$pkg" && npm_config_user_agent=${UA:-pnpm/9} sh -c "$script"); }

  check "$pkg: at the tag publishes" 0 run
  echo x > "$repo/past.txt"; g add -A; g commit -qm "past the tag"
  check "$pkg: commit past the tag is refused" 1 run
  out=$(run 2>&1); case $out in *"git checkout $name@1.2.3"*) echo "ok   $pkg: message names the checkout";; *) echo "FAIL $pkg: no checkout hint: $out"; failures=$((failures + 1));; esac
  g checkout -q --detach HEAD~1 && g tag -d "$name@1.2.3" >/dev/null && g tag -a "$name@1.2.2" -m old
  check "$pkg: HEAD tagged for another version is refused" 1 run
  g tag -a "$name@1.2.3" -m release
  UA=npm/10 check "$pkg: npm is still refused" 1 run
done

[ $failures -eq 0 ] && echo "all green" || { echo "$failures failure(s)"; exit 1; }
