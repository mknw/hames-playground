# Hosting the harness in your own app

**Audience:** a developer with an existing TypeScript app who wants agents in it — not a
fork of this repo.

**You will build:** a working agent inside your own process, with no model and no MCP
gateway, then swap each stand-in for the real thing.

**Time:** 10 minutes to a running loop.

---

## 1. Install

Four packages, and only the first is mandatory:

| Package                   | Bring it in when                                              |
| ------------------------- | ------------------------------------------------------------- |
| `@hames/harness-patterns` | always — patterns, event views, the guard, the tool transport |
| `@hames/harness-baml`     | you want the shipped prompts and model adapters               |
| `@hames/agents`           | you want the six ready-made agent definitions                 |
| `@hames/sandbox`          | you want to run code in a container                           |

```bash
pnpm add @hames/harness-patterns
# each companion declares @hames/harness-patterns as a PEER, so add it yourself:
pnpm add @hames/harness-baml @hames/agents @hames/sandbox
```

The peer edge is deliberate: the companions hold module-level AsyncLocalStorage scopes
(the tool transport, the injection guard, the inference tier), and two resolved copies of
the core package would be two scopes that never see each other. One copy, owned by you.

**You must be a TS-bundler consumer.** These packages ship TypeScript source — `main` and
every `exports` target is a `.ts` file, there is no `dist/`, and `pnpm pack` is the whole
publish pipeline. Vite, vinxi, esbuild, tsx and Bun run them as-is. A plain
`node dist/index.js` consumer is not supported, deliberately: a build step would make the
published artefact different from the source every test in this repo runs against.

## 2. A working agent, with nothing else installed

The shortest thing that is genuinely an agent: a tool your process owns, a controller that
decides, and a harness that runs them. No model, no gateway, no container.

```typescript
import {
  harness,
  simpleLoop,
  withTransport,
  ToolsFrom,
} from "@hames/harness-patterns";
import type {
  ControllerFn,
  HarnessData,
  SimpleLoopData,
  ToolTransport,
} from "@hames/harness-patterns";

// The data generic must extend `HarnessData` AND carry an index signature —
// that is what lets wrappers write `scope.data` generically.
interface Data extends HarnessData, SimpleLoopData {
  [key: string]: unknown;
}

// 1. A transport: anything that owns some tool names and can run them.
const echo: ToolTransport = {
  id: "echo",
  ownsTool: (name) => name === "echo_upper",
  callTool: async (_name, args) => ({
    success: true,
    data: String(args.text ?? "").toUpperCase(),
  }),
  listTools: async () => [
    { name: "echo_upper", description: "Upper-case its `text` argument." },
  ],
};

// 2. A controller. Hand-rolled here; §3 swaps in the real one.
const controller: ControllerFn = (() => {
  let turn = 0;
  return async () => {
    turn += 1;
    return turn === 1
      ? {
          action: {
            reasoning: "shout it",
            tool_name: "echo_upper",
            tool_args: JSON.stringify({ text: "hello harness" }),
            is_final: false,
          },
        }
      : {
          action: {
            reasoning: "done",
            tool_name: "",
            tool_args: "",
            is_final: true,
          },
        };
  };
})();

// 3. Group the tools, compose the chain, run it.
const tools = ToolsFrom(await echo.listTools!(), { namespaces: () => "echo" });
const agent = harness<Data>(
  simpleLoop<Data>(controller, tools.echo ?? [], { patternId: "echo-loop" }),
);

const result = await withTransport(echo, () =>
  agent("shout hello harness", "demo-session"),
);
for (const event of result.context.events) console.log(event.type, event.data);
```

That prints the whole turn:

```text
user_message      {"content":"shout hello harness","chainTurnEstimate":8}
pattern_enter     {"pattern":"simpleLoop"}
controller_action {"action":{"reasoning":"shout it","tool_name":"echo_upper",…}}
tool_call         {"callId":"tc-…","tool":"echo_upper","args":{"text":"hello harness"}}
tool_result       {"callId":"tc-…","tool":"echo_upper","result":"HELLO HARNESS","success":true}
controller_action {"action":{"reasoning":"done","tool_name":"","tool_args":"","is_final":true}}
pattern_exit      {"status":"running"}
```

Three things to take from it:

- **`withTransport` is scoped and wins.** It is an AsyncLocalStorage stack bounded by one
  call, consulted before any process-registered transport and before the gateway. There is
  deliberately no `priority` field, so containment cannot be inverted by a value or an
  import order. `registerTransport(mine)` is the process-wide twin, consulted last.
- **A session is its serialized context.** `result.serialized` is the JSON string you
  store; `continueSession(serialized, patterns, nextInput)` picks the conversation up.
  There is no separate session store to wire.
- **`status: 'running'` at rest is normal.** A successful chain does not set `'done'`; your
  host decides what a finished turn means (see §5).

## 3. Swap in the real controller

`@hames/harness-baml` supplies the LLM seam — prompts, adapters, usage accounting,
cap-hit detection with one corrective retry. `bamlPatterns()` assembles every injected
function a pattern might need, so the wiring stays one line:

```typescript
import { bamlPatterns, createLoopControllerAdapter } from "@hames/harness-baml";
import { simpleLoop } from "@hames/harness-patterns/patterns/simpleLoop.server";

const loop = simpleLoop(createLoopControllerAdapter(), ["search", "Return"], {
  patternId: "my-loop",
  ...bamlPatterns(),
});
```

**Patterns take adapter factories, never raw BAML functions.** A generated function's
positional signature does not match a pattern's controller contract — a bound raw function
fails typecheck and would die on turn one. The adapters do the call-order adaptation and
return `{ action, llmCall }`.

To point those prompts at your own model, see
[bring your own provider or model](./own-provider-or-model.md). The V1 contract is **own
provider or model, same prompts**: you supply clients, not templates, and no accessor to
the generated client ships.

## 4. Swap in the real tools

`Tools()` is the MCP-gateway transport the package ships. Its `namespaces` argument is
**required**, not optional:

```typescript
import { Tools } from "@hames/harness-patterns/tools.server";

declare const yourCatalog: Record<string, string | undefined>;

const tools = await Tools({ namespaces: (toolName) => yourCatalog[toolName] });
tools.web; // → the tool names in the `web` namespace
tools.all; // → every name this deployment can reach
```

A missing map is how `tools.web` disappears silently on the day a catalog moves, so it is
an argument rather than an option. This deployment's own 86-name map ships as
`mcpNamespace` in `@hames/connectors/mcp-catalog`; yours can be any
`(name) => string | undefined`.

Before any untrusted tool result reaches a controller, wrap the pattern — see
[guarding an agent](./guarding-an-agent.md).

## 5. Run a ready-made agent instead

`@hames/agents` ships six agent definitions — data only, no UI concepts and no host
policy. Everything app-side arrives through **one** `AgentDeps` bag:

```typescript
import type { AgentDeps } from "@hames/agents";

declare const yourCatalog: (toolName: string) => string | undefined;

const deps: AgentDeps = {
  // The ONLY required member: this deployment's tool→namespace map.
  toolNamespaces: yourCatalog,
  // Everything else is optional — omit what you do not compose.
  // enrichNeo4jResult, createRedisBackend, withSandbox, clientOverride,
  // persistTitle, doNotCachePatterns
};
```

```typescript
import { searchAgent } from "@hames/agents/agents/search.server";
import type { AgentDeps } from "@hames/agents";
import { harness } from "@hames/harness-patterns";
import type { AgentData } from "@hames/agents";

declare const deps: AgentDeps;

const patterns = await searchAgent.createPatterns("session-1", deps);
const agent = harness<AgentData>(...patterns);
```

`createPatterns` returns a `ConfiguredPattern[]`; `harness(...patterns)` makes it callable.
The definitions carry no `icon` or `accent` — presentation is yours to overlay at
registration.

### The missing-supplier throw you will hit

An agent that needs a supplier the bag does not carry **throws by name**, at
`createPatterns`, rather than degrading into a composition that looks fine and contains
less:

```text
sandbox-session requires deps.withSandbox — the composition root must supply it (AgentDeps)
```

That is not an accident of the type system — `withSandbox` is optional on `AgentDeps` on
purpose, because a deployment that composes no sandbox must not be forced to supply one.
What must not happen is the loop silently running **on the host process** instead of inside
a container. So the agents that need it guard and throw. `flavoured-sandbox` throws the
same way.

Two more failures with the same shape, both at the composition root rather than mid-turn:

- `configureWorkspaceStore` throws at the call when a supplier is missing —
  `@hames/sandbox: configureWorkspaceStore requires a function for "store" (got undefined)`.
- Using durable workspace sync without having configured one raises a named
  `WorkspaceStoreNotConfiguredError`. See
  [attaching a sandbox workspace](./attaching-a-sandbox-workspace.md).

### Deciding a turn is finished

`runChain` almost never throws — every pattern catches internally and records an `error`
event — so "the chain returned" is not the same as "the turn succeeded". A turn whose LLM
calls all failed comes back with `status: 'running'` and an empty response. Decide it
explicitly: **nothing to show AND something recorded → error**. The conjunction matters —
an error _with_ a response is the designed partial-answer path, and no error and no
response is simply a chain with no synthesizer.

## 6. Where to go next

- [Wiring a host](./wiring-a-host.md) — the composition root that builds the bag, and
  where each supplier is registered.
- [Guarding an agent](./guarding-an-agent.md) — before any untrusted tool result reaches a
  model.
- [Running code in a sandbox](./running-code-in-a-sandbox.md) — the `withSandbox` supplier
  the throw above is asking for.
- [`@hames/harness-patterns` GUIDE](../../packages/harness-patterns/GUIDE.md) — the
  composition model, writing your own pattern, the error surface.
  [SPEC.md](../../packages/harness-patterns/SPEC.md) is the per-pattern reference.
- [`@hames/agents` README](../../packages/agents/README.md) — the agent catalog and the
  full injected-vs-imported table.
