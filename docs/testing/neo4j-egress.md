# Neo4j network isolation (#241 G13)

Neo4j joins only `neo4j-internal` (`internal: true`). The only other member,
`neo4j-relay`, also joins `app-network` and listens on HTTP 7474/Bolt 7687.
Its two socat listeners have fixed Neo4j destinations; it has no IP forwarding
and drops every capability. Host consumers keep localhost; the container app
and gateway config use `neo4j-relay`. Both compose files close CSV file URLs
and APOC file imports. This fails closed at the network regardless of procedure
name; no Cypher blacklist or procedure allowlist supplies the boundary.

The image builds APOC (bundled upstream) and n10s into the plugins directory.
Runtime plugin downloads would fail under isolation, so `NEO4J_PLUGINS` is
absent. A first bring-up builds the image automatically. After merge the owner
must recreate their own stack once: `docker compose up -d`.

## Checks and scope

Layer 1: `src/__tests__/lib/config/compose-neo4j-egress.test.ts` under `app/`
pins the base and production overlay, file settings, relay destinations, pins
and consumer endpoints. Negative topology mutations exercise the same
assertions. The [pyramid](pyramid.md) cannot prove packet containment in its
hermetic layers. `app/scripts/check-neo4j-egress.mjs` is therefore an explicit
infrastructure check outside the default CI glob, with no package hook.

Run from `app/`, with a default-context Docker daemon of at least 4 GiB:

```sh
node scripts/check-neo4j-egress.mjs --config-only
node scripts/check-neo4j-egress.mjs > /tmp/g13-green.log 2>&1
node scripts/check-neo4j-egress.mjs --mutate > /tmp/g13-red.log 2>&1
```

The green run must exit 0. The red run removes `internal: true` and must exit 1
with `EGRESS OPEN` and a successful forbidden fetch. An unavailable public
endpoint, missing procedure or unobserved mutation is inconclusive, never green.
Keep both outputs in the PR evidence.

The check renders the actual production compose settings, then creates a
throwaway fixture: project **g13-test** only, default context only, ports
**59141/59142** only, synthetic credentials, tmpfs database storage, no named
volumes, host `.env`, Docker socket mount or company data. It refuses to adopt
existing `g13-test` containers or networks and runs `docker compose -p g13-test
down` in its cleanup. It never starts Docker/Colima or changes a context.

It checks authenticated host Bolt through the relay and a Bolt handshake from
the pinned gateway image's network namespace. The gateway image runs a synthetic
HTTP listener on 8811 instead of launching MCP tools through the host Docker
socket: this check proves network reachability, not MCP behavior. Redis and
Postgres are real isolated test instances; gateway-side positive controls prove
their ports listen. APOC and n10s procedure inventory checks prevent a missing
plugin from masquerading as isolation. From inside Neo4j, APOC GET to public
JSON and POST to `mcp-gateway:8811` must fail, as must raw TCP to the literal
IP addresses of the gateway, Redis and Postgres (not just their DNS names).

## Digest provenance (2026-10-15)

Queried Docker Hub's authenticated registry v2 manifest endpoint with OCI/index
Accept headers, hashed the returned bytes with SHA-256 and matched each value
to `Docker-Content-Digest`. The socat index includes linux/amd64 and linux/arm64.
These are content-integrity checks against the registry, not publisher signatures.

| Artifact                         | Verified SHA-256                                                   |
| -------------------------------- | ------------------------------------------------------------------ |
| `alpine/socat:latest` index      | `fb3862c949af7c79996d0e514ee96128644d840835ed5368eeecb14a869de361` |
| `neo4j:5.26` index               | `f1e52d4dc6da122468c4a3c1050a4f5e117f6d3268625237c34d49166f0d6082` |
| `redis:7-alpine` test-only index | `858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` |
| n10s 5.26.0 JAR                  | `509bec192befce6224a7e3bf78a0e6b74aeb8bf61eb7a1e009b7b62e0737900b` |

The n10s hash matches both the downloaded JAR bytes and the `digest` field from
GitHub's `repos/neo4j-labs/neosemantics/releases/tags/5.26.0` API. The Dockerfile
uses `ADD --checksum` so corrupted or replaced bytes fail the build. The
pgvector and gateway images reuse the repository's existing digest pins.
