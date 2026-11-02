#!/usr/bin/env bash
# make publish — publish the packages of the latest release tag to npm.
#
# Replaces the manual block in CONTRIBUTING.md ("How a release happens"):
# pick the highest `v<semver>` tag, refuse unless every
# `@hames-ai/<pkg>@<version>` tag exists at the same commit, refuse a partial
# npm publish, ask for confirmation, then run the install / whoami / publish
# from a THROWAWAY worktree so the caller's checkout is never touched. The real
# publish guard stays each package's `prepublishOnly` check
# (scripts/check-release-tag.mjs); nothing here weakens it.
#
# Usage: scripts/publish.sh [--dry-run]
# Env:   VERSION=x.y.z       publish this version instead of the latest tag
#        CONFIRM=1           skip the y/N prompt
#        NPM_USERCONFIG=path npm config file for the whoami / publish steps
#                            (exported as NPM_CONFIG_USERCONFIG)
# `--dry-run` (also `make publish-dry`) packs without publishing: the registry
# gates (the already-published check, `npm whoami`, the post-publish verify)
# and the confirmation prompt are skipped, and the publish itself is
# `pnpm -r publish --dry-run --no-git-checks`.
#
# Tested by scripts/publish.test.sh, which stubs npm and pnpm on PATH and runs
# this against a throwaway git repo — nothing is published and no registry is
# contacted there.

set -euo pipefail

case "${1:-}" in
  "") DRY=0 ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# --- 0. NPM_USERCONFIG -> NPM_CONFIG_USERCONFIG for EVERY npm step: the
# registry gate below, whoami, the publish, and the post-publish verify.
if [ -n "${NPM_USERCONFIG:-}" ]; then
  export NPM_CONFIG_USERCONFIG="$NPM_USERCONFIG"
fi
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

PKGS="agents connectors harness-baml harness-patterns sandbox"

# --- 1. the release: VERSION override, else the highest semver `v*` tag ------
if [ -n "${VERSION:-}" ]; then
  VERSION="${VERSION#v}"
else
  VERSION=$(git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
  VERSION="${VERSION#v}"
fi
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: no release found — expected a v<semver> tag (or set VERSION=x.y.z)" >&2
  exit 1
fi

if ! git fetch --tags >/dev/null 2>&1; then
  echo "warning: git fetch --tags failed; using the local tags" >&2
fi

# --- 2. all five package tags must exist at the same commit ------------------
repo_commit=$(git rev-parse --verify --quiet "refs/tags/v$VERSION^{commit}" || true)
if [ -z "$repo_commit" ]; then
  echo "ERROR: tag v$VERSION does not exist (run git fetch --tags, or check VERSION)" >&2
  exit 1
fi
echo "release: v$VERSION at $repo_commit"
for pkg in $PKGS; do
  tag="@hames-ai/$pkg@$VERSION"
  pkg_commit=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}" || true)
  if [ -z "$pkg_commit" ]; then
    echo "ERROR: tag $tag does not exist" >&2
    exit 1
  fi
  if [ "$pkg_commit" != "$repo_commit" ]; then
    echo "ERROR: $tag points at $pkg_commit, but v$VERSION is at $repo_commit" >&2
    exit 1
  fi
done

# --- 3. the npm registry gate: never partially republish ---------------------
if [ "$DRY" -eq 0 ]; then
  published=""
  for pkg in $PKGS; do
    if npm view "@hames-ai/$pkg@$VERSION" version >/dev/null 2>&1; then
      published="$published @hames-ai/$pkg"
    fi
  done
  # Unquoted on purpose: it is a controlled space-separated list that must
  # word-split into the positional parameters.
  # shellcheck disable=SC2086
  set -- $published
  if [ "$#" -eq 5 ]; then
    echo "already published: @hames-ai/*@$VERSION (nothing to do)"
    exit 0
  fi
  if [ "$#" -gt 0 ]; then
    echo "ERROR: already on npm at $VERSION; refusing a partial republish:" >&2
    echo "  published: $*" >&2
    missing=""
    for pkg in $PKGS; do
      case " $* " in
        *" @hames-ai/$pkg "*) ;;
        *) missing="$missing @hames-ai/$pkg" ;;
      esac
    done
    echo "  not yet published:$missing" >&2
    exit 1
  fi
fi

# --- 4. confirmation ----------------------------------------------------------
if [ "$DRY" -eq 0 ] && [ "${CONFIRM:-}" != "1" ]; then
  printf 'publish @hames-ai/* %s from %s? [y/N] ' "$VERSION" "$repo_commit"
  if ! read -r reply; then
    echo
    echo "aborted: no confirmation" >&2
    exit 1
  fi
  case "$reply" in
    y | Y | yes | YES) ;;
    *) echo "aborted" >&2; exit 1 ;;
  esac
fi

# --- 5. throwaway worktree at the release commit, removed on exit -------------
worktree=$(mktemp -d)
cleanup() {
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$worktree"
}
trap cleanup EXIT

git worktree add --quiet --detach "$worktree" "$repo_commit"


# --- 6. install, whoami, publish (the prepublishOnly tag guard stays) --------
(
  cd "$worktree"
  echo "==> pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
  if [ "$DRY" -eq 0 ]; then
    echo "==> npm whoami"
    npm whoami
    echo "==> pnpm -r publish --no-git-checks"
    pnpm -r publish --no-git-checks
  else
    echo "==> pnpm -r publish --dry-run --no-git-checks"
    pnpm -r publish --dry-run --no-git-checks
  fi
)

# --- 7. verify npm actually has the version for every package -----------------
if [ "$DRY" -eq 0 ]; then
  failed=0
  for pkg in $PKGS; do
    got=$(npm view "@hames-ai/$pkg" version 2>/dev/null || echo "unavailable")
    if [ "$got" != "$VERSION" ]; then
      echo "ERROR: npm has @hames-ai/$pkg at $got, expected $VERSION" >&2
      failed=1
    fi
  done
  if [ "$failed" -ne 0 ]; then
    exit 1
  fi
  echo "published @hames-ai/* $VERSION: all five verified on npm"
fi
