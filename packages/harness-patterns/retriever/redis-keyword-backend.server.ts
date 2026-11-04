/**
 * Redis keyword RetrieverBackend — Server Only
 *
 * The BM25 half of hybrid retrieval (#928 slice 1): wraps `searchDocumentsKeyword`
 * — RediSearch's BM25 scorer over the session index's plain, full-text-indexed
 * `text` field, which every v2 ingest writes alongside the vector. No embedding,
 * no vector comparison: the query text is tokenized and scored as-is, which is
 * what moves the exact-term questions (`ERR-7A42`, `PG-4411-B`, `2.1 N·m`) that
 * an embedding tends to blur.
 *
 * Mirrors {@link createRedisBackend} in every structural respect — same lazy
 * `ensureSessionIngested` safety net (which is also what runs the lazy
 * schema-version re-ingest), same injectable seams, same SearchHit →
 * RetrievalHit normalization, SAME composite id shape (`docId:chunkIndex`) — so
 * the same chunk found by both backends collapses into one RRF-merged hit.
 *
 * `score` is BM25 RELEVANCE (higher = more relevant), not a distance — see
 * {@link RetrievalHit.score}.
 *
 * Transport: needs a `callTool` that implements `keyword_search_hash`. The app's
 * direct ioredis adapter does; the MCP gateway's redis server exposes no
 * full-text search, so over the gateway this backend's search throws — the
 * retriever's per-backend guard turns that into an error event + empty results,
 * loudly, never a silent "no matches".
 *
 * `sessionId` scopes the corpus. `searchFn`/`ensureFn` are injectable and
 * `ensureIngested:false` disables the net — both for tests.
 */

import { assertServerOnImport } from '../assert.server'
import type { RetrieverBackend, RetrievalHit } from '../patterns/retriever.server'
import { searchDocumentsKeyword, ensureSessionIngested } from '../stash/document-ingest.server'

assertServerOnImport()

export function createRedisKeywordBackend(
  sessionId: string,
  opts: {
    searchFn?: typeof searchDocumentsKeyword
    ensureFn?: typeof ensureSessionIngested
    ensureIngested?: boolean
  } = {},
): RetrieverBackend {
  const searchFn = opts.searchFn ?? searchDocumentsKeyword
  const ensureFn = opts.ensureFn ?? ensureSessionIngested
  const ensureIngested = opts.ensureIngested !== false
  let ensured = false
  return {
    name: 'redis-keyword',
    type: 'keyword',
    async search({ text }, { k, excludeIds }): Promise<RetrievalHit[]> {
      if (ensureIngested && !ensured) {
        // Same background safety net as the vector backend — never block the
        // query, mark first so racing searches don't re-trigger, and re-arm
        // when a flagged document was skipped (an un-hidden document must be
        // indexed by a later search) or the net failed.
        ensured = true
        void ensureFn(sessionId)
          .then((res) => {
            if (res?.skippedFlagged) ensured = false
          })
          .catch((err: unknown) => {
            ensured = false
            console.warn(
              `[retriever] background ingest net failed for session ${sessionId} ` +
                `(${err instanceof Error ? err.message : String(err)}) — searches until the ` +
                'next attempt may see an incomplete index.',
            )
          })
      }
      const hits = await searchFn(sessionId, text, { k, excludeIds })
      return hits.map((h) => ({
        backend: 'redis-keyword',
        ...(h.provenance ? { provenance: h.provenance } : {}),
        id: `${h.docId}:${h.chunkIndex}`,
        content: h.content,
        source: h.source,
        score: h.score,
        docId: h.docId,
        chunkIndex: h.chunkIndex,
        startOffset: h.startOffset,
        endOffset: h.endOffset,
        ...(h.docChunks !== undefined ? { docChunks: h.docChunks } : {}),
      }))
    },
  }
}
