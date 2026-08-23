# Harness Client

Server-side module that bridges the UI with the `harness-patterns` framework. Handles auth, session persistence, agent registration, and event streaming.

## File Structure

```
harness-client/
├── actions.server.ts          # processMessage(), processMessageStreaming(), approveAction(), rejectAction(), listConversations(), loadConversation()
├── session.server.ts          # In-process pattern cache + Postgres-backed serialized context (per-user, scoped via userId)
├── registry.server.ts         # Registers all agents, exports getAgentMetadata()
├── graph-extractor.ts         # ContextEvent → GraphElement[] extraction (MCP + driver formats; recognises enriched payloads)
├── neo4j-enricher.server.ts   # `onToolResult` recipe — fetches 1-hop neighborhood for touched nodes
├── types.ts                   # GraphElement (extends Cytoscape ElementDefinition)
├── index.ts                   # Public exports
└── agents/                    # 10 pre-built agent configurations (see agents/README.md)
```

Persistence layer is in `../db/`:

```
db/
├── client.server.ts           # Lazy pg.Pool singleton + idempotent CREATE TABLE IF NOT EXISTS
└── conversations.server.ts    # loadConversation, saveConversation, listConversations, deleteConversation, deriveTitle
```

## API

### `processMessage(sessionId, message)`

Synchronous agent execution. Delegates to `processMessageWithAgent(sessionId, message, 'search')`.

### `processMessageStreaming(sessionId, message, agentId, onEvent)`

Streaming variant — calls the harness with an `onEvent` callback that fires for each committed `ContextEvent`. Used by the SSE endpoint (`/api/events`).

```typescript
const result = await processMessageStreaming(sessionId, message, 'search', (evt: ContextEvent) => {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`))
})
```

### `approveAction(sessionId)` / `rejectAction(sessionId)`

Resume a paused session after user approval or rejection of a write operation.

### `getAgentMetadata()`

Returns metadata for all registered agents (id, name, description, icon).

### `listConversations()` / `loadConversation(sessionId)`

Server actions used by the sidebar. Both authenticate via the Entra session (`getAuthenticatedUser()`, or fall back to `dev-bypass-user` when `VITE_DEV_BYPASS_AUTH=true`) and scope by `user.id`:

- `listConversations()` → `{ id, agentId, title, updatedAt }[]`, newest first, capped at 200
- `loadConversation(sessionId)` → returns the deserialized `UnifiedContext` so `ChatInterface` can replay events into the graph + observability panel

## Graph Extraction

`extractGraphElements(events)` parses `ContextEvent[]` (specifically `tool_result` events) into `GraphElement[]` for Cytoscape visualization.

Handles two Neo4j result formats:

- **MCP format**: Flat records `{ n: { name, description }, r: [startNode, "TYPE", endNode] }`
- **Neo4j driver format**: Structured objects with `identity`, `labels[]`, `properties{}`

Also handles Memory MCP results (`entities[]`, `relations[]`).

Pattern IDs are mapped to graph sources (`neo4j`, `memory`) for tab filtering in the UI.

### Schema suppression and the plain-object guard (#14)

`get_neo4j_schema` returns an APOC-shaped object (`{ Concept: { type: 'node', count, properties, relationships }, HAS_CONCEPT: { type: 'relationship', count }, … }`) — metadata, not graph data. The extractor short-circuits on this tool name and returns `[]`. The plain-object fallback also rejects values shaped like a schema info bag (`type: 'node' | 'relationship'` with `count`) and refuses to synthesise a node from any object lacking a string `name` / `id` / `title`. Together these stop the schema's relationship-type names from being rendered as fake nodes.

### Enriched-result payload (`_neighborhood` + `_touched`)

When a Neo4j tool's result is wrapped by the enricher hook, the extractor sees:

```ts
{
  rows:          <original tool result>,
  _neighborhood: { rows: [...] },     // 1-hop fetched directly via the driver
  _touched:      ['Redis', 'Cache']    // node names from the original rows
}
```

The extractor processes both `rows` and `_neighborhood.rows` through the same MCP-format parser, deduplicates, then post-processes: any node whose `data.id` is in `_touched` is tagged with `data.touched = true`. The Neo4j panel maps that flag to a magenta highlight via `extraStyles` so the user can see what the agent actually queried (vs. surrounding context).

## Neo4j enricher (`onToolResult` recipe)

`neo4j-enricher.server.ts` exports a `OnToolResult`-shaped function that:

1. Skips non-enrichable tools (only `read_neo4j_cypher` / `write_neo4j_cypher`) and result payloads with no `name` strings.
2. Walks the result for node names (capped at 50).
3. Runs `MATCH (n) WHERE n.name IN $names OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 100` directly on the `neo4j-driver` singleton (`app/src/lib/neo4j/client.ts`).
4. Serialises records to the MCP cypher tuple shape (`[startProps, "TYPE", endProps]`) — **always in the relationship's actual direction** (`rel.start → rel.end`), not the query-binding order. This keeps edge IDs stable across queries that touch the same rel from either endpoint, so dedup collapses what would otherwise be duplicate edges.
5. Returns the enriched payload above.

Wire it into a pattern via the `onToolResult` config knob (see `harness-patterns/README.md` for the hook spec).

Failures are non-fatal: `simpleLoop` / `actorCritic` catch the throw, log a `recoverable` `error` event, and proceed with the original (un-enriched) result.

## Session Lifecycle

Sessions are split into two layers:

- **Pattern instances** — non-serializable (BAML clients, tool refs, closures). Cached in-process by `sessionId`; rebuilt from the agent registry on miss.
- **Serialized `UnifiedContext`** — pure JSON. Persisted in Postgres, scoped by `userId`, so conversations survive restarts and can be listed/resumed.

1. First message: auth → `processMessageStreaming(sessionId, message, agentId)` builds patterns, runs the agent, and `saveSession(sessionId, userId, agentId, serializeContext(ctx))` upserts the row. Title is derived from the first user message and stuck via `COALESCE` on update.
2. Subsequent messages: `loadSession(sessionId, userId)` reads the row, `deserializeContext()` rehydrates state, `continueSession()` runs the next turn.
3. Sidebar selection: `loadConversation(sessionId)` returns the rehydrated context; `ChatInterface` replays events into graph + observability via the existing pipeline.
4. Approval flow (plumbing): a paused context (`status: 'paused'`) resumes via `approveAction()` / `rejectAction()` → `resumeHarness()`; the resumed context is re-saved. The gating pattern that pauses a run is being redesigned — see "Execute under Supervision" (#123).
5. Agent change / new chat: `deleteSession()` evicts the pattern cache and removes the row (or simply selects a different `sessionId`).
