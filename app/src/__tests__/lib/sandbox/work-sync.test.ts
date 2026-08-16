/**
 * work-sync tests — host ⇄ /work file movement over a simulated transport.
 *
 * The fake transport implements a tiny in-VM filesystem plus exactly the bash
 * command shapes work-sync emits (mkdir, base64 -d/-w 0 redirects, sha256sum
 * find), so text and binary round-trips and the /work/out diff are exercised
 * end-to-end without a real container.
 */

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import type { McpTransport } from '../../../lib/sandbox/types'
import type { ToolCallResult } from '../../../lib/harness-patterns/types'
import {
  writeWorkFile,
  readWorkFile,
  listWorkFiles,
  diffWorkFiles,
} from '../../../lib/sandbox/work-sync.server'

/** Strip the single-quoting `shq()` applies. */
const unq = (s: string): string => s.replace(/^'|'$/g, '').replace(/'\\''/g, "'")

function bashOk(stdout = ''): ToolCallResult {
  return { success: true, data: { stdout, stderr: '', exit_code: 0, timed_out: false } }
}

/** In-memory fs (path → content; binary stored as a latin1 byte string). */
function makeFsTransport() {
  const fs = new Map<string, string>()

  const runBash = (cmd: string): ToolCallResult => {
    let m = /^base64 -d (\S+) > (\S+) && rm -f (\S+)$/.exec(cmd)
    if (m) {
      const b64 = fs.get(unq(m[1])) ?? ''
      fs.set(unq(m[2]), Buffer.from(b64, 'base64').toString('latin1'))
      fs.delete(unq(m[3]))
      return bashOk()
    }
    m = /^base64 -w 0 (\S+) > (\S+)$/.exec(cmd)
    if (m) {
      const content = fs.get(unq(m[1])) ?? ''
      fs.set(unq(m[2]), Buffer.from(content, 'latin1').toString('base64'))
      return bashOk()
    }
    m = /cd (\S+) && find \. -type f/.exec(cmd)
    if (m) {
      const dir = unq(m[1]).replace(/\/$/, '')
      const lines: string[] = []
      for (const [p, content] of fs) {
        if (p.startsWith(dir + '/')) {
          const rel = p.slice(dir.length + 1)
          const hash = createHash('sha256').update(Buffer.from(content, 'latin1')).digest('hex')
          lines.push(`${hash}  ./${rel}`)
        }
      }
      return bashOk(lines.join('\n'))
    }
    return bashOk() // mkdir -p / rm -f / anything else → no-op success
  }

  const transport: McpTransport = {
    vmId: 'vm-test',
    toolNames: async () => ['sandbox_read', 'sandbox_write', 'sandbox_bash'],
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
          : { success: false, data: null, error: 'not found' }
      }
      if (name === 'sandbox_bash') return runBash(args.command as string)
      return { success: false, data: null, error: `unknown tool ${name}` }
    },
  }
  return { transport, fs }
}

describe('work-sync: text round-trip', () => {
  it('writes and reads utf8 verbatim', async () => {
    const { transport, fs } = makeFsTransport()
    await writeWorkFile(transport, '/work/in/notes.md', '# hello\nworld\n', 'utf8')
    expect(fs.get('/work/in/notes.md')).toBe('# hello\nworld\n')
    expect(await readWorkFile(transport, '/work/in/notes.md', 'utf8')).toBe('# hello\nworld\n')
  })
})

describe('work-sync: binary round-trip', () => {
  it('preserves raw bytes through base64 staging', async () => {
    const { transport, fs } = makeFsTransport()
    // Bytes that are NOT valid UTF-8 — the whole point of base64.
    const original = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x7f, 0x80]).toString('base64')
    await writeWorkFile(transport, '/work/in/img.bin', original, 'base64')
    // Staged .b64 was cleaned up after decode.
    expect(fs.has('/work/in/img.bin.b64')).toBe(false)
    const back = await readWorkFile(transport, '/work/in/img.bin', 'base64')
    expect(back).toBe(original)
  })
})

describe('work-sync: listWorkFiles + diff', () => {
  it('hashes files and detects new/changed since a baseline', async () => {
    const { transport } = makeFsTransport()
    await writeWorkFile(transport, '/work/out/a.txt', 'hello', 'utf8')
    const baseline = await listWorkFiles(transport, '/work/out')
    expect([...baseline.keys()]).toEqual(['a.txt'])

    await writeWorkFile(transport, '/work/out/b.txt', 'world', 'utf8')
    await writeWorkFile(transport, '/work/out/a.txt', 'hello again', 'utf8') // changed
    const current = await listWorkFiles(transport, '/work/out')

    expect(diffWorkFiles(baseline, current).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('returns empty for an unchanged tree', async () => {
    const { transport } = makeFsTransport()
    await writeWorkFile(transport, '/work/out/x.csv', 'a,b,c', 'utf8')
    const snap = await listWorkFiles(transport, '/work/out')
    expect(diffWorkFiles(snap, snap)).toEqual([])
  })

  it('ignores deletions (promotion never removes stored docs)', () => {
    const baseline = new Map([
      ['gone.txt', 'h1'],
      ['keep.txt', 'h2'],
    ])
    const current = new Map([['keep.txt', 'h2']])
    expect(diffWorkFiles(baseline, current)).toEqual([])
  })
})

describe('work-sync: in-VM failures surface with the path that failed', () => {
  /** Transport where the named tool always fails, and bash reports a non-zero
   *  exit — the shape a real container returns for a full disk / missing file. */
  function failingTransport(opts: { failTool?: string; bashStderr?: string }): McpTransport {
    return {
      vmId: 'vm-broken',
      toolNames: async () => [],
      listTools: async () => [],
      ownsTool: () => true,
      close: async () => {},
      callTool: async (name): Promise<ToolCallResult> => {
        if (name === opts.failTool) {
          return { success: false, data: null, error: 'no space left on device' }
        }
        if (name === 'sandbox_bash' && opts.bashStderr !== undefined) {
          return {
            success: true,
            data: { stdout: '', stderr: opts.bashStderr, exit_code: 1, timed_out: false },
          }
        }
        return { success: true, data: '' }
      },
    }
  }

  it('reports a failed utf8 write', async () => {
    const t = failingTransport({ failTool: 'sandbox_write' })
    await expect(writeWorkFile(t, '/work/in/a.txt', 'hi', 'utf8')).rejects.toThrow(
      'sandbox_write failed for /work/in/a.txt: no space left on device',
    )
  })

  it('reports a failed base64 staging write', async () => {
    const t = failingTransport({ failTool: 'sandbox_write' })
    await expect(writeWorkFile(t, '/work/in/a.bin', 'AAA=', 'base64')).rejects.toThrow(
      'staging base64 write failed for /work/in/a.bin.b64: no space left on device',
    )
  })

  it('reports a failed in-VM base64 decode', async () => {
    const t = failingTransport({ bashStderr: 'base64: invalid input' })
    await expect(writeWorkFile(t, '/work/in/a.bin', 'not-base64', 'base64')).rejects.toThrow(
      'base64 decode failed for /work/in/a.bin: base64: invalid input',
    )
  })

  it('reports a failed utf8 read', async () => {
    const t = failingTransport({ failTool: 'sandbox_read' })
    await expect(readWorkFile(t, '/work/out/missing.txt', 'utf8')).rejects.toThrow(
      'sandbox_read failed for /work/out/missing.txt: no space left on device',
    )
  })

  it('reports a failed in-VM base64 encode', async () => {
    const t = failingTransport({ bashStderr: 'No such file or directory' })
    await expect(readWorkFile(t, '/work/out/missing.bin', 'base64')).rejects.toThrow(
      'base64 encode failed for /work/out/missing.bin: No such file or directory',
    )
  })

  it('reports a staged base64 file it cannot read back', async () => {
    const t = failingTransport({ failTool: 'sandbox_read' })
    await expect(readWorkFile(t, '/work/out/a.bin', 'base64')).rejects.toThrow(
      'reading staged base64 failed for /work/out/a.bin: no space left on device',
    )
  })
})
