<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mknw/hames-playground/main/docs/images/hames-banner-wide-dark.png">
  <img src="https://raw.githubusercontent.com/mknw/hames-playground/main/docs/images/hames-banner-wide-light.png" alt="hames: supports of a harness to which its traces are fastened. The @hames-ai packages on npm: harness-patterns, harness-baml, agents, connectors, sandbox. hames app: where harness primitives become your integrated workspace." width="880">
</picture>

# @hames-ai/sandbox

[![npm](https://img.shields.io/npm/v/@hames-ai/sandbox?style=flat)](https://www.npmjs.com/package/@hames-ai/sandbox)
[![CI](https://img.shields.io/github/actions/workflow/status/mknw/hames-playground/ci.yml?branch=main&style=flat&label=CI)](https://github.com/mknw/hames-playground/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/mknw/hames-playground/github-code-scanning%2Fcodeql?branch=main&style=flat&label=CodeQL)](https://github.com/mknw/hames-playground/actions/workflows/github-code-scanning/codeql)
[![node](https://img.shields.io/node/v/@hames-ai/sandbox?style=flat)](https://nodejs.org)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue?style=flat)](./LICENSE)

## What this is

Lets an agent built with
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme)
run the code it writes inside a disposable Docker container instead of on
your machine. `withSandbox` wraps a pattern and attaches a container to it
while it runs; the pattern's `sandbox_*` tools (shell, file read, write, edit,
list and search) act inside that container. By default the container has no
network at all, shell commands are screened before they run, and files the
agent leaves in `/work/out` can be saved to a document store your application
supplies. It is its own package so that installing the core library never
pulls Docker code into your project.

> **Note:** These packages are at 0.1: further guardrails are in active development
> and a release is coming ([tracking issue](https://github.com/mknw/hames-playground/issues/391)), so until then run them
> against data you can afford to lose ([details](https://github.com/mknw/hames-playground/tree/main/packages/agents#agent-catalog)).

## Which package do you need?

Five packages that work together. The first is the foundation; add the others
for what they do.

| If you want to…                                                                                            | Use                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| build an agent out of composable pieces — tool loops, routers, planners                                    | [`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme) |
| get typed model calls with the prompts already written, on Anthropic or your own model provider            | [`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)         |
| use a ready-made agent                                                                                     | [`@hames-ai/agents`](https://github.com/mknw/hames-playground/tree/main/packages/agents#readme)                     |
| use Microsoft 365 or the Neo4j graph database from an agent, or sort an MCP server's tools into namespaces | [`@hames-ai/connectors`](https://github.com/mknw/hames-playground/tree/main/packages/connectors#readme)             |
| run agent-written code in a container                                                                      | [`@hames-ai/sandbox`](https://github.com/mknw/hames-playground/tree/main/packages/sandbox#readme)                   |

## See it running

The [hames app](https://github.com/mknw/hames-playground) is the reference
host for all five packages: a self-hosted agent workspace whose agents are
built from them, with every step of every run visible in its UI. Its
[Quickstart](https://github.com/mknw/hames-playground#quickstart) runs it
locally with Docker and pnpm.

## Install

```bash
pnpm add @hames-ai/sandbox @hames-ai/harness-patterns @hames-ai/harness-baml
```

`@hames-ai/harness-patterns` is a peer dependency, so you add it yourself.
`@hames-ai/harness-baml` is not a dependency of this package, but the quick start
below uses its model calls. You also need Docker on the machine that runs your
agent.

This package ships TypeScript source, not compiled JavaScript, so run it through
something that compiles TypeScript: Vite (or vinxi), esbuild, tsx or Bun. Plain
`node` cannot import it, because Node refuses to strip types from files under
`node_modules`. The examples use top-level `await`, so run them as ES modules (`"type": "module"` in your
`package.json`, or a `.mts` file).

### Build the sandbox image

`withSandbox` boots a Docker image that this package does not ship. By default
it expects one tagged `kg-sandbox:base` (set `SANDBOX_IMAGE` to use another).
Build it in a clone of the repository:

```bash
git clone https://github.com/mknw/hames-playground.git && cd hames-playground
docker build -t kg-sandbox:base rootfs/
```

`bash rootfs/build.sh` builds the base image plus its three flavours
(`image-processing`, `data`, `office`). See
[`rootfs/`](https://github.com/mknw/hames-playground/tree/main/rootfs) for what
each image contains.

## Usage

### Quick start

Wrap a loop in `withSandbox`, and its tools run inside a container. The model
calls come from
[`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme).

> **Needs:** Docker, the `kg-sandbox:base` image ([build it](#build-the-sandbox-image) as [rootfs/README.md](https://github.com/mknw/hames-playground/blob/main/rootfs/README.md) in the hames-playground repository describes), and an Anthropic API key in `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)).

```typescript
import { actorCritic, compactExecution, harness } from '@hames-ai/harness-patterns'
import type { ActorCriticData, CompactExecutionData, HarnessData } from '@hames-ai/harness-patterns'
import {
  bamlPatterns,
  createActorControllerAdapter,
  createCriticAdapter,
} from '@hames-ai/harness-baml'
import { withSandbox } from '@hames-ai/sandbox'

// The data the harness carries between steps. TypeScript needs it spelled out once.
interface Data extends HarnessData, ActorCriticData, CompactExecutionData {
  [key: string]: unknown
}

// A generate-then-check loop. The actor's one argument is its tool list or an options
// object; `{}` gives it neither, because inside `withSandbox` the container's tools are
// offered to the model automatically. The loop's own tool list (`[]`) is empty for the
// same reason.
const loop = actorCritic<Data>(createActorControllerAdapter({}), createCriticAdapter(), [])

const agent = harness<Data>(
  // Two calls: `withSandbox()` takes the configuration (none here) and returns a
  // wrapper; calling that wrapper on `loop` returns the sandboxed loop.
  withSandbox()(loop),
  compactExecution({ mode: 'thread', synthesize: bamlPatterns().synthesize }), // both fields are required
)

const result = await agent('Write a Python script that prints the first ten primes, and run it.')
console.log(result.response)
```

`mode: 'thread'` hands the answer step the loop's tool calls and their results.

### Choosing the image, the network and the batching

The same agent with its options spelled out:

> **Needs:** Docker, the `kg-sandbox:base` image ([build it](#build-the-sandbox-image) as [rootfs/README.md](https://github.com/mknw/hames-playground/blob/main/rootfs/README.md) in the hames-playground repository describes), and an Anthropic API key in `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)).

```typescript
import { actorCritic, compactExecution, harness } from '@hames-ai/harness-patterns'
import type { ActorCriticData, CompactExecutionData, HarnessData } from '@hames-ai/harness-patterns'
import {
  bamlPatterns,
  createActorControllerAdapter,
  createCriticAdapter,
} from '@hames-ai/harness-baml'
import { withSandbox } from '@hames-ai/sandbox'

interface Data extends HarnessData, ActorCriticData, CompactExecutionData {
  [key: string]: unknown
}

// The loop's own tool list is empty: inside `withSandbox`, the container's
// `sandbox_*` tools (shell, file read/write/edit/list/search) are offered to the
// model automatically.
const loop = actorCritic<Data>(createActorControllerAdapter({}), createCriticAdapter(), [], {
  patternId: 'code',
  // One container, one filesystem: run a batch of tool calls in order.
  multiToolCalls: 'sequential',
})

const agent = harness<Data>(
  // No network inside the container ('mcp-only' is also the default).
  withSandbox({ rootfs: 'base', egress: 'mcp-only' })(loop),
  compactExecution<Data>({
    mode: 'thread',
    patternId: 'answer',
    synthesize: bamlPatterns().synthesize,
  }),
)

const result = await agent('Write a Python script that prints the first ten primes, and run it.')
console.log(result.response)
```

Without an `id`, each run borrows a container from a warm pool; pass `id` (for
example a conversation id) to keep one container, and its files, across turns.

### What it protects you from, and what it does not

- **Container isolation.** Every container starts with all Linux capabilities
  dropped, a read-only root filesystem, `no-new-privileges`, a process limit,
  size-capped scratch space for `/work` and `/tmp` (and a small, non-executable
  one for `/skills`), and a non-root user.
- **Network.** The default egress profile, `mcp-only`, starts the container
  with no network at all. Two narrower profiles, `pypi` and `github-trusted`,
  allow only an allowlist of hosts through a proxy (see
  [Egress profiles](#egress-profiles)).
- **Shell-command screen.** Every `sandbox_bash` command the model sends is
  checked against a denylist before it runs, by the default Docker backend (a
  `backend` you supply yourself does not get it) (for example `docker`, the Docker
  socket, `mount`, raw disk writes); a denied command comes back to the model
  as a tool error. The screen is _advisory_: it reads the command text and
  cannot parse shell, so it catches the obvious and does not stop a determined
  attacker. The container isolation above is the actual boundary.
- **Not covered:** what the code's _output_ says. Tool results coming back from
  the container are not passed through the injection guard.

The types say "VM" (`VMHandle`, `V0_IN_VM_SERVERS`) because the compute
backend is pluggable (`backend`); the one this package ships runs Docker
containers.

## Configuration

### Docker endpoint

`SANDBOX_DOCKER_HOST` selects one sandbox-only Docker endpoint for backend
operations, both MCP exec streams, startup cleanup, proxy/network lifecycle and
the interactive Shell. Supported values are `unix:///absolute/socket` and
`tcp://host:port`. TCP requires all three absolute file paths:
`SANDBOX_DOCKER_TLS_CA`, `SANDBOX_DOCKER_TLS_CERT`, `SANDBOX_DOCKER_TLS_KEY`;
Docker verifies the server and presents the client certificate. For Unix sockets,
omit the TLS settings. Invalid configuration throws before backend operations;
connection failures never retry against another endpoint.

An explicit setting overrides inherited `DOCKER_HOST`, `DOCKER_CONTEXT` and
Docker TLS variables in every child, without changing the app's environment.
With all four settings absent, CLI arguments and environment inheritance stay
unchanged, including existing Docker CLI defaults. Configure these settings
before constructing backends and restart to change them: each backend captures
its endpoint, and its Shell uses the connection on the acquired handle.

See [GUIDE.md](GUIDE.md) for configuration and [SPEC.md](SPEC.md) for the
contract and test boundaries. This selects a daemon; it does not provision VMs,
remove socket mounts or establish network isolation.

The existing wildcard export makes `./docker-connection.server` available, but
this subpath is **internal and unstable**, shared by the backend and PTY; it is
**not a supported entry point**.
`DockerConnection` is its readonly CLI-flag type, `dockerConnectionFromEnv(env?)`
validates the generic environment settings, and `dockerInvocation(connection,
args, baseEnv?)` prepares child argv/env. These server-only helpers are shared by
the backend and PTY; ordinary consumers configure the environment and keep using
`DockerBackend` or `withSandbox`. No new root-entry export is added.

### Incus environment VMs (operator opt-in)

`createIncusEnvironment` provisions **one VM per environment**, with Docker still
providing the individual sandboxes. It is an operator-side, server-only API;
import it only from `@hames-ai/sandbox/incus-environment.server`. It does not
depend on the app and is excluded from the app-facing root entry point.
The subpath exports the named `IncusEnvironment` controller, `IncusCredential`,
`IncusEnvironmentOptions` and `IncusEnvironmentConnection` types.
Existing Docker deployments keep their current behavior until explicitly opted in.

```typescript
import { createIncusEnvironment } from '@hames-ai/sandbox/incus-environment.server'
import { readFile } from 'node:fs/promises'

const ca = await readFile('/operator-private/incus-ca.pem', 'utf8')
const cert = await readFile('/operator-private/incus-cert.pem', 'utf8')
const key = await readFile('/operator-private/incus-key.pem', 'utf8')
const imageFingerprint = 'a'.repeat(64) // replace with your verified image digest

const environment = createIncusEnvironment({
  environment: 'preview', // owns only the project sandbox-preview
  manager: { url: 'https://incus.example.test:8443', ca, cert, key }, // PEM strings
  bridge: 'previewbr', // dedicated, operator-created managed bridge
  address: '10.77.0.2', // reserve this guest IPv4 on that bridge
  storagePool: 'sandbox-pool',
  image: {
    server: 'https://images.example.test', // HTTPS simplestreams origin
    fingerprint: imageFingerprint, // pinned 64-character SHA-256
  },
  quota: { cpu: 2, memoryMiB: 2048, diskGiB: 24, rootDiskGiB: 16 },
  stateDirectory: '/operator-private/sandbox-preview', // parent must exist
})
const { project, dockerEnv } = await environment.reconcile()
// Deliver only dockerEnv and its three files to this environment's app.
// Remap file paths in dockerEnv if the app runs in a container.
// Wait for the Docker TLS endpoint to become ready before starting the app.
// Later, from the operator process:
await environment.teardown()
```

The Incus server must support every configured restriction: **Incus 7.3+** is
the minimum for `projects_restricted_virtual_machines_nesting`; it must also
support `projects_restricted_storage_pool_access`. Servers missing these keys
reject project creation, failing closed. See the
[Incus 7.3 release notes](https://linuxcontainers.org/incus/news/#incus-7-3-has-been-released)
and [API extensions](https://linuxcontainers.org/incus/docs/main/api-extensions/).
Distribution packages of Incus 6.0.x lack both; the operator runbook
([sandbox VM spike runbook](https://github.com/mknw/hames-playground/blob/main/docs/deployment/sandbox-vm-spike.md), "Upstream Incus packages") installs a
pinned 7.3+ build from the Incus maintainers' signed apt repository.
The earlier 7.0.1 system-container experiment predates these restrictions and
does not verify this configuration. The operator supplies an Incus HTTPS manager certificate permitted to create
projects and register certificates, a bridge, a storage pool and a pinned VM
image. The image must already contain **Docker (`/usr/bin/dockerd`), systemd,
cloud-init and the Incus VM agent**, and support `cloud-init.user-data` and `cloud-init.network-config`; arbitrary
OCI images cannot boot as Incus VMs. Installing the host, preparing images,
loading the four `kg-sandbox` images into the guest, bridge routing, firewall
coexistence with Docker, and nested-KVM measurements belong to the operator's
scripts and runbook. No installation or firewall change happens on import or
controller creation. Node 22+ and `openssl` on the operator machine are required.

`reconcile()` creates a restricted `sandbox-<environment>` project, then verifies
its restrictions on every call. Containers are disabled, one VM is allowed,
CPU/memory/disk totals are explicit, and host devices, snapshots, backups and
low-level VM settings are blocked. Root storage and the selected managed NIC are
the necessary exceptions. The project allows only the selected storage pool;
VM nesting is blocked and the VM explicitly disables it. Network access and
image-server domain allowlists are nonempty. Image origins use the default
HTTPS port (443); other ports are refused. It registers a separate restricted Incus client certificate confined to
exactly that project, verifies the registered scope, and uses **that certificate**
for instance operations. The manager credential is never sent to the guest.

Cloud-init writes a per-environment Docker CA/server certificate, configures
`tlsverify`, and binds the daemon **only** to the reserved guest IPv4 on the
Incus bridge at port 2376. It pins the classic `overlay2` image store that the
VM image preloads (Docker 29 would otherwise start on an empty containerd store). It disables socket activation and replaces Docker's
inherited `-H fd://` command. The managed NIC enables MAC, IPv4 and IPv6 address
filtering. The operator must enable the bridge netfilter support required by
Incus for these filters. The app receives the CA certificate and Docker
client certificate/key as absolute-file settings understood by the existing
backend, MCP streams and PTY. The app has root-equivalent authority inside its
own disposable environment VM. It receives **neither** the Incus manager nor
the project certificate, Docker server key or CA private key. An operator that
chooses to call the provisioner inside the app explicitly supplies that stronger
credential through `manager`; doing so broadens the app's authority.
The Docker server key also persists in the instance's `cloud-init.user-data`
for the VM's lifetime, readable by holders of the project-restricted or manager
certificate and by the guest API inside the VM.

State and private keys stay in `stateDirectory` (0700; keys 0600). Keep this
operator-only directory across restarts, out of source control, logs and app
mounts. Serialize controllers using the same directory; concurrency across
processes is the operator's responsibility. Credentials are valid for 365 days;
rotation is an explicit, successfully completed teardown followed by reconcile.
After deleting the project and revoking its exact certificate, teardown removes
`state.json` and all generated PEM, CSR, extension and serial files; reconcile
then generates a new CA, Docker client key and Incus certificate. Failed teardown
retains credentials for recovery and does not rotate them. Failed reconciliation
keeps owned resources and state for retry or teardown. An interrupted initial
key generation may require operator recovery of the incomplete local directory.
Transport/API errors omit response bodies, credential values and underlying TLS
errors, and never retry through plaintext or a different origin.

A slow image pull is recorded as an Incus operation in the private state directory;
retrying reconcile resumes it before submitting another create. Teardown also waits
for that create and handles completed operations that Incus has expired.

Before first boot, reconcile reads and validates `volatile.eth0.hwaddr` (the
Incus device key, independent of the guest name), then writes a per-instance
`cloud-init.network-config` with a static address matched by MAC, using the
validated guest address, bridge prefix and default gateway. DHCPv4 and DHCPv6
are disabled, and no nameservers are set; this works on the reviewed bridges
with `ipv4.dhcp=false` and `dns.mode=none` without a host INPUT exception.
The guest can keep `eth0`, `enp5s0` or another predictable name. The shared image seed and the
operator spike harness's static addressing are unchanged. Reconcile reads the
seed back before starting; missing/malformed MACs, failed writes and seed/MAC
drift are refused. An unseeded VM must be stopped with a pending `create`
template: an already-booted legacy VM requires operator teardown and recreation,
because changing its cloud-init seed cannot repair its first boot. Interrupted
creation/seeding can be retried while the VM is still unbooted.

Repeated reconcile verifies ownership/configuration and starts a stopped VM;
it refuses drift rather than silently rebuilding a running environment. A
successful return means Incus accepted creation/start, **not** cloud-init or
Docker readiness. `teardown()` is idempotent, checks ownership, stops/deletes only
the named instance, removes its pinned cached image and empty default profile,
deletes the project without force, and revokes only its exact restricted
certificate. Incus clears a certificate's project references on project deletion;
an empty scope is accepted only for that final revocation, never for provisioning
or instance access. Unexpected resources block project deletion. Shared bridges/pools
are never deleted. This API does
not establish firewall isolation from host services or other bridges: prove that
separately before routing an app to the guest.

In the repository compose deployment, opt in with
`-f docker-compose.yaml -f docker-compose.sandbox-vm.yaml` (put this overlay last;
Compose 2.24.4+). Supply the four `SANDBOX_DOCKER_*` settings in the compose
process environment. The overlay **replaces** the app's mount list, drops its
host socket and mounts only the three Docker client files read-only. Adapt any
other app mounts explicitly. The MCP gateway's own socket remains out of scope.
No compose defaults change without this overlay.

Real Incus 7.3+ VM creation with these restrictions and NIC filters, and a pull
from an allowed image-server domain, remain evidence owed to the spike, along
with VM boot/agent/cloud-init, firewall/routing, streams/files/PTY and performance.
The overlay still runs the app container as root and shares `app-network` with
the gateway, whose host socket remains mounted; it does not establish removal
of host-root reachability from the app.

### Multiple app clones on one Docker daemon

Set a distinct `SANDBOX_ENVIRONMENT` in each app (for example `release` and
`dev`). Production requires it; local development defaults to `local`. The
backend captures that label once and applies it to sandbox/proxy containers and
egress networks. Both startup cleanup sweeps require the environment label as
well as `kg-sandbox=1`, so a restart leaves other environments and legacy
unlabelled resources alone. Remove legacy leftovers manually by inspected ID.
Set a distinct `SANDBOX_CACHE_VOLUME` base per clone too. Labels prevent
accidental cleanup; access to the Docker socket remains host-wide authority.

### What your application passes in

Nothing, for the example above. Two things are yours to supply when you need
them:

- **Keeping files between conversations** — `configureWorkspaceStore({ list, get, store, guessMimeType, isTextMime })`,
  called once at startup, is where you plug in your own document storage. With
  `withSandbox({ id, syncWorkspace: true })`, the conversation's stored files are
  copied into `/work/in` when a turn starts, and anything the agent writes to
  `/work/out` is saved back when it ends. Syncing is off by default. If you turn
  it on without configuring a store, the first turn fails with
  `WorkspaceStoreNotConfiguredError` rather than silently saving nothing.
  A file a tool stores _during_ the run (for example a Microsoft 365 file copied
  into the stash) is copied into `/work/in` right after that call returns, so
  the agent can open it in the same run. If that copy fails, the call is
  reported as failed rather than as a success that the agent cannot act on.
- **Starting the sandbox only when it is used** — `withSandbox({ id, lazy: true })`
  starts the container on the agent's first `sandbox_*` call instead of at the start
  of the turn, so a turn that never runs code never needs a container engine. Until
  then the agent is shown a fixed list of the sandbox tools (kept in step with the
  real servers by a test), and, when you pass `skills`, a note that skills load when
  the workspace starts. If the container cannot start, the call fails with a short
  fixed sentence ("The code workspace is unavailable on this server") instead of the
  engine's own error, which is written to the server log only; the failure is
  remembered for the rest of that run. The same holds for a step that fails after
  the container has started (restoring or saving files, mounting skills): the
  events say it failed and the engine's words stay in the server log. `lazy` needs
  an `id` and is off by default.
- **Whose container it is** — `WithSandboxConfig.tenantId`, the id of the user who
  owns the conversation, as a string or as a function called per run (useful when
  you build your patterns once but the signed-in user changes per request).
- **Skills** — `WithSandboxConfig.skills`, a function called per run that returns
  the [Agent Skills](https://agentskills.io/specification) to mount (`SandboxSkill[]`:
  a name, a description and the whole `SKILL.md` text). Each is written into the
  container as `/skills/<name>/SKILL.md`, and the model is shown an index of them
  (name and description only) as a delimited, escaped `<skills>` block in the
  request's `user`-role context — outside the tool list and the system message —
  so it reads a file only when its description fits the task. Names follow the
  specification's rule, a description is 1–1024 characters, a file is at most
  64 KiB, and at most 20 skills mount per run; a skill that cannot be mounted is
  reported as a `warning` run event rather than dropped silently.
  Which skills a run gets — and whose they are — is yours to decide, server-side.

Every other option on `WithSandboxConfig` (`backend`, `pool`, `scheduler`,
`attachments`, `resources`, `egress`) has a default, and `skills` is off unless you
pass it.

If you use `@hames-ai/agents`, its two sandbox agents do not import this package
directly: your application builds the wrapper with `withSandbox` and hands it
to them as `AgentDeps.withSandbox`.

### Egress profiles

**`egress` takes one of three profiles**, and that is the whole set:
`mcp-only` (the default — `--network none`, no network at all: the container
reaches only its own tools, which it serves over MCP without a network), `pypi` and
`github-trusted` (an internal-only Docker network plus an allowlist proxy).
The `EgressProfile` type also has an `open` member, which is deliberately not
selectable: asking for it falls back to `mcp-only`, exactly like an unknown
name, unless the deployment sets `SANDBOX_ENABLE_OPEN_EGRESS=1`. One leak
remains under the two proxied profiles: depending on the host's Docker DNS
setup, the container may still be able to resolve hostnames, though it cannot
connect to them, so at most it learns that a hostname exists. The per-profile
table and the default allowlists are in
[running code in a sandbox](https://github.com/mknw/hames-playground/blob/main/docs/tutorials/running-code-in-a-sandbox.md).

### Container images live outside the package

`withSandbox` boots `kg-sandbox:base` and its three _flavours_ — images with
extra tools preinstalled: `image-processing`, `data` and `office` — plus the
allowlist proxy behind the `pypi` / `github-trusted` profiles. Their
definitions live in **[`rootfs/`](https://github.com/mknw/hames-playground/blob/main/rootfs/README.md) at the repository
root**, not in this package: you build (or replace) them for your own
deployment, and they version separately from this TypeScript. Set
`SANDBOX_IMAGE` to boot a different base image, or pass `backend` to run on a
different compute substrate entirely.

## Reference

Each egress profile, attachment lifetimes and per-turn image selection, step by
step: [running code in a sandbox](https://github.com/mknw/hames-playground/blob/main/docs/tutorials/running-code-in-a-sandbox.md)
and [attaching a sandbox workspace](https://github.com/mknw/hames-playground/blob/main/docs/tutorials/attaching-a-sandbox-workspace.md).
What each image contains: [rootfs/README.md](https://github.com/mknw/hames-playground/blob/main/rootfs/README.md).

### Exports

| Subpath                      | What lives there                                                                                            | Browser-safe?                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `.` (root entry point)       | `withSandbox`, `DockerBackend`, `getComputeBackend`, the compute types, `configureWorkspaceStore`           | **no** — server-only, pulls the Docker backend |
| `./types`                    | `ComputeBackend` / `VMHandle` / `RuntimeConfig` / …, `SANDBOX_TOOL_PREFIX`, `V0_IN_VM_SERVERS`              | yes — types + constants, no `node:` imports    |
| `./settings`                 | `SandboxSettings` + `DEFAULT_SANDBOX_SETTINGS` (the caps and per-call defaults)                             | yes — same rule                                |
| `./guard` (= `./bash-guard`) | `screenBashCommand` / `bashGuardPolicyFromEnv` — the shell-command screen                                   | yes                                            |
| `./egress-policy`            | the three selectable egress profiles and the per-boot network naming                                        | yes                                            |
| `./skills`                   | `SandboxSkill`, the skill limits and checks (`isSkillName`, `isSkillDescription`), the index text           | yes                                            |
| `./workspace-store`          | `configureWorkspaceStore(...)` — where you plug in storage for `/work` files                                | server                                         |
| `./with-sandbox.server`      | the wrapper itself, for code that skips the root entry point                                                | server                                         |
| `./pty-manager.server`       | an interactive terminal into a running container (uses `node-pty`, see Troubleshooting)                     | server                                         |
| `./docker-connection.server` | Endpoint validation and child invocation shared by backend, MCP and PTY                                     | server                                         |
| `./docker-backend.server`    | the Docker compute backend                                                                                  | server                                         |
| `./incus-environment.server` | Operator-only `createIncusEnvironment`, `IncusEnvironment`, `IncusCredential`, options and connection types | server; excluded from root                     |

**The root entry point is server-only and it pulls Docker with it**, because
`withSandbox` constructs a `DockerBackend` by default. Browser code imports
`./types` or `./settings` instead; neither reaches a `node:` module.

## Troubleshooting

### Building a private VM image

The operator-only [offline VM image pipeline](https://github.com/mknw/hames-playground/tree/main/packages/sandbox/scripts/vm-image)
assembles pinned local inputs into Incus metadata and qcow2, preloads the
three sandbox flavours, and records provenance. Its design note distinguishes
Docker config IDs, save-archive hashes and Incus fingerprints, including the
additive spike pin support and the Linux boot checks still owed. Save and
measurement hosts support either classic or containerd stores with archive-derived
config identity; guest assembly and boot require the classic store. The driver
is recorded for comparison at boot. This is repo
tooling outside the published tarball and TypeScript API.

### Opening an interactive shell

The interactive terminal (`./pty-manager.server`) uses `node-pty`, a native
module. It is loaded only when a shell is opened, so importing this package
never needs it. `node-pty` ships prebuilt binaries for macOS and Windows (arm64
and x64) but not Linux; elsewhere its install script has to build it, and pnpm
does not run install scripts by default. If opening a shell fails with a
missing `.node` addon error under pnpm, run `pnpm approve-builds` and reinstall.

## How this package is tested (contributors)

The suite lives under `__tests__/` and is excluded from the published tarball;
run it with `pnpm test` from `packages/sandbox/`. It imports only this package,
its declared dependencies and its own fixtures. On top of it, this repository's
CI checks three things about the package itself:

1. **`zero-app-imports.test.ts`** — no file here imports the hames app's source,
   not even a type-only import, including the tests.
2. **`scripts/pack-smoke.sh`** — packs the tarball, installs it into a scratch
   project and loads every entry point the hames app imports or the `exports` map
   declares, which catches an
   undeclared dependency or an import that escaped the package. It also checks
   that `__tests__/` and `scripts/` are not shipped, and that `node-pty` is
   declared but not needed to import the package.
3. **`package-conventions.test.ts`** — every package carries a `.prettierrc.json`,
   a LICENSE and a README.

`rootfs/egress-proxy/proxy.mjs` is tested from the hames app's test tree
(`app/src/__tests__/lib/sandbox/egress-proxy.test.ts`), and `scripts/` here
(live-container smoke checks against those images) is excluded from the
tarball.
