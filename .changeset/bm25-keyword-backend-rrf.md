---
"@hames-ai/harness-patterns": minor
---

Hybrid retrieval (#928 slice 1): a BM25 keyword backend plus a reciprocal-rank-fusion merge for the retriever.

- Ingest now writes each chunk's text to a plain, full-text-indexed `text` field beside the vector and the base64 meta, and the stash index schema declares it as TEXT so RediSearch's BM25 scorer can rank it. `searchDocumentsKeyword` answers keyword queries against that field with the same no-corpus, visibility (hidden/archived), paging-exclusion and widening contracts as the vector search.
- `createRedisKeywordBackend` (in the package's `retriever/` subpath) exposes that search as a `type: 'keyword'` `RetrieverBackend`, mirroring the vector backend's lazy ingest safety net and id shape. It needs a transport that implements `keyword_search_hash` — the app's direct ioredis adapter; the MCP gateway's redis server exposes no full-text search, so over the gateway the keyword backend fails loudly (a per-backend error event, never a silent empty result).
- The stash index name carries a schema-version suffix (`..._v{STASH_INDEX_SCHEMA_VERSION}`, now 2). A corpus recorded under an older schema is re-ingested into the current-version index lazily by the ingest safety net (and by a background run the search paths trigger, deduped per session); old indexes simply empty out as their chunks expire with the 7-day TTL.
- The retriever pattern merges hits from more than one backend with `reciprocalRankFusion` — each backend's ranking contributes `1/(k + rank)` per hit, k = 60 (Cormack, Clarke & Buettcher 2009; also the Elasticsearch/OpenSearch RRF default). Rank-based fusion needs no cross-backend score comparability: the vector backends report distances while the keyword backend reports BM25 relevance. With one backend the distance-only sort is unchanged.
