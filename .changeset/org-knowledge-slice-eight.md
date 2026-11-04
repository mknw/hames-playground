---
"@hames-ai/harness-patterns": minor
---

Memory recall's lexical half accepts linked terms: `MemoryCandidate.terms` (and `RankInput.terms`) are extra words BM25 counts with a memory's content, never rendered or embedded. The app uses them for a memory's links to organizational-graph nodes.
