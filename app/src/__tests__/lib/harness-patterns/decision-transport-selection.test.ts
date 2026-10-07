/**
 * `decision-transport-selection` (F1, #418 slice T3) — the adapter resolves the
 * role's client FIRST and picks the transport by the CLIENT, never by the tier.
 *
 *   resolved client           transport
 *   ─────────────────────     ───────────────────────────────────────────────
 *   ∈ LOGPROB_CLIENTS         the BAML `Decide` readout
 *   ∈ JEV_CLIENTS             the Jev REST adapter (slice T4; none wired yet)
 *   anything else             the injected verbalized secondary (slice T5)
 *
 * The throw rule is therefore NARROW: a client CLAIMED logprob-capable whose
 * response carries no logprobs throws; nothing else can make a logprob check
 * throw, and the Anthropic tier can never reach one. These tests pin both halves
 * against a counting fake server, so "never calls `Decide`" is a statement about
 * requests that were not made, not about a mock that was not invoked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

import '../../../lib/inference/config.server'
import type { DecideFn } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const FIXTURES = path.resolve(process.cwd(), 'src/__tests__/fixtures/decide')
const readFixture = (name: string) =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')).response

const SPEC = {
  key: 'route',
  question: 'Which route?',
  labels: [
    { id: 'search', description: 'look something up' },
    { id: 'chat', description: 'just talk' },
  ],
} as const

/** A verbalized secondary that records it was used. Never calibrated, by construction. */
const verbalizedStub = vi.fn(async () => ({
  probs: { search: 0.7, chat: 0.3 },
  method: 'verbalized' as const,
  calibrated: false,
}))

let server: Server
let requests = 0
let reply: unknown = readFixture('llamacpp-confident')

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.SMALL_LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  process.env.SMALL_LLM_API_KEY = 'local'
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'unused'
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
afterEach(() => {
  verbalizedStub.mockClear()
  requests = 0
  reply = readFixture('llamacpp-confident')
})

async function onPrivateTier<T>(fn: () => Promise<T>): Promise<T> {
  const clients = await import('@hames-ai/harness-baml/clients.server')
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  clients.assertInferenceTier('verda')
  return withRunFrame({ inference: { tier: 'verda' } }, fn)
}

describe('the selection table (by the resolved client)', () => {
  it('a LOGPROB_CLIENTS member is read for logprobs; the private tier’s decide client is one', async () => {
    const { decideTransportFor } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { LOGPROB_CLIENTS, VERDA_CLIENT_BY_ROLE } =
      await import('@hames-ai/harness-baml/clients.server')
    expect(decideTransportFor('LocalQwenSmallDecide')).toBe('logprob')
    expect(LOGPROB_CLIENTS.has(VERDA_CLIENT_BY_ROLE.decide!)).toBe(true)
  })

  it('a JEV_CLIENTS member selects the Jev transport (the set is empty until T4)', async () => {
    const { decideTransportFor } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { JEV_CLIENTS } = await import('@hames-ai/harness-baml/clients.server')
    expect(JEV_CLIENTS.size).toBe(0)
    ;(JEV_CLIENTS as Set<string>).add('JevDecide')
    try {
      expect(decideTransportFor('JevDecide')).toBe('jev')
    } finally {
      ;(JEV_CLIENTS as Set<string>).delete('JevDecide')
    }
  })

  it.each(['AnthropicHaiku45', 'VerdaQwen', 'LocalQwenSmall', 'JevDecide', 'whatever'])(
    'any other client (%s) is verbalized — a chat model cannot be read for a distribution',
    async (client) => {
      const { decideTransportFor } = await import('@hames-ai/harness-baml/baml-adapters.server')
      expect(decideTransportFor(client)).toBe('verbalized')
    },
  )
})

describe('a non-logprob client never calls `Decide` and never throws a logprob error', () => {
  it('the Anthropic tier (no frame) takes the verbalized secondary: calibrated false, zero requests', async () => {
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
    expect(verbalizedStub).toHaveBeenCalledTimes(1)
    expect(requests).toBe(0)
  })

  it('with no verbalized secondary wired it rejects with an LLMCallError — never a silent downgrade', async () => {
    const { createDecideAdapter, LLMCallError } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter()
    const err = await decide({ spec: SPEC, state: 's' }).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/no decide transport for client JevDecide/i)
    expect(String(err.message)).toMatch(/rather than downgrading/)
    // Not the logprob throw, and nothing was sent anywhere.
    expect(String(err.message)).not.toMatch(/top_logprobs/)
    expect(requests).toBe(0)
  })
})

describe('the narrow throw: a CLAIMED logprob client that returns no logprobs', () => {
  it('throws an LLMCallError naming the missing logprobs, and stamps hitOutputCap false', async () => {
    reply = readFixture('no-logprobs')
    const { createDecideAdapter, LLMCallError } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    const err = await onPrivateTier(() => decide({ spec: SPEC, state: 's' })).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/carried no top_logprobs/)
    expect(err.llmCall.hitOutputCap).toBe(false)
    // It reached the server (that is how it learned there were no logprobs) …
    expect(requests).toBe(1)
    // … and did NOT fall through to the verbalized secondary to cover for it.
    expect(verbalizedStub).not.toHaveBeenCalled()
  })

  it('treats an empty logprobs window the same way', async () => {
    reply = {
      ...readFixture('llamacpp-confident'),
      choices: [
        {
          index: 0,
          finish_reason: 'length',
          message: { role: 'assistant', content: 'A' },
          logprobs: { content: [] },
        },
      ],
    }
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter()
    await expect(onPrivateTier(() => decide({ spec: SPEC, state: 's' }))).rejects.toThrow(
      /carried no top_logprobs/,
    )
  })
})
