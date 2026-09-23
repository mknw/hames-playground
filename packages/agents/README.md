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

## Which package do you need?

Five packages that work together. The first is the foundation; add the others
for what they do.

| If you want to…                                                                      | Use                                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| build an agent out of composable pieces — tool loops, routers, planners              | [`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme) |
| get typed model calls with the prompts already written                               | [`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)         |
| use a ready-made agent                                                               | [`@hames-ai/agents`](https://github.com/mknw/hames-playground/tree/main/packages/agents#readme)                     |
| use Microsoft 365 or Neo4j from an agent, or a ready tool catalog for an MCP gateway | [`@hames-ai/connectors`](https://github.com/mknw/hames-playground/tree/main/packages/connectors#readme)             |
| run agent-written code in a container                                                | [`@hames-ai/sandbox`](https://github.com/mknw/hames-playground/tree/main/packages/sandbox#readme)                   |

## See it running

The [hames app](https://github.com/mknw/hames-playground) is the reference
host for all five packages: a self-hosted agent workspace whose agents are
built from them, with every step of every run visible in its UI. Its
[Quickstart](https://github.com/mknw/hames-playground#quickstart) runs it
locally with Docker and pnpm.

## Agent catalog

Each agent is a chain of patterns from `@hames-ai/harness-patterns`, listed in
order under **Composition**. **Guard coverage** says which tool results pass
through the injection guard (`withInjectionGuard`), which neutralizes
instructions hidden in untrusted content before a model reads it.

| Agent               | Composition                                                   | Tools                           | Guard coverage                                                                           |
| ------------------- | ------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `search`            | router → routes(neo4j loop, web loop) → compactExecution      | neo4j-cypher, web_search, fetch | web route guarded; neo4j route trusted (a graph you control)                             |
| `retriever-agent`   | router → routes(retriever, neo4j, web) → compactExecution     | neo4j-cypher, web_search, fetch | web namespace + retriever exact-name guarded together (ingested documents are untrusted) |
| `microsoft-365`     | explicit graph-tool allowlist loop → compactExecution         | Microsoft Graph, per-user token | whole graph loop guarded (mail/files are attacker-authored)                              |
| `general`           | planner → simpleLoop(tools.all) → compactExecution            | everything                      | not guarded yet — see guardrail status below                                             |
| `sandbox-session`   | compactIntent → withSandbox(actorCritic) → compactExecution   | in-VM `sandbox_*`               | not guarded yet — see guardrail status below                                             |
| `flavoured-sandbox` | router → routes(base, image, data, office) → compactExecution | in-VM `sandbox_*`               | not guarded yet, on any of its four routes — see guardrail status below                  |

**Guardrail status.** The injection guard is the only guard these agents carry
today; guardrails beyond it are in active development —
[status and design](https://github.com/mknw/hames-playground/issues/242).

This column is pinned by a test in this repository
(`app/src/__tests__/lib/harness-client/agents/injection-guard-coverage-inventory.test.ts`),
so a guard added or dropped shows up as a diff a reviewer must look at. The
guard has two layers with opposite failure policies — the optional LLM screen
lets content through if the screen itself fails, the deterministic layer does
not — and which of the two should win is an open decision, not settled by this
package.

## What an agent definition contains

The shape (illustrative — the compiled source is the record; the fences below
that make API calls are compile-checked against the package by the docs-pins
test):

```
// What a ready-made agent IS — data only, no presentation:
interface AgentDefinition {
  id: string
  name: string
  description: string
  /** The empty-conversation greeting — required, so a new agent's greeting is
   *  a compile error, not someone else's wrong sentence. */
  welcome: string
  servers: string[]
  createPatterns: (sessionId: string, deps: AgentDeps) => Promise<ConfiguredPattern<AgentData>[]>
}

// The composite the patterns carry through the context:
interface AgentData
  extends HarnessData, RouterData, SimpleLoopData, RetrieverData, WithApproval {
  response?: string
  [key: string]: unknown
}

// What the HOST supplies per agent — ONLY app-side things. The BAML pieces
// (bamlPatterns, the adapter factories) are imported from @hames-ai/harness-baml
// directly, not injected:
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

### What is injected vs imported vs overlaid

| Concern                                         | Where it lives               | How it reaches the agent                         |
| ----------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| Model calls: adapters, prompt templates         | `@hames-ai/harness-baml`     | imported directly by the factories               |
| Patterns, event views, guard, tool transport    | `@hames-ai/harness-patterns` | imported directly                                |
| Tool→namespace catalog (your MCP gateway's map) | your application             | `AgentDeps.toolNamespaces` — required            |
| Neo4j tool-result enrichment                    | your application             | `AgentDeps.enrichNeo4jResult`                    |
| Document-retrieval backend                      | your application             | `AgentDeps.createRedisBackend`                   |
| Sandbox wrapper (built on `@hames-ai/sandbox`)  | your application             | `AgentDeps.withSandbox`                          |
| Which model each role uses (your policy)        | your application             | `AgentDeps.clientOverride`                       |
| Title persistence, pattern-cache refusal        | your application             | `AgentDeps.persistTitle` / `.doNotCachePatterns` |
| Icons + accent colours                          | your application             | added when you register the agent (below)        |

## Composing an agent

Each definition's `createPatterns` composes patterns from
`@hames-ai/harness-patterns` with what your application supplies in
`AgentDeps`. The excerpts below are lifted from the shipped agents, and a test
in this repository compiles them against the package source, so they cannot
drift from the real signatures.

```typescript
// The tool surface, from the injected catalog — required, not defaulted
// (owner ruling B-iii). Lifted from `search.server.ts`:
import { Tools } from '@hames-ai/harness-patterns/tools.server'
import type { AgentDeps } from '@hames-ai/agents'

declare const deps: AgentDeps
const toolSet = await Tools({ namespaces: deps.toolNamespaces })
```

```typescript
// A tool loop on the controller adapter, with the injected enricher —
// lifted from `search.server.ts`:
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
// Routes dispatched by intent classification, the web route guarded — the
// guard declaration TRAVELS WITH THE AGENT (it is the agent's threat model,
// not the transport's). Lifted from `search.server.ts`:
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
> **refuses to build** if nothing in it produces the namespace (#242 item 4).
> The usual cause: the tool→namespace resolver was never registered. Call
> `registerToolNamespaces(mcpNamespace)` once at boot — the deployment's map
> ships in `@hames-ai/connectors/mcp-catalog` — or supply your own resolver the
> same way. An agent with no untrusted namespaces writes `namespaces: []`
> explicitly.

```typescript
// A session-persistent sandbox loop — the wrapper is INJECTED (SD-19: the
// containment posture stays app-side and is supplied, not carried). Lifted
// from `sandbox-session.server.ts`:
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns'

declare const loop: ConfiguredPattern<AgentData>

function sandboxIt(deps: AgentDeps, sessionId: string): ConfiguredPattern<AgentData> {
  // The injected wrapper is required by this agent — a missing one is a
  // misconfigured bag, so guard-and-throw rather than degrade silently
  // (exactly what `sandbox-session.server.ts` does):
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
// A retrieval route over the injected Data Stash backend — lifted from
// `retriever-agent.server.ts`:
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

- `registry.server.ts` overlays presentation — `AgentConfig extends
AgentDefinition` with `icon: string` and `accent: AgentAccent`, supplied per
  registration next to the palette, and wraps each definition's
  `(sessionId, deps)` factory with THE one `AgentDeps` bag.
- `session.server.ts` builds that bag (`agentDeps()`) and aliases the app's
  `SessionData` onto `AgentData`.
- `turn.server.ts` / `actions.server.ts` run turns (choosing the model tier and,
  on the self-hosted tier, waking its GPU endpoint first) and hand `agentDeps()` to the
  title generator's entry points.

```typescript
// The app's overlay, one site per agent (abridged from registry.server.ts) —
// `AgentConfig` / `AgentAccent` / `agentDeps` / `registerAgent` are the host's;
// the definition and the icon choice are what a consumer re-makes:
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

A consumer that wants different presentation overlays its own fields the same
way — the definitions carry none.

## No build step

Like every `@hames-ai` package, this one **ships TypeScript source**: `main` and
every code target in `exports` is a `.ts` file (`./package.json` is the one
non-code entry), there is no `dist/`, and `pnpm pack` is the whole publish
pipeline. Consumers are **TS-bundler consumers** — a project whose bundler or
runtime compiles TypeScript: Vite/vinxi, esbuild, tsx, Bun. **Not**
`node --experimental-strip-types`, which refuses to strip types under
`node_modules` — exactly where an installed package lives
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on Node v22.21.1). A
plain `node dist/index.js` consumer is not supported either, deliberately: a
build step would make the published artefact different from the source every
test in this repo runs against.
