/**
 * listDocumentSummariesStrict (#507 slice 10) — the metadata-only strict read the
 * Decide step's document list is built from.
 *
 * The fake emulates what RedisJSON does with a bracket-union path: it answers
 * the members in SELECTOR order and silently skips an absent one. Each pin names
 * the mutation that turns it red.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import { listDocumentSummariesStrict, type CallTool } from '../../stash/document-store.server'

type Doc = Record<string, unknown>
const body = 'SECRET-BODY-'.repeat(50)

function fake(docs: Record<string, Doc>, opts: { failGet?: string; failIndex?: boolean } = {}) {
  const ops: Array<[string, Record<string, unknown>]> = []
  const callTool: CallTool = async (name, args) => {
    ops.push([name, args])
    if (name === 'smembers') {
      return opts.failIndex
        ? { success: false, data: null, error: 'index down' }
        : { success: true, data: Object.keys(docs).concat('gone') }
    }
    if (name === 'srem') return { success: true, data: 1 }
    if (name === 'json_get') {
      const id = String(args.name).split(':').pop()!
      if (id === opts.failGet) return { success: false, data: null, error: 'timeout' }
      const doc = docs[id]
      if (!doc) return { success: true, data: null } // expired: a SUCCESSFUL empty read
      const path = String(args.path)
      const members = [...path.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
      // the reply is the union, in selector order, absent members skipped
      return {
        success: true,
        data: JSON.stringify(members.filter((m) => m in doc).map((m) => doc[m])),
      }
    }
    return { success: false, data: null, error: `unhandled ${name}` }
  }
  return { callTool, ops }
}

const meta = (extra: Doc = {}): Doc => ({
  id: 'x',
  sessionId: 's',
  filename: 'a.md',
  mimeType: 'text/markdown',
  size: 10,
  uploadedAt: 1,
  content: body,
  ...extra,
})

describe('listDocumentSummariesStrict', () => {
  // Mutation: read the whole document (`path: '$'`) as `listDocumentsStrict` does.
  it('reads only the summary members, never the content, one call per document', async () => {
    const { callTool, ops } = fake({ d1: meta(), d2: meta({ filename: 'b.csv' }) })
    const out = await listDocumentSummariesStrict('s', callTool)
    const gets = ops.filter(([n]) => n === 'json_get')
    expect(gets).toHaveLength(3) // d1, d2, and the expired 'gone'
    for (const [, args] of gets) {
      expect(String(args.path)).not.toBe('$')
      expect(String(args.path)).not.toMatch(/content|derivedText/)
    }
    expect(JSON.stringify(out)).not.toContain('SECRET-BODY')
  })

  // Mutation: read the optional members by position instead of by type.
  it('tells the optional members apart: ingestStatus is a string, flags are booleans, absent ones are skipped', async () => {
    const { callTool } = fake({
      plain: meta({ uploadedAt: 1 }),
      indexed: meta({ ingestStatus: 'indexed', uploadedAt: 2 }),
      hiddenOnly: meta({ hidden: true, uploadedAt: 3 }),
      archivedOnly: meta({ archived: true, uploadedAt: 4 }),
      both: meta({ ingestStatus: 'pending', hidden: false, archived: true, uploadedAt: 5 }),
    })
    const byId = Object.fromEntries(
      (await listDocumentSummariesStrict('s', callTool)).map((d) => [d.id, d]),
    )
    expect(byId.plain.excluded).toBe(false)
    expect(byId.plain).not.toHaveProperty('ingestStatus')
    expect(byId.indexed).toMatchObject({ excluded: false, ingestStatus: 'indexed' })
    expect(byId.hiddenOnly.excluded).toBe(true)
    expect(byId.archivedOnly.excluded).toBe(true)
    expect(byId.both).toMatchObject({ excluded: true, ingestStatus: 'pending' })
  })

  it('lists newest first', async () => {
    const { callTool } = fake({ old: meta({ uploadedAt: 1 }), new: meta({ uploadedAt: 9 }) })
    expect((await listDocumentSummariesStrict('s', callTool)).map((d) => d.id)).toEqual([
      'new',
      'old',
    ])
  })

  // Mutation: swallow the failure (return []), as `listDocuments` does.
  it('a failed index read throws', async () => {
    const { callTool } = fake({}, { failIndex: true })
    await expect(listDocumentSummariesStrict('s', callTool)).rejects.toThrow(/index read failed/)
  })

  // Mutation: srem on any non-document, not only after a successful empty read.
  it('a failed document read throws and prunes nothing', async () => {
    const { callTool, ops } = fake({ d1: meta(), d2: meta() }, { failGet: 'd2' })
    await expect(listDocumentSummariesStrict('s', callTool)).rejects.toThrow(/stash read failed/)
    expect(ops.map(([n]) => n)).not.toContain('srem')
  })

  // Mutation: treat an unreadable reply as an absent document (and prune it).
  it.each([
    ['not JSON', 'Error: WRONGTYPE'],
    ['an empty array', '[]'],
    ['a wrong-typed member', JSON.stringify([7, 'text/plain', 1, 1])],
    ['an order this read does not expect', JSON.stringify(['a.md', 'text/plain', 'indexed', 1, 2])],
    ['an unknown ingest status', JSON.stringify(['a.md', 'text/plain', 1, 1, 'weird'])],
    ['a stray extra member', JSON.stringify(['a.md', 'text/plain', 1, 1, true, true, true])],
  ])('an unreadable reply (%s) throws and prunes nothing', async (_what, data) => {
    const ops: string[] = []
    const callTool: CallTool = async (name) => {
      ops.push(name)
      if (name === 'smembers') return { success: true, data: ['d1'] }
      return { success: true, data }
    }
    await expect(listDocumentSummariesStrict('s', callTool)).rejects.toThrow(/unreadable/)
    expect(ops).not.toContain('srem')
  })

  // Mutation: remove the prune (the index would keep naming expired documents).
  it('prunes the index only for a document whose read SUCCEEDED and found nothing', async () => {
    const { callTool, ops } = fake({ d1: meta() })
    await listDocumentSummariesStrict('s', callTool)
    const srems = ops.filter(([n]) => n === 'srem')
    expect(srems).toHaveLength(1)
    expect(srems[0][1]).toMatchObject({ value: 'gone' })
  })

  // Mutation: ignore the signal.
  it('stops between reads when aborted, before the next call and any prune', async () => {
    const { callTool, ops } = fake({ d1: meta(), d2: meta() })
    const ac = new AbortController()
    const wrapped: CallTool = async (name, args) => {
      const r = await callTool(name, args)
      if (name === 'json_get') ac.abort()
      return r
    }
    await expect(listDocumentSummariesStrict('s', wrapped, ac.signal)).rejects.toThrow()
    expect(ops.filter(([n]) => n === 'json_get')).toHaveLength(1)
    expect(ops.map(([n]) => n)).not.toContain('srem')
  })
})
