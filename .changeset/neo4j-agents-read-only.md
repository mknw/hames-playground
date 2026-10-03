---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
"@hames-ai/connectors": patch
---

Agents are read-only against Neo4j (#403).

`@hames-ai/harness-patterns`: `listTools()` no longer returns `write_neo4j_cypher`, including under a gateway prefix (`mcp__<server>__write_neo4j_cypher`) or a server namespace prefix (`<namespace>-write_neo4j_cypher`). `Tools()` and the BAML adapters' catalogs read through it. And `simpleLoop` and `actorCritic` refuse the tool in their allowlist check even when the allowlist you pass names it, or `dynamicToolAllowlist` / `dynamicToolPattern` would admit it; the refusal says the tool is withheld from every agent. So no agent's tool list, loop allowlist or planner catalog holds it. Like the management-tool filter, it is unconditional, and `listTools()` logs one warning per process when the gateway lists the tool. `callTool()` is unchanged: the list decides what an agent may call, not what the host may call by name. If an agent of yours wrote to Neo4j through this tool, it no longer can.

`simpleLoop` now filters `fewShots` by the loop's allowlist before the controller sees them (#401): a shot whose `tool` the loop would refuse is dropped, and shots of `Return` and `expandPreviousResult` always stay. A model that copied a shot of a tool outside the allowlist used to end the loop on "Tool not allowed".

`@hames-ai/agents`: new export `NEO4J_READ_ONLY_CONTEXT`, the controller context `search`, `retriever` and `general` now pass to the loops that reach Neo4j. It tells the controller the graph is read-only and to answer a request to change it instead of attempting one. `NEO4J_FEW_SHOTS_DEFAULT` is unchanged; its write example now reaches only a loop whose allowlist holds the write tool.

`@hames-ai/connectors`: README only.
