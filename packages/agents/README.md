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
pnpm add @hames-ai/agents @hames-ai/harness-baml @hames-ai/harness-patterns @hames-ai/connectors
```

`@hames-ai/harness-baml` and `@hames-ai/harness-patterns` are peer
dependencies, so you add them yourself. `@hames-ai/connectors` is not a
dependency of this package, but it supplies `mcpNamespace`, the tool-namespace
map the example below passes in. Running an agent calls Anthropic
models, so set `ANTHROPIC_API_KEY` in the environment; the model clients in
`@hames-ai/harness-baml` read it.

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

The quick start below also needs a Neo4j graph database with data in it. These
three commands start the MCP server and Neo4j (user `neo4j`, password `password`,
already connected to each other) and load a small demo graph:

```bash
git clone https://github.com/mknw/hames-playground.git && cd hames-playground
docker compose up -d
./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher
```

The web tools (`web_search`, `fetch`) need no key.

## Usage

### Quick start: run the search agent once

Build a shipped agent's patterns, compose them into a harness, and ask one
question. It runs `search`, one of the three agents the
[Warning under Agent catalog](#agent-catalog) is about: with writes enabled it
can change the Neo4j you give it (they ship off).

> **Needs:** an Anthropic API key in `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)), and the MCP server and seeded Neo4j from the [three commands under Install](#install).

```typescript
import { harness } from '@hames-ai/harness-patterns'
import { registerToolNamespaces } from '@hames-ai/harness-patterns/tools.server'
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import { searchAgent } from '@hames-ai/agents/agents/search.server'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'

// Which group ("namespace") each MCP tool belongs to, such as `web` or `neo4j`.
// The map is used twice, for two different readers. Registered here, it is what
// the agent's injection guard (which neutralizes instructions hidden in web
// content) uses to find the `web` tools; without it the guard refuses to build.
registerToolNamespaces(mcpNamespace)

// In AgentDeps it is what the agent's own `Tools()` call uses to sort its tools
// into `tools.web` and `tools.neo4j`. It is the one required field of AgentDeps.
const deps: AgentDeps = { toolNamespaces: mcpNamespace }

const sessionId = 'session-1'
const patterns = await searchAgent.createPatterns(sessionId, deps)
const result = await harness<AgentData>(...patterns)(
  'Which technologies in the knowledge graph are frameworks?',
  sessionId,
)
console.log(result.response)
```

The MCP server has to run the MCP servers the agent lists in `servers`
(`neo4j-cypher`, `web_search`, `fetch`); the one this repository ships does, as
configured in
[configs/mcp-config.yaml](https://github.com/mknw/hames-playground/blob/main/configs/mcp-config.yaml).

### How the shipped agents are composed

These excerpts show how the shipped agents are built. Each definition's `createPatterns` composes patterns from
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

> **Note.** The injection guard checks, when it is built, that every namespace it is told to
> guard is produced by at least one tool in the `catalog` you pass, and refuses to
> build if one is not (while the MCP server is unreachable it warns instead). It
> works out a tool's namespace in this order: the
> `namespaceFor` of a transport registered with `registerTransport`, then any map
> registered with `registerToolNamespaces`, then the tool's name (`web_search`
> becomes `web`). So
> `registerToolNamespaces` is needed only when neither the transport nor the name
> gives the namespace, as with the MCP server this repository ships, whose web tools
> are named `search` and `fetch`. `Tools({ namespaces })` is a separate step: it sorts
> the listed tools into the `tools.web`, `tools.neo4j` groups that you hand to
> patterns, and the guard does not read it.
> An agent with no untrusted namespaces writes `namespaces: []` explicitly.

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

### Registering agents in your application

Your application decides how agents are presented and builds the one
`AgentDeps` object they share. The hames app's version of this is described in
its [harness-client README](https://github.com/mknw/hames-playground/blob/main/app/src/lib/harness-client/README.md).

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

## Agent catalog

Each agent is a chain of patterns from `@hames-ai/harness-patterns`, listed in
order under **Composition**; each name is a pattern documented in the
[harness-patterns README](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme).
**Injection guard** says which tool results pass through `withInjectionGuard`,
which neutralizes instructions hidden in untrusted content (a web page, an
email) before a model reads it.

| Agent               | Composition                                                      | Tools                                                   | Injection guard                                                                          |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `search`            | router → routes(neo4j loop, web loop) → compactExecution         | neo4j-cypher, web_search, fetch                         | web route guarded; neo4j route not guarded (see the Warning below)                       |
| `retriever`         | router → routes(retriever, neo4j, web) → compactExecution        | neo4j-cypher, web_search, fetch                         | web namespace + retriever exact-name guarded together (ingested documents are untrusted) |
| `microsoft-365`     | allowlist loop over the Microsoft Graph tools → compactExecution | Microsoft Graph (the Microsoft 365 API), per-user token | whole Microsoft Graph loop guarded (mail and files can be written by anyone)             |
| `general`           | planner → simpleLoop(tools.all) → compactExecution               | everything                                              | not guarded yet (below)                                                                  |
| `sandbox-session`   | compactIntent → withSandbox(actorCritic) → compactExecution      | in-container `sandbox_*`                                | not on tool results yet; shell commands are screened (below)                             |
| `flavoured-sandbox` | router → routes(base, image, data, office) → compactExecution    | in-container `sandbox_*`                                | not on tool results yet, on any route; shell commands are screened (below)               |

**Guardrail status.** Two guards ship today. The injection guard covers the
tool results marked in the table above, and the two sandbox agents also get
`@hames-ai/sandbox`'s shell-command screen, which checks every `sandbox_bash`
command against a denylist before it runs. Guardrails beyond these two are in
active development; the Warning below has the status and what to do meanwhile.

> **Warning:** Guardrails for these routes are in active development, and a
> release is coming ([tracking issue](https://github.com/mknw/hames-playground/issues/391)). Until it ships, `search`,
> `retriever` and `general` are not meant for production use. Two things
> keep your data safe while you try them:
>
> - **Use throwaway data.** Point them at a fresh Neo4j loaded with the demo graph
>   (`./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher`, as under
>   [Install](#install)), not at data you need.
> - **Writes are off by default.** This repository ships `read_only: true` for
>   `neo4j-cypher` in
>   [configs/mcp-config.yaml](https://github.com/mknw/hames-playground/blob/main/configs/mcp-config.yaml). The pinned server, `mcp-neo4j-cypher` 0.5.0, reads it as
>   `NEO4J_READ_ONLY` and then does not register its write tool,
>   `write_neo4j_cypher`; any value other than `true` or `false` stops it from
>   starting. To let the agents write, set it to `false` and recreate the gateway
>   (`docker compose up -d --force-recreate mcp-gateway`; a plain `up -d` leaves
>   it running on the old file). The trade-off: only then can they write into the
>   graph, such as adding web results they found earlier, which is what
>   `withReferences` was built for
>   ([design doc](https://github.com/mknw/hames-playground/blob/main/docs/harness-patterns/with-references.md)).
>
> Both protect the graph, not the network. A query can still make the database
> fetch URLs through APOC's load procedures: the server's read tool refuses only
> queries that look like writes, and `CALL apoc.load.json('http://…')` does not.
> To close that too, run them against a Neo4j without APOC, or one whose network
> reaches nothing you care about. The demo graph needs no APOC
> (`neo4j_dumps/seed-data.cypher` is plain Cypher), but these agents read the
> schema through the MCP server's `get_neo4j_schema` tool, which runs
> `CALL apoc.meta.schema(...)` and fails on a Neo4j without APOC. The agents then
> log `graph schema unavailable` and run without the schema
> ([graph-schema.server.ts](https://github.com/mknw/hames-playground/blob/main/packages/agents/agents/graph-schema.server.ts)). On `docker compose`, the Neo4j shares a network
> with the MCP server, Postgres and Redis.
>
> Why: these three agents let the model write Cypher and run it through the MCP
> server's `neo4j-cypher` tools. The one this repository ships is read-only by
> default (`read_only: true`), but a deployer can set it to `false`, and then
> their Neo4j loops may call `write_neo4j_cypher`, which the agents' own examples
> teach; `general` reaches every tool. None of the three
> guards its Neo4j route, and nothing asks for approval before a write. So, with
> writes on, what these agents read, whether a person types it or `general` and the web route fetch
> it, can try to steer them into changing or deleting your graph (`DETACH DELETE`
> included). It can also try to make the database fetch URLs: the Neo4j this
> repository ships installs APOC (`NEO4J_PLUGINS=["apoc", "n10s"]` in [docker-compose.yaml](https://github.com/mknw/hames-playground/blob/main/docker-compose.yaml)),
> and with APOC's load procedures enabled (the default once APOC is installed) a
> query such as `CALL apoc.load.json('http://…')` makes the database fetch that
> URL. See also [#241](https://github.com/mknw/hames-playground/issues/241) and the Warning on
> [running your own Cypher query](https://github.com/mknw/hames-playground/tree/main/packages/connectors#run-your-own-cypher-query)
> in `@hames-ai/connectors`.

## Configuration

### What an agent definition contains

The shape, simplified from `types.ts` (the source is the authority; the
`typescript` samples under Usage are compiled against it by a test in this
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

#### What comes from where

| Concern                                           | Where it lives               | How it reaches the agent                         |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| Model calls: adapters, prompt templates           | `@hames-ai/harness-baml`     | imported directly by the factories               |
| Patterns, event views, guard, tool calling        | `@hames-ai/harness-patterns` | imported directly                                |
| Tool→namespace catalog (your MCP gateway's map)   | your application             | `AgentDeps.toolNamespaces` — required            |
| Neo4j tool-result enrichment                      | your application             | `AgentDeps.enrichNeo4jResult`                    |
| Document search backend (uploaded files)          | your application             | `AgentDeps.createRedisBackend`                   |
| Sandbox wrapper (built on `@hames-ai/sandbox`)    | your application             | `AgentDeps.withSandbox`                          |
| Which model each role uses (your policy)          | your application             | `AgentDeps.clientOverride`                       |
| Saving conversation titles; opting out of caching | your application             | `AgentDeps.persistTitle` / `.doNotCachePatterns` |
| Icons + accent colours                            | your application             | added when you register the agent (see Usage)    |

## Reference

The patterns each agent is built from, and their options:
[GUIDE.md](https://github.com/mknw/hames-playground/blob/main/packages/harness-patterns/GUIDE.md)
and [SPEC.md](https://github.com/mknw/hames-playground/blob/main/packages/harness-patterns/SPEC.md)
in `@hames-ai/harness-patterns`. The tutorial on wiring agents into your own
application, [Wiring a host](https://github.com/mknw/hames-playground/blob/main/docs/tutorials/wiring-a-host.md), is still a
stub; until it is written,
[Hosting the harness](https://github.com/mknw/hames-playground/blob/main/docs/tutorials/hosting-the-harness.md) shows how to
run a turn from your own code.
Each agent's source is in
[`agents/`](https://github.com/mknw/hames-playground/tree/main/packages/agents/agents).

### Exports

The root entry point (`import from '@hames-ai/agents'`) is **browser-safe** —
front-end code can import it without pulling in anything server-side:

| Export                                                                        | What it is                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `extractGraphElements`, `extractGraphFromResult`                              | ContextEvent/tool-result → `GraphElement[]` for graph rendering |
| `isEdgeElement`, `isNodeElement`, `isNeo4jGraphResult`, `isMemoryGraphResult` | shape guards over extracted elements                            |
| `extractReferences`, `referencesForDoc`                                       | retriever citations out of the event stream                     |
| `errorBubble`, `replayMessages`, `ReplayedMessage`                            | serialized context → minimal chat transcript                    |
| `GraphElement`, `OpenReferenceTarget`                                         | the shared data types                                           |
| `AgentDefinition`, `AgentData`, `AgentDeps`                                   | the definition types (see Configuration)                        |

The definitions entry point (`import from '@hames-ai/agents/agents'`) is
**server-only** — six registered agents plus three shared helpers
(`getGraphSchema`, the Neo4j few-shots, the title generator). Every module
calls core's `assertServerOnImport()` at load.
