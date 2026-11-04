---
"@hames-ai/harness-patterns": minor
---

Add the organizational-knowledge graph store seam, `org-knowledge-store`: the `OrgGraphStore` interface (`snapshot`, and `apply`, which writes one validated assertion in one transaction after a stale re-check), the shared `isStale` check and property helpers, and `createMemoryOrgGraphStore`, an in-memory adapter for tests and evals. Nothing calls it yet.
