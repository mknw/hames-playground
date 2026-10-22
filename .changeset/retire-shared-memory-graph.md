---
"@hames-ai/agents": minor
"@hames-ai/connectors": minor
"@hames-ai/harness-patterns": minor
---

**Breaking:** retire the shared memory graph (the `memory` MCP server and its tools).
Personal memory is unchanged: `withMemory` stores and recalls per-user memories in
Postgres.

- `@hames-ai/connectors`: `MCP_TOOL_CATALOG` / `mcpNamespace` no longer map the nine
  memory-graph tools (`create_entities`, `create_relations`, `add_observations`,
  `delete_entities`, `delete_relations`, `delete_observations`, `open_nodes`,
  `search_nodes`, `read_graph`) to a `memory` namespace, so `Tools()` returns no `memory`
  list. The catalog is 77 names across five namespaces.
- `@hames-ai/agents`: `general-next` no longer holds the memory graph's read tools, and its
  info route's description and capability no longer mention a memory graph.
  `isMemoryGraphResult` is no longer exported, `GraphElement.source` is
  `'neo4j' | 'unknown'`, and the graph extractor no longer parses memory-graph results.
- `@hames-ai/harness-patterns`: `withPseudonymisedInputs` treats only `neo4j` as a local
  namespace; a tool that still resolves to `memory` is egress-checked like any other.
  `isReadOnlyTool` no longer lists `open_nodes`.

Migration: remove the `memory` server from your gateway catalog and config, drop any
`tools.memory` read, and drop any import of `isMemoryGraphResult`. A gateway that still
serves those tools hands them to no agent shipped here. Decide separately what to do with
the old server's data volume before deleting it.
