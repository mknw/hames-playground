/**
 * Reviewer pins for PR #545 (Jev direct via TypeSafe). Synthetic data only.
 *
 *  r545-redirect   — a redirect from the configured endpoint must not carry the
 *                    decision state (or the key) to another origin
 *  r545-hosts      — lookalike / userinfo / case / port hosts select the right
 *                    request shape and never mis-detect OpenRouter or TypeSafe
 *  r545-extra      — an answer carrying a label outside the asked set is refused
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import '../../../lib/inference/config.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type { DecisionSpec } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const SPEC: DecisionSpec<'yes' | 'no'> = {
  key: 'k',
  question: 'q?',
  labels: [
    { id: 'yes', description: 'y' },
    { id: 'no', description: 'n' },
  ],
}
const ok = (probabilities: Record<string, number>) =>
  new Response(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: { k: { type: 'choice', choice: 'yes', confidence: 0.9, probabilities } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const anthropic = <T>(fn: () => Promise<T>) =>
  withRunFrame({ inference: { tier: 'anthropic' } } as never, fn)

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  process.env.JEV_DECISIONS_API_KEY = 'synthetic-review-key'
})
afterEach(() => {
  process.env = saved
})

describe('r545-redirect', () => {
  const servers: Server[] = []
  afterEach(() => servers.splice(0).forEach((s) => s.close()))
  const listen = (host: string, h: Parameters<typeof createServer>[1]) =>
    new Promise<number>((r) => {
      const s = createServer(h!)
      servers.push(s)
      s.listen(0, host, () => r((s.address() as AddressInfo).port))
    })

  for (const code of [307, 308]) {
    it(`${code} to another origin: the state never reaches it`, async () => {
      const hits: { auth: string | null; state: boolean }[] = []
      const pB = await listen('127.0.0.1', (req, res) => {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => {
          hits.push({ auth: req.headers.authorization ?? null, state: b.includes('SYNTH-STATE') })
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              answers: { k: { probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          )
        })
      })
      const pA = await listen('127.0.0.1', (req, res) => {
        req.resume()
        req.on('end', () => {
          res.statusCode = code
          res.setHeader('location', `http://localhost:${pB}/elsewhere`)
          res.end()
        })
      })
      process.env.JEV_DECISIONS_URL = `http://127.0.0.1:${pA}/x`
      const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
      await anthropic(() =>
        createJevTransport().decide({ spec: SPEC, state: 'SYNTH-STATE' }),
      ).catch(() => undefined)
      expect(hits).toEqual([])
    })
  }
})

describe('r545-hosts', () => {
  const cases: [string, 'typesafe' | 'openrouter' | undefined, string, boolean][] = [
    ['https://api.typesafe.ai/v1/systemone', 'typesafe', 'jev-1.13.0', false],
    ['https://API.TypeSafe.AI:443/v1/systemone', 'typesafe', 'jev-1.13.0', false],
    ['https://api.typesafe.ai.evil.example/v1/systemone', undefined, 'typesafe/jev-1.13', false],
    ['https://evil.example/api.typesafe.ai', undefined, 'typesafe/jev-1.13', false],
    ['https://xapi.typesafe.ai/v1/systemone', undefined, 'typesafe/jev-1.13', false],
    ['https://openrouter.ai/api/alpha/decisions', 'openrouter', 'typesafe/jev-1.13', true],
    ['https://eu.OpenRouter.ai/api/alpha/decisions', 'openrouter', 'typesafe/jev-1.13', true],
    [
      'https://openrouter.ai.evil.example/api/alpha/decisions',
      undefined,
      'typesafe/jev-1.13',
      false,
    ],
    ['https://evilopenrouter.ai/api/alpha/decisions', undefined, 'typesafe/jev-1.13', false],
  ]
  for (const [url, provider, model, o1] of cases) {
    it(url, async () => {
      process.env.JEV_DECISIONS_URL = url
      const seen: { url: string; body: Record<string, unknown> }[] = []
      const fetch = (async (u: string, init: RequestInit) => {
        seen.push({ url: u, body: JSON.parse(String(init.body)) })
        return ok({ yes: 0.9, no: 0.1 })
      }) as unknown as typeof globalThis.fetch
      const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
      const r = await anthropic(() =>
        createJevTransport({ fetch }).decide({ spec: SPEC, state: 's' }),
      )
      expect(seen).toHaveLength(1)
      expect(new URL(seen[0].url).hostname).toBe(new URL(url).hostname)
      expect(seen[0].body.model).toBe(model)
      expect('provider' in seen[0].body).toBe(o1)
      expect(r.llmCall?.provider).toBe(provider)
    })
  }
  for (const url of [
    'https://user:pw@api.typesafe.ai/v1/systemone',
    'https://api.typesafe.ai@evil.example/v1/systemone',
    'https://openrouter.ai./api/alpha/decisions',
    'https://api.typesafe.ai./v1/systemone',
    'http://api.typesafe.ai/v1/systemone',
    'http://localhost.evil.example/x',
  ]) {
    it(`refused before the key is read: ${url}`, async () => {
      process.env.JEV_DECISIONS_URL = url
      const reads = vi.fn()
      const env = process.env
      process.env = new Proxy(env, {
        get: (t, k) => (k === 'JEV_DECISIONS_API_KEY' && reads(), Reflect.get(t, k)),
      })
      const fetch = vi.fn()
      const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
      await expect(
        anthropic(() =>
          createJevTransport({ fetch: fetch as never }).decide({ spec: SPEC, state: 's' }),
        ),
      ).rejects.toThrow(/no request was made/)
      process.env = env
      expect(fetch).not.toHaveBeenCalled()
      expect(reads).not.toHaveBeenCalled()
    })
  }
})

describe('r545-extra', () => {
  it('an answer with a label outside the asked set is refused', async () => {
    process.env.JEV_DECISIONS_URL = 'https://api.typesafe.ai/v1/systemone'
    const fetch = (async () => ok({ yes: 0.6, no: 0.395, maybe: 0.005 })) as never
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    await expect(
      anthropic(() => createJevTransport({ fetch }).decide({ spec: SPEC, state: 's' })),
    ).rejects.toThrow()
  })
})

describe('r545-range', () => {
  it('a probability outside [0, 1] is refused even when the mass sums to 1', async () => {
    process.env.JEV_DECISIONS_URL = 'https://api.typesafe.ai/v1/systemone'
    const fetch = (async () => ok({ yes: 1.5, no: -0.5 })) as never
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    await expect(
      anthropic(() => createJevTransport({ fetch }).decide({ spec: SPEC, state: 's' })),
    ).rejects.toThrow(/no valid probability/)
  })
})
describe('r545-unset-url', () => {
  it('the pre-built default names TypeSafe when explicitly configured', async () => {
    const { JEV_DEFAULT_URL, createJevTransport } =
      await import('@hames-ai/harness-baml/jev-decide.server')
    process.env.JEV_DECISIONS_URL = JEV_DEFAULT_URL
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      ok({ yes: 0.9, no: 0.1 }),
    )
    const result = await anthropic(() =>
      createJevTransport({ fetch }).decide({ spec: SPEC, state: 's' }),
    )
    expect(result.llmCall?.provider).toBe('typesafe')
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.typesafe.ai/v1/systemone')
  })
  it('unset URL refuses before reading the key or sending a request', async () => {
    delete process.env.JEV_DECISIONS_URL
    const env = process.env
    const reads = vi.fn()
    process.env = new Proxy(env, {
      get: (t, k) => (k === 'JEV_DECISIONS_API_KEY' && reads(), Reflect.get(t, k)),
    })
    const fetch = vi.fn()
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    try {
      await expect(
        anthropic(() => createJevTransport({ fetch }).decide({ spec: SPEC, state: 's' })),
      ).rejects.toThrow(/needs JEV_DECISIONS_URL/)
      expect(fetch).not.toHaveBeenCalled()
      expect(reads).not.toHaveBeenCalled()
    } finally {
      process.env = env
    }
  })
})
