# @hames-ai/connectors

## What this is

Connections from an agent built with
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme)
to outside systems: nine Microsoft Graph tools that let an agent read the
signed-in user's Microsoft 365 mail, calendar, files and profile; a client for
the Neo4j graph database, with read queries and graph-editing operations; and a
lookup table that sorts an MCP gateway's tool names into _namespaces_ — named
groups of tools, such as `web` or `neo4j`, that a pattern or the injection
guard can refer to. Everything that touches identity stays with your
application: the signed-in user, their access tokens and where files are
stored are passed in, never held by the package.

### Install

```bash
pnpm add @hames-ai/connectors @hames-ai/harness-patterns
```

`@hames-ai/harness-patterns` is a peer dependency, so you add it yourself.
`neo4j-driver` comes with this package. Nothing here calls a language model,
so no API key is needed.

This package ships TypeScript source, not compiled JavaScript, so run it through
something that compiles TypeScript: Vite (or vinxi), esbuild, tsx or Bun. Plain
`node` cannot import it, because Node refuses to strip types from files under
`node_modules`.

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

## Usage: query Neo4j

Configure the driver once, then run read queries.

```typescript
import { configureNeo4j } from '@hames-ai/connectors/neo4j/client'
import { runManualCypher } from '@hames-ai/connectors/neo4j/queries'

declare const password: string

// Required: nothing reads connection settings from the environment for you.
configureNeo4j({ url: 'bolt://localhost:7687', user: 'neo4j', password })

const result = await runManualCypher('MATCH (p:Person) RETURN p.name LIMIT 5')
console.log(result.raw)
```

Until `configureNeo4j` runs, the first query fails with
`Neo4jNotConfiguredError`. Queries are read-only: one containing a write clause
is refused (`result.success` is `false`, with the reason in `result.error`),
and the session itself is opened in READ mode.

`result.graphUpdate` also carries the same rows as nodes and edges for
[Cytoscape.js](https://js.cytoscape.org), a graph-drawing library, in case you
want to render them.

## Going further: give an agent the Microsoft 365 tools

`registerGraphConnectorTools` adds nine tools an agent can call as the
signed-in user: today's calendar, recent mail and attachments, the user's
profile, and searching, listing and importing OneDrive/SharePoint files. They
live in a small in-process tool registry, which you then make visible to every
pattern:

```typescript
import { createAppToolRegistry } from '@hames-ai/connectors/app-tools/registry'
import {
  registerGraphConnectorTools,
  type GraphFetchFn,
} from '@hames-ai/connectors/graph/graph-tools.server'
import { registerTransport } from '@hames-ai/harness-patterns/tool-transport.server'

// 1. Who is asking. Return the signed-in user's id for the current request
//    (for example from your session middleware), or null when there is none.
declare function currentUserId(): string | null
// 2. A Microsoft Graph request made with that user's delegated token, which your
//    application acquires (for example with MSAL). The package never sees a token.
declare const graphFetch: GraphFetchFn

const registry = createAppToolRegistry({
  resolveContext: { userId: currentUserId, sessionId: () => null },
})

registerGraphConnectorTools({
  registerAppTool: registry.registerAppTool,
  graphFetch,
  // 3 and 4 are used only by the file-import tool (`graph_file_ingest`), which
  // copies a file into your document store. With these stubs that one tool fails
  // with a clear error, and the other eight work normally.
  content: {
    conversionEnabled: () => false,
    isConvertible: () => false,
    guessMimeType: () => 'application/octet-stream',
    isTextMime: (mimeType) => mimeType.startsWith('text/'),
  },
  stash: {
    loadStore: async () => {
      throw new Error('file import is not configured')
    },
    ingest: async () => undefined,
  },
})

// Route calls for these tools to the registry, grouped under the `graph` namespace.
registerTransport({
  id: 'app-tools',
  ownsTool: (name) => registry.hasAppTool(name),
  callTool: (name, args) => registry.runAppTool(name, args),
  listTools: async () => registry.appToolDescriptions(),
  namespaceFor: (name) => registry.appToolNamespace(name) ?? undefined,
})
```

After this, `Tools()` from `@hames-ai/harness-patterns` lists the tools under
`tools.graph` (even when no MCP gateway is reachable), and any loop can be given
them. The ready-made `microsoft-365` agent in `@hames-ai/agents` calls these
tools.

## What the four suppliers are, and why you pass them in

| Supplier         | What it is                                                                                                | Why the package cannot default it                                         | Smallest stub                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| `resolveContext` | two functions returning the current user id and conversation id                                           | only your application knows who is signed in                              | `{ userId: () => 'me', sessionId: () => null }` |
| `graphFetch`     | `(userId, path, init?) => Promise<unknown>`, a Graph call with that user's token                          | tokens and sign-in belong to your application; the package never sees one | none — without it no Graph tool can work        |
| `content`        | four small functions that classify a downloaded file (MIME type, text or not, convertible to text or not) | how you convert and store documents is yours                              | the object in the example above                 |
| `stash`          | `loadStore()` and `ingest()`: where an imported file is saved, and a hook to index it                     | the document store is yours                                               | the object in the example above                 |

Every supplier is **required**: a missing one throws when you call the factory,
not later on the turn that first needs it. That is why the stubs exist.

## Tool namespaces for an MCP gateway

A _namespace_ is a named group of tools, such as `web` or `neo4j`, that a
pattern or the injection guard refers to instead of listing tool names.
`mcpNamespace(toolName)` is a lookup table from tool names to namespaces for
the MCP servers (servers that expose tools over the Model Context Protocol)
that this repository's own gateway runs. It is a good starting point if your
gateway runs the same servers. If yours differs, write your own
`(toolName) => string | undefined` function; either way, pass it to
`registerToolNamespaces` and `Tools({ namespaces })` in
`@hames-ai/harness-patterns`.

## Exports

| Subpath                              | What lives there                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (root entry point)               | browser-safe exports only: `mcpNamespace` / `MCP_TOOL_CATALOG`, the Neo4j → Cytoscape.js projection `transformNeo4jToCytoscape` / `parseNeo4jResults`          |
| `./neo4j/client`                     | `configureNeo4j({ url, user, password })` + the driver singleton — **explicit-config-only**: unset config is a named error at first use, never an env fallback |
| `./neo4j/queries`                    | the identity-free read ops (`getSchema`, `runManualCypher`, …) — every session opened in READ mode                                                             |
| `./neo4j/graph-edit.server`          | the intent-shaped write ops (`createGraphNode`, `linkGraphNodes`, `setGraphNodeProperty`)                                                                      |
| `./neo4j/plain`, `./neo4j/transform` | plain projections of driver values; the Cytoscape projection                                                                                                   |
| `./app-tools/registry`               | `createAppToolRegistry({ resolveContext })` — a registry for tools that run inside your own process, beside the MCP gateway's                                  |
| `./mcp-catalog`                      | `mcpNamespace`: a tool-name → namespace lookup for the MCP servers this repository's gateway runs (pure data)                                                  |
| `./graph/graph-tools.server`         | `registerGraphConnectorTools(deps)` — the nine Microsoft Graph tools                                                                                           |
| `./graph/graph-auth`                 | `GraphAuthRequiredError`, owned by the package so `instanceof` works on both sides of it                                                                       |

## How this package is tested (contributors)

The suite lives under `__tests__/` and is excluded from the published tarball;
run it with `pnpm test` from `packages/connectors/`. It runs in a plain Node
environment and imports no code from the hames app.
