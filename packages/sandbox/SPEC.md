# Sandbox package contract — Docker connections and Incus environments

The Docker backend and interactive Shell share `docker-connection.server.ts`.
This package owns endpoint selection; core harness patterns have no Docker
configuration.

## Selection and validation

- With `SANDBOX_DOCKER_HOST` and all `SANDBOX_DOCKER_TLS_*` settings absent,
  command argv and environment inheritance are unchanged. This preserves the
  existing local-socket setup and any operator-configured Docker CLI defaults;
  absence does not force a socket when the app already inherits a context.
  If `DOCKER_HOST` or `DOCKER_CONTEXT` is inherited in this mode, the backend
  warns once per process that backend/PTY and MCP streams can reach different
  daemons and points to `SANDBOX_DOCKER_HOST`.
- An explicit `SANDBOX_DOCKER_HOST` accepts an absolute `unix:///path` socket or
  `tcp://host:port` (DNS name, IPv4 or IPv6 literal). Empty/malformed endpoints,
  other schemes, credentials, query strings, fragments, encoded characters and
  TCP URL paths other than `/` are refused. A TCP port must be explicit and
  within 1–65535.
- TCP requires `SANDBOX_DOCKER_TLS_CA`, `SANDBOX_DOCKER_TLS_CERT` and
  `SANDBOX_DOCKER_TLS_KEY`, each an absolute filename. The invocation includes
  `--tlsverify` and all three file flags. This module does not read files:
  Docker rejects missing/unreadable/invalid material or a TLS authentication
  failure. No operation retries against a local or alternate daemon.
- TLS settings without a TCP endpoint are refused, including partially set
  configurations. Validation errors name settings, without echoing values.
- A backend captures its connection before any operation, including the reaper.
  Its handles retain that connection across reset. The Shell consumes the
  acquired handle's connection, with environment resolution for older/custom
  Docker handles that lack it. Settings are deployment configuration; restart
  the process to change them.

## Every child uses the same connection

Global endpoint/TLS flags precede each Docker subcommand. When configured,
child environments omit `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS`,
`DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH`. The parent environment is not
mutated. Explicit flags override Docker's saved default context as well.

This applies to container run/inspect/remove/reset, reaper ps/remove/network
prune, both MCP `exec -i` streams, proxy run/inspect/remove and network
inspect/create/connect/remove, including failed-boot cleanup, and the Shell's
`exec -it`. The smoke scripts' image-inspection preflight uses it too. MCP
retains the SDK's default environment allowlist rather than
copying the whole app environment. Files still cross over MCP; no host mount
or `docker cp` path is introduced.

Configured backend errors omit full argv and redact endpoint/TLS filename
values from Docker diagnostics, including normalized HTTP(S) URLs, authorities,
hostnames and bare Unix socket paths. Configured MCP exec stderr passes through
the same redactor, on complete lines so chunk boundaries cannot expose values.
Handshake errors attach the redacted original diagnostic as their cause; legacy
stderr/error behavior remains unchanged. Certificate/key contents are never
read by this module. Interactive shell output continues to reach its owner.

This is connection plumbing, not an isolation claim. Daemon/VM
provisioning, socket removal, firewall rules and cross-environment certificate
rejection require separate deployment work and live evidence.

## Verification

Layer 1 tests mock child boundaries, not this connection helper:
`__tests__/docker-routing.test.ts` drives backend operations, both MCP streams,
reaper, proxy/network lifecycle and PTY with conflicting inherited routing/TLS.
`__tests__/docker-connection.test.ts` checks validation without masking Unix
refusals with TLS errors. Diagnostic redaction (CLI errors, MCP stderr and
handshake causes) is checked in `__tests__/docker-routing.test.ts`. The smoke
preflight also uses the selected endpoint, pinned in
`__tests__/scripts/shared.test.ts`.
Default-path tests pin the legacy argv/env shape. Every claimed path is
mutation-checked by bypassing its endpoint selection; actual daemon routing,
certificate authentication and interactive resize remain integration evidence
owed by the deployment work.

## Operator-only Incus environments

The supported API is the server-only `./incus-environment.server` subpath,
excluded from the root entry point. It exports `createIncusEnvironment`, the
`IncusEnvironment` controller and the named credential, options and connection
types, and `probeDockerEndpoint` with its `DockerProbe` result. The operator supplies manager credentials explicitly. Construction makes
no network calls; `reconcile()` and `teardown()` serialize within a controller.
See [README — Incus environment VMs](README.md#incus-environment-vms-operator-opt-in)
for prerequisites, deployment and the live evidence still owed.

Layer 1's `__tests__/incus-environment.test.ts` uses an in-process HTTPS API
with real certificate generation and pins these fail-closed invariants:

- One owned, restricted project permits one VM and no containers, with explicit
  CPU, memory and disk limits. Host devices, snapshots, backups, low-level VM
  settings and nesting are blocked. Network, image-server domain and storage
  pool access are explicit. Incus 7.3+ is required; unsupported keys fail creation.
- Instance operations use a separate certificate restricted to exactly that
  project. Foreign ownership, certificate scope and project restriction drift
  are refused. VM config is exact except for Incus `volatile.*` and `image.*`
  metadata, with `volatile.eth0.hwaddr` and `volatile.apply_template` additionally
  gating network seeding as below; profiles and devices, including NIC address
  filters, are exact.
- The guest network seed is derived only from the Incus-generated
  `volatile.eth0.hwaddr` (full colon-separated MAC, lowercased). It is written
  only while the VM is stopped with `volatile.apply_template=create`, and read
  back with the MAC before start. Seed or MAC drift is refused. A booted VM
  with no seed is refused and must be recreated.
- Manager origins require verified HTTPS; image origins additionally require
  port 443. No redirects, plaintext retry, alternate provider, credential or
  provider response body is exposed through diagnostics.
- Docker requires mTLS on only the reserved guest bridge address. Certificate
  roles, CA constraints, key usage, server SAN, issuer and validity are explicit.
  Private keys, `state.json` and `creation.json` have mode 0600; the operator
  directory is private. The app receives only the Docker client files and endpoint.
- Creation is journaled and resumed before retry. Teardown checks ownership,
  removes only its instance and pinned image, deletes the project without force,
  and revokes the exact certificate. Scoped DELETE queries contain only the own
  project. Unexpected resources retain the project, resource and certificate.
- Completed teardown removes generated credentials/state, so reconcile rotates
  the CA, Docker client key and Incus certificate. Failed teardown retains them
  for recovery; repeated teardown is safe. Shared bridges/pools are never deleted.

`probeDockerEndpoint` makes one mutual-TLS `GET /_ping` with exactly the four
settings an app receives, on a fresh connection, bounded by `timeoutMs` (10 s
by default). `__tests__/incus-docker-probe.test.ts` pins it against real TLS in
both directions. It accepts only a TLS tcp endpoint, never answers ready from
plaintext, an unverified server or anything but `200 OK`, and reads at most a
few bytes. A server certificate that fails verification is the only final
result (`untrusted-server`): one this environment's CA did not sign, a
self-signed or misnamed one, or one outside its validity. No answer after TLS
completed (`refused`: a dropped connection, which is how a refused client
certificate looks under TLS 1.3, or silence past the bound), no TLS at all
(`unreachable`) and a wrong answer (`not-ready`) can change while a VM boots.
File errors carry no contents.

These hermetic tests and their red mutations establish the client contract,
not a real VM or host firewall boundary. Real Incus image pulls, VM boot,
cloud-init/agent, routing/firewall, streams/files/PTY and performance remain
spike evidence. The server key stays in cloud-init data for the VM lifetime;
the compose overlay leaves the root app and gateway network/socket caveats
documented in the README.

## Offline VM image identity

The operator scripts (outside the published runtime) pin Docker **config**
digests, archive checksums and Incus fingerprints separately. Save and measurement
hosts may use classic or containerd image stores; containerd manifest/index IDs
are never accepted as config IDs. Original config bytes in Docker's save metadata
provide the cross-store identity; a confirmed classic driver retains its inspect
config ID. Measurement exports stream without disk files, at low client priority,
with a 188-second deadline, 8 GiB limit and 64 MiB/s consumer backpressure;
unknown stores or ambiguous content
fail closed. Host export admission is restricted to the three supplied immutable
flavour references with no extra flags. For a containerd host, both guests
resolve all three host-verified config IDs before an internal map is published;
guest run image selectors use that map, while host runs and classic-host
selectors stay unchanged. Missing/conflicting configs or unmapped guest images
are refused before workloads.

Guest assembly and boot remain classic: they preload `/var/lib/docker` and
inspect/tag/run by config ID. These offline checks prove identity handling, not
Docker/VM boot compatibility or containment. See the
[VM image pipeline](https://github.com/mknw/hames-playground/tree/main/packages/sandbox/scripts/vm-image) for evidence, store requirements
and owed Linux checks. Existing spike launch flags are preserved.
