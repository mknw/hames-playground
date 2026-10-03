---
"@hames-ai/harness-patterns": patch
---

No agent may hold a Postgres tool (#412).

The `database-server` MCP server's tools — `query_database`, `execute_sql`, `list_tables`, `describe_table`, `connect_to_database`, `get_connection_examples` and `get_current_database_info` — join `write_neo4j_cypher` in `AGENT_WITHHELD_TOOLS`. Like it, they are seen through a gateway or server-namespace prefix, `listTools()` drops them, and every loop's allowlist check refuses them. If an agent of yours ran SQL through one of these names, it no longer can; a tool of the same name on another server is withheld too.

Each withheld name now carries the decision behind it and the switch that stops the gateway serving it: `withholdingFor(name)` returns both, beside `isAgentWithheldTool`. `listTools()` warns once per decision, so a gateway that lists both kinds logs two warnings, each naming its own remedy, where it used to log one that only described the Neo4j switch.
