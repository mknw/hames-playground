/**
 * Direct-Redis adapter tests — `makeDirectCallTool` (the ioredis-backed
 * `CallTool` used by the Data Stash when `STASH_DIRECT_REDIS=1`).
 *
 * A hand-rolled fake ioredis (no socket) drives each tool case; the assertions
 * check the return SHAPES the existing parsers rely on — most importantly that
 * a `vector_search_hash` reply flows through the real `createVectorStore`/
 * `parseHits` to identical `VectorHit`s, and that the FLOAT32 blob is
 * byte-exact (so a direct KNN matches gateway-written vectors).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
// redis-direct imports the gateway callTool for `stashCallTool`'s off-branch;
// stub it so no real gateway is touched on import.
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import { makeDirectCallTool } from '../../lib/redis-direct.server'
import { createVectorStore, encodeMeta } from '@hames-ai/harness-patterns/stash/vector-store.server'
import type { Redis } from 'ioredis'

// ----------------------------------------------------------------------------
// Fake ioredis — records ops; canned replies for module commands.
// ----------------------------------------------------------------------------
function makeFakeIoredis(
  opts: { jsonGet?: unknown; smembers?: string[]; scanPages?: Array<[string, string[]]> } = {},
) {
  const ops: Array<[string, unknown[]]> = []
  const scanPages = [...(opts.scanPages ?? [])]
  let ftSearch: unknown = [0]
  let ftCreateErr: Error | null = null
  const fake = {
    ops,
    setFtSearch(r: unknown) {
      ftSearch = r
    },
    setFtCreateErr(e: Error | null) {
      ftCreateErr = e
    },
    call: async (cmd: string, ...args: unknown[]) => {
      ops.push([`call:${cmd}`, args])
      switch (cmd) {
        case 'FT.CREATE':
          if (ftCreateErr) throw ftCreateErr
          return 'OK'
        case 'FT.SEARCH':
          return ftSearch
        case 'JSON.SET':
          return 'OK'
        case 'JSON.GET':
          return opts.jsonGet ?? null
        default:
          return null
      }
    },
    hset: async (...args: unknown[]) => {
      ops.push(['hset', args])
      return 1
    },
    sadd: async (...args: unknown[]) => {
      ops.push(['sadd', args])
      return 1
    },
    smembers: async (...args: unknown[]) => {
      ops.push(['smembers', args])
      return opts.smembers ?? []
    },
    srem: async (...args: unknown[]) => {
      ops.push(['srem', args])
      return 1
    },
    del: async (...args: unknown[]) => {
      ops.push(['del', args])
      return 1
    },
    expire: async (...args: unknown[]) => {
      ops.push(['expire', args])
      return 1
    },
    scan: async (...args: unknown[]) => {
      ops.push(['scan', args])
      return scanPages.shift() ?? ['0', []]
    },
  }
  return fake
}

const asRedis = (f: ReturnType<typeof makeFakeIoredis>) => f as unknown as Redis

describe('redis-direct adapter', () => {
  it('set_vector_in_hash stores a byte-exact little-endian FLOAT32 blob', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))
    const res = await ct('set_vector_in_hash', { name: 'stashvec:s:t:d:0', vector: [1, 2, 3.5] })
    expect(res).toEqual({ success: true, data: true })

    const hset = fake.ops.find(([m]) => m === 'hset')!
    const [key, field, value] = hset[1] as [string, string, Buffer]
    expect(key).toBe('stashvec:s:t:d:0')
    expect(field).toBe('vector')
    const expected = Buffer.alloc(12)
    expected.writeFloatLE(1, 0)
    expected.writeFloatLE(2, 4)
    expected.writeFloatLE(3.5, 8)
    expect(Buffer.isBuffer(value)).toBe(true)
    expect((value as Buffer).equals(expected)).toBe(true)
  })

  it('vector_search_hash → parseHits yields identical VectorHits (via createVectorStore)', async () => {
    const fake = makeFakeIoredis()
    const store = createVectorStore({
      indexName: 'idx',
      prefix: 'stashvec:s:t:',
      dim: 3,
      callTool: makeDirectCallTool(asRedis(fake)),
    })
    // Flat RESP2 reply: [total, key, [field, val, ...]].
    fake.setFtSearch([
      1,
      'stashvec:s:t:d1:0',
      [
        'meta',
        encodeMeta({ content: 'hello', doc_id: 'd1', chunk_index: 0, _vid: 'd1:0' }),
        'score',
        '0.25',
      ],
    ])
    const hits = await store.search([1, 2, 3], 5)
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('d1:0')
    expect(hits[0].payload.content).toBe('hello')
    expect(hits[0].score).toBe(0.25)
  })

  it('vector_search_hash returns [] for an empty result set', async () => {
    const fake = makeFakeIoredis()
    const store = createVectorStore({
      indexName: 'idx',
      prefix: 'p:',
      dim: 3,
      callTool: makeDirectCallTool(asRedis(fake)),
    })
    fake.setFtSearch([0])
    expect(await store.search([1, 2, 3], 5)).toEqual([])
  })

  it('create_vector_index_hash tolerates "already exists" but rethrows other errors', async () => {
    const fake = makeFakeIoredis()
    const store = createVectorStore({
      indexName: 'idx',
      prefix: 'p:',
      dim: 3,
      callTool: makeDirectCallTool(asRedis(fake)),
    })
    fake.setFtCreateErr(new Error('Index already exists'))
    await expect(store.ensureIndex()).resolves.toBeUndefined()

    fake.setFtCreateErr(new Error('WRONGTYPE bad key'))
    await expect(store.ensureIndex()).rejects.toThrow(/WRONGTYPE|Failed to create/)
  })

  it('json_get returns {data:null} for a missing key', async () => {
    const ct = makeDirectCallTool(asRedis(makeFakeIoredis({ jsonGet: null })))
    expect(await ct('json_get', { name: 'nope', path: '$' })).toEqual({ success: true, data: null })
  })

  it('json_set returns "OK" and applies expire when given', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))
    const res = await ct('json_set', { name: 'k', path: '$', value: '{"a":1}', expire_seconds: 60 })
    expect(res).toEqual({ success: true, data: 'OK' })
    expect(fake.ops.some(([m, a]) => m === 'expire' && (a as unknown[])[0] === 'k')).toBe(true)
  })

  it('delete uses args.key (not args.name)', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))
    await ct('delete', { key: 'stash:doc:s:d1' })
    const del = fake.ops.find(([m]) => m === 'del')!
    expect((del[1] as unknown[])[0]).toBe('stash:doc:s:d1')
  })

  it('smembers passes through the set members as an array', async () => {
    const ct = makeDirectCallTool(asRedis(makeFakeIoredis({ smembers: ['a', 'b'] })))
    expect(await ct('smembers', { name: 'stash:docs:s' })).toEqual({
      success: true,
      data: ['a', 'b'],
    })
  })

  it('sadd adds the member and returns the insert count', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    expect(await ct('sadd', { name: 'stash:docs:s', value: 'd1' })).toEqual({
      success: true,
      data: 1,
    })
    expect(fake.ops.find(([m]) => m === 'sadd')![1]).toEqual(['stash:docs:s', 'd1'])
    // No TTL asked for → none applied (the session index must not silently expire).
    expect(fake.ops.some(([m]) => m === 'expire')).toBe(false)
  })

  it('sadd applies a TTL only when expire_seconds is given', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    await ct('sadd', { name: 'stash:docs:s', value: 'd1', expire_seconds: 3600 })

    expect(fake.ops.find(([m]) => m === 'expire')![1]).toEqual(['stash:docs:s', 3600])
  })

  it('srem removes the member from the session index', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    expect(await ct('srem', { name: 'stash:docs:s', value: 'd1' })).toEqual({
      success: true,
      data: 1,
    })
    expect(fake.ops.find(([m]) => m === 'srem')![1]).toEqual(['stash:docs:s', 'd1'])
  })

  it('scan_all_keys walks the cursor to the end and returns each key once', async () => {
    const fake = makeFakeIoredis({
      scanPages: [
        ['17', ['stashvec:s:a', 'stashvec:s:b']],
        ['0', ['stashvec:s:b', 'stashvec:s:c']],
      ],
    })
    const ct = makeDirectCallTool(asRedis(fake))

    expect(await ct('scan_all_keys', { pattern: 'stashvec:s:*', batch_size: 500 })).toEqual({
      success: true,
      data: ['stashvec:s:a', 'stashvec:s:b', 'stashvec:s:c'],
    })
    expect(fake.ops.filter(([m]) => m === 'scan').map(([, a]) => a)).toEqual([
      ['0', 'MATCH', 'stashvec:s:*', 'COUNT', 500],
      ['17', 'MATCH', 'stashvec:s:*', 'COUNT', 500],
    ])
  })

  it('expire uses args.name + numeric expire_seconds', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    expect(await ct('expire', { name: 'stash:doc:s:d1', expire_seconds: '120' })).toEqual({
      success: true,
      data: 1,
    })
    expect(fake.ops.find(([m]) => m === 'expire')![1]).toEqual(['stash:doc:s:d1', 120])
  })

  it('hset writes the named field and honours expire_seconds', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    expect(await ct('hset', { name: 'k', key: 'meta', value: 'YmFzZTY0' })).toEqual({
      success: true,
      data: 1,
    })
    expect(fake.ops.find(([m]) => m === 'hset')![1]).toEqual(['k', 'meta', 'YmFzZTY0'])

    await ct('hset', { name: 'k', key: 'meta', value: 'YmFzZTY0', expire_seconds: 60 })
    expect(fake.ops.find(([m]) => m === 'expire')![1]).toEqual(['k', 60])
  })

  it('create_vector_index_hash declares the FLOAT32 vector + meta schema', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    expect(
      await ct('create_vector_index_hash', {
        index_name: 'idx',
        prefix: 'stashvec:s:t:',
        dim: 1024,
      }),
    ).toEqual({ success: true, data: 'OK' })

    const args = fake.ops.find(([m]) => m === 'call:FT.CREATE')![1] as string[]
    expect(args.slice(0, 6)).toEqual(['idx', 'ON', 'HASH', 'PREFIX', '1', 'stashvec:s:t:'])
    expect(args).toContain('FLOAT32')
    expect(args[args.indexOf('DIM') + 1]).toBe('1024')
    // Metric defaults to COSINE, matching what the gateway path wrote.
    expect(args[args.indexOf('DISTANCE_METRIC') + 1]).toBe('COSINE')
  })

  it('reports an unhandled tool as a failed result rather than throwing', async () => {
    const ct = makeDirectCallTool(asRedis(makeFakeIoredis()))

    expect(await ct('publish', { channel: 'x' })).toEqual({
      success: false,
      data: null,
      error: 'redis-direct: unhandled tool "publish"',
    })
  })

  it('turns a redis failure into a failed result carrying the message', async () => {
    const fake = makeFakeIoredis()
    fake.setFtCreateErr(new Error('boom'))
    const ct = makeDirectCallTool(asRedis(fake))

    expect(
      await ct('create_vector_index_hash', { index_name: 'idx', prefix: 'p', dim: 3 }),
    ).toEqual({ success: false, data: null, error: 'boom' })
  })

  it('skips rows whose fields are not an array (defensive against a RESP shape change)', async () => {
    const fake = makeFakeIoredis()
    fake.setFtSearch([1, 'stashvec:s:t:d1:0', 'not-an-array'])
    const ct = makeDirectCallTool(asRedis(fake))

    const res = await ct('vector_search_hash', { index_name: 'idx', query_vector: [1, 2, 3], k: 1 })

    expect(res.success).toBe(true)
    expect(res.data).toEqual([{ id: 'stashvec:s:t:d1:0' }])
  })

  it('passes a caller-supplied filter into the KNN query (dedup hook)', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    await ct('vector_search_hash', {
      index_name: 'idx',
      query_vector: [1, 2, 3],
      k: 3,
      filter: '@session_ids:{s1}',
    })

    const args = fake.ops.find(([m]) => m === 'call:FT.SEARCH')![1] as unknown[]
    expect(args[1]).toBe('@session_ids:{s1}=>[KNN 3 @vector $BLOB AS score]')
  })

  it('defaults to an unfiltered KNN of 5 when neither filter nor k is given', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    await ct('vector_search_hash', { index_name: 'idx', query_vector: [1, 2, 3] })

    const args = fake.ops.find(([m]) => m === 'call:FT.SEARCH')![1] as unknown[]
    expect(args[1]).toBe('*=>[KNN 5 @vector $BLOB AS score]')
  })
})

/**
 * Escaping pin for the BM25 keyword path (RV967, #928 slice 1).
 *
 * `keywordSearch` reduces user text to `[\p{L}\p{N}]+` tokens joined by ` | `
 * before the string reaches RediSearch's query syntax. Raw text is a syntax
 * error today (RediSearch: `Syntax error at offset 5 near hello`) and a bare
 * `*` returns the WHOLE corpus, so the composition is the control. This pin
 * holds exactly that: every hostile input either makes NO `FT.SEARCH` call
 * (empty / all-punctuation query) or composes a query whose every
 * ` | `-separated term is letters and numbers only — no operators, `@field`,
 * wildcards, braces, quotes, comments, bidi or control characters survive.
 * Deleting the tokenize-and-join in `redis-direct.server.ts` turns this
 * describe red (verified by mutation).
 */
describe('keyword_search_hash — user text is tokenized before RediSearch sees it', () => {
  const HOSTILE_QUERIES = [
    '*@meta:secret', // wildcard + @field:term
    'hello) | (malicious', // group + union injection
    '%GP%',
    '" OR "1', // quoted operator injection
    '; --', // terminator + comment
    '{a | b}', // braces
    '*) AND (*', // wildcard pair with boolean
    'secret\u200Flabel\u202Eevil', // RTL override + mark (bidi)
    'q\u0007uery\u0001ctrl', // BEL + control character
    ' caf\u00e9 世界 ', // accented + CJK are LEGITIMATE tokens and must survive
    'hello world', // ordinary text still splits into unioned tokens
    // Punctuation-only / empty: no term survives, so NO FT.SEARCH call at all.
    '*',
    '!!!???',
    '%%%.%',
    '',
  ]

  const isPlainToken = (t: string) => /^[\p{L}\p{N}]+$/u.test(t)

  it('composes only [\\p{L}\\p{N}]+ tokens joined by " | " — or no FT.SEARCH at all', async () => {
    for (const query of HOSTILE_QUERIES) {
      const fake = makeFakeIoredis()
      const ct = makeDirectCallTool(asRedis(fake))

      const res = await ct('keyword_search_hash', { index_name: 'idx', query, k: 5 })
      expect(res.success).toBe(true)

      const searches = fake.ops.filter(([m]) => m === 'call:FT.SEARCH')
      if (searches.length === 0) continue // empty / all-punctuation: nothing sent

      expect(searches).toHaveLength(1)
      const composed = (searches[0]![1] as unknown[])[1] as string
      const terms = composed.split(' | ')
      expect(terms.length).toBeGreaterThan(0)
      for (const term of terms) {
        expect(isPlainToken(term)).toBe(true)
      }
    }
  })

  it('sends the user terms verbatim as the FT.SEARCH query argument (no raw pass-through)', async () => {
    const fake = makeFakeIoredis()
    const ct = makeDirectCallTool(asRedis(fake))

    await ct('keyword_search_hash', { index_name: 'idx', query: 'hello world', k: 5 })

    const args = fake.ops.find(([m]) => m === 'call:FT.SEARCH')![1] as unknown[]
    expect(args[1]).toBe('hello | world')
  })
})
