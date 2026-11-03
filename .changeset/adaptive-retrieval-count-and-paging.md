---
'@hames-ai/harness-patterns': minor
'@hames-ai/agents': minor
---

Adaptive document retrieval: ingest now records the chunk count it computed beside the document's size, and the retriever can page through a long document across re-dispatches instead of returning the same k chunks (#927 slices 1 and 2).

- Document records carry a `chunkCount` plaintext integer after a successful ingest; documents ingested before this change carry no count and render without one — never a fabricated 0. The documents block and the retrieval step line show it when every matched document reported its total.
- `retriever({ page: true })` opts a route into paging: the retriever excludes the chunk ids it already returned for this route in this turn, and the exclusion sits inside the visibility-widening search loop, so a page of a long document still returns `k` chunks when every visible chunk beyond the first batch would otherwise have been hidden. An exhausted document returns an empty page, which the #926 progress rule counts as no progress.
