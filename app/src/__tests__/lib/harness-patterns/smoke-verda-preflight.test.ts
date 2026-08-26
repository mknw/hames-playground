/**
 * `smoke-verda.ts`'s preflight — the manual live check's own reachability probe.
 *
 * Why this is pinned: the smoke script is the documented way to answer "is the
 * self-hosted route working?", and on 2026-08-26 it could not answer. Its
 * `GET /v1/models` used Node's `fetch` with no timeout, hung for ~4 minutes
 * against a struggling endpoint, and failed with the bare string
 * `fetch failed` — before any billed call, and with nothing in the message
 * naming the URL or the likely cause. An operator reading that reasonably
 * concludes the repo is broken rather than the deployment unreachable.
 *
 * Everything here runs against a local server, so it is hermetic and fast.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const { servedModelIds } = await import('../../../lib/harness-patterns/scripts/smoke-verda')

let server: Server | undefined
const sockets = new Set<import('node:net').Socket>()

/** A stand-in deployment. `handler: null` accepts the request and never
 *  answers — the scale-to-zero proxy shape that hung the real preflight. */
async function listen(handler: null | ((url: string) => [number, string])): Promise<string> {
  server = createServer((req, res) => {
    if (!handler) return // hold the connection open, forever
    const [status, body] = handler(req.url ?? '')
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
  server.on('connection', (socket) => sockets.add(socket))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (server) await new Promise((resolve) => server!.close(resolve))
  server = undefined
  delete process.env.VERDA_INFERENCE_ENDPOINT
  delete process.env.VERDA_INFERENCE_API_KEY
})

describe('servedModelIds', () => {
  it('returns the served ids on a healthy endpoint', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = await listen(() => [
      200,
      JSON.stringify({ object: 'list', data: [{ id: 'Qwen/Qwen3.8-27B-FP8' }] }),
    ])
    process.env.VERDA_INFERENCE_API_KEY = 'k'

    await expect(servedModelIds(2_000)).resolves.toEqual(['Qwen/Qwen3.8-27B-FP8'])
  })

  it('gives up on an endpoint that accepts and never answers', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = await listen(null)
    process.env.VERDA_INFERENCE_API_KEY = 'k'

    // Without the abort signal this promise never settles on its own within
    // any interval a test can wait for — that IS the bug being pinned.
    const started = Date.now()
    await expect(servedModelIds(300)).rejects.toThrow(/did not answer within 0\.3s/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('names the URL and the endpoint-shape hint in the failure', async () => {
    // The message is the whole deliverable of a failed preflight: it is what
    // the operator acts on, and `fetch failed` on its own is unactionable.
    const base = await listen(null)
    process.env.VERDA_INFERENCE_ENDPOINT = base

    const error: Error = await servedModelIds(300).then(
      () => new Error('expected a rejection'),
      (err: unknown) => err as Error,
    )

    expect(error.message).toContain(`${base}/models`)
    expect(error.message).toContain('`/v1`')
    // And it must not send the operator hunting for a cold start: a cold
    // container still answers /models fast (measured 1.2s while a completion
    // on the same deployment took 146s).
    expect(error.message).toContain('cold container does NOT cause this')
  })

  it('still reports a non-OK status as itself', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = await listen(() => [401, '{}'])

    await expect(servedModelIds(2_000)).rejects.toThrow(/→ 401/)
  })
})
