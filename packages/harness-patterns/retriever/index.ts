/**
 * Retriever backends — the concrete backends for the framework-pure `retriever`
 * pattern (`patterns/retriever.server.ts`), reunited with it by the core-absorb
 * move (the pattern lived here; its backends were left app-side).
 *
 * The pattern defines the {@link RetrieverBackend} contract; these factories are
 * the concrete data sources an agent plugs into `retriever({ backends })`:
 *   - {@link createRedisBackend}    — local Data Stash (RediSearch KNN over a
 *     session's ingested uploads). Live. Reaches Redis only through the
 *     `CallTool` seam — importing this subpath never opens a socket; whether a
 *     deployment HAS a stash is runtime configuration.
 *   - {@link createSupabaseBackend} — company pgvector corpus via the Supabase
 *     MCP (text-in, server-side embed). Deferred stub (pending IT access).
 *
 * OPT-IN by subpath: the root barrel and `./patterns` never import this module
 * (pinned by `__tests__/stash-opt-in.test.ts`) — a consumer who wants the
 * retriever pattern without the backends pulls neither the stash pipeline nor
 * its transport.
 *
 * Server-only: both re-exported modules call `assertServerOnImport()`.
 */
export { createRedisBackend } from './redis-backend.server'
export { createSupabaseBackend, type SupabaseBackendConfig } from './supabase-backend.server'
