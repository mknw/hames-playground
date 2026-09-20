#!/usr/bin/env bash
# Sandbox init / launcher.
#
# Two roles, selected by the first argument:
#
#   (no args)            ENTRYPOINT mode. Prepare /work and block forever so the
#                        container is a long-lived idle host. The harness then
#                        spawns MCP servers on demand via:
#                            docker exec <ctr> /opt/mcp/init.sh serve <name>
#
#   serve filesystem     Run rust-mcp-filesystem on stdio, scoped to /work,
#                        write enabled. Used as the docker-exec target by
#                        DockerBackend.connectMcp.
#
#   serve shell          Run mcp-shell on stdio. Same purpose.
#
# Keeping both behind one script means connectMcp targets a single, stable
# launch path per server (see docs/sandbox-plan.md → "How tools reach the
# controller" / the DockerBackend exec model).

set -euo pipefail

WORK_DIR="${WORK_DIR:-/work}"
mkdir -p "$WORK_DIR"

cmd="${1:-}"

case "$cmd" in
  serve)
    server="${2:-}"
    case "$server" in
      filesystem)
        # Write-enabled, scoped to /work only. Stdio is the MCP transport;
        # do NOT emit anything else to stdout.
        exec /opt/mcp/rust-mcp-filesystem --allow-write "$WORK_DIR"
        ;;
      shell)
        exec node /opt/mcp/mcp-shell/server.mjs
        ;;
      *)
        echo "init.sh: unknown server '$server' (want: filesystem|shell)" >&2
        exit 64
        ;;
    esac
    ;;
  "")
    # Entrypoint mode: idle host. Prepare the non-root user's HOME on the
    # /work tmpfs (the backend mounts /work RAM-backed; the image itself is
    # read-only, #116), then block forever; servers come up via docker exec.
    mkdir -p "$WORK_DIR/home"
    echo "[sandbox] init ready; /work prepared; idling (servers spawn on exec)" >&2
    exec tail -f /dev/null
    ;;
  *)
    echo "init.sh: unknown command '$cmd' (want: serve <name> | <none>)" >&2
    exit 64
    ;;
esac
