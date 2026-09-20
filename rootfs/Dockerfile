# Sandbox rootfs (v0, flavor: base)
#
# See docs/sandbox-plan.md → "Rootfs composition (v0)". Bundles the two in-VM
# MCP servers + a Python runtime on debian-slim:
#
#   /opt/mcp/rust-mcp-filesystem   filesystem MCP (read/write/edit/list/search)
#   /opt/mcp/mcp-shell/            JS shell-exec MCP (one `bash` tool; covers Python)
#   python3                         invoked through mcp-shell in v0
#
# Architecture note (MCP-in-VM): the container is a long-lived, idle host. It
# does NOT run the MCP servers as foreground processes. Instead the harness's
# DockerBackend.connectMcp opens one stdio transport per server by running
# `docker exec <container> <server-cmd>` — the server's lifetime is the
# transport's lifetime. So the container's job at boot is only to (a) prepare
# /work and (b) stay alive. init.sh does exactly that. Stdout/stderr of the
# server processes flow over the docker-exec stdio pipe straight to the harness.

# ---- stage 1: lift the rust-mcp-filesystem binary from the pinned image ----
# Same digest the project already trusts (configs/custom-catalog.yaml). The
# binary is a statically-linked ELF, so it runs unmodified on debian/glibc.
FROM mcp/rust-mcp-filesystem@sha256:77a7f6f7a477bdec2c58696c76afda8e1f88d189f7c8b935d8dd9a00ee5780c5 AS fs-mcp

# ---- stage 2: the sandbox image ----
FROM node:22-bookworm-slim AS base

# Python 3 + a minimal toolchain. python3-venv/pip so the actor can install
# packages via `sandbox_bash`. curl/ca-certificates for file ingestion
# (curl/wget into /work) per the plan's "File ingestion in v0".
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
        curl \
        bash \
    && rm -rf /var/lib/apt/lists/*

# In-VM MCP servers live under /opt/mcp.
RUN mkdir -p /opt/mcp /work

# Egress allowlist CONNECT proxy (#116). Same image as the sandboxes — the
# gateway container only needs Node. Not an MCP server; its stdout is the
# outbound audit log. PER BOOT (channel 2): the backend names each boot's
# gateway kg-sandbox-egress-<profile>-<sandbox-id>-gw, so the audit trail
# (`docker logs <gw>`) survives only until that sandbox is destroyed — the
# per-profile long-lived window is gone.
COPY egress-proxy/proxy.mjs /opt/mcp/egress-proxy/proxy.mjs
RUN chmod +x /opt/mcp/egress-proxy/proxy.mjs

# rust-mcp-filesystem (filesystem MCP).
COPY --from=fs-mcp /rust-mcp-filesystem /opt/mcp/rust-mcp-filesystem
RUN chmod +x /opt/mcp/rust-mcp-filesystem

# mcp-shell (JS shell-exec MCP). Install its prod deps in-image so it runs
# offline at exec time (no network needed once built).
COPY mcp-shell/package.json /opt/mcp/mcp-shell/package.json
WORKDIR /opt/mcp/mcp-shell
RUN npm install --omit=dev --no-audit --no-fund
COPY mcp-shell/server.mjs /opt/mcp/mcp-shell/server.mjs
RUN chmod +x /opt/mcp/mcp-shell/server.mjs

# init.sh keeps the container alive and prepares /work.
COPY init.sh /opt/mcp/init.sh
RUN chmod +x /opt/mcp/init.sh

# uv (static binary, same pin as the data/office flavours) — live installs on
# the networked egress profiles go through it (#116: "uv live-install").
COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /uvx /bin/

# Writable-at-runtime knobs (#116 hardening):
#   /work       RAM-backed tmpfs mounted by the backend (mode 1777 — docker
#               cannot chown a tmpfs to the image user, so it is world-
#               writable; every in-VM process runs as the same uid anyway).
#   /work/home  the non-root user's HOME, created by init.sh on the /work
#               tmpfs — nothing about it needs to survive a container.
#   /cache      shared wheel cache (docker volume mounted by the backend on
#               networked boots). Owned by the sandbox user in the image, so
#               the volume inherits that ownership on first use and needs no
#               chown at runtime.
RUN useradd --uid 10001 --user-group --no-create-home \
        --home-dir /work/home --shell /bin/bash sandbox \
    && mkdir -p /cache/uv /cache/pip \
    && chown -R sandbox:sandbox /cache /work

ENV WORK_DIR=/work
ENV HOME=/work/home
ENV UV_CACHE_DIR=/cache/uv
ENV PIP_CACHE_DIR=/cache/pip
# Don't prepend the script dir / cwd to sys.path (Python 3.11+). Agents write
# scripts into /work (the cwd) with names they choose — a script named after a
# stdlib module (inspect.py, types.py, email.py, …) would otherwise shadow that
# module and break unrelated imports (`import pandas` died on an agent-written
# /work/inspect.py via numpy's `import inspect`). Agents importing their own
# sibling modules must set PYTHONPATH=/work explicitly (covered in guidance).
ENV PYTHONSAFEPATH=1
WORKDIR /work

# Everything in-VM — entrypoint, the MCP servers (docker exec), the actor's
# commands, the interactive shell — runs as this non-root user (#116).
# Combined with the backend's --cap-drop=ALL, --read-only and
# no-new-privileges there is no privilege left to drop INTO.
USER sandbox

# Idle host: prepare /work, then block forever. MCP servers are spawned
# per-connection via `docker exec` (see connectMcp).
ENTRYPOINT ["/opt/mcp/init.sh"]
