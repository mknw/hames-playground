---
"@hames-ai/agents": patch
---

`extractGraphElements` keys a node by its `id` property when that is a non-empty string, in both Neo4j result formats. A node read once as a plain object and once as a driver node is now one element, and a driver relationship's ends are rewritten to those keys. A node with no string `id` keeps its previous key, and the enrichment's `_touched` names still mark a node keyed by `id`.
