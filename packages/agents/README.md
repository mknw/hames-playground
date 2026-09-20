# @hames/agents

Ready-made harness compositions for
[@hames/harness-patterns](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns):
nine agent definitions built on the framework's composable patterns, plus the
client-safe extraction/replay helpers the reference UI consumes. The BAML
backing (prompt templates, role→client resolution, adapter factories) lives in
the companion package
[@hames/harness-baml](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml).

The package owns **definitions**, not composition. It carries no UI framework
concepts (no SolidJS, no UnoCSS, no Ark UI) and no host policy — everything
app-side is either imported from `@hames/harness-baml` directly or injected
through one `AgentDeps` bag.

## Surface

The root barrel (`import from '@hames/agents'`) is **client-safe** — UI
consumers import it and drag nothing server-side:

| Export                                                                        | What it is                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `extractGraphElements`, `extractGraphFromResult`                              | ContextEvent/tool-result → `GraphElement[]` for graph rendering |
| `isEdgeElement`, `isNodeElement`, `isNeo4jGraphResult`, `isMemoryGraphResult` | shape guards over extracted elements                            |
| `extractReferences`, `referencesForDoc`                                       | retriever citations out of the event stream                     |
| `errorBubble`, `replayMessages`, `ReplayedMessage`                            | serialized context → minimal chat transcript                    |
| `GraphElement`, `OpenReferenceTarget`                                         | the shared data types                                           |
| `AgentDefinition`, `AgentData`, `AgentDeps`                                   | the definition surface (below)                                  |

The definitions barrel (`import from '@hames/agents/agents'`) is
**server-only** — six registered agents plus three shared helpers
(`getGraphSchema`, the Neo4j few-shots, the title generator). Every module
calls core's `assertServerOnImport()` at load.

## The definition surface

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
// (bamlPatterns, the adapter factories) are imported from @hames/harness-baml
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

| Concern                                             | Where it lives            | How it reaches the agent                                  |
| --------------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| Pattern implementations, adapters, prompt templates | `@hames/harness-baml`     | imported directly by the factories                        |
| Patterns, event views, guard, tool transport        | `@hames/harness-patterns` | imported directly                                         |
| Tool→namespace catalog (this deployment's MCP map)  | host                      | `AgentDeps.toolNamespaces` — required; owner ruling B-iii |
| Neo4j tool-result enrichment                        | host                      | `AgentDeps.enrichNeo4jResult`                             |
| Data Stash retrieval backend                        | host                      | `AgentDeps.createRedisBackend`                            |
| Sandbox wrapper (containment posture, SD-19)        | host                      | `AgentDeps.withSandbox`                                   |
| Inference-tier routing (app policy)                 | host                      | `AgentDeps.clientOverride`                                |
| Title persistence, pattern-cache refusal            | host                      | `AgentDeps.persistTitle` / `.doNotCachePatterns`          |
| Icons + accent colours                              | host                      | overlay at registration (below)                           |

## Composing an agent

Each definition's `createPatterns` composes the framework's patterns with the
host's supplies. The fences are compiled against the package source by the
docs-pins test, so they cannot drift from the real signatures.

```typescript
// The tool surface, from the injected catalog — required, not defaulted
// (owner ruling B-iii). Lifted from `search.server.ts`:
import { Tools } from '@hames/harness-patterns/tools.server'
import type { AgentDeps } from '@hames/agents'

declare const deps: AgentDeps
const toolSet = await Tools({ namespaces: deps.toolNamespaces })
```

```typescript
// A tool loop on the controller adapter, with the injected enricher —
// lifted from `search.server.ts`:
import { simpleLoop, type ConfiguredPattern } from '@hames/harness-patterns'
import { bamlPatterns, createLoopControllerAdapter } from '@hames/harness-baml'
import type { AgentData, AgentDeps } from '@hames/agents'
import type { ToolSet } from '@hames/harness-patterns'
import { NEO4J_FEW_SHOTS_DEFAULT } from '@hames/agents/agents/neo4j-fewshots.server'

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
} from '@hames/harness-patterns'
import type { AgentData } from '@hames/agents'
import type { ToolSet } from '@hames/harness-patterns'
import { bamlPatterns } from '@hames/harness-baml'

declare const neo4jPattern: import('@hames/harness-patterns').ConfiguredPattern<AgentData>
declare const webPattern: import('@hames/harness-patterns').ConfiguredPattern<AgentData>

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

```typescript
// A session-persistent sandbox loop — the wrapper is INJECTED (SD-19: the
// containment posture stays app-side and is supplied, not carried). Lifted
// from `sandbox-session.server.ts`:
import type { AgentData, AgentDeps } from '@hames/agents'
import type { ConfiguredPattern } from '@hames/harness-patterns'

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
import { retriever, type ConfiguredPattern, type RetrieverBackend } from '@hames/harness-patterns'
import type { AgentData } from '@hames/agents'
import { bamlPatterns } from '@hames/harness-baml'

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

## The agent catalog

| Agent               | Composition                                                   | Tools                            | Guard coverage                                                             |
| ------------------- | ------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `search`            | router → routes(neo4j loop, web loop) → compactExecution      | neo4j-cypher, web_search, fetch  | web route guarded; neo4j trusted (our own graph)                           |
| `retriever-agent`   | router → routes(retriever, neo4j, web) → compactExecution     | neo4j-cypher, web_search, fetch  | web + retriever routes guarded together (ingested documents are untrusted) |
| `microsoft-365`     | explicit graph-tool allowlist loop → compactExecution         | graph (app-side, per-user token) | whole graph loop guarded (mail/files are attacker-authored)                |
| `general`           | planner → simpleLoop(tools.all) → compactExecution            | everything                       | **no guard** — known, filed gap (#206)                                     |
| `sandbox-session`   | compactIntent → withSandbox(actorCritic) → compactExecution   | in-VM `sandbox_*`                | no guard (in-VM results pass callTool)                                     |
| `flavoured-sandbox` | router → routes(base, image, data, office) → compactExecution | in-VM `sandbox_*`                | no guard on any of the four routes                                         |

The guard coverage is pinned by the app's inventory test
(`injection-guard-coverage-inventory.test.ts`) — a guard added or dropped
surfaces as a diff a reviewer must look at. The two layers' opposite failure
policies (the optional LLM screen fails open, the deterministic layer does not)
are an OPEN owner decision, not settled by this package (SD-7).

## What the host composes on top

The reference app (`app/src/lib/harness-client/`) keeps the composition root:

- `registry.server.ts` overlays presentation — `AgentConfig extends
AgentDefinition` with `icon: string` and `accent: AgentAccent`, supplied per
  registration next to the palette, and wraps each definition's
  `(sessionId, deps)` factory with THE one `AgentDeps` bag.
- `session.server.ts` builds that bag (`agentDeps()`) and aliases the app's
  `SessionData` onto `AgentData`.
- `turn.server.ts` / `actions.server.ts` run turns, the tier scope, the wake,
  and hand `agentDeps()` to the title generator's entry points.

```typescript
// The app's overlay, one site per agent (abridged from registry.server.ts) —
// `AgentConfig` / `AgentAccent` / `agentDeps` / `registerAgent` are the host's;
// the definition and the icon choice are what a consumer re-makes:
import type { AgentDefinition } from '@hames/agents'
import { searchAgent } from '@hames/agents/agents/search.server'

declare function agentDeps(): import('@hames/agents').AgentDeps
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
