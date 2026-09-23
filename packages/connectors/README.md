# @hames-ai/connectors

## What this is

Connections from an agent built with
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme)
to outside systems: nine Microsoft Graph tools for Microsoft 365 (mail,
calendar, files and the signed-in user's profile), a Neo4j client with read
queries and graph-editing operations, and a catalog that sorts an MCP
gateway's tool names into _namespaces_ — named groups of tools, such as `web`
or `neo4j`, that a pattern or the injection guard can refer to. Everything
that touches identity stays with your application: the signed-in user,
their access tokens and where files are stored are passed in, never held by
the package.

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

## Exports

| Subpath                              | What lives there                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (root entry point)               | browser-safe exports only: `mcpNamespace` / `MCP_TOOL_CATALOG`, the Neo4j→Cytoscape `transformNeo4jToCytoscape` / `parseNeo4jResults`                          |
| `./neo4j/client`                     | `configureNeo4j({ url, user, password })` + the driver singleton — **explicit-config-only**: unset config is a named error at first use, never an env fallback |
| `./neo4j/queries`                    | the identity-free read ops (`getSchema`, `runManualCypher`, …) — every session opened in READ mode                                                             |
| `./neo4j/graph-edit.server`          | the intent-shaped write ops (`createGraphNode`, `linkGraphNodes`, `setGraphNodeProperty`)                                                                      |
| `./neo4j/plain`, `./neo4j/transform` | plain projections of driver values; the Cytoscape projection                                                                                                   |
| `./app-tools/registry`               | `createAppToolRegistry({ resolveContext })` — the generic in-process tool registry                                                                             |
| `./mcp-catalog`                      | the tool→namespace catalog for the MCP gateway this repository configures (pure data)                                                                          |
| `./graph/graph-tools.server`         | `registerGraphConnectorTools(deps)` — the nine Microsoft Graph tools                                                                                           |
| `./graph/graph-auth`                 | `GraphAuthRequiredError`, owned by the package so `instanceof` works on both sides of it                                                                       |

## What your application passes in

Below, the _host_ is your application — the code that imports this package.

**Injected (host → package, every field REQUIRED — a missing or non-function
supplier throws at factory call, never degrades):**

- `createAppToolRegistry({ resolveContext })`: the `userId` / `sessionId` pair
  for the current request.
- `registerGraphConnectorTools(deps)`:
  - `registerAppTool` — where the tools register;
  - `graphFetch` — a Microsoft Graph fetch made with the signed-in user's
    delegated token; the package never sees a token;
  - `content` — `conversionEnabled` / `isConvertible` / `guessMimeType` /
    `isTextMime`, one required supplier;
  - `stash` — `loadStore` / `ingest`: the document-store bridge the file-ingest
    tool needs (lazily resolved by the host, so composing the tools never
    loads the storage stack).

**Imported directly:** `@hames-ai/harness-patterns` (types, `assert.server`,
`tools.server`'s `ToolsFrom` in tests) and `neo4j-driver`. Nothing else —
it imports no code from the hames app in this repository, type-only included
(pinned by the app's `zero-app-imports.test.ts`).

**Left to your application:** the server endpoints that expose these
operations, each with its own authorization check; registering the tools as a
transport with `@hames-ai/harness-patterns`; acquiring and refreshing
Microsoft tokens; and document conversion and storage behind the `content` and
`stash` suppliers. The package never reaches into the host's storage code for
`guessMimeType`/`isTextMime` — that is why `content` is injected.

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

## Tests

The suite is co-located under `__tests__/` and excluded from the published
tarball via the `files` allowlist. Run it with `pnpm test` from
`packages/connectors/`. It runs in a plain node environment and imports no
code from the hames app; tests that need the app's request scope stayed in
the app's own `src/__tests__/` tree.

The manifest sets `publishConfig.access: public`, so the package publishes to
npm as the public `@hames-ai/connectors`.
