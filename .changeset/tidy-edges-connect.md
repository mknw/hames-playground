---
'@hames-ai/agents': patch
---

Extract Neo4j driver relationships as edges, preserving their endpoints and properties instead of rendering phantom nodes or dropping bare relationships.

Normalize native driver Integer identities exactly before extracting graph data. Driver relationship graph keys now carry a `neo4j-rel:` prefix to distinguish them from node keys, including when their native identities coincide; node keys and endpoint mapping stay unchanged. Flat MCP nodes with ordinary `identity` and `type` properties remain nodes.
