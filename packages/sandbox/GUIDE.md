# Sandbox package guide — Docker connections

The [README](README.md) covers composing sandboxed patterns. This guide covers
connecting every sandbox path to an already provisioned daemon.

## Verified TLS endpoint

Configure the application environment before creating a `DockerBackend`:

```dotenv
SANDBOX_DOCKER_HOST=tcp://sandbox.example.test:2376
SANDBOX_DOCKER_TLS_CA=/run/sandbox-tls/ca.pem
SANDBOX_DOCKER_TLS_CERT=/run/sandbox-tls/cert.pem
SANDBOX_DOCKER_TLS_KEY=/run/sandbox-tls/key.pem
```

Use the CA and client material for that environment's daemon. The app must be
able to read these files; Docker reads and validates them. A bad endpoint or
missing path is refused before launching Docker. An unreadable file, rejected
certificate or unreachable daemon fails the requested operation under its
existing error policy, without a fallback to another daemon. The reaper remains
best-effort. Backend error diagnostics redact configured endpoint and filename
values, including normalized URLs, hostnames and bare socket paths. Configured
MCP stderr is forwarded through the same redactor; handshake failures retain a
redacted diagnostic cause.

The same endpoint reaches container operations, both MCP exec streams, cleanup,
proxies and networks, the interactive Shell, and the smoke-script image
preflight. Do not rely on inherited
`DOCKER_HOST` or `DOCKER_CONTEXT`: they are removed from configured children.
MCP uses the SDK's restricted environment plus explicit connection flags, so it
needs no Docker variables on that allowlist.

## Explicit Unix socket

```dotenv
SANDBOX_DOCKER_HOST=unix:///run/sandbox/docker.sock
```

Omit all three TLS settings. This explicit socket also wins over inherited
remote contexts and TLS environment variables. These paths belong to the app's
filesystem; when the app runs in a container, make the selected socket or TLS
files available there through deployment configuration.

## Existing local setup

Leave all four settings absent to preserve existing argv and environment
inheritance byte for byte. This usually means the local Docker socket, and
continues to honor any Docker CLI environment/default context already in use.
If `DOCKER_HOST` or `DOCKER_CONTEXT` is inherited, the backend warns once: the
SDK environment allowlist means MCP streams can reach a different daemon from
backend operations and the Shell. Set `SANDBOX_DOCKER_HOST` to align them.
Restart after changing configuration: backends and the handles consumed by the
Shell retain the connection with which their containers were created.

Endpoint selection alone does not remove the host socket or provision an Incus
VM. It does not prove environment isolation; those deployment changes and live
checks follow separately. The full contract is in [SPEC.md](SPEC.md).

## Operator-provisioned Incus VM

Import `createIncusEnvironment` only from
`@hames-ai/sandbox/incus-environment.server`, outside the app process. Follow
the [README's operator example](README.md#incus-environment-vms-operator-opt-in)
for Incus 7.3+, image/bridge/pool prerequisites, manager credentials and private
state. The returned `dockerEnv` configures the existing connection seam above;
wait until `probeDockerEndpoint(dockerEnv)` is ready before starting the app. A completed teardown followed
by reconcile rotates credentials; failed teardown keeps them for recovery.
The [Incus contract](SPEC.md#operator-only-incus-environments) lists the pinned
invariants and distinguishes hermetic checks from evidence owed to the spike.
