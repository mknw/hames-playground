# @hames-ai/harness-baml

## What this is

The model calls for
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme),
ready to import. The core library's patterns take every model call as a
function you pass in; this package provides those functions — the _controller_
that decides which tool a loop calls next, a _critic_ that checks a result
before a loop may finish, a router, a planner, the answer step's model call (the
_answer step_ is `compactExecution`, which calls the `synthesize` function this
package supplies), and the rest — each with its prompt
already written and its output parsed into a TypeScript type. The prompts are
written in [BAML](https://docs.boundaryml.com), a language for declaring LLM
calls as typed functions; the TypeScript client BAML generates from them ships
pre-built, so you never run BAML's tooling yourself. Calls go to Anthropic
models by default, and can be pointed at an OpenAI-compatible endpoint of your
own.

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
pnpm add @hames-ai/harness-baml @hames-ai/harness-patterns
export ANTHROPIC_API_KEY=sk-ant-…
```

`@hames-ai/harness-patterns` is a peer dependency, so you add it yourself.
`ANTHROPIC_API_KEY` is the only credential the default setup needs.

This package ships TypeScript source, not compiled JavaScript, so run it through
something that compiles TypeScript: Vite (or vinxi), esbuild, tsx or Bun. Plain
`node` cannot import it, because Node refuses to strip types from files under
`node_modules`. The examples use top-level `await`, so run them as ES modules (`"type": "module"` in your
`package.json`, or a `.mts` file).

Examples whose **Needs:** line names an MCP server list their tools from one. An
_MCP server_ exposes tools (web search, a database) to agents over one protocol, the
Model Context Protocol, and the packages reach it at `MCP_GATEWAY_URL` (default
`http://localhost:8811/mcp`). Any MCP server that speaks the protocol over HTTP
(its "streamable HTTP" mode) works, including your own; "gateway" is this
repository's name for the one it ships, which `docker compose up -d` starts in a
clone of the repository. An MCP server that requires authentication is not
supported yet.

## Usage

### Quick start

A tool loop that calls one tool, then a step that writes the answer, with this
package's model calls in both places. The tool is a function in this process, so
the only thing it needs is an Anthropic API key. A _transport_ is where an agent's tools come from: an MCP server over HTTP, or an
object you register in your own process with `registerTransport`, as here.

> **Needs:** an Anthropic API key in `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)).

```typescript
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import {
  registerTransport,
  simpleLoop,
  compactExecution,
  harness,
} from '@hames-ai/harness-patterns'
import type { CompactExecutionData, HarnessData, SimpleLoopData } from '@hames-ai/harness-patterns'

// The data the harness carries between steps. TypeScript needs it spelled out once.
interface Data extends HarnessData, SimpleLoopData, CompactExecutionData {
  [key: string]: unknown
}

// A tool that runs in this process: it reads the clock.
registerTransport({
  id: 'clock',
  ownsTool: (name) => name === 'clock_now',
  callTool: async () => ({ success: true, data: new Date().toISOString() }),
  listTools: async () => [{ name: 'clock_now', description: 'The current time' }],
})

const agent = harness<Data>(
  simpleLoop(createLoopControllerAdapter(), ['clock_now']),
  compactExecution({ mode: 'thread', synthesize: bamlPatterns().synthesize }),
)

const result = await agent('What time is it?')
console.log(result.response)
```

With no MCP server running, it prints two `[mcp-client] listTools failed … fetch failed`
warnings before the answer. They are harmless here: the controller always asks
an MCP server for tool descriptions too, finds none, and carries on with the
in-process tool.
`mode: 'thread'` hands the answer step the loop's tool calls and their results.

### With tools from an MCP server

The same shape, with the tool list read from an MCP server by `Tools()`.

> **Needs:** an Anthropic API key in `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)), and an MCP server at `MCP_GATEWAY_URL` — clone [the repository](https://github.com/mknw/hames-playground), then run `docker compose up -d` ([docker-compose.yaml](https://github.com/mknw/hames-playground/blob/main/docker-compose.yaml)) in it to start one.

```typescript
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import { Tools, simpleLoop, compactExecution, harness } from '@hames-ai/harness-patterns'
import type { CompactExecutionData, HarnessData, SimpleLoopData } from '@hames-ai/harness-patterns'

// The data the harness carries between steps. TypeScript needs it spelled out once.
interface Data extends HarnessData, SimpleLoopData, CompactExecutionData {
  [key: string]: unknown
}

// `namespaces` is required; `() => undefined` leaves every tool to the built-in
// grouping by name.
const tools = await Tools({ namespaces: () => undefined })

const agent = harness<Data>(
  simpleLoop(createLoopControllerAdapter(), tools.all),
  compactExecution({ mode: 'thread', synthesize: bamlPatterns().synthesize }), // both fields are required
)

const result = await agent('What shipped in TypeScript 5.7?')
console.log(result.response)
```

### How the model calls plug in

A pattern in `@hames-ai/harness-patterns` never calls a model itself; it is handed a function
of the shape `(input) => Promise<LLMResult<T>>`, where `LLMResult` carries the value plus an
`LLMCallRecord` with usage, timing and the raw output. The two loop patterns take their
controller (and critic) as the **first argument**; the other functions (`synthesize`,
`selector`, `route`, `describe`, `describeBatch`, `compactIntent`, `retrieveQuery`) arrive as
**required config**. (`selector` picks which earlier results a step carries forward;
`describe` and `describeBatch` summarize tool results; `compactIntent` rewrites a follow-up
into a self-contained request; `retrieveQuery` rewrites a question into a search query.) The
core library has no defaults for any of them — this package is where they come from, and one
import wires them:

```typescript
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import { simpleLoop } from '@hames-ai/harness-patterns/patterns/simpleLoop.server'

const patterns = bamlPatterns()
const controller = createLoopControllerAdapter()
const loop = simpleLoop(controller, ['search', 'Return'], {
  patternId: 'my-loop',
  ...patterns,
})
```

The tool list is the loop's allowlist; `'Return'` is the loop's built-in name for "I have the
answer, stop". `createLoopControllerAdapter()` is one of this package's _adapter factories_ —
the next section.

### Adapter factories

An adapter factory returns a function with exactly the type a pattern expects, wrapping one of
the generated BAML functions. It handles what the raw generated function does not: argument
order, recording token usage and timing for each call, and detecting an answer cut off at the
model's output limit, with one corrective retry:

```typescript
import { createActorControllerAdapter, createCriticAdapter } from '@hames-ai/harness-baml'

declare const tools: string[]

const actor = createActorControllerAdapter(tools)
const critic = createCriticAdapter()
```

`bamlPatterns()` returns what patterns take as config in one object — `router`, `synthesize`,
`selector`, `describe`, `describeBatch`, `compactIntent` and `retrieveQuery`, plus `planner`,
which is a factory you call with the planner's tool list (`baml.planner(tools.all)`) — so the
wiring stays one line however many of them a pattern needs. The loop controllers and the critic
come from their own factories, as above.

## Configuration

Three words run through this section. A _role_ is the job a model call does:
`controller` (both the tool loop's controller and the actor of a generate-then-check
loop run under it, the actor on the `ActorAnthropic` chain), `planner`, `critic`,
`compactExecution` (the answer step), `router`, `describe` (summarizing tool
results) or `screen` (the injection guard's check of untrusted content). A _chain_ is the ordered list of Anthropic models one role tries
in turn, falling back to the next if a call fails, declared in the package's `.baml`
files. A _tier_ is which set of models a whole run uses: `anthropic` by default, or
the optional self-hosted tier at the end of this section.

### Bring your own provider or model

There are two ways to send calls somewhere other than Anthropic, and they are
different things. This section is the one for you: it plugs in **your own**
provider or model. The [optional self-hosted tier](#optional-self-hosted-tier)
further down is the private model this repository runs for its own deployment,
and is off by default.

You can supply your own LLM clients — a different provider, or a model you host —
without touching prompts: define runtime clients through a BAML `ClientRegistry`, map the
roles you want off the built-in chains, and your clients take over **exactly the mapped roles**
on top of the built-in tier (unmapped roles change nothing, and the injection guard's `screen`
role moves only when you map it by name). One function type serves both wiring paths:

```typescript
import {
  defineInferenceClients,
  activateConsumerClients,
} from '@hames-ai/harness-baml/consumer-clients.server'

const plug = defineInferenceClients({
  clients: [
    {
      name: 'MyEndpoint',
      provider: 'openai-generic',
      options: {
        model: 'my-model-7b',
        base_url: 'https://llm.internal.example.com/v1',
        api_key: '…',
      },
    },
  ],
  byRole: { router: 'MyEndpoint', describe: 'MyEndpoint' },
})
activateConsumerClients(plug) // from here on, the mapped roles use your clients
```

If you use `@hames-ai/agents`, hand `plug` to `AgentDeps.clientOverride` as well — the type is the same `ClientOverride` —
for the package-side call sites outside the adapters (the title generator). Definition-time
validation throws on a malformed config (empty name/provider, `byRole` naming an undefined
client), naming the role and the client — never on turn one. Full walkthrough, including
what happens to unmapped roles and to prompt budgeting:
**[bring your own provider or model](https://github.com/mknw/hames-playground/blob/main/docs/tutorials/own-provider-or-model.md)**.

### Choosing which model each call uses

You can skip this section if Anthropic is all you need: every call already goes there.
The Anthropic clients are the default: every function names an Anthropic chain
(`ControllerAnthropic`, `ActorAnthropic`, `PlannerAnthropic`, `CriticAnthropic`,
`SynthesizerAnthropic`, `RouterAnthropic`, `DescribeAnthropic`), and the `client X` line on
each function is what routes a call.

Each role resolves to a BAML _client_, a named model configuration (provider, model, limits,
fallbacks). Your application picks the tier per run, for example per conversation; you care
because it decides where your prompts are sent. A _run frame_ is the bundle of settings one run carries from start to finish — its tier, its
budgets, its live-event listener. Your application opens it with `withRunFrame` from
`@hames-ai/harness-patterns` (or `harness()` opens one for you), and every model call made
inside that run reads its settings from it.

Three functions answer "which model does this role use right now": `clientOverrideFor(role)`
builds the per-call options a call spreads into its BAML options; `resolveClientForRole(role)`
names the client; `limitsFor(role)` returns that model's context window and output cap, so
patterns size their prompts for the right model. `assertInferenceTier(tier)` checks that a tier
can actually be reached — it throws for the optional self-hosted tier when that tier is not configured —
and your application calls it before putting a tier in a run frame:

```typescript
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import {
  assertInferenceTier,
  clientOverrideFor,
  limitsFor,
} from '@hames-ai/harness-baml/clients.server'

assertInferenceTier('anthropic')
await withRunFrame({ inference: { tier: 'anthropic' } }, async () => {
  const opts = { ...clientOverrideFor('controller') } // undefined on the anthropic tier
  const limits = limitsFor('controller')
})
```

### Optional self-hosted tier

The package also ships the clients for a self-hosted tier, the private model this
repository runs for its own deployment. It is off by default and you do not need
it; to use your own model, see
[Bring your own provider or model](#bring-your-own-provider-or-model). How it is
switched on is documented beside its clients, in
[baml_src/verda-client.baml](https://github.com/mknw/hames-playground/blob/main/packages/harness-baml/baml_src/verda-client.baml).

## Reference

How patterns take these functions, and every pattern's options:
[GUIDE.md](https://github.com/mknw/hames-playground/blob/main/packages/harness-patterns/GUIDE.md)
and [SPEC.md](https://github.com/mknw/hames-playground/blob/main/packages/harness-patterns/SPEC.md)
in `@hames-ai/harness-patterns`. Plugging in your own model, step by step:
[bring your own provider or model](https://github.com/mknw/hames-playground/blob/main/docs/tutorials/own-provider-or-model.md).
The prompts themselves are the `.baml` files in
[`baml_src/`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml/baml_src).

### Licence

MIT — see [LICENSE](./LICENSE).

## Regenerating the client (contributors)

`baml_client/` is pre-generated and committed, so as a consumer you never run BAML's CLI. If you
edit a `.baml` file in this package, regenerate and commit the result with the source change:

```bash
pnpm baml-generate   # from packages/harness-baml; requires @boundaryml/baml (a dependency)
```
