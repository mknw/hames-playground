---
"@hames-ai/agents": patch
---

`generalNextAgent`'s info loop now takes the host's `enrichNeo4jResult`, so a graph answer carries the 1-hop neighbourhood the Neo4j tab draws; the controller's turn log omits it. `extractGraphElements` reads string values through the injection guard's fence, so a guarded graph read draws readable node ids.
