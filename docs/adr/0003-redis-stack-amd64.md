# ADR-0003: The `redis` service is redis-stack, pinned `linux/amd64` on Apple Silicon

**Date**: 2026-06-21 — the date the decision was taken
**Status**: accepted

The Data Stash pipeline (#6/#8) needs RedisJSON for documents and RediSearch for
the chunk vector index, and `redis:7-alpine` ships neither, so the compose
service moved to `redis/redis-stack:7.4.0-v8`. On Apple Silicon under colima a
second constraint applies: redis-stack's arm64 `redisearch.so` SIGILL-crashes the
container during vector operations, so the `redis` service is run
`platform: linux/amd64` (emulated) via a git-ignored `docker-compose.override.yml`
rather than by pinning the whole compose file to an architecture nobody else
needs.

## Considered options

- **Plain `redis` + a separate vector database.** Rejected: the MCP gateway
  already exposes one Redis server, and the Data Stash's document store and
  chunk index are keyed off the same `sessionId`. Two stores would mean two
  lifetimes and two failure modes for one logical corpus.
- **Pin `platform: linux/amd64` in `docker-compose.yaml` itself.** Rejected: the
  emulation is an Apple-Silicon workaround, and baking it into the tracked
  compose file would make every x86 host pay for it. An override file keeps the
  workaround local to the machines that need it.
- **Wait for a working arm64 build.** Rejected as the primary fix — it blocks the
  pipeline on someone else's release. Recorded instead as the long-term exit:
  colima CPU passthrough (`--vm-type vz`).

## Consequences

- Vector search on Apple Silicon runs emulated, so it is slower than native.
  Store and RedisJSON operations are unaffected — only vector ops need the pin.
- The override file is git-ignored, so a fresh Apple-Silicon worktree that never
  creates one will see RediSearch crash rather than fail cleanly. This is the
  single most likely Data Stash setup failure on this hardware.
- The same change removed the `redis.password` / `REDIS_PWD` secret block from
  `configs/custom-catalog.yaml`: the gateway Redis runs without auth, so
  requiring a password made every redis MCP op fail with an `AUTH` error.

## Sources

Back-filled. The redis-stack half is from commit `cc8c49e` / **PR #91**
(2026-06-21, `fix(infra): redis-stack image + drop bogus redis MCP password
secret`), which names the missing RedisJSON/RediSearch modules and the AUTH
misconfiguration. The `linux/amd64` half was documented one day later in commit
`0bad350` (2026-06-22) and survives at `docs/DATA_STASH.md` line 139, which
carries the SIGILL diagnosis, the override-file mechanism and the `--vm-type vz`
exit. The standing disposition is the "Redis MCP quirks" bullet in `CLAUDE.md`.
