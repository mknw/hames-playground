# @hames-ai/agents

## What this is

Six ready-made AI agents to register in your own application: search over the
web and a Neo4j knowledge graph, question-answering over documents you have
uploaded, a Microsoft 365 assistant, a general-purpose agent with every tool,
and two that run code in a container. Each one is built from
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme)
and makes its model calls through
[`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme).
An agent here is a plain definition — an id, a name, a greeting, the tool
servers it needs and a function that builds it — and whatever it needs from
your application (a tool catalog, a document store, a sandbox) you hand it in
one object, `AgentDeps`. The package also ships browser-safe helpers that turn
a run's history into graph elements, citations and a chat transcript.

### Install

```bash
pnpm add @hames-ai/agents @hames-ai/harness-baml @hames-ai/harness-patterns
```

`@hames-ai/harness-baml` and `@hames-ai/harness-patterns` are peer
dependencies, so you add them yourself. Running an agent calls Anthropic
models, so set `ANTHROPIC_API_KEY` in the environment; the model clients in
`@hames-ai/harness-baml` read it. The agents also reach their tools through an
MCP gateway (a server that exposes tools over the Model Context Protocol) at
`MCP_GATEWAY_URL`, which defaults to `http://localhost:8811/mcp`.

## Which package do you need?

Five packages that work together. The first is the foundation; add the others
for what they do.

| If you want to…                                                                                             | Use                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| build an agent out of composable pieces — tool loops, routers, planners                                     | [`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme) |
| get typed model calls with the prompts already written, on Anthropic or your own model provider             | [`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)         |
| use a ready-made agent                                                                                      | [`@hames-ai/agents`](https://github.com/mknw/hames-playground/tree/main/packages/agents#readme)                     |
| use Microsoft 365 or the Neo4j graph database from an agent, or sort an MCP gateway's tools into namespaces | [`@hames-ai/connectors`](https://github.com/mknw/hames-playground/tree/main/packages/connectors#readme)             |
| run agent-written code in a container                                                                       | [`@hames-ai/sandbox`](https://github.com/mknw/hames-playground/tree/main/packages/sandbox#readme)                   |

## See it running

The [hames app](https://github.com/mknw/hames-playground) is the reference
host for all five packages: a self-hosted agent workspace whose agents are
built from them, with every step of every run visible in its UI. Its
[Quickstart](https://github.com/mknw/hames-playground#quickstart) runs it
locally with Docker and pnpm.

## Agent catalog

Each agent is a chain of patterns from `@hames-ai/harness-patterns`, listed in
order under **Composition**; each name is a pattern documented in the
[harness-patterns README](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme).
**Injection guard** says which tool results pass through `withInjectionGuard`,
which neutralizes instructions hidden in untrusted content (a web page, an
email) before a model reads it.

| Agent               | Composition                                                   | Tools                           | Injection guard                                                                          |
| ------------------- | ------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `search`            | router → routes(neo4j loop, web loop) → compactExecution      | neo4j-cypher, web_search, fetch | web route guarded; neo4j route trusted (a graph you control)                             |
| `retriever-agent`   | router → routes(retriever, neo4j, web) → compactExecution     | neo4j-cypher, web_search, fetch | web namespace + retriever exact-name guarded together (ingested documents are untrusted) |
| `microsoft-365`     | explicit graph-tool allowlist loop → compactExecution         | Microsoft Graph, per-user token | whole graph loop guarded (mail/files are attacker-authored)                              |
| `general`           | planner → simpleLoop(tools.all) → compactExecution            | everything                      | not guarded yet (below)                                                                  |
| `sandbox-session`   | compactIntent → withSandbox(actorCritic) → compactExecution   | in-container `sandbox_*`        | not on tool results yet; shell commands are screened (below)                             |
| `flavoured-sandbox` | router → routes(base, image, data, office) → compactExecution | in-container `sandbox_*`        | not on tool results yet, on any route; shell commands are screened (below)               |

**Guardrail status.** Two guards ship today. The injection guard covers the
tool results marked in the table above, and the two sandbox agents also get
`@hames-ai/sandbox`'s shell-command screen, which checks every `sandbox_bash`
command against a denylist before it runs. Guardrails beyond these two are
designed, not yet built — [design record](https://github.com/mknw/hames-playground/issues/242#issuecomment-5768168881).

The injection guard has two layers with opposite failure policies — an
optional model-based screen, which lets content through if the screen itself
fails, and a deterministic layer, which does not — and which of the two should
win is an open decision, not settled by this package.

## Usage: run the search agent once

Build a shipped agent's patterns, compose them into a harness, and ask one
question.

```typescript
import { harness } from '@hames-ai/harness-patterns'
import { registerToolNamespaces } from '@hames-ai/harness-patterns/tools.server'
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import { searchAgent } from '@hames-ai/agents/agents/search.server'

// Which group ("namespace") each tool belongs to, such as `web` or `neo4j` —
// for example `mcpNamespace` from @hames-ai/connectors/mcp-catalog.
declare const toolNamespaces: (toolName: string) => string | undefined

// Required: the agent's injection guard refuses to build without it.
registerToolNamespaces(toolNamespaces)

// `toolNamespaces` is the one required field of AgentDeps.
const deps: AgentDeps = { toolNamespaces }

const sessionId = 'session-1'
const patterns = await searchAgent.createPatterns(sessionId, deps)
const result = await harness<AgentData>(...patterns)(
  'Who maintains the billing service?',
  sessionId,
)
console.log(result.response)
```

It needs `ANTHROPIC_API_KEY` set, an MCP gateway serving the Neo4j and web
tools the agent lists in `servers` (`neo4j-cypher`, `web_search`, `fetch`), and
a Neo4j database behind the first of them.

## What an agent definition contains

The shape, simplified from `types.ts` (the source is the authority; the
`typescript` samples further down are compiled against it by a test in this
repository):

```
// What a ready-made agent IS — data only, no presentation:
interface AgentDefinition {
  id: string
  name: string
  description: string
  /** The greeting shown in an empty conversation. Required, so a new agent
   *  without one fails to compile instead of borrowing another's greeting. */
  welcome: string
  servers: string[]
  createPatterns: (sessionId: string, deps: AgentDeps) => Promise<ConfiguredPattern<AgentData>[]>
}

// The data every pattern in the agent reads and writes during a run:
interface AgentData
  extends HarnessData, RouterData, SimpleLoopData, RetrieverData, WithApproval {
  response?: string
  [key: string]: unknown
}

// What your application supplies. Only `toolNamespaces` is required; the model
// calls are not in here, because the agents import them from
// @hames-ai/harness-baml themselves:
interface AgentDeps {
  toolNamespaces: (toolName: string) => string | undefined
  enrichNeo4jResult?: OnToolResult
  createRedisBackend?: (sessionId: string) => RetrieverBackend
  withSandbox?: (config: SandboxAttach) => (pattern: ConfiguredPattern<AgentData>) => ConfiguredPattern<AgentData>
  clientOverride?: (role: string) => Record<string, unknown> | undefined
  persistTitle?: (sessionId: string, userId: string, title: string) => Promise<void>
  doNotCachePatterns?: (sessionId: string) => void
}
```

### What comes from where

| Concern                                           | Where it lives               | How it reaches the agent                         |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| Model calls: adapters, prompt templates           | `@hames-ai/harness-baml`     | imported directly by the factories               |
| Patterns, event views, guard, tool transport      | `@hames-ai/harness-patterns` | imported directly                                |
| Tool→namespace catalog (your MCP gateway's map)   | your application             | `AgentDeps.toolNamespaces` — required            |
| Neo4j tool-result enrichment                      | your application             | `AgentDeps.enrichNeo4jResult`                    |
| Document search backend (uploaded files)          | your application             | `AgentDeps.createRedisBackend`                   |
| Sandbox wrapper (built on `@hames-ai/sandbox`)    | your application             | `AgentDeps.withSandbox`                          |
| Which model each role uses (your policy)          | your application             | `AgentDeps.clientOverride`                       |
| Saving conversation titles; opting out of caching | your application             | `AgentDeps.persistTitle` / `.doNotCachePatterns` |
| Icons + accent colours                            | your application             | added when you register the agent (below)        |

## Composing an agent

Each definition's `createPatterns` composes patterns from
`@hames-ai/harness-patterns` with what your application supplies in
`AgentDeps`. The excerpts below are lifted from the shipped agents, and a test
in this repository compiles them against the package source, so they cannot
drift from the real signatures.

```typescript
// The agent's tools, grouped by namespace. You pass the grouping in: the
// package cannot guess which of your MCP tools are web tools. From
// `search.server.ts`:
import { Tools } from '@hames-ai/harness-patterns/tools.server'
import type { AgentDeps } from '@hames-ai/agents'

declare const deps: AgentDeps
const toolSet = await Tools({ namespaces: deps.toolNamespaces })
```

```typescript
// A Neo4j tool loop: the shipped controller decides each query, and your
// optional `enrichNeo4jResult` post-processes each result. From `search.server.ts`:
import { simpleLoop, type ConfiguredPattern } from '@hames-ai/harness-patterns'
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import type { ToolSet } from '@hames-ai/harness-patterns'
import { NEO4J_FEW_SHOTS_DEFAULT } from '@hames-ai/agents/agents/neo4j-fewshots.server'

function buildNeo4jRoute(
  deps: AgentDeps,
  tools: ToolSet,
  schema: string,
): ConfiguredPattern<AgentData> {
  const baml = bamlPatterns()
  return simpleLoop<AgentData>(createLoopControllerAdapter(), tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema,
    liveEvents: true,
    rememberPriorTurns: false,
    fewShots: NEO4J_FEW_SHOTS_DEFAULT,
    onToolResult: deps.enrichNeo4jResult,
  })
}
```

```typescript
// Two routes picked by the router. Only the web route is wrapped in the
// injection guard: the agent itself declares which of its sources it does
// not trust. `withReferences` hands each route relevant results from earlier
// turns; `scope: 'global'` lets it pick them from any route, not only its own.
// From `search.server.ts`:
import {
  routes,
  withReferences,
  withInjectionGuard,
  type ConfiguredPattern,
} from '@hames-ai/harness-patterns'
import type { AgentData } from '@hames-ai/agents'
import type { ToolSet } from '@hames-ai/harness-patterns'
import { bamlPatterns } from '@hames-ai/harness-baml'

declare const neo4jPattern: import('@hames-ai/harness-patterns').ConfiguredPattern<AgentData>
declare const webPattern: import('@hames-ai/harness-patterns').ConfiguredPattern<AgentData>

function buildRoutes(tools: ToolSet): ConfiguredPattern<AgentData> {
  const baml = bamlPatterns()
  const selector = baml.selector
  return routes<AgentData>(
    {
      neo4j: withReferences<AgentData>(neo4jPattern, {
        scope: 'global',
        liveEvents: true,
        selector,
      }),
      web_search: withInjectionGuard({ namespaces: ['web'], catalog: tools.all })(
        withReferences<AgentData>(webPattern, {
          scope: 'global',
          liveEvents: true,
          selector,
        }),
      ),
    },
    { liveEvents: true },
  )
}
```

> **The guard needs the namespace catalog registered.** `withInjectionGuard`
> verifies every declared namespace against the `catalog` you pass and
> **refuses to build** if nothing in it produces the namespace.
> The usual cause: the tool→namespace resolver was never registered. Call
> `registerToolNamespaces(mcpNamespace)` once at startup — a ready map ships in
> `@hames-ai/connectors/mcp-catalog` — or register your own resolver the same
> way. An agent with no untrusted namespaces writes `namespaces: []`
> explicitly.

```typescript
// A code-running loop kept in one container for the whole conversation. The
// sandbox wrapper comes from your application (built on @hames-ai/sandbox),
// so you decide how the container is isolated. From `sandbox-session.server.ts`:
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns'

declare const loop: ConfiguredPattern<AgentData>

function sandboxIt(deps: AgentDeps, sessionId: string): ConfiguredPattern<AgentData> {
  // This agent cannot run without a sandbox, so it fails loudly rather than
  // run agent-written code on your machine:
  const wrap = deps.withSandbox
  if (!wrap) throw new Error('requires deps.withSandbox (AgentDeps)')
  return wrap({
    id: sessionId,
    sessionId,
    rootfs: 'base',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(loop)
}
```

```typescript
// A route that searches your uploaded documents (the retrieval backend you pass
// as `createRedisBackend`). From `retriever-agent.server.ts`:
import { retriever, type ConfiguredPattern, type RetrieverBackend } from '@hames-ai/harness-patterns'
import type { AgentData } from '@hames-ai/agents'
import { bamlPatterns } from '@hames-ai/harness-baml'

function buildRetrieverRoute(redisBackend: RetrieverBackend): ConfiguredPattern<AgentData> {
  const baml = bamlPatterns()
  return retriever<AgentData>({
    patternId: 'retriever',
    backends: [redisBackend],
    k: 5,
    generateQuery: true,
    rewrite: baml.retrieveQuery,
    liveEvents: true,
  })
}
```

## Exports

The root entry point (`import from '@hames-ai/agents'`) is **browser-safe** —
front-end code can import it without pulling in anything server-side:

| Export                                                                        | What it is                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `extractGraphElements`, `extractGraphFromResult`                              | ContextEvent/tool-result → `GraphElement[]` for graph rendering |
| `isEdgeElement`, `isNodeElement`, `isNeo4jGraphResult`, `isMemoryGraphResult` | shape guards over extracted elements                            |
| `extractReferences`, `referencesForDoc`                                       | retriever citations out of the event stream                     |
| `errorBubble`, `replayMessages`, `ReplayedMessage`                            | serialized context → minimal chat transcript                    |
| `GraphElement`, `OpenReferenceTarget`                                         | the shared data types                                           |
| `AgentDefinition`, `AgentData`, `AgentDeps`                                   | the definition surface (below)                                  |

The definitions entry point (`import from '@hames-ai/agents/agents'`) is
**server-only** — six registered agents plus three shared helpers
(`getGraphSchema`, the Neo4j few-shots, the title generator). Every module
calls core's `assertServerOnImport()` at load.

## Registering agents in your application

Your application decides how agents are presented and builds the one
`AgentDeps` object they share. The hames app, this repository's reference
host, does that in `app/src/lib/harness-client/`:

- `registry.server.ts` adds presentation — an `icon` and an `accent` colour —
  to each definition, and wraps its `(sessionId, deps)` factory so every agent
  gets the same `AgentDeps` object.
- `session.server.ts` builds that shared object (`agentDeps()`).
- `turn.server.ts` / `actions.server.ts` run turns — including choosing which
  set of models a conversation uses — and hand `agentDeps()` to the title
  generator.

```typescript
// How the hames app registers an agent (simplified from its registry.server.ts).
// `agentDeps` and `registerAgent` are the app's own functions; you write yours.
// The definition is spread in, and an icon and accent colour are added on top:
import type { AgentDefinition } from '@hames-ai/agents'
import { searchAgent } from '@hames-ai/agents/agents/search.server'

declare function agentDeps(): import('@hames-ai/agents').AgentDeps
declare function registerAgent(config: AgentDefinition & { icon: string; accent: string }): void
type AgentAccent = string

function overlay(def: AgentDefinition, icon: string, accent: AgentAccent) {
  return {
    ...def,
    icon,
    accent,
    createPatterns: (sessionId: string) => def.createPatterns(sessionId, agentDeps()),
  }
}
registerAgent(overlay(searchAgent, 'i-material-symbols-search', 'indigo'))
```

To present agents differently, add your own fields the same way; the
definitions carry no presentation of their own.

## Requirements: a TypeScript bundler

Like every `@hames-ai` package, this one **ships TypeScript source**: `main`
and every code target in `exports` is a `.ts` file, and there is no
`dist/`. Run it through something that compiles TypeScript — Vite, esbuild,
tsx, Bun. **Not** `node --experimental-strip-types`, which refuses to strip
types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and
not a plain `node dist/index.js`.
