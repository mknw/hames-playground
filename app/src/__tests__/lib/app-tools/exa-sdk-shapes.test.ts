// @vitest-environment node
/** Real SDK error instances through the real Exa failure classifier.
 *
 * exa.test.ts drives classifyExaFailure with a SYNTHETIC shape
 * (Object.assign(new Error(...), { code })) — green even if the installed SDK
 * moved its error codes off `.code`. These tests throw REAL instances of the
 * classes @modelcontextprotocol/sdk actually throws — McpError (the protocol
 * layer, types.js) and StreamableHTTPError (the HTTP transport,
 * client/streamableHttp.js) — through the REAL createExaTransport
 * classifier, so a class whose code lands somewhere else cannot pass here.
 * Only the Client class is mocked: the transport is constructed for real and
 * nothing touches the network. No live Exa call, no real key, sentinels only. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queue, calls } = vi.hoisted(() => ({
  /** One queued throw per callTool; a shift on empty answers a success. */
  queue: [] as unknown[],
  calls: { count: 0 },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn(async () => undefined)
    close = vi.fn(async () => undefined)
    callTool = vi.fn(async () => {
      calls.count++
      const err = queue.shift()
      if (err !== undefined) throw err
      return { content: [{ type: 'text', text: 'provider result' }] }
    })
  },
}))

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createExaTransport, selectedExaTools } from '../../../lib/app-tools/exa.server'

/** Synthetic sentinel standing in for provider-echoed secret material. */
const SENT = 'SYNTH-PROVIDER-SENTINEL-NO-REAL-KEY'

beforeEach(() => {
  queue.length = 0
  calls.count = 0
})

const transport = () => createExaTransport(selectedExaTools('both'), 'synthetic-key')

describe('real SDK error instances through the real Exa classifier', () => {
  it('McpError(ErrorCode.RequestTimeout) — the SDK timeout shape — is named "timed out"', async () => {
    queue.push(
      new McpError(ErrorCode.RequestTimeout, `Request timed out near ${SENT}`, {
        timeout: 60000,
      }),
    )
    const result = await transport().callTool('web_fetch_exa', {
      url: 'https://example.test',
    })
    expect(result).toEqual({
      success: false,
      data: null,
      error: 'Exa hosted request timed out',
    })
    expect(calls.count).toBe(1)
    expect(JSON.stringify(result)).not.toContain(SENT)
  })

  it('StreamableHTTPError(429) — the HTTP rate-limit shape — is named "rate limit reached"', async () => {
    queue.push(
      new StreamableHTTPError(
        429,
        `Error POSTing to endpoint: {"error":"rate limited, ref ${SENT}"}`,
      ),
    )
    const result = await transport().callTool('web_search_exa', { query: 'public' })
    expect(result).toEqual({
      success: false,
      data: null,
      error: 'Exa hosted rate limit reached (HTTP 429)',
    })
    expect(calls.count).toBe(1)
    expect(JSON.stringify(result)).not.toContain(SENT)
  })

  it('StreamableHTTPError(401) keeps the generic fixed name', async () => {
    queue.push(new StreamableHTTPError(401, `Failed to open SSE stream near ${SENT}`))
    const result = await transport().callTool('web_search_exa', { query: 'public' })
    expect(result).toEqual({
      success: false,
      data: null,
      error: 'Exa hosted request unavailable',
    })
    expect(calls.count).toBe(1)
    expect(JSON.stringify(result)).not.toContain(SENT)
  })
})
