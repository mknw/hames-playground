# @hames-ai/sandbox

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
pnpm add @hames-ai/sandbox @hames-ai/harness-patterns
```

`@hames-ai/harness-patterns` is a peer dependency, so you add it yourself. You
also need Docker on the machine that runs your agent.

This package ships TypeScript source, not compiled JavaScript, so run it through
something that compiles TypeScript: Vite (or vinxi), esbuild, tsx or Bun. Plain
`node` cannot import it, because Node refuses to strip types from files under
`node_modules`.

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

> **Needs:** Docker, the `kg-sandbox:base` image ([build it](#build-the-sandbox-image) as [rootfs/README.md](https://github.com/mknw/hames-playground/blob/main/rootfs/README.md) in the hames app describes), and an Anthropic API key in `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)).

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

Build the image first: [Build the sandbox image](#build-the-sandbox-image).
`mode: 'thread'` hands the answer step the loop's tool calls and their results.

### Choosing the image, the network and the batching

The same agent with its options spelled out:

> **Needs:** Docker, the `kg-sandbox:base` image ([build it](#build-the-sandbox-image) as [rootfs/README.md](https://github.com/mknw/hames-playground/blob/main/rootfs/README.md) in the hames app describes), and an Anthropic API key in `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)).

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
  size-capped scratch space for `/work` and `/tmp`, and a non-root user.
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
- **Whose container it is** — `WithSandboxConfig.tenantId`, the id of the user who
  owns the conversation, as a string or as a function called per run (useful when
  you build your patterns once but the signed-in user changes per request).

Every other option on `WithSandboxConfig` (`backend`, `pool`, `scheduler`,
`attachments`, `resources`, `egress`) has a default.

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
name, unless the deployment sets `SANDBOX_ENABLE_OPEN_EGRESS=1`. The
per-profile table, the default allowlists and the remaining DNS caveat are in
[running code in a sandbox](../../docs/tutorials/running-code-in-a-sandbox.md).

### Container images live outside the package

`withSandbox` boots `kg-sandbox:base` and its three _flavours_ — images with
extra tools preinstalled: `image-processing`, `data` and `office` — plus the
allowlist proxy behind the `pypi` / `github-trusted` profiles. Their
definitions live in **[`rootfs/`](../../rootfs/README.md) at the repository
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

| Subpath                      | What lives there                                                                                  | Browser-safe?                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `.` (root entry point)       | `withSandbox`, `DockerBackend`, `getComputeBackend`, the compute types, `configureWorkspaceStore` | **no** — server-only, pulls the Docker backend |
| `./types`                    | `ComputeBackend` / `VMHandle` / `RuntimeConfig` / …, `SANDBOX_TOOL_PREFIX`, `V0_IN_VM_SERVERS`    | yes — types + constants, no `node:` imports    |
| `./settings`                 | `SandboxSettings` + `DEFAULT_SANDBOX_SETTINGS` (the caps and per-call defaults)                   | yes — same rule                                |
| `./guard` (= `./bash-guard`) | `screenBashCommand` / `bashGuardPolicyFromEnv` — the shell-command screen                         | yes                                            |
| `./egress-policy`            | the three selectable egress profiles and the per-boot network naming                              | yes                                            |
| `./workspace-store`          | `configureWorkspaceStore(...)` — where you plug in storage for `/work` files                      | server                                         |
| `./with-sandbox.server`      | the wrapper itself, for code that skips the root entry point                                      | server                                         |
| `./pty-manager.server`       | an interactive terminal into a running container (uses `node-pty`, see Troubleshooting)           | server                                         |
| `./docker-backend.server`    | the Docker compute backend                                                                        | server                                         |

**The root entry point is server-only and it pulls Docker with it**, because
`withSandbox` constructs a `DockerBackend` by default. Browser code imports
`./types` or `./settings` instead; neither reaches a `node:` module.

## Troubleshooting

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
