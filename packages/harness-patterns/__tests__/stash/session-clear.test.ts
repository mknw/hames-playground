/**
 * Clearing a session's stash: documents, chunk records, index entry and the
 * recorded embedding space, against an in-memory Redis behind a fake `callTool`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import { deleteSessionStash, ingestDocument } from '../../stash/document-ingest.server'
import {
  storeDocument,
  listSessionDocumentIds,
  type CallTool,
  type StashDocument,
} from '../../stash/document-store.server'
import type { ToolCallResult } from '../../types'

function makeFakeRedis() {
  const keys = new Map<string, unknown>() // json docs, space records, vector hashes
  const sets = new Map<string, Set<string>>()
  const calls: Array<[string, Record<string, unknown>]> = []
  let failOn: ((name: string, args: Record<string, unknown>) => string | null) | null = null

  const callTool: CallTool = async (name, args): Promise<ToolCallResult> => {
    calls.push([name, args])
    const failure = failOn?.(name, args)
    if (failure) return { success: false, data: null, error: failure }
    switch (name) {
      case 'json_set':
        keys.set(args.name as string, JSON.parse(args.value as string))
        return { success: true, data: 'OK' }
      case 'json_get': {
        const v = keys.get(args.name as string)
        return { success: true, data: v == null ? null : [v] }
      }
      case 'sadd': {
        const k = args.name as string
        sets.set(k, (sets.get(k) ?? new Set()).add(args.value as string))
        return { success: true, data: 1 }
      }
      case 'smembers':
        return { success: true, data: [...(sets.get(args.name as string) ?? [])] }
      case 'srem': {
        const set = sets.get(args.name as string)
        set?.delete(args.value as string)
        if (set?.size === 0) sets.delete(args.name as string)
        return { success: true, data: 1 }
      }
      case 'delete':
        keys.delete(args.key as string)
        return { success: true, data: 1 }
      case 'create_vector_index_hash':
        return { success: true, data: 'OK' }
      case 'set_vector_in_hash':
      case 'hset':
        keys.set(args.name as string, 'hash')
        return { success: true, data: 1 }
      case 'scan_all_keys': {
        const re = new RegExp(
          '^' +
            (args.pattern as string)
              .replace(/\\(.)/g, (_m, c: string) => `\u0000${c.charCodeAt(0)}\u0000`)
              .replace(/[.+^${}()|]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\u0000(\d+)\u0000/g, (_m, c: string) =>
                String.fromCharCode(Number(c)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              ) +
            '$',
        )
        return { success: true, data: [...keys.keys()].filter((k) => re.test(k)) }
      }
      default:
        return { success: false, data: null, error: `unhandled tool ${name}` }
    }
  }
  return {
    keys,
    sets,
    calls,
    callTool,
    failOn: (f: typeof failOn) => {
      failOn = f
    },
  }
}

const embedFn = async (texts: string[]) => ({
  vectors: texts.map(() => [1, 0, 0, 0]),
  provider: 'local' as const,
  model: 'fake-model',
  dimensions: 4,
})

/** Store one document and ingest it, so it has a doc key, an index entry, chunks and a space. */
async function stash(fake: ReturnType<typeof makeFakeRedis>, sessionId: string) {
  const doc: StashDocument = await storeDocument(
    {
      sessionId,
      filename: 'a.txt',
      mimeType: 'text/plain',
      content: 'one paragraph.\n\nanother paragraph.',
    },
    fake.callTool,
  )
  await ingestDocument(doc, {
    callTool: fake.callTool,
    embedFn,
    chunk: { maxChars: 20, overlap: 0, strategy: 'paragraph' },
  })
  return doc
}

describe('deleteSessionStash', () => {
  let fake: ReturnType<typeof makeFakeRedis>
  beforeEach(() => {
    fake = makeFakeRedis()
  })

  it('removes documents, chunk records, the index entry and the embedding space', async () => {
    const doc = await stash(fake, 's1')
    const before = [...fake.keys.keys()]
    expect(before.some((k) => k.startsWith('stashvec:s1:'))).toBe(true)
    expect(before).toContain('stash:space:s1')

    await deleteSessionStash('s1', fake.callTool)

    expect([...fake.keys.keys()]).toEqual([])
    expect(await listSessionDocumentIds('s1', fake.callTool)).toEqual([])
    expect(fake.keys.has(`stash:doc:s1:${doc.id}`)).toBe(false)
  })

  it('touches nothing of another session, including one whose id extends this one', async () => {
    const other = await stash(fake, 's1:x')
    const peer = await stash(fake, 's2')
    const othersBefore = [...fake.keys.keys()].sort()
    await stash(fake, 's1')

    await deleteSessionStash('s1', fake.callTool)

    expect([...fake.keys.keys()].sort()).toEqual(othersBefore)
    expect(await listSessionDocumentIds('s1:x', fake.callTool)).toEqual([other.id])
    expect(await listSessionDocumentIds('s2', fake.callTool)).toEqual([peer.id])
  })

  it('escapes glob characters in the session id', async () => {
    await stash(fake, 's*')
    await stash(fake, 'sa')
    await deleteSessionStash('s*', fake.callTool)
    const scan = fake.calls.find(([n]) => n === 'scan_all_keys')!
    expect(scan[1].pattern).toBe('stashvec:s\\*:*')
    expect([...fake.keys.keys()].every((k) => !k.includes('s*'))).toBe(true)
    expect([...fake.keys.keys()].some((k) => k.startsWith('stashvec:sa:'))).toBe(true)
  })

  it('is idempotent: a second clear finds nothing and succeeds', async () => {
    await stash(fake, 's1')
    await deleteSessionStash('s1', fake.callTool)
    await expect(deleteSessionStash('s1', fake.callTool)).resolves.toBeUndefined()
    expect(fake.keys.size).toBe(0)
  })

  it('attempts every step when one fails, then reports the failure', async () => {
    await stash(fake, 's1')
    fake.failOn((name, args) =>
      name === 'delete' && String(args.key).startsWith('stash:doc:') ? 'boom' : null,
    )
    await expect(deleteSessionStash('s1', fake.callTool)).rejects.toThrow(/document .*boom/)
    // The chunks and the space went even though the document delete failed.
    expect([...fake.keys.keys()].some((k) => k.startsWith('stashvec:'))).toBe(false)
    expect(fake.keys.has('stash:space:s1')).toBe(false)
  })

  it('reports an unreadable index or a failed scan instead of passing for empty', async () => {
    await stash(fake, 's1')
    fake.failOn((name) => (name === 'smembers' || name === 'scan_all_keys' ? 'down' : null))
    const err = await deleteSessionStash('s1', fake.callTool).catch((e: Error) => e)
    expect(String(err)).toMatch(/documents: .*down/)
    expect(String(err)).toMatch(/chunks: down/)
  })
})
