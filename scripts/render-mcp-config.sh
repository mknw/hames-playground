#!/bin/sh
# Renders the MCP gateway's config from configs/mcp-config.yaml, substituting
# ${NEO4J_PASSWORD} and ${POSTGRES_PASSWORD} from the environment.
#
#   render-mcp-config.sh <input.yaml> <output.yaml>
#
# Run by the one-shot `mcp-config` service in docker-compose.yaml, which hands
# it the same two `${VAR:?}` values the databases are created with — so the
# gateway's neo4j-cypher and database-server credentials come from the repo-root
# `.env` like every other consumer, instead of being literals that silently
# disagree with it. A config written with literal passwords (a deployment's own
# copy) contains no placeholder and passes through unchanged.
#
# POSIX sh + awk only: it runs in the stack's postgres:16-alpine image (busybox).
# Fails closed — nothing is written unless every placeholder was filled.
set -eu

in="${1:?usage: render-mcp-config.sh <input> <output>}"
out="${2:?usage: render-mcp-config.sh <input> <output>}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set}"

# awk's gsub treats `&` and `\` in the replacement specially, and the Postgres
# value is spliced raw into a postgresql:// URL, where these break it. Refuse
# rather than render something subtly different from what the database holds.
case "$NEO4J_PASSWORD" in
  *'&'* | *'\'*)
    echo "render-mcp-config: NEO4J_PASSWORD must not contain & or \\ (use e.g. openssl rand -hex 24)" >&2
    exit 1
    ;;
esac
case "$POSTGRES_PASSWORD" in
  *'&'* | *'\'* | *'/'* | *'@'* | *':'* | *'#'* | *'?'* | *'%'* | *' '*)
    echo "render-mcp-config: POSTGRES_PASSWORD must be URL-safe (no & \\ / @ : # ? % or space; use e.g. openssl rand -hex 24)" >&2
    exit 1
    ;;
esac

tmp="$out.tmp.$$"
awk '{
  gsub(/\$\{NEO4J_PASSWORD\}/, ENVIRON["NEO4J_PASSWORD"])
  gsub(/\$\{POSTGRES_PASSWORD\}/, ENVIRON["POSTGRES_PASSWORD"])
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
