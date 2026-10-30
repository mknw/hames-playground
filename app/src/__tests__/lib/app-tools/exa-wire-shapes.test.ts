// @vitest-environment node
/** The real SDK stack against a loopback fake MCP server.
 *
 * Proves which error shapes actually reach the app's catch on (a) a 429
 * tools/call response and (b) a request the server never answers — the two
 * shapes classifyExaFailure (lib/app-tools/exa.server.ts) names failures by.
 * The classifier suites (exa.test.ts, exa-sdk-shapes.test.ts) assert the
 * naming of thrown instances; only this file runs the REAL
 * @modelcontextprotocol/sdk Client and StreamableHTTPClientTransport on a
 * wire, so a future SDK that changed the actual thrown shape cannot pass
 * here.
 *
 * Hermetic: loopback only (127.0.0.1, ephemeral port), no credential sent, no
 * live Exa call. The timeout case passes a short per-request timeout for
 * speed; the 60s DEFAULT the app relies on (exa.server.ts passes no per-call
 * options) is the SDK's own DEFAULT_REQUEST_TIMEOUT_MSEC (shared/protocol.js). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'

/** Synthetic sentinel the fake provider plants in its 429 response body. */
const SENT = 'SYNTH-PROVIDER-BODY-SENTINEL'

type Behavior = 'rate429' | 'hang'
let behavior: Behavior = 'rate429'

/** Never-answered hang responses, destroyed in afterAll. */
const pendingHangs: http.ServerResponse[] = []
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    // The SDK tolerates 405 on the SSE-open GET (streamableHttp.js: "405
    // indicates that the server does not offer an SSE stream").
    res.writeHead(405).end()
    return
  }
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
    }
    if (raw.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: raw.id,
          result: {
            protocolVersion: (raw.params as { protocolVersion?: string }).protocolVersion,
            capabilities: {},
            serverInfo: { name: 'fake', version: '0.0.0' },
          },
        }),
      )
      return
    }
    if (raw.method === 'notifications/initialized') {
      res.writeHead(202).end()
      return
    }
    if (raw.method === 'tools/call') {
      if (behavior === 'rate429') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `rate limited, ref ${SENT}` }))
        return
      }
      pendingHangs.push(res) // never answered: the SDK request timeout fires
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: raw.id, result: {} }))
  })
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})
afterAll(async () => {
  for (const res of pendingHangs) res.destroy()
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function withFakeServer<T>(mode: Behavior, run: (client: Client) => Promise<T>): Promise<T> {
  behavior = mode
  const port = (server.address() as AddressInfo).port
  const client = new Client({ name: 'wire-shape-check', version: '0.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    return await run(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}

describe('the real SDK stack against a 127.0.0.1 fake MCP server', () => {
  it('a 429 tools/call response rejects with StreamableHTTPError.code === 429 carrying provider text', async () => {
    const thrown = await withFakeServer('rate429', (client) =>
      client.callTool({ name: 'web_search_exa', arguments: { query: 'public' } }).then(
        () => undefined,
        (err: unknown) => err,
      ),
    )
    expect(thrown).toBeInstanceOf(Error)
    // The field exa.server.ts's classifier reads: the numeric `code`.
    const err = thrown as { code?: unknown; message?: string }
    expect(err.code).toBe(429)
    // The SDK's thrown MESSAGE carries the provider's response body verbatim
    // (streamableHttp.js: "Error POSTing to endpoint: …") — which is exactly
    // why classifyExaFailure must never echo it and reads the numeric code
    // only.
    expect(String(err.message)).toContain(SENT)
  })

  it('a request the server never answers rejects with McpError.code === ErrorCode.RequestTimeout', async () => {
    const thrown = await withFakeServer('hang', (client) =>
      client
        .callTool(
          { name: 'web_fetch_exa', arguments: { url: 'https://example.test' } },
          undefined,
          { timeout: 250 }, // short for speed; same code path as the 60s default
        )
        .then(
          () => undefined,
          (err: unknown) => err,
        ),
    )
    expect(thrown).toBeInstanceOf(Error)
    const err = thrown as { code?: unknown }
    expect(err.code).toBe(ErrorCode.RequestTimeout)
    expect(err.code).toBe(-32001)
  })
})
