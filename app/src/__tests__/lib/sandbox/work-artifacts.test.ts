/**
 * work-artifacts tests — hydrate (store → /work/in) and promote
 * (/work/out → store), with the document store mocked and a simulated `/work`
 * transport. Verifies routing (which docs land where), the text/binary encoding
 * decision, and that promotion only stores files changed since the baseline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../lib/document-store.server', () => ({
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  storeDocument: vi.fn(async () => ({})),
}))

import type { McpTransport } from '../../../lib/sandbox/types'
import type { ToolCallResult } from '../../../lib/harness-patterns/types'
import { listDocuments, getDocument, storeDocument } from '../../../lib/document-store.server'
import {
  hydrateWorkspace,
  promoteOutputs,
  snapshotOutputs,
} from '../../../lib/sandbox/work-artifacts.server'

const unq = (s: string): string => s.replace(/^'|'$/g, '').replace(/'\\''/g, "'")
function bashOk(stdout = ''): ToolCallResult {
  return { success: true, data: { stdout, stderr: '', exit_code: 0, timed_out: false } }
}

function makeFsTransport() {
  const fs = new Map<string, string>()
  const runBash = (cmd: string): ToolCallResult => {
    let m = /^base64 -d (\S+) > (\S+) && rm -f (\S+)$/.exec(cmd)
    if (m) {
      fs.set(unq(m[2]), Buffer.from(fs.get(unq(m[1])) ?? '', 'base64').toString('latin1'))
      fs.delete(unq(m[3]))
      return bashOk()
    }
    m = /^base64 -w 0 (\S+) > (\S+)$/.exec(cmd)
    if (m) {
      fs.set(unq(m[2]), Buffer.from(fs.get(unq(m[1])) ?? '', 'latin1').toString('base64'))
      return bashOk()
    }
    m = /cd (\S+) && find \. -type f/.exec(cmd)
    if (m) {
      const dir = unq(m[1]).replace(/\/$/, '')
      const lines: string[] = []
      for (const [p, content] of fs) {
        if (p.startsWith(dir + '/')) {
          const hash = createHash('sha256').update(Buffer.from(content, 'latin1')).digest('hex')
          lines.push(`${hash}  ./${p.slice(dir.length + 1)}`)
        }
      }
      return bashOk(lines.join('\n'))
    }
    return bashOk()
  }
  const transport: McpTransport = {
    vmId: 'vm',
    toolNames: async () => [],
    listTools: async () => [],
    ownsTool: (n) => n.startsWith('sandbox_'),
    close: async () => {},
    callTool: async (name, args): Promise<ToolCallResult> => {
      if (name === 'sandbox_write') {
        fs.set(args.path as string, args.content as string)
        return { success: true, data: 'ok' }
      }
      if (name === 'sandbox_read') {
        const p = args.path as string
        return fs.has(p)
          ? { success: true, data: fs.get(p) }
          : { success: false, data: null, error: 'nf' }
      }
      if (name === 'sandbox_bash') return runBash(args.command as string)
      return { success: false, data: null, error: 'unknown' }
    },
  }
  return { transport, fs }
}

beforeEach(() => vi.clearAllMocks())

describe('hydrateWorkspace', () => {
  it('writes visible docs into /work/in (text verbatim, binary decoded) and skips hidden/archived', async () => {
    vi.mocked(listDocuments).mockResolvedValue([
      {
        id: 'd1',
        sessionId: 's',
        filename: 'data.csv',
        mimeType: 'text/csv',
        size: 3,
        uploadedAt: 1,
      },
      {
        id: 'd2',
        sessionId: 's',
        filename: 'sheet.xlsx',
        mimeType: 'application/vnd…',
        size: 4,
        uploadedAt: 2,
        encoding: 'base64',
      },
      {
        id: 'd3',
        sessionId: 's',
        filename: 'old.txt',
        mimeType: 'text/plain',
        size: 1,
        uploadedAt: 3,
        hidden: true,
      },
    ] as never)
    const xlsxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // "PK.." zip/xlsx magic
    vi.mocked(getDocument).mockImplementation(async (_s, id) => {
      if (id === 'd1')
        return {
          id: 'd1',
          sessionId: 's',
          filename: 'data.csv',
          mimeType: 'text/csv',
          size: 3,
          uploadedAt: 1,
          content: 'a,b',
        } as never
      if (id === 'd2')
        return {
          id: 'd2',
          sessionId: 's',
          filename: 'sheet.xlsx',
          mimeType: 'x',
          size: 4,
          uploadedAt: 2,
          encoding: 'base64',
          content: xlsxBytes.toString('base64'),
        } as never
      return null
    })

    const { transport, fs } = makeFsTransport()
    const { written, skipped } = await hydrateWorkspace(transport, 's', (async () => ({
      success: true,
      data: null,
    })) as never)

    expect(written).toBe(2) // d3 skipped (hidden)
    // Hidden/archived is a deliberate exclusion, not a failure.
    expect(skipped).toEqual([])
    expect(fs.get('/work/in/data.csv')).toBe('a,b')
    expect(fs.get('/work/in/sheet.xlsx')).toBe(xlsxBytes.toString('latin1'))
    expect(fs.has('/work/in/old.txt')).toBe(false)
    // getDocument never fetched the hidden doc.
    expect(vi.mocked(getDocument)).not.toHaveBeenCalledWith('s', 'd3', expect.anything())
  })

  it('reports a doc whose body has gone missing between list and fetch (sf-L8)', async () => {
    vi.mocked(listDocuments).mockResolvedValue([
      {
        id: 'd1',
        sessionId: 's',
        filename: 'gone.csv',
        mimeType: 'text/csv',
        size: 3,
        uploadedAt: 1,
      },
      {
        id: 'd2',
        sessionId: 's',
        filename: 'here.csv',
        mimeType: 'text/csv',
        size: 3,
        uploadedAt: 2,
      },
    ] as never)
    vi.mocked(getDocument).mockImplementation(async (_s, id) =>
      id === 'd2'
        ? ({
            id: 'd2',
            sessionId: 's',
            filename: 'here.csv',
            mimeType: 'text/csv',
            size: 3,
            uploadedAt: 2,
            content: 'a,b',
          } as never)
        : null,
    )

    const { transport, fs } = makeFsTransport()
    const { written, skipped } = await hydrateWorkspace(transport, 's', (async () => ({
      success: true,
      data: null,
    })) as never)

    expect(written).toBe(1)
    expect(fs.has('/work/in/gone.csv')).toBe(false)
    expect(fs.get('/work/in/here.csv')).toBe('a,b')
    // The missing one is NAMED rather than silently dropped: the agent has been
    // told the file exists and will not find it in /work/in.
    expect(skipped).toEqual([{ filename: 'gone.csv', error: 'document not found in store' }])
  })
})

describe('snapshotOutputs', () => {
  it('hashes the contents of /work/out so a later promote can diff against it', async () => {
    const { transport, fs } = makeFsTransport()
    fs.set('/work/out/report.csv', 'x,y')
    fs.set('/work/in/ignored.csv', 'not an output') // /work/in is not snapshotted

    const snap = await snapshotOutputs(transport)

    expect([...snap.keys()]).toEqual(['report.csv'])
    expect(snap.get('report.csv')).toBe(
      createHash('sha256').update(Buffer.from('x,y', 'latin1')).digest('hex'),
    )
  })
})

describe('promoteOutputs', () => {
  it('stores only files new/changed since baseline, with correct text/binary encoding', async () => {
    const { transport, fs } = makeFsTransport()
    // report.csv is new; chart.png is new binary; notes.md is unchanged vs baseline.
    fs.set('/work/out/report.csv', 'x,y\n1,2')
    fs.set('/work/out/notes.md', '# unchanged')
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    fs.set('/work/out/chart.png', pngBytes.toString('latin1'))

    const notesHash = createHash('sha256')
      .update(Buffer.from('# unchanged', 'latin1'))
      .digest('hex')
    const baseline = new Map([['notes.md', notesHash]])

    const { promoted, skipped } = await promoteOutputs(transport, 's', baseline, (async () => ({
      success: true,
      data: null,
    })) as never)

    expect(promoted.sort()).toEqual(['chart.png', 'report.csv'])
    expect(skipped).toEqual([])
    const calls = vi.mocked(storeDocument).mock.calls.map((c) => c[0])
    const csv = calls.find((c) => c.filename === 'report.csv')!
    const png = calls.find((c) => c.filename === 'chart.png')!
    expect(csv.mimeType).toBe('text/csv')
    expect(csv.encoding).toBeUndefined()
    expect(csv.content).toBe('x,y\n1,2')
    expect(png.mimeType).toBe('image/png')
    expect(png.encoding).toBe('base64')
    expect(Buffer.from(png.content, 'base64').equals(pngBytes)).toBe(true)
    // notes.md (unchanged) was not promoted.
    expect(calls.find((c) => c.filename === 'notes.md')).toBeUndefined()
  })

  // sf-L8: a deliverable that cannot be stored used to disappear into a bare
  // `catch {}` — the return value looked exactly like "the turn produced
  // nothing", so neither the caller nor the log could tell them apart.
  it('names a file it could not store instead of dropping it silently (sf-L8)', async () => {
    const { transport, fs } = makeFsTransport()
    fs.set('/work/out/small.csv', 'a,b')
    fs.set('/work/out/huge.csv', 'x'.repeat(20))

    vi.mocked(storeDocument).mockImplementation(async (input) => {
      if (input.filename === 'huge.csv') throw new Error('content too large')
      return {} as never
    })

    const { promoted, skipped } = await promoteOutputs(transport, 's', new Map(), (async () => ({
      success: true,
      data: null,
    })) as never)

    // One bad file still does not cost the others...
    expect(promoted).toEqual(['small.csv'])
    // ...and it is reported by name, with the reason.
    expect(skipped).toEqual([{ filename: 'huge.csv', error: 'content too large' }])
  })

  it('reports a file it could not read out of the container (sf-L8)', async () => {
    const { transport, fs } = makeFsTransport()
    // Listed by the find/hash sweep but unreadable by `sandbox_read`.
    fs.set('/work/out/vanished.txt', 'gone by the time we read it')
    const original = transport.callTool
    transport.callTool = async (name, args) => {
      if (name === 'sandbox_bash' && /base64 -w 0/.test(String(args.command))) {
        return { success: false, data: null, error: 'no such file' }
      }
      if (name === 'sandbox_read' && String(args.path).endsWith('vanished.txt')) {
        return { success: false, data: null, error: 'no such file' }
      }
      return original(name, args)
    }

    const { promoted, skipped } = await promoteOutputs(transport, 's', new Map(), (async () => ({
      success: true,
      data: null,
    })) as never)

    expect(promoted).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].filename).toBe('vanished.txt')
    expect(vi.mocked(storeDocument)).not.toHaveBeenCalled()
  })
})
