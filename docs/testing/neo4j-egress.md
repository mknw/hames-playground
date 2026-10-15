# Neo4j network isolation (#241 G13)

Neo4j joins only `neo4j-internal` (`internal: true`,
`com.docker.network.bridge.gateway_mode_ipv4: isolated`). The only other member,
`neo4j-relay`, also joins `app-network` and listens on HTTP 7474/Bolt 7687.
Its two socat listeners have fixed Neo4j destinations; it has no IP forwarding
and drops every capability. Host consumers keep localhost; the container app
and gateway config use `neo4j-relay`. Both compose files close CSV file URLs
and APOC file imports. The bridge controls external forwarding and removes
the host IPv4 address on the bridge; no procedure allowlist supplies that boundary.
Docker Engine >= 28 is required (`gateway_mode_ipv4: isolated`); runtime evidence targets Engine 29.2.1. The
network proof is IPv4-only. Neo4j can still reach the relay's HTTP/Bolt listeners
on `neo4j-internal` by design; both forward only back into Neo4j.
[Docker gateway-mode documentation](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)
explains why `internal: true` alone still permits host-local delivery and why
`isolated` removes the bridge address.

The image builds APOC (bundled upstream) and n10s into the plugins directory.
Runtime plugin downloads would fail under isolation, so `NEO4J_PLUGINS` is
absent. A first bring-up builds the image automatically. After merge the owner
must take a dump with the currently running image before recreating their stack:
`docker compose up -d` moves an older store to 5.26.32 and that move cannot
be undone. The backup and restore default is `hames-neo4j:local`, matching compose.
`bootstrap-vps.sh` checks the daemon version before `dc up` and refuses Engine
versions below 28.0.0, unreadable versions and an unavailable daemon. It does
not upgrade an existing Engine automatically. Manual operators must run this
check before deployment (a failed check means stop and upgrade first). Local dev: `make check-docker` runs the same gate (`scripts/check-docker.sh`, tested by `scripts/check-docker.test.sh`) and names the colima fix (`colima update`, restart the VM); an older Engine otherwise fails `docker compose up -d` with "unknown gateway mode isolated". There is deliberately no fallback that drops the isolation:

```sh
test "$(docker version --format '{{.Server.Version}}' | cut -d. -f1)" -ge 28 || { echo 'Docker Engine >= 28.0.0 required; upgrade before deploying.' >&2; exit 1; }
```

## Checks and scope

Layer 1: `src/__tests__/lib/config/compose-neo4j-egress.test.ts` under `app/`
pins the base and production overlay, file settings, relay destinations, pins
and consumer endpoints. Negative topology mutations exercise the same
assertions. The [pyramid](pyramid.md) cannot prove packet containment in its
hermetic layers. `app/scripts/check-neo4j-egress.mjs` is therefore an explicit
infrastructure check outside the default CI glob, with no package hook.

Run from `app/`, only after the owner starts a dedicated throwaway VM of at
least 4 GiB. Pass its Docker context explicitly (the script never changes the
active context). Replace `g13-vm` below with that existing context:

```sh
node scripts/check-neo4j-egress.mjs --context g13-vm --config-only
node scripts/check-neo4j-egress.mjs --context g13-vm > /tmp/g13-green.log 2>&1
node scripts/check-neo4j-egress.mjs --context g13-vm --mutate > /tmp/g13-red.log 2>&1
```

The green run must exit 0. The red run additionally joins Neo4j to `app-network` and must exit 1
with `EGRESS OPEN` and a successful forbidden fetch. An unavailable public
endpoint, missing procedure or unobserved mutation is inconclusive, never green.
Keep both outputs, including the recorded `docker version`, in the PR evidence.
Authentication, syntax, missing commands and other non-network failures are
inconclusive: a blocked APOC request must report `UnknownHost`, `Connect` or
`timed out`; TCP must time out or report a network-class error.

The check renders the actual production compose settings, then creates a
throwaway fixture: project **g13-test** only, explicit context only, ports
**59141–59143** only, synthetic credentials, tmpfs database storage, no named
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

The fixture starts a socat HTTP listener on `0.0.0.0:59143` using
`network_mode: host`, in the same throwaway project. Both HTTP stand-ins reuse
a handler that consumes the request before replying, preventing TCP resets from
masquerading as containment. The handler lives on tmpfs and uses socat `EXEC`.

The scratch internal subnet is fixed at `172.30.249.0/24` across runs. Before
applying isolated gateway mode, the evidence captures a RED: the exact-address
listener control at `172.30.249.1` passes and Neo4j can fetch JSON and connect
by TCP there. With `isolated`, that host bridge address intentionally disappears.
The probe records network inspect, the host bridge's IPv4 addresses and Neo4j's
`/proc/net/route`; GREEN requires no IPv4 address on the bridge and no default
route or gateway in Neo4j. This structural check replaces the old exact-address
D1 positive control, which cannot succeed at an address removed by the fix.

The former `172.30.249.1` leg is structural, not a daemon-host reachability
negative: with no host bridge address or IPAM gateway, `.1` can be allocated to
Neo4j or the relay. Its recorded `Connection refused` is a peer reset, not a
network-class timeout proving host isolation. The probe now prints network
inspect `Containers` to identify the holder; host isolation is carried by the
actual bridge-address/route assertions and the controlled VM/docker0 negatives.
The `.1` TCP/APOC assertions remain unchanged. The probe also requires
forbidden TCP and APOC GET to the VM primary-interface IPv4 address and docker0
(`172.17.0.1`), plus every IPv4 address of `host.docker.internal` if Neo4j resolves
it. Lookup exit 2 is recorded explicitly if the alias is absent; other lookup
failures are inconclusive. Each _assigned_ host address must first return HTTP
200 and JSON from the SAME host listener to the non-isolated gateway-image
container on `app-network`. The former bridge address instead has the recorded
pre-change host control and structural proof that the host address was removed;
a peer may now own that same numeric address. No failed
negative is converted into a pass by a missing listener. A real failed negative,
unsupported mode or broken relay stops the evidence run for owner direction.

Host-authenticated Bolt and the gateway-image Bolt handshake are repeated with
the isolated bridge, proving the relay can still reach Neo4j. The `--mutate` run
keeps the internal isolated bridge but attaches Neo4j to `app-network` too;
this avoids the invalid `isolated` plus `internal: false` combination and must
expose forbidden reachability with exit 1 / `EGRESS OPEN`. All runtime legs,
including the old failure and source SHAs, are recorded verbatim on the PR.

First `nslookup example.com` in the relay (on `app-network`) must succeed as
the upstream DNS positive control; its output is recorded. Then
`getent hosts example.com` inside Neo4j must fail with lookup exit 2 (exit 0
means egress; any other exit is inconclusive). Evidence records `docker version`
for the external-DNS forwarding regression CVE-2024-29018 (fixed in Engine
26.0.0 / 25.0.4 / 23.0.11). Runtime checks also require
`LOAD CSV FROM 'file:///etc/passwd' AS row RETURN row` and
`apoc.load.json('file:///etc/passwd')` to fail with the corresponding disabled
file-import setting errors. Reaching these assertions after a healthy startup
also exercises strict config validation of `NEO4J_apoc_import_file_enabled`.

Source pins and config-only checks do not constitute packet or file-import
evidence. See PR #573 for the recorded runtime attempts and their exact scope;
no runtime claim is made for another Engine version or deployment without its
own probe run.

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
