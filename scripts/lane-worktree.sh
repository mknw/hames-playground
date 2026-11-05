#!/usr/bin/env bash
# Bootstrap a lane worktree the way orca.yaml's `setup` hook did.
#
# Orca ran that hook itself after `worktree create`. The herdr runtime runs no
# per-repo hooks — `herdr worktree open` creates/attaches the checkout and does
# nothing else — so a herdr lane bootstraps its checkout with this script once,
# BEFORE the agent is started in it (agents need node_modules for their first
# command; see the dispatch contract in .claude/skills/kg-lane-dispatch/).
#
# Usage:
#   scripts/lane-worktree.sh --branch <name> --path <dir> [--repo <root>] [--base <ref>]
#
#   --repo  the main checkout to seed from (default: the current git toplevel)
#   --base  the ref the lane branches from (default: main, falling back to HEAD)
#
# Steps, mirroring orca.yaml `setup` step for step:
#   1. git worktree add
#   2. copy gitignored config a worktree cannot inherit from git
#   3. LINK deploy/modal/*.local.* — never copy. They are gitignored, so a worktree
#      copy is the only one a lane could ever have written to: an edit made in the
#      lane writes through the link to the main checkout's file, and removing the
#      worktree deletes only the link (2026-10-15: a copy was the sole surviving
#      one and went with its worktree). Absent in the main checkout -> skipped.
#   4. copy .claude settings (gitignored enablement + permission allow-list;
#      without them every lane re-prompts to approve the MCP gateway)
#   5. direnv allow (when direnv is installed and .envrc exists — direnv trust is
#      per-directory and does NOT travel with the worktree), then
#      `pnpm install --frozen-lockfile` from app/, as the repo does
#   There is NO BAML generate step: the one corpus
#   (packages/harness-baml/baml_src) ships a COMMITTED baml_client/, so a fresh
#   worktree already has the generated client.
#
# Refuses to run with the main checkout (or anything inside it) as the target,
# and quotes every path it prints.

set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/lane-worktree.sh --branch <name> --path <dir> [--repo <root>] [--base <ref>]
EOF
}

die() { printf 'lane-worktree.sh: %s\n' "$1" >&2; exit 1; }

branch=""
path=""
repo=""
base=""

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) [ $# -ge 2 ] || die "--branch needs a value"; branch=$2; shift 2 ;;
    --path)   [ $# -ge 2 ] || die "--path needs a value";   path=$2;   shift 2 ;;
    --repo)   [ $# -ge 2 ] || die "--repo needs a value";   repo=$2;   shift 2 ;;
    --base)   [ $# -ge 2 ] || die "--base needs a value";   base=$2;   shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$branch" ] || { usage >&2; die "--branch is required"; }
[ -n "$path" ]   || { usage >&2; die "--path is required"; }

if [ -z "$repo" ]; then
  repo=$(git rev-parse --show-toplevel 2>/dev/null) \
    || die "--repo not given and the current directory is not inside a git checkout"
fi
[ -d "$repo" ] || die "repo is not a directory: \"$repo\""
repo=$(cd "$repo" && pwd) || die "cannot resolve repo: \"$repo\""

# The main checkout is never a lane target — the one with the owner's dev
# server attached, where every save hot-reloads under the owner's hands.
case "$path" in
  "$repo")
    die "refusing to run with the main checkout as target: \"$repo\"" ;;
  "$repo"/*)
    die "refusing a target inside the main checkout: \"$path\" (main checkout: \"$repo\")" ;;
esac

if [ -e "$path" ]; then
  [ -d "$path" ] || die "target exists and is not a directory: \"$path\""
  [ -z "$(ls -A "$path")" ] \
    || die "refusing a non-empty target: \"$path\" (create a fresh directory, or remove the failed one)"
fi
mkdir -p "$path"
path=$(cd "$path" && pwd) || die "cannot resolve target: \"$path\""

if [ -z "$base" ]; then
  if git -C "$repo" show-ref --verify --quiet refs/heads/main; then
    base=main
  else
    base=HEAD
  fi
fi

# Preflight the required seeds BEFORE the worktree exists: a missing one must
# not leave a half-created checkout behind (the refusal creates no worktree).
for req in app/.env configs/mcp-config.yaml; do
  [ -e "$repo/$req" ] \
    || die "required file missing in the main checkout: \"$repo/$req\" (seed \"$req\")"
done

echo "lane-worktree.sh: creating \"$path\" (branch \"$branch\", base \"$base\") from \"$repo\""
git -C "$repo" worktree add -b "$branch" "$path" "$base" >&2

# 2. gitignored config a worktree cannot inherit from git.
seed_copy() { # <source-rel> <dest-rel> — required: a missing main-checkout source is fatal
  if [ -e "$repo/$1" ]; then
    cp "$repo/$1" "$path/$2"
    echo "  copied \"$2\""
  else
    die "required file missing in the main checkout: \"$repo/$1\""
  fi
}
seed_optional() {
  if [ -e "$repo/$1" ]; then
    cp "$repo/$1" "$path/$2"
    echo "  copied \"$2\""
  fi
}

# app/.env and the repo-root .env (the ONE source of the stack's database
# passwords: compose, `pnpm dev` and the test suites' DB URLs all read it)
# stay COPIES on purpose — lanes may diverge from them.
seed_copy "app/.env" "app/.env"
seed_optional ".env" ".env"
seed_copy "configs/mcp-config.yaml" "configs/mcp-config.yaml"
seed_optional "docker-compose.override.yml" "docker-compose.override.yml"

for src in "$repo"/deploy/modal/*.local.*; do
  [ -e "$src" ] || continue
  rel=${src#"$repo"/}
  mkdir -p "$path/$(dirname "$rel")"
  dest="$path/$rel"
  # Never replace what the lane already holds (a regular copy, or any link,
  # dangling included): that file may be its only one.
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    continue
  fi
  ln -s "$src" "$dest"
  echo "  linked \"$rel\""
done

# 4. Claude Code project settings.
mkdir -p "$path/.claude"
for f in settings.json settings.local.json; do
  seed_optional ".claude/$f" ".claude/$f"
done

# 5. toolchain + deps. .envrc is `use flake`.
run() { "$@"; }
if command -v direnv >/dev/null 2>&1 && [ -f "$path/.envrc" ]; then
  direnv allow "$path"
  run() { direnv exec "$path" "$@"; }
fi

[ -d "$path/app" ] || die "the checkout has no app/ directory: \"$path/app\""
cd "$path/app"
# A failed install leaves the checkout half-bootstrapped; the failure must be
# loud and the checkout discarded — never a lane started in it.
run pnpm install --frozen-lockfile \
  || die "pnpm install failed — the checkout at \"$path\" is half-bootstrapped; remove it with: git worktree remove \"$path\" --force"

echo "lane-worktree.sh: done — \"$path\" on \"$branch\"."
echo "Next (herdr): herdr worktree open --cwd \"$repo\" --path \"$path\" --no-focus"
