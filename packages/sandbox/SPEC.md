# Sandbox package contract — Docker connections

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
