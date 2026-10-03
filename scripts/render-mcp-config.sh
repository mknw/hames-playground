#!/bin/sh
# Renders the MCP gateway's config from configs/mcp-config.yaml, substituting
# ${NEO4J_PASSWORD} from the environment.
#
#   render-mcp-config.sh <input.yaml> <output.yaml>
#
# Run by the one-shot `mcp-config` service in docker-compose.yaml, which hands
# it the same `${VAR:?}` value Neo4j is created with — so the gateway's
# neo4j-cypher credential comes from the repo-root `.env` like every other
# consumer, instead of being a literal that silently disagrees with it. A config
# written with a literal password (a deployment's own copy) contains no
# placeholder and passes through unchanged.
#
# The gateway gets NO Postgres credential. Agents were never meant to reach the
# app's own database, so the `database-server` MCP server is gone and this
# script no longer fills ${POSTGRES_PASSWORD}: a config that still carries it is
# refused below, by name, rather than rendered into a database URL.
#
# POSIX sh + awk only: it runs in the stack's postgres:16-alpine image (busybox).
# Fails closed — nothing is written unless every placeholder was filled.
set -eu

in="${1:?usage: render-mcp-config.sh <input> <output>}"
out="${2:?usage: render-mcp-config.sh <input> <output>}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set}"

# awk's gsub treats `&` and `\` in the replacement specially. Refuse rather
# than render something subtly different from what the database holds.
case "$NEO4J_PASSWORD" in
  *'&'* | *'\'*)
    echo "render-mcp-config: NEO4J_PASSWORD must not contain & or \\ (use e.g. openssl rand -hex 24)" >&2
    exit 1
    ;;
esac

# A host config from before the removal still has the `database-server` block.
# The generic check below would refuse it too; this one says what to do.
if grep -v '^[[:space:]]*#' "$in" | grep -q '\${POSTGRES_PASSWORD}'; then
  echo "render-mcp-config: $in still carries \${POSTGRES_PASSWORD}. The database-server MCP server was removed, because agents get no Postgres access: delete its block from configs/mcp-config.yaml (mounted here as $in), then re-run." >&2
  exit 1
fi

tmp="$out.tmp.$$"
awk '{
  gsub(/\$\{NEO4J_PASSWORD\}/, ENVIRON["NEO4J_PASSWORD"])
  print
}' "$in" > "$tmp"

# Any placeholder left outside a comment is one this script does not know.
if grep -v '^[[:space:]]*#' "$tmp" | grep -q '\${'; then
  echo "render-mcp-config: unfilled \${...} placeholder in $in:" >&2
  grep -v '^[[:space:]]*#' "$tmp" | grep '\${' >&2
  rm -f "$tmp"
  exit 1
fi
mv "$tmp" "$out"
echo "render-mcp-config: wrote $out"
