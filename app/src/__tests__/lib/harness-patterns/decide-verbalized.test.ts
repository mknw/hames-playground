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

  it('renormalises rounding within the tolerance, and uses the result', async () => {
    await nameByoClient()
    content = stated(0.6, 0.3, 0.08) // sums to 0.98
    const r = await (await verbalized())({ spec: SPEC, state: 's' })
    expect(r.probs.episodic).toBeCloseTo(0.6 / 0.98, 9)
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
    expect(String(err.message)).toMatch(/no usable distribution/)
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

describe('verbalizedProbabilities (pure) — fails closed like the Jev transport (#511 R3)', () => {
  const L = ['A', 'B', 'C']
  const row = (...v: Array<[string, number]>) =>
    v.map(([letter, probability]) => ({ letter, probability }))

  it('reads a complete, in-range distribution within the tolerance', async () => {
    const { verbalizedProbabilities: v } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    expect(v(row(['A', 0.5], ['B', 0.25], ['C', 0.25]), L)).toEqual({ A: 0.5, B: 0.25, C: 0.25 })
    expect(v(row([' a ', 0.5], ['b', 0.25], ['C', 0.25]), L)).toEqual({ A: 0.5, B: 0.25, C: 0.25 })
    // An unlisted letter is ignored; the listed ones still make a complete answer.
    expect(v(row(['Q', 0.9], ['A', 0.5], ['B', 0.25], ['C', 0.25]), L)).toEqual({
      A: 0.5,
      B: 0.25,
      C: 0.25,
    })
  })

  it.each([
    ['omitted options', row(['A', 1])],
    ['a single partial value', row(['A', 0.3])],
    ['a percent scale', row(['A', 70], ['B', 20], ['C', 10])],
    ['a negative value', row(['A', 1.2], ['B', -0.2], ['C', 0])],
    ['a value above 1', row(['A', 1.5], ['B', 0], ['C', 0])],
    ['a repeated letter', row(['A', 0.5], ['A', 0.5], ['B', 0.25], ['C', 0.25])],
    ['a sum of 0.6', row(['A', 0.3], ['B', 0.2], ['C', 0.1])],
    ['an unlisted letter carrying the mass', row(['Q', 1], ['A', 0], ['B', 0], ['C', 0])],
    ['a non-finite value', row(['A', Number.NaN], ['B', 0.5], ['C', 0.5])],
    ['no answer', []],
  ])('%s is not a usable distribution', async (_name, stated) => {
    const { verbalizedProbabilities: v } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    expect(v(stated, L)).toBeUndefined()
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
    expect(String(err.message)).toMatch(/serves only a client that was re-named/)
    expect(hits).toHaveLength(0)
  })

  it('through createDecideAdapter: the named secondary is selected as verbalized and reports so before the call', async () => {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    const { createDecideAdapter, createVerbalizedDecide } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: createVerbalizedDecide() })
    // The role's default is refused by the factory, so nothing is reported as
    // verbalized until a client is named (#513 review R3).
    expect(decide.serving('memory.kind').method).not.toBe('verbalized')
    await nameByoClient()
    expect(decide.serving('memory.kind')).toEqual({ method: 'verbalized' })
    content = stated(0.1, 0.1, 0.8)
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
    expect(r.probs.preference).toBeCloseTo(0.8, 6)
    expect(clients.resolveClientForRole('decide')).toBe('ByoDecide')
  })

  it('requireCalibrated still abstains on the real factory: uncalibrated, and no request is made (D15)', async () => {
    // A consumer client (the loopback), NOT the DecideAnthropic secondary, so a
    // regression reaches the loopback rather than a public endpoint.
    const { createDecideAdapter, createVerbalizedDecide } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const { evaluateDecision } =
      await import('@hames-ai/harness-patterns/patterns/typedDecision.server')
    await nameByoClient()
    content = stated(0.1, 0.1, 0.8)
    const out = await evaluateDecision({
      decide: createDecideAdapter({ verbalized: createVerbalizedDecide() }),
      spec: SPEC,
      state: 's',
      policy: { fallback: 'episodic', requireCalibrated: true },
    })
    expect(out.decision.abstained).toBe(true)
    expect(out.decision.reason).toBe('uncalibrated')
    expect(hits).toHaveLength(0)
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
    // The floor is the min over the PARSED chain, so a leaf added to the
    // strategy moves this expectation instead of hiding behind two hard-coded names.
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const src = readFileSync(
      path.resolve(process.cwd(), '../packages/harness-baml/baml_src/anthropic-only.baml'),
      'utf8',
    )
    const chain = /client<llm> DecideAnthropic \{[\s\S]*?strategy \[([^\]]*)\]/
      .exec(src)![1]
      .split(',')
      .map((x) => x.trim())
    expect(chain.length).toBeGreaterThan(0)
    expect(CLIENT_MAX_OUTPUT_TOKENS.DecideAnthropic).toBe(
      Math.min(...chain.map((c) => CLIENT_MAX_OUTPUT_TOKENS[c])),
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

// S3: same categorical mapping; stated probabilities remain uncalibrated.
describe('S3 verbalized specs', () => {
  const score = {
    type: 'score' as const,
    key: 's3.score',
    question: 'How urgent?',
    levels: [
      { id: 'later', description: 'A reply next month is fine' },
      { id: 'today', description: 'A reply today is needed' },
      { id: 'now', description: 'Work is blocked until a reply' },
    ],
  }
  const noul = {
    type: 'noul' as const,
    key: 's3.noul',
    question: 'The statement holds.',
    criteria: { true: 'Custom yes', false: 'Custom no' },
  }

  it('score-order-preserved: stated letter i returns level i', async () => {
    await nameByoClient()
    content = stated(0.1, 0.2, 0.7)
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const secondary = await verbalized()
    const fn = createDecideAdapter({ verbalized: secondary })
    expect(secondary.supportedTypes).toEqual(['choice', 'score', 'noul'])
    expect(fn.supportedTypes).toEqual(['choice', 'score', 'noul'])
    const r = await fn({ spec: score, state: 'synthetic' })
    expect(r.probs).toEqual({ later: 0.1, today: 0.2, now: 0.7 })
    const user = JSON.stringify(hits[0].messages)
    expect(user).toContain('A. A reply next month is fine')
    expect(user).toContain('B. A reply today is needed')
    expect(user).toContain('C. Work is blocked until a reply')
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
  })

  it('noul-letter-mapping: A is true, B is false, including default descriptions', async () => {
    await nameByoClient()
    content = JSON.stringify([
      { letter: 'A', probability: 0.8 },
      { letter: 'B', probability: 0.2 },
    ])
    const fn = await verbalized()
    const r = await fn({ spec: noul, state: 'synthetic' })
    expect(r.probs).toEqual({ true: 0.8, false: 0.2 })
    expect(JSON.stringify(hits[0].messages)).toContain('A. Custom yes')
    expect(JSON.stringify(hits[0].messages)).toContain('B. Custom no')
    await fn({ spec: { ...noul, criteria: undefined }, state: 'synthetic' })
    expect(JSON.stringify(hits[1].messages)).toContain('A. Yes — the statement holds')
    expect(JSON.stringify(hits[1].messages)).toContain('B. No — the statement does not hold')
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
  })

  it('new types remain uncalibrated and reject incomplete distributions', async () => {
    await nameByoClient()
    const { configureDecisionCalibration } = await import('@hames-ai/harness-baml/clients.server')
    const fn = await verbalized()
    configureDecisionCalibration({
      ByoDecide: {
        's3.score': { temperature: 2, bias: { A: 4 } },
        's3.noul': { temperature: 2, bias: { A: 4 } },
      },
    })
    for (const spec of [score, noul]) {
      content =
        spec.type === 'score'
          ? stated(0.1, 0.2, 0.7)
          : JSON.stringify([
              { letter: 'A', probability: 0.8 },
              { letter: 'B', probability: 0.2 },
            ])
      const r = await fn<string>({ spec, state: 'synthetic' })
      expect(r.calibrated).toBe(false)
      expect(r.probs[spec.type === 'score' ? 'later' : 'true']).toBe(
        spec.type === 'score' ? 0.1 : 0.8,
      )
      content = '[{"letter":"A","probability":1}]'
      await expect(fn({ spec, state: 'synthetic' })).rejects.toThrow(/no usable distribution/)
    }
  })

  it('score/noul tier lock: raw and routed secondary make zero calls under the private tier', async () => {
    await nameByoClient()
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const secondary = await verbalized()
    const fn = createDecideAdapter({ verbalized: secondary })
    await onPrivateTier(async () => {
      expect(fn.supportedTypes).toEqual([]) // consumer override selects the public secondary
      for (const spec of [score, noul]) {
        await expect(secondary({ spec, state: 'synthetic' })).rejects.toThrow(
          /outside the Anthropic tier/,
        )
        await expect(fn({ spec, state: 'synthetic' })).rejects.toThrow(/private inference tier/)
      }
    })
    expect(hits).toHaveLength(0)
  })

  it.each([1, 11])('score transport cap refuses %i levels', async (n) => {
    await nameByoClient()
    const fn = await verbalized()
    await expect(
      fn({
        spec: {
          ...score,
          levels: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, description: 'd' })),
        },
        state: 'synthetic',
      }),
    ).rejects.toThrow(/2\.\.10/)
    expect(hits).toHaveLength(0)
  })
})
