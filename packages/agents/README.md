<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mknw/hames-playground/main/docs/images/hames-banner-wide-dark.png">
  <img src="https://raw.githubusercontent.com/mknw/hames-playground/main/docs/images/hames-banner-wide-light.png" alt="hames: supports of a harness to which its traces are fastened. The @hames-ai packages on npm: harness-patterns, harness-baml, agents, connectors, sandbox. hames app: where harness primitives become your integrated workspace." width="880">
</picture>

# @hames-ai/agents

[![npm](https://img.shields.io/npm/v/@hames-ai/agents?style=flat)](https://www.npmjs.com/package/@hames-ai/agents)
[![CI](https://img.shields.io/github/actions/workflow/status/mknw/hames-playground/ci.yml?branch=main&style=flat&label=CI)](https://github.com/mknw/hames-playground/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/mknw/hames-playground/github-code-scanning%2Fcodeql?branch=main&style=flat&label=CodeQL)](https://github.com/mknw/hames-playground/actions/workflows/github-code-scanning/codeql)
[![node](https://img.shields.io/node/v/@hames-ai/agents?style=flat)](https://nodejs.org)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue?style=flat)](./LICENSE)

## What this is

One ready-made agent definition, `general-next`, for a host application. It
chooses among Microsoft 365 work, Neo4j and web lookup, document retrieval,
planning, and an office sandbox. It is built from
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme)
and makes its model calls through
[`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme).
The host supplies a tool catalog, document store, sandbox and guards through
`AgentDeps`. The package also ships browser-safe graph, citation and transcript
helpers. Earlier agent exports were retired in #898; saved ids in the reference
app resolve to `general-next`.

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
host for all five packages: a self-hosted agent workspace whose agent is
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

The gateway's DuckDuckGo and fetch tools need no key. The reference app also
offers Exa's hosted `web_search_exa` and `web_fetch_exa` by default through a
server-side transport; an optional `EXA_API_KEY` gives it authenticated access.
Without one, Exa's documented keyless free rate limit applies. `EXA_TOOLS=off`
removes Exa only; see `app/.env.example`.

## Usage

### Quick start: inspect the shipped agent

The reference app wires the required sandbox, document backend and guards before
running a turn. This snippet shows the server-only definition and its metadata;
see [the app composition root](https://github.com/mknw/hames-playground/blob/main/app/src/lib/harness-client/registry.server.ts)
for the complete host wiring.

```typescript
import { generalNextAgent } from '@hames-ai/agents/agents/general-next.server'

console.log(generalNextAgent.id, generalNextAgent.name)
```

### How general-next is composed

`general-next` is the decision-loop agent, and the reference app's default: a new chat
opens on it. It replaced `general`, which was removed (see
[the changelog](https://github.com/mknw/hames-playground/blob/main/packages/agents/CHANGELOG.md) for the migration, and
[the decision-loop design](https://github.com/mknw/hames-playground/blob/main/docs/plan/decision-loop-agent.md)
for why `general` gave way). It requires `deps.withSandbox` and
`deps.createRedisBackend`, and accepts `deps.guards` — the host's guard
settings, from the `GUARD_*` operator switches (below) — plus
`deps.egressRoster` for the egress gate. It chooses among Microsoft 365 work, Neo4j/web lookup,
conversation-document retrieval and planning, then synthesizes once from the
orchestrator's guarded route records. Each guard declares its own options and
none is inherited: the office and info route guards declare an always-on fence
and a screen behind the guard gate, with a mode per tier. On the Anthropic tier
the screen runs on every external result and the gate is never asked; on the
self-deployed tier the gate is asked first and, in `'shadow'`, its answer is
recorded and the screen runs anyway, until an eval bar moves that tier to
`'gated'`. `deps.guards.screenMode` replaces that tier map when the host sets
it (validated at boot against these defaults; on the Anthropic tier only
`'off'` and `'always'` are accepted — `'gated'` or `'shadow'` there would send
the bodies the screen would have read to that tier's decisions host). A
deterministic finding always forces the screen, after
sanitization, so those neutralizations stay intact. The host's classifier
(`deps.guards.classifyIngress`) keeps the deployment's own content to the deterministic
pass. That is a screen call per
external office or info result, plus a gate call on the self-deployed tier. The documents route's guard declares the
fence and no screen, so retrieved hits get the deterministic pass only. The
orchestrator's loop sanitizes and screens nothing of its own: a route record
is capped, and the tool-result bodies it quotes keep the fence they arrived in. A screen outage inside a route is recorded and fails open. The web
route admits only its own and retriever
references, excluding sandbox-promoted documents, and pseudonymises inherited
content when the host supplies `deps.guards.pseudonymiseForWeb`. Without it —
the `GUARD_PSEUDONYMISE=off` switch, or no `guards` bag at all — the route is
composed without the wrapper, so earlier content reaches it as written rather
than withheld (boundary guards slice 5). The web route's outgoing calls are
judged by the egress gate (`deps.egressRoster`; `deps.guards.egressMode` sets
`filter` or `roster`). A supplied filter that cannot be built withholds earlier
content, and the egress gate refuses what it cannot judge. An unconfigured private decisions endpoint
produces a visible error without public fallback.

#### The `GUARD_*` operator switches

Eight environment variables set the guards this agent composes with: four
modes, which can only weaken a guard, three numbers, which can move it
either way, and the tenant's own document-host list, a deployment fact that
narrows one deterministic rule. They are read once at boot and validated
there. They set the
fields of
[`AgentDeps.guards`](#what-an-agent-definition-contains); a host that composes
guards in code sets the same fields directly:

| Variable                                 | Sets                                                                                                                                                                               | Values                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `GUARD_SCREEN`                           | the injection screen's mode on the self-deployed tier                                                                                                                              | `off` / `shadow` / `gated` / `always` |
| `GUARD_SCREEN_ANTHROPIC`                 | the screen's mode on the Anthropic tier (only the two modes that do not ask the gate)                                                                                              | `off` / `always`                      |
| `GUARD_EGRESS`                           | the egress gate's mode on every tier (`roster` vetoes on a directory match and asks no model)                                                                                      | `filter` / `roster`                   |
| `GUARD_PSEUDONYMISE`                     | the web route's input pseudonymiser (default `on`; `off` is its retirement switch)                                                                                                 | `on` / `off`                          |
| `GUARD_GATE_THRESHOLD`                   | τi, `gateThreshold`: the screen runs when the gate's probability is at or above it (default `0.15`; obeyed only by a `gated` screen)                                               | a number from 0 to 1                  |
| `GUARD_EGRESS_THRESHOLD`                 | τe, `egressThreshold`: an outgoing call is refused or asked about when the private mass is at or above it (default `0.3`)                                                          | a number from 0 to 1                  |
| `GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE` | the tripwire's N, `maxOutgoingRetriesPostTripwire`: refusal N + 1 on a route closes it for the turn (default `0`)                                                                  | a whole number, 0 or greater          |
| `GRAPH_DOCUMENT_HOSTS`                   | the tenant's own SharePoint/OneDrive hosts, `documentHosts`: a Graph result's own `webUrl` on one of these exact hostnames is exempt from `exfil-data-url`, and from no other rule | comma-separated exact hostnames       |

A mode below a tier's declared default, or a number looser than its default (a
threshold above it, an N above 0), warns at boot, naming what it loosens; an
unrecognised or out-of-range value refuses boot without echoing it. Unset, each
keeps today's default. The deterministic layers have no switch — one
deployment fact is the exception: `GRAPH_DOCUMENT_HOSTS` narrows one
deterministic rule (`exfil-data-url`) on one field, and empty means nothing is
exempt; a refused entry there is named in the error, not withheld.
The reference host reads the seven `GUARD_*` variables in
[`guard-config.server.ts`](https://github.com/mknw/hames-playground/blob/main/app/src/lib/inference/guard-config.server.ts)
and `GRAPH_DOCUMENT_HOSTS` in
[`document-hosts.server.ts`](https://github.com/mknw/hames-playground/blob/main/app/src/lib/harness-client/document-hosts.server.ts).

`general-next` also opts into optional memory. Only its final synthesis receives recalled
memory. `graph_file_ingest` is in general-next's own office list only when the host enables it; the executor refuses unless the host predicate positively allows it (the app: raw private run frame, `INFERENCE_TIERS=self_deployed`, no OpenRouter embedder). Turn-results materialisation stays disabled. It became the default agent on an owner
ruling (2026-10-27) rather than on the design's flip gate. See the
[decision-loop design](https://github.com/mknw/hames-playground/blob/main/docs/plan/decision-loop-agent.md).

These excerpts show how the shipped agents are built. Each definition's `createPatterns` composes patterns from
`@hames-ai/harness-patterns` with what your application supplies in
`AgentDeps`. The excerpts below are lifted from the shipped agents, and a test
in this repository compiles them against the package source, so they cannot
drift from the real signatures.

```typescript
// The agent's tools, grouped by namespace. You pass the grouping in: the
// package cannot guess which of your MCP tools are web tools. From
// an illustrative composition:
import { Tools } from '@hames-ai/harness-patterns/tools.server'
import type { AgentDeps } from '@hames-ai/agents'

declare const deps: AgentDeps
const toolSet = await Tools({ namespaces: deps.toolNamespaces })
```

```typescript
// A Neo4j tool loop: the shipped controller decides each query, and your
// optional `enrichNeo4jResult` post-processes each result. The context prefix
// tells the controller the graph is read-only and what to answer instead of a
// write; the loop shows it only the few-shots whose tool it holds, so the
// set's write example never reaches it. Illustrative composition:
import { simpleLoop, type ConfiguredPattern } from '@hames-ai/harness-patterns'
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import type { ToolSet } from '@hames-ai/harness-patterns'
import {
  NEO4J_FEW_SHOTS_DEFAULT,
  NEO4J_READ_ONLY_CONTEXT,
} from '@hames-ai/agents/agents/neo4j-fewshots.server'

function buildNeo4jRoute(
  deps: AgentDeps,
  tools: ToolSet,
  schema: string,
): ConfiguredPattern<AgentData> {
  const baml = bamlPatterns()
  const neo4jController = createLoopControllerAdapter(NEO4J_READ_ONLY_CONTEXT)
  return simpleLoop<AgentData>(neo4jController, tools.neo4j ?? [], {
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
// Illustrative composition:
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

The office route runs through the host's `withSandbox` wrapper and uses a
workspace shared with document retrieval. The document route uses the backend
provided as `createRedisBackend`. See `general-next.server.ts` for the exact
composition and guard placement.

### Registering agents in your application

Your application decides how agents are presented and builds the one
`AgentDeps` object they share. The hames app's version of this is described in
its [harness-client README](https://github.com/mknw/hames-playground/blob/main/app/src/lib/harness-client/README.md).

```typescript
// How the hames app registers an agent (simplified from its registry.server.ts).
// `agentDeps` and `registerAgent` are the app's own functions; you write yours.
// The definition is spread in, and an icon and accent colour are added on top:
import type { AgentDefinition } from '@hames-ai/agents'
import { generalNextAgent } from '@hames-ai/agents/agents/general-next.server'

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
registerAgent(overlay(generalNextAgent, 'i-material-symbols-route', 'indigo'))
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

| Agent          | Composition                                                     | Tools                                                         | Injection guard                                                                                                                            |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `general-next` | decisionLoop(office, info, retriever, think) → compactExecution | Microsoft 365, office sandbox, Neo4j/web/context7, Data Stash | per-route guards with their own fence and screen, and quoted tool bodies that keep their ingress fence; private web input pseudonymisation |

In the `general-next` row, `context7` is the MCP server that answers questions
about software libraries; _Data Stash_ is the uploaded-document store behind
`createRedisBackend`, described in the repository's
[Data Stash doc](https://github.com/mknw/hames-playground/blob/main/docs/DATA_STASH.md).

**Guardrail status.** `general-next` guards external tool results by route,
including Microsoft Graph, web and retrieved documents. The host's sandbox
wrapper also screens shell commands. Read the [general-next design](https://github.com/mknw/hames-playground/blob/main/docs/plan/decision-loop-agent.md)
for the route-specific policies.

## Configuration

### What an agent definition contains

The shape, simplified from `types.ts` (the source is the authority; the
`typescript` samples under Usage are compiled against it by a test in this
repository, and this excerpt omits a few further optional fields —
`memory`, `graphFileIngest`, `createDecisionDocuments`, `quoteMemoriesToDecider` — that `types.ts`
carries):

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
interface AgentData extends HarnessData, RouterData, SimpleLoopData, RetrieverData {
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
  // The guards' host settings: the injection screen's per-tier mode, the
  // egress gate's mode, the host's ingress classifier, the web-route
  // pseudonymiser. Built once at boot from the GUARD_* operator switches
  // above; absent, every guard keeps its per-tier default.
  guards?: AgentGuards
  // The egress gate's directory (who is who). Wiring, not a switch: the gate
  // reads it at run time, and no GUARD_* variable turns it on or off.
  egressRoster?: EgressRosterSource
}
```

#### What comes from where

| Concern                                                                       | Where it lives               | How it reaches the agent                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| Model calls: adapters, prompt templates                                       | `@hames-ai/harness-baml`     | imported directly by the factories                                                         |
| Patterns, event views, guard, tool calling                                    | `@hames-ai/harness-patterns` | imported directly                                                                          |
| Tool→namespace catalog (your MCP gateway's map)                               | your application             | `AgentDeps.toolNamespaces` — required                                                      |
| Neo4j tool-result enrichment                                                  | your application             | `AgentDeps.enrichNeo4jResult`                                                              |
| Document search backend (uploaded files)                                      | your application             | `AgentDeps.createRedisBackend`                                                             |
| Sandbox wrapper (built on `@hames-ai/sandbox`)                                | your application             | `AgentDeps.withSandbox`                                                                    |
| Guard settings (screen mode per tier, egress mode, classifier, pseudonymiser) | your application             | `AgentDeps.guards` — composed from the [`GUARD_*` switches](#the-guard_-operator-switches) |
| The egress gate's directory (who is who)                                      | your application             | `AgentDeps.egressRoster`                                                                   |
| Which model each role uses (your policy)                                      | your application             | `AgentDeps.clientOverride`                                                                 |
| Saving conversation titles; opting out of caching                             | your application             | `AgentDeps.persistTitle` / `.doNotCachePatterns`                                           |
| Icons + accent colours                                                        | your application             | added when you register the agent (see Usage)                                              |

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

| Export                                                              | What it is                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `extractGraphElements`, `extractGraphFromResult`                    | ContextEvent/tool-result → `GraphElement[]` for graph rendering |
| `isEdgeElement`, `isNodeElement`, `isNeo4jGraphResult`              | shape guards over extracted elements                            |
| `extractReferences`, `referencesForDoc`                             | retriever citations out of the event stream                     |
| `errorBubble`, `warningBubble`, `replayMessages`, `ReplayedMessage` | serialized context → minimal chat transcript                    |
| `GraphElement`, `OpenReferenceTarget`                               | the shared data types                                           |
| `AgentDefinition`, `AgentData`, `AgentDeps`                         | the definition types (see Configuration)                        |

The definitions entry point (`import from '@hames-ai/agents/agents'`) is
**server-only** — `generalNextAgent` plus three shared helpers
(`getGraphSchema`, the Neo4j few-shots, the title generator). Every module
calls core's `assertServerOnImport()` at load.
