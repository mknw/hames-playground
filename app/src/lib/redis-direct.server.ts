/**
 * Direct Redis Client — Server Only
 *
 * A `CallTool`-shaped adapter over a direct `ioredis` connection, for the Data
 * Stash APP path only. The MCP gateway runs the redis MCP over a single serial
 * stdio pipe (~1.6s per call), so ingesting a doc costs O(chunks)×2 serial
 * round-trips (~200s for a large doc). The exact same commands issued directly
 * to `localhost:6379` are sub-millisecond — the bottleneck is gateway latency,
 * not command count. This adapter runs them directly.
 *
 * It is a **drop-in** for `callTool`: the whole Data Stash layer
 * (`document-store` / `document-ingest` / `vector-store`) is already
 * parameterised on an injectable `CallTool`, so swapping the implementation
 * needs no change to the tested ingest/search logic. `stashCallTool()` picks
 * this adapter vs the gateway from `STASH_DIRECT_REDIS` — mirroring the
 * `USE_MIXED_CHAINS` toggle. The GLOBAL `defaultCallTool` is untouched, so
 * agentic MCP tool use still goes through the gateway.
 *
 * Same instance, same schema: the gateway's redis-mcp and this client both hit
 * the one redis-stack (`localhost:6379`, published by docker-compose), and the
 * vector field (`vector`, FLOAT32) + key schema match what `set_vector_in_hash`
 * already wrote — so a direct `FT.SEARCH` reads gateway-written vectors and
 * vice-versa. Requires redis-stack (RediSearch/RedisJSON); on arm64 colima the
 * redis service must run `platform: linux/amd64` (same as the gateway path).
 */

import { Redis } from 'ioredis'
import { assertServerOnImport } from './harness-patterns/assert.server'
import { callTool as gatewayCallTool } from './harness-patterns/mcp-client.server'
import type { CallTool } from './document-store.server'
import type { ToolCallResult } from './harness-patterns/types'

assertServerOnImport()

// ============================================================================
// Schema constants (must match what the redis-mcp tools use — see module doc)
// ============================================================================

/** Hash field holding the FLOAT32 vector blob. The redis-mcp default; the Data
 *  Stash never overrides it. Kept as a const so dedup can reuse it later. */
const VEC_FIELD = 'vector'
/** Hash field holding the base64 JSON payload (`encodeMeta` output). */
const META_FIELD = 'meta'

// ============================================================================
// Connection (lazy singleton — import never blocks; connects on first command)
// ============================================================================

let client: Redis | null = null

/** The shared direct client. Lazy (`lazyConnect`) so importing this module —
 *  which happens even when the flag is off — never opens a socket. */
export function getRedis(): Redis {
  if (client) return client
  const host = process.env.REDIS_HOST_DIRECT || process.env.REDIS_HOST || 'localhost'
  const port = Number(process.env.REDIS_PORT || 6379)
  const password = process.env.REDIS_PWD || process.env.REDIS_PASSWORD || undefined
  const useTls = process.env.REDIS_SSL === 'true'
  const c = new Redis({
    host,
    port,
    password,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    family: 0, // let ioredis choose IPv4/IPv6 (avoids macOS localhost mismatch)
    ...(useTls ? { tls: {} } : {}),
  })
  // ioredis auto-reconnects; surface the blip but never let it crash the server.
  c.on('error', (err: Error) =>
    console.error('[redis-direct] connection error:', err?.message ?? err),
  )
  client = c
  return c
}

/** Drop the singleton without awaiting (HMR / tests). */
export function resetRedisDirect(): void {
  client?.disconnect()
  client = null
}

/** Gracefully close the singleton (await-able). */
export async function closeRedisDirect(): Promise<void> {
  if (!client) return
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
  client = null
}

// ============================================================================
// Vector encoding
// ============================================================================

/** Pack a vector as a little-endian FLOAT32 blob — byte-identical to what the
 *  redis-mcp server wrote (numpy `float32.tobytes()`), so KNN over a mixed
 *  corpus (some chunks gateway-written, some direct) still matches. */
export function toFloat32LE(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

// ============================================================================
// The adapter
// ============================================================================

const ok = (data: unknown): ToolCallResult => ({ success: true, data })
const fail = (err: unknown): ToolCallResult => ({
  success: false,
  data: null,
  error: err instanceof Error ? err.message : String(err),
})

function s(v: unknown): string {
  return typeof v === 'string' ? v : String(v)
}

/**
 * Build a `CallTool` backed by `redis` (defaults to the shared singleton,
 * resolved per-invocation so it survives `resetRedisDirect`). Tests pass a fake
 * ioredis. Each case returns the SAME `ToolCallResult` shape the existing
 * parsers expect (`redisWriteError`, `unwrapJsonGet`, `parseSetMembers`,
 * `parseHits`) — see the per-tool notes.
 */
export function makeDirectCallTool(injected?: Redis): CallTool {
  return async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
    const redis = injected ?? getRedis()
    try {
      switch (name) {
        // ── RedisJSON (documents + embedding-space record) ──────────────────
        case 'json_set': {
          // {name, path:'$', value:<json str>, expire_seconds}
          await redis.call('JSON.SET', s(args.name), s(args.path ?? '$'), s(args.value))
          if (args.expire_seconds != null) {
            await redis.expire(s(args.name), Number(args.expire_seconds))
          }
          return ok('OK') // redisWriteError passes "OK"
        }
        case 'json_get': {
          // {name, path:'$'} → raw JSON string (or null); unwrapJsonGet parses it.
          const v = await redis.call('JSON.GET', s(args.name), s(args.path ?? '$'))
          return ok(v ?? null)
        }

        // ── Session index SET ───────────────────────────────────────────────
        case 'sadd': {
          const n = await redis.sadd(s(args.name), s(args.value))
          if (args.expire_seconds != null) {
            await redis.expire(s(args.name), Number(args.expire_seconds))
          }
          return ok(n)
        }
        case 'smembers':
          return ok(await redis.smembers(s(args.name))) // string[] → parseSetMembers
        case 'srem':
          return ok(await redis.srem(s(args.name), s(args.value)))
        case 'delete': // note: `key`, not `name`
          return ok(await redis.del(s(args.key)))
        case 'expire':
          return ok(await redis.expire(s(args.name), Number(args.expire_seconds)))

        // ── Vector store (RediSearch HNSW) ──────────────────────────────────
        case 'create_vector_index_hash': {
          // {index_name, prefix, dim, distance_metric}. Tolerate "already exists"
          // via the outer catch — the message contains "exist", which
          // ensureIndex's /exist/i guard swallows.
          await redis.call(
            'FT.CREATE',
            s(args.index_name),
            'ON',
            'HASH',
            'PREFIX',
            '1',
            s(args.prefix),
            'SCHEMA',
            VEC_FIELD,
            'VECTOR',
            'HNSW',
            '6',
            'TYPE',
            'FLOAT32',
            'DIM',
            s(args.dim),
            'DISTANCE_METRIC',
            s(args.distance_metric ?? 'COSINE'),
            META_FIELD,
            'TEXT',
            // Dedup (later): append `'session_ids','TAG','SEPARATOR',','` here and
            // hset a session_ids field, to enable a per-session FT.SEARCH filter.
          )
          return ok('OK')
        }
        case 'set_vector_in_hash': {
          // {name, vector} → one hash field holding the FLOAT32 blob.
          await redis.hset(s(args.name), VEC_FIELD, toFloat32LE(args.vector as number[]))
          return ok(true)
        }
        case 'hset': {
          // {name, key:'meta', value:<b64 str>, expire_seconds?}
          const n = await redis.hset(s(args.name), s(args.key), s(args.value))
          if (args.expire_seconds != null) {
            await redis.expire(s(args.name), Number(args.expire_seconds))
          }
          return ok(n)
        }
        case 'vector_search_hash':
          return ok(await knnSearch(redis, args))

        default:
          return fail(`redis-direct: unhandled tool "${name}"`)
      }
    } catch (err) {
      return fail(err)
    }
  }
}

/**
 * KNN search via native `FT.SEARCH`, shaped into the array-of-hit-objects that
 * `parseHits` (vector-store.server.ts) consumes: each row `{ id, meta, score }`
 * where `meta` is the stored base64 payload and `id` is the redis key (parseHits
 * prefers the `_vid` inside meta). The optional `filter` is a dedup-readiness
 * hook: today every caller omits it (`*` = unfiltered KNN); later a session-
 * membership TAG filter can be passed with no signature change.
 */
async function knnSearch(
  redis: Redis,
  args: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const k = Number(args.k) || 5
  const blob = toFloat32LE(args.query_vector as number[])
  const pre = typeof args.filter === 'string' && args.filter ? args.filter : '*'
  const query = `${pre}=>[KNN ${k} @${VEC_FIELD} $BLOB AS score]`
  const reply = (await redis.call(
    'FT.SEARCH',
    s(args.index_name),
    query,
    'PARAMS',
    '2',
    'BLOB',
    blob,
    'RETURN',
    '2',
    META_FIELD,
    'score',
    'SORTBY',
    'score',
    'DIALECT',
    '2',
  )) as unknown

  // RESP2 shape: [ total, key1, [field,val,...], key2, [...], ... ].
  if (!Array.isArray(reply) || reply.length < 2) return []
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i + 1 < reply.length; i += 2) {
    const key = reply[i]
    const fields = reply[i + 1]
    const rec: Record<string, unknown> = { id: typeof key === 'string' ? key : s(key) }
    if (Array.isArray(fields)) {
      for (let j = 0; j + 1 < fields.length; j += 2) {
        const val = fields[j + 1]
        rec[s(fields[j])] = Buffer.isBuffer(val) ? val.toString('utf8') : val
      }
    }
    rows.push(rec)
  }
  return rows
}

// ============================================================================
// Flag-gated resolver (Data-Stash-scoped)
// ============================================================================

/** The shared direct adapter (lazy client, resolved per call). */
export const directCallTool: CallTool = makeDirectCallTool()

/**
 * The `CallTool` the Data Stash layer should default to: the direct client when
 * `STASH_DIRECT_REDIS=1`, else the MCP gateway. Read per-call (like
 * `clientOverrideFor`) so a test/env change needs no re-import. Only the Data
 * Stash modules call this — agentic MCP tools keep using `defaultCallTool`.
 */
export function stashCallTool(): CallTool {
  return process.env.STASH_DIRECT_REDIS === '1' ? directCallTool : gatewayCallTool
}

/** Re-exported so the document-store list cache can recognise a "real" backend
 *  (either default) and still bypass caching for injected test fakes. */
export { gatewayCallTool }
