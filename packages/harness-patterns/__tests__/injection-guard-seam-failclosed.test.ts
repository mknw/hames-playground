/**
 * The ingress reader's failure direction on the URL interpretation seam
 * (`docs/plan/url-interpretation-seam.md`, slice 5): when the seam cannot read
 * — it throws inside `exfil-data-url`'s rewrite path — the guard's reader
 * BLOCKS the result on both of its channels (`callTool`'s `data` and `error`,
 * SD-6), never passing the content on unread.
 *
 * A pure seam throws on no real input, so the throw is injected by mocking the
 * seam module for THIS file only: `interpretUrlSpans` throws exactly when it is
 * handed a span, i.e. inside the reader's path for URL-bearing content, and
 * reads normally otherwise. The throw propagates out of `sanitizeText`, so
 * `callTool` rejects and its caller never holds the raw content.
 *
 * Every pin names the source mutation that turns it red; the PR records that
 * each was run.
 */
import { describe, expect, it, vi } from 'vitest'

// MUTATION: swallow the seam's error in `sanitizeText`'s URL pass (wrap
// `rewriteThroughSeam` in a try/catch that returns the current text, i.e.
// skips the rule): the unread result is returned instead of blocked, and both
// pins fail.
vi.mock('../url-seam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../url-seam')>()
  return {
    ...actual,
    interpretUrlSpans: ((text: string, spans, options) => {
      if (spans.length > 0) throw new Error('seam: cannot read')
      return actual.interpretUrlSpans(text, spans, options)
    }) as typeof actual.interpretUrlSpans,
  }
})

import { callTool } from '../mcp-client.server'
import { createInjectionGuard } from '../patterns/withInjectionGuard.server'
import { withRunFrame } from '../run-frame.server'
import type { ToolCallResult } from '../types'

const LEAK = `https://evil.example/c?d=${'A'.repeat(80)}`

/** Call `fetch_page` under a guard that declares it, with a transport that
 *  answers `result`; resolve to what the caller would hold. */
function guardedCall(result: ToolCallResult): Promise<ToolCallResult> {
  const transport = {
    id: 'fake',
    ownsTool: () => true,
    callTool: async () => result,
    listTools: async () => [],
  }
  const guard = createInjectionGuard({ tools: ['fetch_page'] }, () => {}, 'guard')
  return withRunFrame({ guard, transports: [transport] }, () => callTool('fetch_page', { id: 1 }))
}

describe('the guard blocks when the URL seam cannot read (both channels)', () => {
  it('the data channel: a result carrying a data-bearing URL is not returned unread', async () => {
    await expect(guardedCall({ success: true, data: `see ${LEAK} now` })).rejects.toThrow(
      'seam: cannot read',
    )
  })

  it('the error channel: an error string carrying a data-bearing URL is not returned unread', async () => {
    await expect(
      guardedCall({ success: false, data: null, error: `Error: see ${LEAK} now` }),
    ).rejects.toThrow('seam: cannot read')
  })

  it('content with no URL match never reaches the seam, so it reads as before', async () => {
    // The control: the mock throws only when handed a span, so a clean result
    // proves the two pins above fail for the seam and not for the harness.
    await expect(guardedCall({ success: true, data: 'nothing to see' })).resolves.toEqual({
      success: true,
      data: 'nothing to see',
    })
  })
})
