<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hames_light-text-on-transparent-bg.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/hames_dark-text-on-transparent-bg.png">
  <img src="assets/hames_dark-text-on-transparent-bg.png" alt="hames" width="340">
</picture>

### Build AI agents from small, composable TypeScript pieces.

[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue?style=flat)](./LICENSE)

**[Read the full API reference and design spec →](./SPEC.md)**

</div>

## What this is

A TypeScript library for building AI agents out of small pieces you snap
together — a tool-calling loop, a router that picks which route handles a
message, a planner that splits a request into steps, a guard for untrusted
tool output, a step that writes the final answer. Each piece is called a _pattern_, and the function you compose
them into — the one that runs a turn of your agent — is a _harness_. Every
pattern reads from and appends to one shared history of the run, which is how
they fit together without knowing about one another. The library itself is
model-agnostic: it contains no prompt templates, and no pattern calls a
language model itself. Wherever a pattern needs one it takes a function as an
argument, and the companion package
[`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)
gives you those functions ready-made, prompts included.

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
pnpm add @hames-ai/harness-patterns
pnpm add @hames-ai/harness-baml   # the ready-made model calls; optional
```

This package has no peer dependencies. It makes no model calls, so it needs no
API key on its own; with `@hames-ai/harness-baml`'s model calls, set
`ANTHROPIC_API_KEY`.

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

A tool loop that calls one tool, then a step that writes the answer. It runs
offline, seconds after `pnpm add`: the tool is a function in this process, and
the two model calls are stand-ins, so there is no MCP server, no Docker and no
API key. A _transport_ is where an agent's tools come from: an MCP server over HTTP, or an
object you register in your own process with `registerTransport`, as here.

`compactExecution` is that answer step, and its `mode` chooses what it reads:
`'thread'` gives it the previous pattern's tool calls and their results,
`'response'` gives it the text the previous pattern returned together with the
run's data, and `'message'` gives it that text alone. The shipped agents use
`'thread'` after a tool loop.

```typescript
import {
  registerTransport,
  simpleLoop,
  compactExecution,
  harness,
} from '@hames-ai/harness-patterns'
import type {
  CompactExecutionData,
  ControllerFn,
  HarnessData,
  SimpleLoopData,
  SynthesisFn,
} from '@hames-ai/harness-patterns'

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

// Stand-ins for the two model calls. The controller asks for the tool once, then stops.
let turn = 0
const controller: ControllerFn = async () => ({
  action:
    turn++ === 0
      ? { reasoning: 'Check the clock.', tool_name: 'clock_now', tool_args: '{}' }
      : { reasoning: 'I have the time.', tool_name: 'Return', tool_args: '{}', is_final: true },
})
const synthesize: SynthesisFn = async ({ loopHistory }) => ({
  value: `The clock says ${JSON.stringify(loopHistory?.iterations[0]?.result)}.`,
})

const agent = harness<Data>(
  simpleLoop(controller, ['clock_now']),
  compactExecution({ mode: 'thread', synthesize }),
)

const result = await agent('What time is it?')
console.log(result.response)
```

It prints something like `The clock says "2026-09-23T16:37:29.324Z".`, and nothing
else: no warnings, because nothing in it asks an MCP server for anything. To make the
two stand-ins real model calls, use `createLoopControllerAdapter()` and
`bamlPatterns().synthesize` from
[`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme).

### With tools from an MCP server (excerpt)

The same shape, with the tool list read from an MCP server by `Tools()` instead
of registered in this process. This is an excerpt, not a script: the two model
calls are only declared (in a real agent they come from
[`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)),
and `Tools()` needs an MCP server to list from.

```typescript
import { Tools, simpleLoop, compactExecution, harness } from '@hames-ai/harness-patterns'
import type {
  CompactExecutionData,
  ControllerFn,
  HarnessData,
  SimpleLoopData,
  SynthesisFn,
} from '@hames-ai/harness-patterns'

// The data the harness carries between steps. TypeScript needs it spelled out once.
interface Data extends HarnessData, SimpleLoopData, CompactExecutionData {
  [key: string]: unknown
}

// The two model calls. In a real agent both come from @hames-ai/harness-baml:
// createLoopControllerAdapter() and bamlPatterns().synthesize.
declare const controller: ControllerFn
declare const synthesize: SynthesisFn

// `namespaces` is required; `() => undefined` leaves every tool to the built-in
// grouping by name.
const tools = await Tools({ namespaces: () => undefined })

const agent = harness<Data>(
  simpleLoop(controller, tools.all),
  compactExecution({ mode: 'thread', synthesize }), // both fields are required
)

const result = await agent('What shipped in TypeScript 5.7?')
console.log(result.response)
```

### A routed, guarded agent

Patterns are ordinary values, so composing a harness is ordinary TypeScript.
This one classifies the message, sends web questions to a tool loop wrapped in
the injection guard (which neutralizes instructions hidden in web content
before a model reads them), and writes the answer from what the loop found.

Three of the patterns need a model call: the loop's _controller_ (the call that
reads the history and decides which tool to run next, or that it is done), the
router's classifier, and the step that writes the answer. The core library
defines only the TypeScript function type each one must have — `ControllerFn`,
`RouteFn`, `SynthesisFn` — and never calls a model itself. In a real agent you
do not write these functions: you import them from
[`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme),
prompts included — `createLoopControllerAdapter()` returns a ready
`ControllerFn`, and `bamlPatterns()` returns the router's and the answer
step's. The example below uses scripted stand-ins in their place only so that it
needs no model provider or API key (it still lists its tools from an MCP
gateway, through `Tools()`):

> **Needs:** an MCP server at `MCP_GATEWAY_URL` — clone [the repository](https://github.com/mknw/hames-playground), then run `docker compose up -d` ([docker-compose.yaml](https://github.com/mknw/hames-playground/blob/main/docker-compose.yaml)) in it to start one.

```typescript
import {
  Tools,
  simpleLoop,
  router,
  routes,
  withInjectionGuard,
  compactExecution,
  harness,
} from '@hames-ai/harness-patterns'
import type {
  ConfiguredPattern,
  ControllerFn,
  RouteFn,
  RouterData,
  SimpleLoopData,
  SynthesisFn,
  CompactExecutionData,
} from '@hames-ai/harness-patterns'
import type { HarnessData } from '@hames-ai/harness-patterns/harness.server'

// One data type across the composition — extends the pieces it rides and
// carries an index signature (what `harness()`'s generic requires):
interface AgentData extends HarnessData, RouterData, SimpleLoopData, CompactExecutionData {
  [key: string]: unknown
}

// Scripted stand-ins for the three model calls, so this needs no model API key.
// In a real agent, import them from @hames-ai/harness-baml instead:
//   const controller = createLoopControllerAdapter()
//   const { router: route, synthesize } = bamlPatterns()
const controller: ControllerFn = async (input) => ({
  action: { reasoning: '', tool_name: '', tool_args: '', is_final: true },
})

const route: RouteFn = async (message, history, routes) => ({
  intent: routes?.[0]?.name ?? 'user',
  tool_call_needed: false,
  tool_name: null,
  response_text: message,
})

const synthesize: SynthesisFn = async (input) => ({
  value: input.userMessage,
})

const tools = await Tools({
  namespaces: (name) => (name.startsWith('web_') ? 'web' : undefined),
})

const search = simpleLoop<AgentData>(controller, tools.web ?? [], {
  patternId: 'web-search',
})

const patterns: ConfiguredPattern<AgentData>[] = [
  router<AgentData>({ web_search: 'Web lookups and information retrieval' }, { route }),
  routes<AgentData>({
    web_search: withInjectionGuard({ namespaces: ['web'], catalog: tools.all })(search),
  }),
  compactExecution<AgentData>({
    mode: 'thread',
    patternId: 'response-synth',
    synthesize,
  }),
]
const agent = harness(...patterns)

const result = await agent('What shipped in TypeScript 5.7?', 'session-123')
```

Nothing in that chain hands state to the next step by hand: each pattern finds
what it needs in the log, and leaves its own events there for whatever runs next.

**[The developer guide →](./GUIDE.md)** — the composition model, writing your
own pattern, routing tool calls to your own tool servers, the error surface,
and how to consume the package. Every snippet in it is compiled by a test.

## Reference

This page is the front door. The depth lives in three places:
[GUIDE.md](./GUIDE.md) explains the composition model, writing your own pattern
and the error surface; [SPEC.md](./SPEC.md) has every signature and each
pattern's options; and the
[tutorials](https://github.com/mknw/hames-playground/tree/main/docs/tutorials#readme)
walk through tasks end to end.

### Patterns at a glance

|                       |                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loops**             | `simpleLoop` — tool loop (reason, call a tool, read the result, repeat) · `actorCritic` — generate, then evaluate before it can finish      |
| **Planning, routing** | `planner` decomposes up front · `router` classifies · `routes` dispatches · `parallel` fans out                                             |
| **Context**           | The unified context is an append-only event log; each pattern commits its draft into it when it finishes, and a serialized log is a session |
| **Views & scopes**    | A view queries the log (by pattern, type, recency); a pattern's scope declares its slice once, so old detail expires by itself              |
| **Carrying data**     | `withReferences` hands a pattern the relevant results of earlier turns, expandable on demand · `retriever` searches a vector store          |
| **Compaction**        | `compactExecution` turns the accumulated events into the answer · `compactIntent` rewrites the request into a brief                         |
| **Guards**            | `withInjectionGuard` neutralizes untrusted tool output before a controller reads it                                                         |
| **Composition**       | `chain` · `harness` · `continueSession` · `resumeHarness`                                                                                   |
| **Models and tools**  | model calls come in as functions (ready-made in `@hames-ai/harness-baml`) · MCP tools via `Tools()` and `callTool`                          |

Each of these has a section in the [spec](./SPEC.md), with the signatures,
configuration and per-pattern semantics that belong there rather than here.

### Why patterns over a shared history

An agent is its history. `hames` makes that literal: one append-only event log
per session — the **unified context** — is the only state there is. Every
primitive here, whether it is a loop, a router, a planner, a guard or a
synthesizer, reads that log and appends to it, so primitives compose without
knowing about one another and any one of them can be swapped without disturbing
the rest. A pattern writes into a private draft of the log and commits it only
when it finishes, so a step that throws leaves nothing behind — and because a
session _is_ its serialized log, continuing a conversation and resuming after an
approval gate (a pause until a person approves a step) are two arguments to the
same mechanism rather than two subsystems.

What that buys you is control over the thing that usually rots first: what each
model call actually sees. **Views** query the log — by pattern, by event type, by
the last N user turns — and a pattern's **scope**, the slice of the log that
pattern is allowed to see, is declared once, up front, instead of at every call
site. A synthesizer gets the tool results of the
route that just ran; a router gets a few turns of messages and nothing else;
older results degrade to compact pointers that a controller can expand on demand.
Context is budgeted by construction, not by remembering to prune.

The model calls themselves live in the companion package, written in
[BAML](https://docs.boundaryml.com) — a language for declaring an LLM call as a
typed function. Prompts sit in version-controlled `.baml` files with declared
input and output types, so a controller hands back a validated action rather
than a string you hope parses, model fallback chains sit next to the prompt
they serve, and a parse failure arrives as a typed error event in the same log
as everything else. BAML stays in the companion and out of the core: the
companion's _adapter factories_ (functions such as `createLoopControllerAdapter`
that wrap a BAML call into the function type a pattern expects) are the only
place that knows which provider you use, which is what keeps the patterns
portable.

### Licence

This package is [MIT](./LICENSE) (Copyright (c) 2026 Michael Accetto), as are
the other four `@hames-ai` packages. It is published to npm as
`@hames-ai/harness-patterns` (see the guide's "Consuming the package" for how
each consumer — workspace, Docker image, tarball — takes it).

It lives in the
[hames-playground repository](https://github.com/mknw/hames-playground#readme),
beside the hames app that uses it (see [See it running](#see-it-running)). The
app is licensed separately, under PolyForm Noncommercial 1.0.0.

How the package is built, and the boundary rules that keep it independent of
any host, are in the [spec](./SPEC.md).
