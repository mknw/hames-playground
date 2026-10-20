---
"@hames-ai/harness-patterns": patch
---

Retrieval and indexing now honour a document's `hidden` / `archived` flags. `searchDocuments` (and so the `redis` retriever backend) drops hits of hidden or archived documents, reading their current flags on each search and dropping a hit whose flags cannot be read or whose document record is absent (logged); it widens the index query, within a bound, so dropped hits do not leave the result short of `k`. `ensureSessionIngested` skips hidden and archived documents and now returns `{ skippedFlagged }` (it returned nothing before); the `redis` backend re-runs it on a later search while it has skipped any. Un-hiding makes a document retrievable again without re-indexing.
