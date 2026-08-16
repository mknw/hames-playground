/**
 * Retriever backends — app-level wiring for the framework-pure `retriever`
 * pattern (`harness-patterns/patterns/retriever.server.ts`).
 *
 * The pattern defines the {@link RetrieverBackend} contract; these factories are
 * the concrete data sources an agent plugs into `retriever({ backends })`:
 *   - {@link createRedisBackend}    — local Data Stash (RediSearch KNN over a
 *     session's ingested uploads). Live.
 *   - {@link createSupabaseBackend} — company pgvector corpus via the Supabase
 *     MCP (text-in, server-side embed). Deferred stub (pending IT access).
 *
 * Server-only: both re-exported modules call `assertServerOnImport()`.
 */
export { createRedisBackend } from './redis-backend.server'
export {
  createSupabaseBackend,
  type SupabaseBackendConfig,
} from './supabase-backend.server'
