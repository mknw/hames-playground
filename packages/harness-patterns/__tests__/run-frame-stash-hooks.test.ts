/**
 * The two run-frame slots #507 N4 added — `stashWriteObservers` and
 * `afterToolCall` — and the two core call sites that read them. Each pin names
 * the mutation that reddens it.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { withRunFrame, amendRunFrame } from '../run-frame.server'
import { registerTransport } from '../tool-transport.server'
import { callTool } from '../mcp-client.server'
import { storeDocument, type CallTool } from '../stash/document-store.server'

const redis =
  (log: string[]): CallTool =>
  async (name) => {
    log.push(name)
    return { success: true, data: 'OK' }
  }
const input = { sessionId: 's1', filename: 'a.csv', mimeType: 'text/csv', content: 'x' }

describe('stashWriteObservers', () => {
  // Mutation: call the observers before the `json_set` / `sadd` writes.
  it('fires once per stored document, AFTER the document and its index entry are written', async () => {
    const log: string[] = []
    await withRunFrame({}, () =>
      amendRunFrame({ stashWriteObservers: [(w) => log.push(`observed:${w.sessionId}`)] }, () =>
        storeDocument(input, redis(log)),
      ),
    )
    expect(log).toEqual(['json_set', 'sadd', 'observed:s1'])
  })

  // Mutation: fire the observers before the throw check on the Redis write.
  it('does not fire when the write fails', async () => {
    const seen = vi.fn()
    const failing: CallTool = async () => ({ success: false, data: null, error: 'down' })
    await withRunFrame({}, () =>
      amendRunFrame({ stashWriteObservers: [seen] }, async () => {
        await expect(storeDocument(input, failing)).rejects.toThrow()
      }),
    )
    expect(seen).not.toHaveBeenCalled()
  })

  // Mutation: delete the try/catch around the observer call.
  it('a throwing observer never un-stores the document, and the others still hear it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = vi.fn()
    const doc = await withRunFrame({}, () =>
      amendRunFrame(
        {
          stashWriteObservers: [
            () => {
              throw new Error('bad observer')
            },
            second,
          ],
        },
        () => storeDocument(input, redis([])),
      ),
    )
    expect(doc.sessionId).toBe('s1')
    expect(second).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  // Mutation: make the slot REPLACE in `amendRunFrame` (`partial.x ?? open.x`).
  it('a nested amend adds to the enclosing observers and never switches them off', async () => {
    const outer = vi.fn()
    const inner = vi.fn()
    await withRunFrame({ stashWriteObservers: [outer] }, () =>
      amendRunFrame({ stashWriteObservers: [inner] }, () => storeDocument(input, redis([]))),
    )
    expect(outer).toHaveBeenCalledOnce()
    expect(inner).toHaveBeenCalledOnce()
  })

  it('outside any observing scope a write is silent', async () => {
    await expect(withRunFrame({}, () => storeDocument(input, redis([])))).resolves.toBeDefined()
    await expect(storeDocument(input, redis([]))).resolves.toBeDefined()
  })
})

describe('afterToolCall', () => {
  const transport = (calls: string[]) => ({
    id: 't',
    ownsTool: (n: string) => n === 'probe',
    listTools: async () => [],
    callTool: async () => {
      calls.push('dispatched')
      return { success: true, data: 'raw' }
    },
  })

  // Mutation: run the hooks before `guardedCall` / `dispatchTool`.
  it('runs after the call has been dispatched and may replace the result', async () => {
    const order: string[] = []
    const result = await withRunFrame({ transports: [transport(order)] }, () =>
      amendRunFrame(
        {
          afterToolCall: [
            async ({ name }, r) => {
              order.push(`hook:${name}:${String(r.data)}`)
              return { success: false, data: null, error: 'replaced' }
            },
          ],
        },
        () => callTool('probe', {}),
      ),
    )
    expect(order).toEqual(['dispatched', 'hook:probe:raw'])
    expect(result).toEqual({ success: false, data: null, error: 'replaced' })
  })

  it('a hook returning nothing leaves the result untouched', async () => {
    const result = await withRunFrame({ transports: [transport([])] }, () =>
      amendRunFrame({ afterToolCall: [async () => undefined] }, () => callTool('probe', {})),
    )
    expect(result).toEqual({ success: true, data: 'raw' })
  })

  // Mutation: replace instead of concatenate; or iterate outer-first.
  it("nested hooks both run, innermost first, each seeing the previous one's result", async () => {
    const seen: string[] = []
    const hook = (tag: string) => async (_c: unknown, r: { data: unknown }) => {
      seen.push(`${tag}<-${String(r.data)}`)
      return { success: true, data: tag }
    }
    await withRunFrame({ transports: [transport([])], afterToolCall: [hook('outer')] }, () =>
      amendRunFrame({ afterToolCall: [hook('inner')] }, () => callTool('probe', {})),
    )
    expect(seen).toEqual(['inner<-raw', 'outer<-inner'])
  })

  it('outside a run there are no hooks and a call is unchanged', async () => {
    const unregister = registerTransport(transport([]))
    try {
      await expect(callTool('probe', {})).resolves.toEqual({ success: true, data: 'raw' })
    } finally {
      unregister()
    }
  })
})
