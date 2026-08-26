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
 * It then got the diagnosis wrong in the other direction. The fix asserted, on a
 * 2026-08-25 observation, that `/models` answers fast even from cold — so a
 * single 15s attempt was enough and a timeout meant "unreachable". Re-measured
 * 2026-08-26 against a fully scaled-to-zero deployment, that same call took
 * **277 seconds**: the gateway queues it behind the container start like
 * anything else. The script therefore refused to run, with a message telling
 * the operator to check the host. Hence the two-attempt shape pinned below —
 * fast when the endpoint is genuinely wrong, patient when it is merely asleep.
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
 *  answers — the scale-to-zero proxy shape that hung the real preflight.
 *  `delayMs` holds the FIRST request open that long before answering, which is
 *  the cold-start shape: slow once, fast afterwards. */
async function listen(
  handler: null | ((url: string) => [number, string]),
  delayMs = 0,
): Promise<string> {
  let served = 0
  server = createServer((req, res) => {
    if (!handler) return // hold the connection open, forever
    const [status, body] = handler(req.url ?? '')
    const answer = () => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    }
    if (served++ === 0 && delayMs > 0) setTimeout(answer, delayMs).unref()
    else answer()
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
    // any interval a test can wait for — that IS the bug being pinned. The
    // retry is switched off so the assertion is about the abort, not the wait.
    const started = Date.now()
    await expect(servedModelIds(300, false)).rejects.toThrow(/did not answer within 0\.3s/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('retries a first timeout instead of calling the endpoint unreachable', async () => {
    // The 2026-08-26 re-measurement: `/models` took 277s from a scaled-to-zero
    // deployment, so the single short attempt turned every cold run into a
    // false "unreachable". Modelled here as a first request held open past the
    // first budget and answered normally after it — the shape a cold container
    // actually has, rather than a permanently dead socket.
    process.env.VERDA_INFERENCE_ENDPOINT = await listen(
      () => [200, JSON.stringify({ data: [{ id: 'Qwen/Qwen3.8-27B-FP8' }] })],
      400,
    )
    process.env.VERDA_INFERENCE_API_KEY = 'k'

    await expect(servedModelIds(100)).resolves.toEqual(['Qwen/Qwen3.8-27B-FP8'])
  })

  it('names the URL and the endpoint-shape hint in the failure', async () => {
    // The message is the whole deliverable of a failed preflight: it is what
    // the operator acts on, and `fetch failed` on its own is unactionable.
    const base = await listen(null)
    process.env.VERDA_INFERENCE_ENDPOINT = base

    const error: Error = await servedModelIds(300, false).then(
      () => new Error('expected a rejection'),
      (err: unknown) => err as Error,
    )

    expect(error.message).toContain(`${base}/models`)
    expect(error.message).toContain('`/v1`')
    // It must not tell the operator to wait longer — by the time this message
    // is produced the long budget has already been spent. And it must NOT
    // repeat the claim it used to make, that a cold container cannot cause a
    // timeout here; that claim is what made the script unrunnable from cold.
    expect(error.message).toContain('waiting longer')
    expect(error.message).not.toContain('cold container does NOT cause this')
  })

  it('still reports a non-OK status as itself', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = await listen(() => [401, '{}'])

    await expect(servedModelIds(2_000)).rejects.toThrow(/→ 401/)
  })
})
