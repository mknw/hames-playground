/**
 * The decide secondary beside T4's Jev transport (#418 T5 × T4, #513 fix round 1).
 *
 * On the Anthropic tier the role has two possible transports. When nothing is
 * named, Jev runs exactly as on main. When an operator names `DecideAnthropic`
 * it REPLACES Jev there — Jev is never called, field by field — and the private
 * tier ignores the setting and never reaches either. The injected verbalized
 * function is a stub here (the real factory is pinned in decide-verbalized);
 * what is pinned is WHICH transport the resolved client selects, counted on a
 * stubbed `fetch` standing in for the Jev endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../lib/inference/config.server'
import type { DecideFn, DecisionSetSpec } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
process.env.VERDA_INFERENCE_API_KEY = 'unused'
process.env.SMALL_LLM_API_KEY = 'unused'
process.env.SMALL_LLM_BASE_URL = 'http://127.0.0.1:1/v1'

const SPEC = {
  key: 'route',
  question: 'Which route?',
  labels: [
    { id: 'search', description: 'look something up' },
    { id: 'chat', description: 'just talk' },
  ],
} as const
const SET: DecisionSetSpec<{ route: 'search' | 'chat' }> = {
  key: 'turn',
  fields: { route: SPEC },
}

const JEV_BODY = {
  id: 'g',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: {
    route: {
      type: 'choice',
      choice: 'search',
      confidence: 0.9,
      probabilities: { search: 0.9, chat: 0.1 },
    },
  },
  usage: { input_tokens: 10, output_tokens: 0, cost: 0.0001 },
}

let jevRequests = 0
const verbalizedStub = vi.fn(async () => ({
  probs: { search: 0.6, chat: 0.4 },
  method: 'verbalized' as const,
  calibrated: false,
}))

beforeEach(() => {
  jevRequests = 0
  verbalizedStub.mockClear()
  process.env.JEV_DECISIONS_API_KEY = 'or-test-key'
  vi.stubEnv('JEV_DECISIONS_URL', 'https://openrouter.ai/api/alpha/decisions')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      jevRequests++
      return Response.json(JEV_BODY)
    }),
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  const clients = await import('@hames-ai/harness-baml/clients.server')
  clients.configureDecideSecondary(undefined)
})

async function adapters() {
  const { createDecideAdapter, createDecideAllAdapter } =
    await import('@hames-ai/harness-baml/baml-adapters.server')
  const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
  return { decide, decideAll: createDecideAllAdapter(decide) }
}

describe('setting unset — T4’s Jev transport runs exactly as on main', () => {
  it('one decide and one set are served by Jev; the injected secondary is never called', async () => {
    const { decide, decideAll } = await adapters()
    expect(decide.serving('route').method).toBe('jev')
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('jev')
    const all = await decideAll({ spec: SET, state: 's' })
    expect(all.fields.route.method).toBe('jev')
    expect(jevRequests).toBe(2)
    expect(verbalizedStub).not.toHaveBeenCalled()
  })
})

describe('setting named on the Anthropic tier — the secondary wins, Jev is never called', () => {
  it('decide and decideAll are served verbalized; zero requests to the Jev endpoint', async () => {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    clients.configureDecideSecondary('DecideAnthropic')
    const { decide, decideAll } = await adapters()
    expect(decide.serving('route').method).toBe('verbalized')
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
    const all = await decideAll({ spec: SET, state: 's' })
    expect(all.fields.route.method).toBe('verbalized')
    expect(verbalizedStub).toHaveBeenCalledTimes(2)
    expect(jevRequests).toBe(0)
  })
})

describe('setting named, private tier — ignored; neither the secondary nor Jev is reached', () => {
  it('serves the logprob client and sends nothing to Jev or the secondary', async () => {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    clients.configureDecideSecondary('DecideAnthropic')
    const { decide } = await adapters()
    clients.assertInferenceTier('verda')
    await withRunFrame({ inference: { tier: 'verda' } }, async () => {
      expect(clients.resolveClientForRole('decide')).toBe('LocalQwenSmallDecide')
      expect(decide.serving('route').method).toBe('logprob')
    })
    expect(verbalizedStub).not.toHaveBeenCalled()
    expect(jevRequests).toBe(0)
  })
})
