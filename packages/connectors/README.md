# @hames/connectors

The **connectors** companion package for
[`@hames/harness-patterns`](../harness-patterns): the Microsoft Graph app-side
tools, the Neo4j non-agentic layer, and the MCP-gateway namespace catalog —
moved out of the host app (#225 PR-3) behind injected seams. The package owns
protocols, query shapes and schemas; the **host owns identity, tokens, content
classification and storage**, every one of them injected.

## Surface

| Subpath                              | What lives there                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (root barrel)                    | client-safe surface only: `mcpNamespace` / `MCP_TOOL_CATALOG`, the Neo4j→Cytoscape `transformNeo4jToCytoscape` / `parseNeo4jResults`                           |
| `./neo4j/client`                     | `configureNeo4j({ url, user, password })` + the driver singleton — **explicit-config-only**: unset config is a named error at first use, never an env fallback |
| `./neo4j/queries`                    | the identity-free read ops (`getSchema`, `runManualCypher`, …) — every session READ-mode (SD-14)                                                               |
| `./neo4j/graph-edit.server`          | the intent-shaped write ops (`createGraphNode`, `linkGraphNodes`, `setGraphNodeProperty`)                                                                      |
| `./neo4j/plain`, `./neo4j/transform` | plain projections of driver values; the Cytoscape projection                                                                                                   |
| `./app-tools/registry`               | `createAppToolRegistry({ resolveContext })` — the generic in-process tool registry                                                                             |
| `./mcp-catalog`                      | this deployment's tool→namespace catalog (pure data)                                                                                                           |
| `./graph/graph-tools.server`         | `registerGraphConnectorTools(deps)` — the nine Microsoft Graph tools                                                                                           |
| `./graph/graph-auth`                 | `GraphAuthRequiredError`, owned by the package so `instanceof` survives across the seam                                                                        |

## What is injected vs imported vs composed

**Injected (host → package, every field REQUIRED — a missing or non-function
supplier throws at factory call, never degrades):**

- `createAppToolRegistry({ resolveContext })`: the `userId` / `sessionId` pair
  (the app's `getRequestUserId`/`getRequestSessionId`).
- `registerGraphConnectorTools(deps)`:
  - `registerAppTool` — where the tools register;
  - `graphFetch` (S1) — delegated-token Microsoft Graph fetch; the package
    never sees a token;
  - `content` (S4) — `conversionEnabled` / `isConvertible` / `guessMimeType` /
    `isTextMime`, one required supplier;
  - `stash` — `loadStore` / `ingest`: the Data Stash bridge the file-ingest
    tool needs (lazily resolved by the host, so composing the tools never
    loads the storage stack).

**Imported directly:** `@hames/harness-patterns` (types, `assert.server`,
`tools.server`'s `ToolsFrom` in tests) and `neo4j-driver`. Nothing else —
there are no `app/src` imports, type-only included (pinned by the host's
`zero-app-imports.test.ts`).

**Composed host-side (not this package's business):** the `'use server'` RPC
wrappers with their per-module auth gates (SD-13: duplicated per module, never
imported), the transport registration on core's seam, the token/MSAL layer,
and the doc-convert/stash modules behind the content seam. A back-edge from
this package into the host's stash (`guessMimeType`/`isTextMime`) is
forbidden by design — see the S4 note in the host's composition root.

## Tests

The suite is co-located under `__tests__/` and excluded from the published
tarball via the `files` allowlist. Run it with `pnpm test` from
`packages/connectors/`. It runs in a plain node environment and imports no
host-app code; tests that need the app's request scope or its composition
root stayed in the app's `src/__tests__/` tree.

The package publishes to npm as `@hames/connectors` with `publishConfig.access:
public` (set at first publication; the setting travels with every future
version).
