---
"@hames-ai/harness-patterns": patch
---

Retrieval and indexing now honour a document's `hidden` / `archived` flags. `searchDocuments` (and so the `redis` retriever backend) drops hits of hidden or archived documents, reading their current flags on each search and dropping a hit whose flags cannot be read (logged); it widens the index query, within a bound, so dropped hits do not leave the result short of `k`. `ensureSessionIngested` skips hidden and archived documents. Un-hiding makes a document retrievable again without re-indexing.
