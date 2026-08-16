/**
 * sse-client — typed AsyncIterable SSE parser tests.
 *
 * Covers the wire-format edge cases we actually emit from `/api/events`:
 *  - default event name (no `event:` header → 'message')
 *  - explicit event names (`done`, `error`, `title_updated`)
 *  - frames split across chunks (partial frame in buffer between reads)
 *  - malformed JSON in a single frame (skip, don't tear down the stream)
 *  - unknown event names (yielded for forward-compat)
 *  - trailing frame with no terminating blank line (flushed on close)
 */
import { describe, it, expect } from 'vitest'
import { parseChatStream, type ChatStreamEvent } from '../../lib/sse-client'

/** Build a minimal Response with a body that emits the given chunks in order. */
function responseFrom(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
  return new Response(stream)
}

async function collect(response: Response): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = []
  for await (const evt of parseChatStream(response)) out.push(evt)
  return out
}

describe('parseChatStream', () => {
  it('yields a single `message` frame with no event header', async () => {
    const evts = await collect(
      responseFrom([
        `data: {"type":"user_message","ts":1,"patternId":"harness","data":{"content":"hi"}}\n\n`,
      ]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('message')
    expect(evts[0].data).toMatchObject({ type: 'user_message', patternId: 'harness' })
  })

  it('discriminates by `event:` header', async () => {
    const evts = await collect(
      responseFrom([
        `event: done\ndata: {"sessionId":"s1","response":"ok","data":{},"status":"done","context":{"events":[]}}\n\n`,
        `event: title_updated\ndata: {"sessionId":"s1","title":"My Title"}\n\n`,
        `event: error\ndata: {"sessionId":"s1","error":"boom"}\n\n`,
      ]),
    )
    expect(evts.map(e => e.event)).toEqual(['done', 'title_updated', 'error'])
    if (evts[1].event === 'title_updated') {
      expect(evts[1].data.title).toBe('My Title')
    }
  })

  it('reassembles a frame split across chunks', async () => {
    // Same frame, sliced mid-`data:` line and mid-JSON-string.
    const evts = await collect(
      responseFrom([
        `event: title_updated\nda`,
        `ta: {"sessionId":"abc","ti`,
        `tle":"Split Frame"}\n\n`,
      ]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('title_updated')
    expect(evts[0].data).toMatchObject({ sessionId: 'abc', title: 'Split Frame' })
  })

  it('skips a frame with malformed JSON without dropping subsequent frames', async () => {
    const evts = await collect(
      responseFrom([
        `event: done\ndata: {not json}\n\n`,
        `event: title_updated\ndata: {"sessionId":"x","title":"After Bad"}\n\n`,
      ]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('title_updated')
  })

  it('yields unknown event names for forward-compat', async () => {
    const evts = await collect(
      responseFrom([`event: future_event\ndata: {"hello":"world"}\n\n`]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('future_event')
    expect(evts[0].data).toEqual({ hello: 'world' })
  })

  it('joins multi-line `data:` payloads per SSE spec', async () => {
    const evts = await collect(
      responseFrom([
        `event: done\ndata: {"sessionId":"s","response":"line1`,
        `","data":{},"status":"done","context":{"events":[]}}\n\n`,
      ]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('done')
  })

  it('flushes a trailing frame even without a terminating blank line', async () => {
    const evts = await collect(
      responseFrom([`event: title_updated\ndata: {"sessionId":"s","title":"Last"}`]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('title_updated')
  })

  it('ignores comment lines starting with `:`', async () => {
    const evts = await collect(
      responseFrom([
        `: keepalive\nevent: title_updated\ndata: {"sessionId":"s","title":"After Comment"}\n\n`,
      ]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('title_updated')
  })

  it('skips a frame with no `data:` field', async () => {
    const evts = await collect(
      responseFrom([
        `event: ping\n\n`,
        `event: title_updated\ndata: {"sessionId":"s","title":"Real"}\n\n`,
      ]),
    )
    expect(evts).toHaveLength(1)
    expect(evts[0].event).toBe('title_updated')
  })
})
