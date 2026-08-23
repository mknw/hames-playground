/**
 * Document Store Tests (Issue #6)
 *
 * Exercises the Redis-backed document storage layer against an in-memory
 * fake `callTool` that emulates the subset of Redis MCP tools the store uses
 * (json_set / json_get / sadd / smembers / srem / delete), including the
 * RedisJSON `$`-path array wrapping the real gateway returns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store self-asserts server-only on import; stub it out under jsdom.
vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// Stub the MCP client module so importing the store never reaches a real
// gateway. Tests inject their own fake callTool per-call instead.
vi.mock('../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import {
  storeDocument,
  getDocument,
  getDocumentMeta,
  listDocuments,
  setDocumentFlags,
  deleteDocument,
  toPriorResult,
  redisWriteError,
  DEFAULT_TTL_SECONDS,
  MAX_CONTENT_BYTES,
  type CallTool,
} from '../../lib/document-store.server'
import type { ToolCallResult } from '../../lib/harness-patterns/types'

// ----------------------------------------------------------------------------
// Fake Redis backing a fake callTool
// ----------------------------------------------------------------------------

interface FakeRedis {
  json: Map<string, unknown>
  sets: Map<string, Set<string>>
  expires: Map<string, number>
}

function makeFakeRedis(): {
  redis: FakeRedis
  callTool: CallTool & { calls: Array<[string, Record<string, unknown>]> }
} {
  const redis: FakeRedis = { json: new Map(), sets: new Map(), expires: new Map() }
  const calls: Array<[string, Record<string, unknown>]> = []

  const fn = (async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
    calls.push([name, args])
    switch (name) {
      case 'json_set': {
        const key = args.name as string
        // The store stringifies the doc into `value`.
        redis.json.set(key, JSON.parse(args.value as string))
        if (typeof args.expire_seconds === 'number') redis.expires.set(key, args.expire_seconds)
        return { success: true, data: 'OK' }
      }
      case 'json_get': {
        const key = args.name as string
        if (!redis.json.has(key)) return { success: true, data: null }
        // Emulate RedisJSON: `$` path returns the value wrapped in an array.
        return { success: true, data: [redis.json.get(key)] }
      }
      case 'json_del':
      case 'delete': {
        const key = (args.key ?? args.name) as string
        redis.json.delete(key)
        redis.expires.delete(key)
        return { success: true, data: 1 }
      }
      case 'sadd': {
        const key = args.name as string
        if (!redis.sets.has(key)) redis.sets.set(key, new Set())
        redis.sets.get(key)!.add(args.value as string)
        if (typeof args.expire_seconds === 'number') redis.expires.set(key, args.expire_seconds)
        return { success: true, data: 1 }
      }
      case 'smembers': {
        const key = args.name as string
        return { success: true, data: Array.from(redis.sets.get(key) ?? []) }
      }
      case 'srem': {
        const key = args.name as string
        redis.sets.get(key)?.delete(args.value as string)
        return { success: true, data: 1 }
      }
      default:
        return { success: false, data: null, error: `unhandled tool ${name}` }
    }
  }) as CallTool & { calls: Array<[string, Record<string, unknown>]> }
  fn.calls = calls
  return { redis, callTool: fn }
}

// ----------------------------------------------------------------------------

describe('document-store (Issue #6)', () => {
  let fake: ReturnType<typeof makeFakeRedis>

  beforeEach(() => {
    fake = makeFakeRedis()
  })

  describe('storeDocument', () => {
    it('stores content + metadata and returns a complete document', async () => {
      const before = Date.now()
      const doc = await storeDocument(
        { sessionId: 's1', filename: 'notes.txt', mimeType: 'text/plain', content: 'hello world' },
        fake.callTool,
      )

      expect(doc.id).toBeTruthy()
      expect(doc.sessionId).toBe('s1')
      expect(doc.filename).toBe('notes.txt')
      expect(doc.mimeType).toBe('text/plain')
      expect(doc.content).toBe('hello world')
      expect(doc.size).toBe(Buffer.byteLength('hello world', 'utf8'))
      expect(doc.uploadedAt).toBeGreaterThanOrEqual(before)
    })

    it('omits ingestStatus by default but persists it when supplied', async () => {
      const plain = await storeDocument(
        { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'x' },
        fake.callTool,
      )
      expect(plain.ingestStatus).toBeUndefined()

      // The upload gate persists 'pending' in this FIRST write so a status poll
      // can't read a no-status gap and flicker; it must round-trip from Redis.
      const pending = await storeDocument(
        {
          sessionId: 's1',
          filename: 'b.txt',
          mimeType: 'text/plain',
          content: 'y',
          ingestStatus: 'pending',
        },
        fake.callTool,
      )
      expect(pending.ingestStatus).toBe('pending')
      expect((await getDocument('s1', pending.id, fake.callTool))?.ingestStatus).toBe('pending')
    })

    it('writes to the namespaced key and registers the session index with a TTL', async () => {
      const doc = await storeDocument(
        {
          sessionId: 's1',
          filename: 'a.txt',
          mimeType: 'text/plain',
          content: 'x',
          id: 'fixed-id',
        },
        fake.callTool,
      )

      const jsonSet = fake.callTool.calls.find((c) => c[0] === 'json_set')!
      expect(jsonSet[1].name).toBe('stash:doc:s1:fixed-id')
      expect(jsonSet[1].expire_seconds).toBe(DEFAULT_TTL_SECONDS)

      const sadd = fake.callTool.calls.find((c) => c[0] === 'sadd')!
      expect(sadd[1].name).toBe('stash:docs:s1')
      expect(sadd[1].value).toBe('fixed-id')
      expect(sadd[1].expire_seconds).toBe(DEFAULT_TTL_SECONDS)
      expect(doc.id).toBe('fixed-id')
    })

    it('honours a custom TTL override', async () => {
      await storeDocument(
        {
          sessionId: 's1',
          filename: 'a.txt',
          mimeType: 'text/plain',
          content: 'x',
          ttlSeconds: 60,
        },
        fake.callTool,
      )
      const jsonSet = fake.callTool.calls.find((c) => c[0] === 'json_set')!
      expect(jsonSet[1].expire_seconds).toBe(60)
    })

    it('rejects content larger than the size limit', async () => {
      const huge = 'a'.repeat(MAX_CONTENT_BYTES + 1)
      await expect(
        storeDocument(
          { sessionId: 's1', filename: 'big', mimeType: 'text/plain', content: huge },
          fake.callTool,
        ),
      ).rejects.toThrow(/too large/i)
    })

    it('throws when the Redis write fails', async () => {
      const failing: CallTool = async () => ({ success: false, data: null, error: 'boom' })
      await expect(
        storeDocument(
          { sessionId: 's1', filename: 'a', mimeType: 'text/plain', content: 'x' },
          failing,
        ),
      ).rejects.toThrow(/boom/)
    })

    it('throws when the MCP reports success but Redis returned an error payload', async () => {
      // The Redis MCP can surface AUTH/WRONGTYPE failures as a `success: true`
      // text payload — a stored doc must not silently "succeed" in that case.
      const authFail: CallTool = async (name) =>
        name === 'json_set'
          ? {
              success: true,
              data: 'Error setting JSON value: AUTH <password> called without any password configured',
            }
          : { success: true, data: 1 }
      await expect(
        storeDocument(
          { sessionId: 's1', filename: 'a', mimeType: 'text/plain', content: 'x' },
          authFail,
        ),
      ).rejects.toThrow(/AUTH|Failed to store/)
    })
  })

  describe('redisWriteError', () => {
    it('passes clean success payloads (OK / count)', () => {
      expect(redisWriteError({ success: true, data: 'OK' })).toBeNull()
      expect(redisWriteError({ success: true, data: 1 })).toBeNull()
    })
    it('flags transport failures', () => {
      expect(redisWriteError({ success: false, data: null, error: 'boom' })).toBe('boom')
    })
    it('flags Redis errors smuggled in as success-data', () => {
      expect(redisWriteError({ success: true, data: 'Error doing thing: WRONGTYPE' })).toMatch(
        /WRONGTYPE/,
      )
      expect(
        redisWriteError({
          success: true,
          data: 'AUTH <password> called without any password configured',
        }),
      ).toMatch(/AUTH/)
      expect(redisWriteError({ success: true, data: { result: 'Error: NOAUTH' } })).toMatch(
        /NOAUTH/,
      )
    })
    it('does not false-positive on normal content containing the word later', () => {
      expect(redisWriteError({ success: true, data: 'stored without issue' })).toBeNull()
    })
  })

  describe('getDocument / getDocumentMeta', () => {
    it('round-trips a stored document, unwrapping the RedisJSON array', async () => {
      const stored = await storeDocument(
        { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'payload' },
        fake.callTool,
      )
      const got = await getDocument('s1', stored.id, fake.callTool)
      expect(got).toEqual(stored)
    })

    it('returns null for a missing document', async () => {
      expect(await getDocument('s1', 'nope', fake.callTool)).toBeNull()
    })

    it('getDocumentMeta omits the content field', async () => {
      const stored = await storeDocument(
        { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'secret' },
        fake.callTool,
      )
      const meta = await getDocumentMeta('s1', stored.id, fake.callTool)
      expect(meta).not.toBeNull()
      expect((meta as unknown as Record<string, unknown>).content).toBeUndefined()
      expect(meta!.filename).toBe('a.txt')
    })

    it('surfaces derivedText as a `converted` flag in meta, never the markdown itself', async () => {
      const stored = await storeDocument(
        {
          sessionId: 's1',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          content: 'Ym9keQ==',
          encoding: 'base64',
        },
        fake.callTool,
      )
      // No derivation yet → not converted.
      let meta = await getDocumentMeta('s1', stored.id, fake.callTool)
      expect(meta!.converted).toBeUndefined()

      // After the ingest converter persists derived markdown…
      await setDocumentFlags('s1', stored.id, { derivedText: '# Report\n\nBody.' }, fake.callTool)
      meta = await getDocumentMeta('s1', stored.id, fake.callTool)
      expect(meta!.converted).toBe(true)
      // The (potentially large) markdown must not ride along in the meta.
      expect((meta as unknown as Record<string, unknown>).derivedText).toBeUndefined()
      // …but the original base64 bytes are still on the full doc for download.
      const full = await getDocument('s1', stored.id, fake.callTool)
      expect(full!.encoding).toBe('base64')
      expect(full!.content).toBe('Ym9keQ==')
      expect(full!.derivedText).toBe('# Report\n\nBody.')
    })
  })

  describe('listDocuments', () => {
    it('lists metadata newest-first and never includes content', async () => {
      const d1 = await storeDocument(
        { sessionId: 's1', filename: 'first.txt', mimeType: 'text/plain', content: 'one' },
        fake.callTool,
      )
      // Force a later timestamp for the second doc.
      vi.spyOn(Date, 'now').mockReturnValue(d1.uploadedAt + 1000)
      const d2 = await storeDocument(
        { sessionId: 's1', filename: 'second.txt', mimeType: 'text/plain', content: 'two' },
        fake.callTool,
      )
      vi.restoreAllMocks()

      const list = await listDocuments('s1', fake.callTool)
      expect(list.map((d) => d.id)).toEqual([d2.id, d1.id])
      expect(list.every((d) => !('content' in d))).toBe(true)
    })

    it('prunes stale index entries whose keys have expired', async () => {
      const doc = await storeDocument(
        { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'x' },
        fake.callTool,
      )
      // Simulate the doc key expiring while the index still references it.
      fake.redis.json.delete(`stash:doc:s1:${doc.id}`)

      const list = await listDocuments('s1', fake.callTool)
      expect(list).toEqual([])
      // The index entry should have been removed.
      expect(fake.callTool.calls.some((c) => c[0] === 'srem' && c[1].value === doc.id)).toBe(true)
    })

    it('returns [] for an empty/unknown session', async () => {
      expect(await listDocuments('ghost', fake.callTool)).toEqual([])
    })

    // The live Redis MCP returns ONE text block per set member, so callTool
    // yields a *bare string* for a 1-member set (not an array). listDocuments
    // must still resolve it (regression: lists came back empty against the
    // real gateway because of a strict Array.isArray check).
    it('lists a single doc when smembers returns a bare member string', async () => {
      const stored = await storeDocument(
        { sessionId: 's1', filename: 'solo.txt', mimeType: 'text/plain', content: 'x' },
        fake.callTool,
      )
      const liveShape: CallTool = async (name, args) =>
        name === 'smembers'
          ? { success: true, data: stored.id } // bare string, not array
          : fake.callTool(name, args)

      const list = await listDocuments('s1', liveShape)
      expect(list.map((d) => d.id)).toEqual([stored.id])
    })

    it('lists docs when smembers returns a JSON-string array', async () => {
      await storeDocument(
        { sessionId: 's2', filename: 'a', mimeType: 'text/plain', content: 'x', id: 'id-a' },
        fake.callTool,
      )
      await storeDocument(
        { sessionId: 's2', filename: 'b', mimeType: 'text/plain', content: 'y', id: 'id-b' },
        fake.callTool,
      )
      const liveShape: CallTool = async (name, args) =>
        name === 'smembers'
          ? { success: true, data: JSON.stringify(['id-a', 'id-b']) } // JSON-string
          : fake.callTool(name, args)

      const list = await listDocuments('s2', liveShape)
      expect(list.map((d) => d.id).sort()).toEqual(['id-a', 'id-b'])
    })

    // Further shapes the gateway has been observed to return for `smembers`.
    // Each one previously read as "session has no documents", which silently
    // empties the panel rather than erroring.
    it.each([
      ['object-wrapped array', { result: ['id-a', 'id-b'] }],
      ['object-wrapped JSON string', { members: JSON.stringify(['id-a', 'id-b']) }],
      ['double-encoded JSON string', JSON.stringify(JSON.stringify(['id-a', 'id-b']))],
      ['array with non-string junk', ['id-a', 42, null, 'id-b']],
    ])('resolves the index when smembers returns a %s', async (_label, data) => {
      await storeDocument(
        { sessionId: 's3', filename: 'a', mimeType: 'text/plain', content: 'x', id: 'id-a' },
        fake.callTool,
      )
      await storeDocument(
        { sessionId: 's3', filename: 'b', mimeType: 'text/plain', content: 'y', id: 'id-b' },
        fake.callTool,
      )
      const liveShape: CallTool = async (name, args) =>
        name === 'smembers' ? { success: true, data } : fake.callTool(name, args)

      const list = await listDocuments('s3', liveShape)

      expect(list.map((d) => d.id).sort()).toEqual(['id-a', 'id-b'])
    })

    it.each([
      ['an empty string', ''],
      ['a whitespace-only string', '   '],
      ['an unparseable object wrapper', { result: 'not-json' }],
    ])('treats %s from smembers as an empty session', async (_label, data) => {
      const liveShape: CallTool = async (name, args) =>
        name === 'smembers' ? { success: true, data } : fake.callTool(name, args)

      expect(await listDocuments('s4', liveShape)).toEqual([])
    })

    it('returns [] when the index read itself fails', async () => {
      const broken: CallTool = async (name, args) =>
        name === 'smembers'
          ? { success: false, data: null, error: 'WRONGTYPE' }
          : fake.callTool(name, args)

      expect(await listDocuments('s1', broken)).toEqual([])
    })
  })

  describe('malformed reads', () => {
    it('treats a non-JSON json_get payload as a missing document', async () => {
      const broken: CallTool = async (name, args) =>
        name === 'json_get' ? { success: true, data: 'not-json-at-all' } : fake.callTool(name, args)

      expect(await getDocument('s1', 'doc-1', broken)).toBeNull()
    })

    it('treats an empty RedisJSON array as a missing document', async () => {
      const broken: CallTool = async (name, args) =>
        name === 'json_get' ? { success: true, data: [] } : fake.callTool(name, args)

      expect(await getDocument('s1', 'doc-1', broken)).toBeNull()
      expect(await getDocumentMeta('s1', 'doc-1', broken)).toBeNull()
    })
  })

  describe('write failures surface as errors', () => {
    it('throws when the session index cannot be updated', async () => {
      const broken: CallTool = async (name, args) =>
        name === 'sadd' ? { success: false, data: null, error: 'OOM' } : fake.callTool(name, args)

      await expect(
        storeDocument(
          { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'x' },
          broken,
        ),
      ).rejects.toThrow(/Failed to index document/)
    })

    it('throws when a flag edit cannot be written back', async () => {
      const doc = await storeDocument(
        { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'x' },
        fake.callTool,
      )
      let stored = false
      const brokenOnUpdate: CallTool = async (name, args) => {
        if (name === 'json_set' && stored) return { success: false, data: null, error: 'OOM' }
        if (name === 'json_set') stored = true
        return fake.callTool(name, args)
      }
      stored = true

      await expect(
        setDocumentFlags('s1', doc.id, { hidden: true }, brokenOnUpdate),
      ).rejects.toThrow(/Failed to update document/)
    })
  })

  describe('setDocumentFlags', () => {
    it('hides and archives a document in place', async () => {
      const doc = await storeDocument(
        { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'x' },
        fake.callTool,
      )

      const hidden = await setDocumentFlags('s1', doc.id, { hidden: true }, fake.callTool)
      expect(hidden!.hidden).toBe(true)

      const archived = await setDocumentFlags(
        's1',
        doc.id,
        { archived: true, hidden: false },
        fake.callTool,
      )
      expect(archived!.archived).toBe(true)
      expect(archived!.hidden).toBe(false)

      // Persisted, not just returned.
      const reread = await getDocument('s1', doc.id, fake.callTool)
      expect(reread!.archived).toBe(true)
    })

    it('returns null for a missing document', async () => {
      expect(await setDocumentFlags('s1', 'nope', { hidden: true }, fake.callTool)).toBeNull()
    })
  })

  describe('deleteDocument', () => {
    it('removes the document and its index entry', async () => {
      const doc = await storeDocument(
        { sessionId: 's1', filename: 'a.txt', mimeType: 'text/plain', content: 'x' },
        fake.callTool,
      )
      await deleteDocument('s1', doc.id, fake.callTool)

      expect(await getDocument('s1', doc.id, fake.callTool)).toBeNull()
      expect(await listDocuments('s1', fake.callTool)).toEqual([])

      const del = fake.callTool.calls.find((c) => c[0] === 'delete')!
      expect(del[1].key).toBe(`stash:doc:s1:${doc.id}`)
    })

    it('is idempotent for a non-existent document', async () => {
      await expect(deleteDocument('s1', 'nope', fake.callTool)).resolves.toBeUndefined()
    })

    // sf-H4. Neither write was checked, so the route above this answered
    // `ok: true` for a deletion that Redis rejected — a privacy-relevant "your
    // document is gone" that isn't. `storeDocument`/`setDocumentFlags` in this
    // same file have always checked; delete was the outlier.
    it('THROWS when the document key write is rejected', async () => {
      const callTool = (async (name: string) =>
        name === 'delete'
          ? { success: false, data: null, error: 'NOAUTH Authentication required' }
          : { success: true, data: 1 }) as CallTool

      await expect(deleteDocument('s1', 'doc-1', callTool)).rejects.toThrow(
        /Failed to delete document doc-1.*document: NOAUTH/,
      )
    })

    it('THROWS when the index entry write is rejected', async () => {
      const callTool = (async (name: string) =>
        name === 'srem'
          ? { success: false, data: null, error: 'WRONGTYPE' }
          : { success: true, data: 1 }) as CallTool

      // A key that went but stayed in the index is a phantom the panel keeps
      // listing, so this half is checked too.
      await expect(deleteDocument('s1', 'doc-1', callTool)).rejects.toThrow(
        /session index: WRONGTYPE/,
      )
    })

    it('names BOTH failures, and still attempts both writes', async () => {
      const seen: string[] = []
      const callTool = (async (name: string) => {
        seen.push(name)
        return { success: false, data: null, error: 'connection refused' }
      }) as CallTool

      await expect(deleteDocument('s1', 'doc-1', callTool)).rejects.toThrow(
        /document: connection refused; session index: connection refused/,
      )
      // The second write is attempted even after the first failed, so a retry
      // of a half-completed delete still converges.
      expect(seen).toEqual(['delete', 'srem'])
    })

    it('reports an error-shaped success payload as a failure', async () => {
      // `redisWriteError` demotes `"ERR ..."`-style text returned on a
      // success:true call — the shape the Redis MCP actually uses.
      const callTool = (async (name: string) =>
        name === 'delete'
          ? { success: true, data: 'ERROR: misconfigured' }
          : { success: true, data: 1 }) as CallTool

      await expect(deleteDocument('s1', 'doc-1', callTool)).rejects.toThrow(/misconfigured/)
    })
  })

  describe('toPriorResult', () => {
    it('maps a document to a PriorResult with a content preview', () => {
      const pr = toPriorResult({
        id: 'doc-1',
        sessionId: 's1',
        filename: 'report.md',
        mimeType: 'text/markdown',
        size: 12,
        uploadedAt: Date.now(),
        content: 'The quick brown fox',
      })
      expect(pr.ref_id).toBe('doc-1')
      expect(pr.tool).toBe('upload:report.md')
      expect(pr.summary).toContain('The quick brown fox')
      expect(pr.expanded_in_turn).toBeNull()
    })

    it('truncates long content with an ellipsis', () => {
      const pr = toPriorResult(
        {
          id: 'doc-1',
          sessionId: 's1',
          filename: 'long.txt',
          mimeType: 'text/plain',
          size: 100,
          uploadedAt: Date.now(),
          content: 'x'.repeat(500),
        },
        50,
      )
      expect(pr.summary.endsWith('…')).toBe(true)
      expect(pr.summary.length).toBeLessThanOrEqual(51)
    })

    it('falls back to a metadata summary when content is absent', () => {
      const pr = toPriorResult({
        id: 'doc-1',
        sessionId: 's1',
        filename: 'data.csv',
        mimeType: 'text/csv',
        size: 2048,
        uploadedAt: Date.now(),
      })
      expect(pr.summary).toContain('data.csv')
      expect(pr.summary).toContain('text/csv')
    })
  })

  describe('base64 encoding (#89)', () => {
    it('stores binary content with encoding=base64 and size = decoded bytes', async () => {
      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]) // 6 raw bytes
      const b64 = bytes.toString('base64')
      const doc = await storeDocument(
        {
          sessionId: 's1',
          filename: 'sheet.xlsx',
          mimeType: 'application/vnd.x',
          content: b64,
          encoding: 'base64',
        },
        fake.callTool,
      )
      expect(doc.encoding).toBe('base64')
      expect(doc.content).toBe(b64)
      // size reflects the ORIGINAL bytes, not the larger base64 string.
      expect(doc.size).toBe(bytes.length)
      expect(doc.size).toBeLessThan(b64.length)
    })

    it('round-trips a stored binary doc unchanged via getDocument', async () => {
      const bytes = Buffer.from([1, 2, 3, 250, 251, 252])
      const b64 = bytes.toString('base64')
      const stored = await storeDocument(
        {
          sessionId: 's1',
          filename: 'x.bin',
          mimeType: 'application/octet-stream',
          content: b64,
          encoding: 'base64',
        },
        fake.callTool,
      )
      const got = await getDocument('s1', stored.id, fake.callTool)
      expect(got?.encoding).toBe('base64')
      expect(Buffer.from(got!.content, 'base64').equals(bytes)).toBe(true)
    })

    it('toPriorResult uses a metadata preview for binary (never slices base64)', () => {
      const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
      const pr = toPriorResult({
        id: 'doc-9',
        sessionId: 's1',
        filename: 'chart.png',
        mimeType: 'image/png',
        size: 4,
        uploadedAt: Date.now(),
        encoding: 'base64',
        content: b64,
      })
      expect(pr.summary).toContain('chart.png')
      expect(pr.summary).toContain('image/png')
      expect(pr.summary).not.toContain(b64)
    })
  })
})
