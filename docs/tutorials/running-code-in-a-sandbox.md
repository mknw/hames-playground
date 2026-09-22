# Running code in a sandbox

**Audience:** someone whose agent needs to execute code — shell, Python, file edits — and
who would rather it not run in the host process.

**You will build:** a sandboxed pattern, choose its egress posture, and pick a flavour per
turn.

**Time:** 10 minutes, plus one image build.

**Prerequisite:** a container engine on the host (Docker, or colima on macOS), and the
rootfs images built — see §6.

**The runnable version:** [`examples/running-code-in-a-sandbox.ts`](./examples/running-code-in-a-sandbox.ts) —
this page's code assembled into one file you can copy out and run.

---

## 1. What runs where

`withSandbox` is a **pattern wrapper**, not a tool. It wraps the pattern whose tool calls
should land inside a container:

```text
your process                        │ the container
────────────────────────────────────┼──────────────────────────────────
the harness, the patterns           │
the controller's LLM calls          │
withSandbox(...)  ── docker exec ──▶│  in-VM MCP servers (stdio)
                                    │    filesystem → sandbox_read / _write
                                    │                 _edit / _list / _search
                                    │    shell      → sandbox_bash
                                    │  /work  (scratch, per container)
                                    │  /work/in, /work/out  (durable — page 6)
```

Two consequences follow from the picture, and both matter:

- **Only the wrapped pattern's tool calls are contained.** The model call is not: prompts
  still leave your process the way they always did. Containment is about what the _tools_
  can touch.
- **The in-VM MCP connection is a `docker exec` stdio pipe, not a socket.** That is why
  the default egress profile can be _no network at all_ and the sandbox still works.

While the wrapped pattern runs, `withSandbox` installs a **scoped transport** that owns
every `sandbox_*` name. Scoped transports are consulted before any process-registered one
and before the gateway, with deliberately no `priority` field — so containment cannot be
inverted by a value or an import order.

## 2. Wrap a pattern

```typescript
import { withSandbox } from "@hames-ai/sandbox";
import type { ConfiguredPattern } from "@hames-ai/harness-patterns";
import type { AgentData } from "@hames-ai/agents";

declare const loop: ConfiguredPattern<AgentData>;
declare const sessionId: string;

const sandboxed = withSandbox({
  id: sessionId, // id-addressable: the same VM for every turn of this conversation
  sessionId, // per-session cap accounting
  rootfs: "base",
  egress: "mcp-only",
})(loop);
```

Three destinations, four ways to ask for one — the package calls them "four acquire
paths, picked by `id` and `fresh`":

| Config                | Path             | Lifetime                                                            |
| --------------------- | ---------------- | ------------------------------------------------------------------- |
| `{ id }`              | attachment table | one VM per id, parked between calls, reused by every later turn     |
| `{ id, fresh: true }` | attachment table | destroy any existing entry for the id first, then acquire a new one |
| `{}`                  | warm pool        | a pooled VM per call, returned to the pool after                    |
| `{ fresh: true }`     | one-shot         | private VM, booted and destroyed around the call                    |

Pick `{ id }` when follow-up turns should build on prior state — installed packages, files
under `/work`, environment. It is also the container an interactive shell attaches to,
because the PTY manager keys on the same session id: write a file with the agent, then
`cat` it in a terminal, and both see one workspace.

The per-call knobs all have shipped defaults you can override: `resources`
(`cpus` / `memoryMB` / `timeoutSec` — 512 MB and 60 s), and `backend` / `pool` /
`scheduler` / `attachments` if you want to substitute a compute substrate or isolate
state in tests.

## 3. Egress profiles

The network posture is per call, and the default is the closed one.

| Profile          | Network                                     | Use it for                      |
| ---------------- | ------------------------------------------- | ------------------------------- |
| `mcp-only`       | **`--network none`** — no network at all    | the default; everything offline |
| `pypi`           | internal-only net + allowlist CONNECT proxy | `pip` / `uv` installs           |
| `github-trusted` | internal-only net + allowlist CONNECT proxy | cloning from GitHub             |

The enforcement model for the two proxied profiles is topology, not a request header: the
container sits on an **internal-only** docker network with no route out at the bridge
level, and the only process on that network with external reach is an allowlist CONNECT
proxy the backend runs beside it. Well-behaved clients honour the `HTTPS_PROXY` /
`HTTP_PROXY` env vars it is handed and are filtered by host; anything that ignores them
has no route out at all. Fail-closed by construction.

The default allowlists are `pypi.org` + `files.pythonhosted.org`, and `github.com` +
`api.github.com` + `codeload.github.com` + `githubusercontent.com` (suffix-matched, so
every `*.githubusercontent.com` subdomain is admitted). A deployment tightens or widens
them with `SANDBOX_EGRESS_PYPI_ALLOWLIST` / `SANDBOX_EGRESS_GITHUB_ALLOWLIST` — no
rebuild.

Both the network and its proxy are **per boot**, named after the boot's sandbox id. Two
boots of the same profile therefore share no network and no gateway; containers on one
docker network are mutually reachable at L3 regardless of names, which is what made a
shared per-profile network a sandbox-to-sandbox channel.

Three fail-closed rules you should not have to discover:

- **An unknown profile name gets no network.** An unrecognised string must never mean
  "unrestricted".
- **`open` is not selectable.** It exists in the type for a single-operator escape hatch,
  but a requested `open` fails closed to `mcp-only` unless the deployment sets
  `SANDBOX_ENABLE_OPEN_EGRESS=1`. Only the exact value `1` enables it — `true` and `yes`
  are off, because a knob that admits unrestricted egress fails closed on a misspelling.
- **One residual leak, stated rather than hidden.** Under the proxied profiles DNS
  _resolution_ may still work depending on the host's docker DNS behaviour. Connections
  are not routed; at most this reveals that a hostname exists.

## 4. Flavours

`rootfs` picks the image. Four ship, all derived from `base`:

| `rootfs`           | Image                         | Carries                                                         |
| ------------------ | ----------------------------- | --------------------------------------------------------------- |
| `base`             | `kg-sandbox:base`             | Node 22, Python 3 (no third-party packages), curl               |
| `image-processing` | `kg-sandbox:image-processing` | numpy, Pillow, OpenCV, imagemagick                              |
| `data`             | `kg-sandbox:data`             | pandas, numpy, polars, pyarrow, matplotlib/seaborn, xlsx, pypdf |
| `office`           | `kg-sandbox:office`           | python-docx, openpyxl + xlsxwriter, PyMuPDF                     |

**Flavour selection is harness composition, not a tool argument.** The routed controller
stays flavour-agnostic; a `router` picks the route, and each route is a differently
flavoured `withSandbox`:

```typescript
import {
  router,
  routes,
  type ConfiguredPattern,
} from "@hames-ai/harness-patterns";
import type { AgentData, AgentDeps } from "@hames-ai/agents";

declare const deps: AgentDeps;
declare const sessionId: string;
declare const loop: ConfiguredPattern<AgentData>;

// The wrapper is INJECTED, never imported here — the containment posture is
// the host's (see the wiring tutorial). A missing supplier is a misconfigured
// bag, so fail loudly rather than run the loop on the host process.
const wrap = deps.withSandbox;
if (!wrap) throw new Error("requires deps.withSandbox (AgentDeps)");

const flavoured = (rootfs: string): ConfiguredPattern<AgentData> =>
  wrap({
    // One container PER FLAVOUR…
    id: `${sessionId}:${rootfs}`,
    // …but ONE workspace across all of them: /work/in and /work/out are keyed
    // by sessionId, so a file produced on a `data` turn is visible on a later
    // `office` turn.
    sessionId,
    rootfs,
    egress: "mcp-only",
    syncWorkspace: true,
  })(loop);

// `router` takes the route DESCRIPTIONS first and its config second; the
// `route` callable itself is injected (`bamlPatterns().router` supplies it).
declare const route: import("@hames-ai/harness-patterns").RouteFn;

const chain = [
  router<AgentData>(
    {
      basic: "quick shell work",
      image_processing: "images",
      data: "dataframes, spreadsheets, plots",
      office: "editing docx / xlsx / pdf",
    },
    { patternId: "flavour-router", route },
  ),
  routes<AgentData>({
    basic: flavoured("base"),
    image_processing: flavoured("image-processing"),
    data: flavoured("data"),
    office: flavoured("office"),
  }),
];
```

The uniformity in that snippet is load-bearing and was once a live bug. A route without an
`id` runs on the anonymous pool, where `syncWorkspace` is a **no-op** — so a turn routed
there ran in a container with no `/work/in` at all, and a file ingested on an earlier turn
was invisible. `withSandbox` now warns at wrap time when `syncWorkspace: true` is passed
without an `id`:

```text
[sandbox] withSandbox({ syncWorkspace: true }) ignored for pattern "…": it requires an
`id` (the anonymous-pool and `{ fresh }` paths have no durable workspace). Pass `id` —
e.g. `${sessionId}:${rootfs}` — to hydrate /work/in.
```

The corollary your prompts should carry: a later turn may land in a _different_ flavour
container, so anything worth keeping goes to `/work/out`, never to bare `/work`.

## 5. Telling the actor what it has

The container is only as useful as the model's picture of it. Each shipped flavour route
carries a short capability note in its actor context — what is installed, and the two
things that reliably go wrong:

- **Multi-line Python.** Write a `.py` file and run it, or use a quoted heredoc
  (`python3 - <<'PY' … PY`) — never nest escaped quotes in `python3 -c`. Models emit
  over-escaped one-liners that bash mangles into "unterminated string literal".
- **`PYTHONSAFEPATH=1` is set**, so the working directory is not on `sys.path`. To import
  helper modules from `/work`, run with `PYTHONPATH=/work`.

An honest note beats a hopeful one: the `base` flavour says outright that it has **no**
third-party Python packages, so the actor says so rather than improvising.

## 6. Building the images

The image definitions are **repository infrastructure, not package code** — they live in
[`rootfs/`](../../rootfs) at the repo root, are built and published by whoever operates a
deployment, and version on a different clock from the TypeScript. The package names the
images; it does not carry them.

```bash
cd rootfs && ./build.sh    # builds base, then the three flavours FROM it
```

A consumer supplies its own images, or substitutes a different compute substrate entirely
through `withSandbox({ backend })`. `COMPUTE_BACKEND=docker` is the default and today the
only implemented one.

## 7. Two more things worth knowing

- **Caps are process-scoped.** 16 concurrent attachments globally, 4 per session, 8 parked
  at rest, a warm pool of 1 per flavour, and a 1-hour idle eviction. They are read once
  when the singletons are first constructed — a host that wants different ones passes
  `pool` / `scheduler` / `attachments` per call rather than mutating the defaults.
- **Orphans are reaped once per process.** A dev-server crash loses the in-memory
  attachment table, leaving `--rm` containers running idle; the first default-backend
  build sweeps the label-scoped leftovers before allocating against the cap.

## 8. Where to go next

- [Attaching a sandbox workspace](./attaching-a-sandbox-workspace.md) — `syncWorkspace`,
  the `/work` protocol and the tenant seam.
- [Wiring a host](./wiring-a-host.md) — where `deps.withSandbox` comes from, and why
  `tenantId` must be a resolver.
- [`@hames-ai/sandbox` README](../../packages/sandbox/README.md) — the subpath table, the
  client-safe entries, and the three guards.
- [`docs/sandbox-flavours.md`](../sandbox-flavours.md) — the flavour design note.
- [`docs/plan/sandbox.md`](../plan/sandbox.md) — the compute design, the multi-user
  tenant-isolation work, and what is still plan-only.
