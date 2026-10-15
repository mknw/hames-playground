#!/usr/bin/env bash
# Fail fast before `docker compose up -d`: the neo4j-internal network sets
# com.docker.network.bridge.gateway_mode_ipv4: isolated (#241 G13), which an
# Engine older than 28 rejects mid-bring-up as "unknown gateway mode isolated".
# Read-only: asks the daemon for its version and nothing else. Run: make check-docker
set -u

MIN_MAJOR=28

# engine_supported VERSION — a parsable x.y.z[-suffix] whose major is >= MIN_MAJOR.
engine_supported() {
  [[ $1 =~ ^([0-9]+)\.[0-9]+\.[0-9]+([-+].*)?$ ]] && ((10#${BASH_REMATCH[1]} >= MIN_MAJOR))
}

check_docker() {
  local v
  # Bounded when `timeout` exists: a wedged daemon should fail fast, not hang.
  local t=()
  command -v timeout >/dev/null 2>&1 && t=(timeout 10)
  v=$(${t[@]+"${t[@]}"} docker version --format '{{.Server.Version}}' 2>/dev/null) || v=""
  if engine_supported "$v"; then
    echo "Docker Engine $v (>= $MIN_MAJOR for isolated gateway mode)"
    return 0
  fi
  echo "Docker Engine ${v:-unavailable} is unsupported: need >= $MIN_MAJOR (gateway_mode_ipv4: isolated)." >&2
  echo "On colima: 'colima update', then 'colima stop && colima start'. Otherwise upgrade Docker Engine." >&2
  echo "No isolation-weakening workaround exists or is wanted; nothing was started." >&2
  return 1
}

check_docker
