/**
 * Supabase vector RetrieverBackend — Server Only — DEFERRED
 *
 * The company corpus lives in Supabase (Postgres/pgvector) and embeds
 * **server-side** (Automatic Embeddings / Edge Functions), so this backend is
 * **text-in**: it sends the query text and lets Supabase embed + match — no
 * client-side embedding.
 *
 * Channel: the **Supabase MCP server** (run a match RPC / `... order by
 * embedding <=> ...` SQL via `callTool`). To finish it when IT provides access:
 *   1. Add the Supabase MCP to `configs/custom-catalog.yaml`
 *      (`@supabase/mcp-server-supabase`; env `SUPABASE_URL`,
 *      `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SCHEMA`).
 *   2. Implement `search()` to `callTool(<supabase match tool>, { query: text, k })`
 *      and map rows → RetrievalHit (n8n already uses this Supabase, so a match
 *      surface likely exists).
 *
 * Until then `search()` throws; the retriever's per-backend guard turns that into
 * an error event + empty results, so a misconfigured backend never sinks a run.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import type { RetrieverBackend, RetrievalHit } from '../harness-patterns'

assertServerOnImport()

export interface SupabaseBackendConfig {
  /** The Supabase MCP tool/RPC name that performs a text→match search. */
  matchTool?: string
  /** Target table/relation, if the match tool needs it. */
  table?: string
}

export function createSupabaseBackend(_config: SupabaseBackendConfig = {}): RetrieverBackend {
  return {
    name: 'supabase',
    type: 'vector',
    async search(): Promise<RetrievalHit[]> {
      throw new Error(
        'Supabase retriever backend not yet implemented (pending IT access). ' +
          'Wire the Supabase MCP (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) + a ' +
          'text→match RPC, then implement search() via callTool.',
      )
    },
  }
}
