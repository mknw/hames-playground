---
"@hames-ai/agents": minor
"@hames-ai/harness-patterns": minor
---

general-next's info route gains `context7` library docs and the memory graph's
targeted read tools (`search_nodes`, `open_nodes`) under the same injection
guard and web-route pseudonymisation boundary; memory write tools stay withheld.
`withPseudonymisedInputs` now treats `memory` as a local namespace beside
`neo4j`, keeps `context7` under the outgoing check, and stops extending its outgoing
literals from `context7` results (as already for web).
