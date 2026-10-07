/**
 * `DecideVerbalized` + `createVerbalizedDecide` — the explicit verbalized
 * secondary (#418 slice T5), against the REAL BAML runtime.
 *
 * The BAML runtime, generated client, rendered request and parser are real; the
 * server is a node http listener on a loopback port answering as an
 * OpenAI-compatible chat completion, reached by naming a consumer client for the
 * `decide` role — the same "a client an operator named" path the secondary is
 * for, without needing an Anthropic endpoint. The DECLARED client
 * (`DecideAnthropic`) is pinned separately on its rendered request body.
 *
 * What the pins protect: a stated probability is not a measurement, so this
 * transport can never report `calibrated: true`, never reaches the private
 * tier, never serves the role's own default, and never turns an answer with no
 * usable probability into a confident distribution.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import '../../../lib/inference/config.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'offline-render-test'

const SPEC = {
  key: 'memory.kind',
  question: 'What kind of memory is the statement in the data?',
  labels: [
    { id: 'episodic', description: 'a specific event that happened' },
    { id: 'semantic', description: 'a general fact about the world' },
    { id: 'preference', description: 'something the person likes' },
  ],
} as const

let server: Server
let hits: Array<Record<string, unknown>> = []
let content = '[]'

const completion = (text: string) => ({
  id: 'x',
  object: 'chat.completion',
  created: 0,
  model: 'byo',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
})
const stated = (a: number, b: number, c: number) =>
  JSON.stringify([
    { letter: 'A', probability: a },
    { letter: 'B', probability: b },
    { letter: 'C', probability: c },
  ])

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      hits.push(JSON.parse(raw || '{}'))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(completion(content)))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.SMALL_LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  process.env.SMALL_LLM_API_KEY = 'local'
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'unused'
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
afterEach(async () => {
  hits = []
  content = '[]'
  const clients = await import('@hames-ai/harness-baml/clients.server')
  clients.configureConsumerClients(undefined)
  clients.configureDecisionCalibration({})
})

/** An operator who named a client for the decide role (the verbalized path). */
async function nameByoClient(): Promise<void> {
  const { defineInferenceClients, activateConsumerClients } =
    await import('@hames-ai/harness-baml/consumer-clients.server')
  activateConsumerClients(
    defineInferenceClients({
      clients: [
        {
          name: 'ByoDecide',
          provider: 'openai-generic',
          options: {
            model: 'byo',
            base_url: process.env.SMALL_LLM_BASE_URL,
            api_key: 'local',
          },
        },
      ],
      byRole: { decide: 'ByoDecide' },
    }),
  )
}

async function onPrivateTier<T>(fn: () => Promise<T>): Promise<T> {
  const clients = await import('@hames-ai/harness-baml/clients.server')
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  clients.assertInferenceTier('verda')
  return withRunFrame({ inference: { tier: 'verda' } }, fn)
}

async function verbalized() {
  const { createVerbalizedDecide } = await import('@hames-ai/harness-baml/baml-adapters.server')
  return createVerbalizedDecide()
}

describe('the transport, as served by a client an operator named', () => {
  it('maps stated letters back to label ids and ALWAYS reports verbalized, uncalibrated', async () => {
    await nameByoClient()
    content = stated(0.7, 0.2, 0.1)
    const r = await (await verbalized())({ spec: SPEC, state: 'I like dark roast.' })
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
    expect(r.probs.episodic).toBeCloseTo(0.7, 6)
    expect(r.probs.semantic).toBeCloseTo(0.2, 6)
    expect(r.probs.preference).toBeCloseTo(0.1, 6)
    // No window was read: coverage is a logprob notion and stays absent.
    expect(r.coverage).toBeUndefined()
    expect(r.llmCall?.functionName).toBe('DecideVerbalized')
    expect(hits).toHaveLength(1)
  })

  it('is uncalibrated BY CONSTRUCTION — a fitted entry for the client is never applied', async () => {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    clients.configureDecisionCalibration({
      ByoDecide: { 'memory.kind': { temperature: 3, bias: { episodic: 2 } } },
    })
    await nameByoClient()
    content = stated(0.7, 0.2, 0.1)
    const r = await (await verbalized())({ spec: SPEC, state: 's' })
    expect(r.calibrated).toBe(false)
    expect(r.probs.episodic).toBeCloseTo(0.7, 6)
  })

  it('renormalises figures that do not sum to 1', async () => {
    await nameByoClient()
    content = stated(0.45, 0.45, 0) // sums to 0.9
    const r = await (await verbalized())({ spec: SPEC, state: 's' })
    expect(r.probs.episodic).toBeCloseTo(0.5, 6)
    expect(Object.values(r.probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })

  it('an answer with no usable probability is an LLMCallError, not a confident distribution', async () => {
    await nameByoClient()
    content = JSON.stringify([
      { letter: 'Z', probability: 1 },
      { letter: 'A', probability: 0 },
      { letter: 'B', probability: 0 },
    ])
    const { LLMCallError } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const err = await (await verbalized())({ spec: SPEC, state: 's' }).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/no probability for any listed option/)
    expect(err.llmCall.functionName).toBe('DecideVerbalized')
  })

  it('refuses a spec outside 2..MAX_DECISION_LABELS before any request', async () => {
    await nameByoClient()
    const { MAX_DECISION_LABELS } = await import('@hames-ai/harness-patterns/types')
    const labels = Array.from({ length: MAX_DECISION_LABELS + 1 }, (_, i) => ({
      id: `l${i}`,
      description: `label ${i}`,
    }))
    await expect(
      (await verbalized())({ spec: { ...SPEC, labels } as never, state: 's' }),
    ).rejects.toThrow(/takes 2\.\./)
    expect(hits).toHaveLength(0)
  })
})

describe('verbalizedProbabilities (pure)', () => {
  it('clamps, ignores unknown letters, sums repeats, renormalises; undefined when no mass', async () => {
    const { verbalizedProbabilities: v } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    expect(
      v(
        [
          { letter: 'A', probability: 3 },
          { letter: 'B', probability: -1 },
        ],
        ['A', 'B'],
      ),
    ).toEqual({
      A: 1,
      B: 0,
    })
    expect(
      v(
        [
          { letter: 'A', probability: 0.3 },
          { letter: 'Q', probability: 0.7 },
        ],
        ['A', 'B'],
      ),
    ).toEqual({
      A: 1,
      B: 0,
    })
    expect(
      v(
        [
          { letter: ' a ', probability: 0.25 },
          { letter: 'A', probability: 0.25 },
          { letter: 'B', probability: 0.5 },
        ],
        ['A', 'B'],
      ),
    ).toEqual({ A: 0.5, B: 0.5 })
    expect(v([{ letter: 'A', probability: Number.NaN }], ['A', 'B'])).toBeUndefined()
    expect(v([], ['A', 'B'])).toBeUndefined()
  })
})

describe('the tier lock', () => {
  it('refuses on the private tier before any request, even though a client is named', async () => {
    await nameByoClient()
    content = stated(0.7, 0.2, 0.1)
    const { LLMCallError } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = await verbalized()
    const err = await onPrivateTier(() => decide({ spec: SPEC, state: 's' })).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/outside the Anthropic tier/)
    expect(hits).toHaveLength(0)
  })
})

describe('reachable only when an operator names it', () => {
  it('the role’s own default is never served: no request, an LLMCallError', async () => {
    // Nothing named: the Anthropic tier resolves to the mirror (`JevDecide`).
    const { LLMCallError } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const err = await (await verbalized())({ spec: SPEC, state: 's' }).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/serves only a client an operator named/)
    expect(hits).toHaveLength(0)
  })

  it('through createDecideAdapter: the named secondary is selected as verbalized and reports so before the call', async () => {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    const { createDecideAdapter, createVerbalizedDecide } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: createVerbalizedDecide() })
    expect(decide.serving('memory.kind')).toEqual({ method: 'verbalized' })
    await nameByoClient()
    content = stated(0.1, 0.1, 0.8)
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
    expect(r.probs.preference).toBeCloseTo(0.8, 6)
    expect(clients.resolveClientForRole('decide')).toBe('ByoDecide')
  })

  it('through createDecideAdapter on the private tier: the lock holds with the secondary injected', async () => {
    const { createDecideAdapter, createVerbalizedDecide } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const clients = await import('@hames-ai/harness-baml/clients.server')
    clients.configureDecideSecondary('DecideAnthropic')
    try {
      const decide = createDecideAdapter({ verbalized: createVerbalizedDecide() })
      // The private tier ignores the setting (G5) and takes its own 4B, which
      // is the logprob transport, not the secondary.
      await onPrivateTier(async () => {
        expect(clients.resolveClientForRole('decide')).toBe('LocalQwenSmallDecide')
        expect(decide.serving('k').method).toBe('logprob')
      })
    } finally {
      clients.configureDecideSecondary(undefined)
    }
  })
})

describe('the declared client — DecideAnthropic', () => {
  type Body = {
    model?: string
    thinking?: { type?: string }
    system?: unknown
    messages?: Array<{ role: string }>
    max_tokens?: number
  }
  const OPTS = [
    { letter: 'A', description: 'first' },
    { letter: 'B', description: 'second' },
  ]

  it('renders on Sonnet 5 with thinking off, system leading, in its own chain', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const req = await b.request.DecideVerbalized('state', 'which?', OPTS)
    const body = req.body.json() as Body
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.system).toBeTruthy()
    expect((body.messages ?? []).map((m) => m.role)).not.toContain('system')
  })

  it('mirrors its chain floor and window in the host tables (a missing entry blinds truncation detection)', async () => {
    const { CLIENT_MAX_OUTPUT_TOKENS, MODEL_CONTEXT_WINDOWS } =
      await import('../../../lib/settings')
    expect(CLIENT_MAX_OUTPUT_TOKENS.DecideAnthropic).toBe(
      Math.min(
        CLIENT_MAX_OUTPUT_TOKENS.AnthropicSonnet5NoThink,
        CLIENT_MAX_OUTPUT_TOKENS.AnthropicSonnet46NoThink,
      ),
    )
    expect(MODEL_CONTEXT_WINDOWS.DecideAnthropic).toBe(MODEL_CONTEXT_WINDOWS.ControllerAnthropic)
  })

  it('is its own block, not a DescribeAnthropic function', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const src = readFileSync(
      path.resolve(process.cwd(), '../packages/harness-baml/baml_src/decide.baml'),
      'utf8',
    )
    expect(src).toMatch(/function DecideVerbalized\([\s\S]*?client DecideAnthropic/)
    expect(src).not.toMatch(/client DescribeAnthropic/)
  })
})
