/**
 * The Jev transport — the Anthropic tier's `decide` client (#418, slice T4).
 *
 * The transport is a REST adapter, so the server is a `fetch` stub that COUNTS
 * requests and records their URLs: "no request was made" and "no request went
 * anywhere but the Jev endpoint" are statements about calls that did not
 * happen, not about a mock that was not invoked.
 *
 *   jev-tier-lock  — Jev is a public provider; refused under the private tier,
 *                    before any request, at BOTH layers
 *   jev-fallback   — connection error / non-2xx / malformed ⇒ abstain 'error'
 *                    on the fallback, and no request to any other provider
 *   jev-limits     — `limits().contextWindow === 32000`, and the default state
 *                    trimmer trims against it
 *   jev-cost-eur   — the provider-reported USD converts once at `EUR_PER_USD`;
 *                    the fourth pricing set (disjointness is in pricing-eur)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import '../../../lib/inference/config.server'
import {
  evaluateDecision,
  typedDecision,
} from '@hames-ai/harness-patterns/patterns/typedDecision.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import {
  observeLlmUsage,
  resetLlmUsageObservers,
  type LlmUsageSample,
} from '@hames-ai/harness-patterns/llm-usage-observer.server'
import type { DecideFn, DecisionSetSpec, DecisionSpec } from '@hames-ai/harness-patterns/types'
import { DEFAULT_EUR_PER_USD } from '../../../lib/settings'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const SPEC: DecisionSpec<'yes' | 'no'> = {
  key: 'memory.recall',
  question: 'Does this need memory?',
  labels: [
    { id: 'yes', description: 'needs memory' },
    { id: 'no', description: 'does not' },
  ],
}
const SET: DecisionSetSpec<{ route: 'search' | 'chat'; recall: 'yes' | 'no' }> = {
  key: 'turn',
  fields: {
    route: {
      key: 'route',
      question: 'Which route?',
      labels: [
        { id: 'search', description: 'look something up' },
        { id: 'chat', description: 'just talk' },
      ],
    },
    recall: SPEC,
  },
}

const JEV_BODY = {
  id: 'gen-dec-1',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: {
    route: {
      type: 'choice',
      choice: 'search',
      confidence: 0.9,
      probabilities: { search: 0.9, chat: 0.1 },
    },
    recall: {
      type: 'choice',
      choice: 'yes',
      confidence: 0.8,
      probabilities: { yes: 0.8, no: 0.2 },
    },
    'memory.recall': {
      type: 'choice',
      choice: 'yes',
      confidence: 0.7,
      probabilities: { yes: 0.7, no: 0.3 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 0, cost: 0.0004 },
}

// The private tier is refused without its endpoints; nothing listens there —
// the lock must refuse before any connection is attempted.
process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
process.env.VERDA_INFERENCE_API_KEY = 'unused'

// The BAML channel: a counting listener standing in for the private tier's 4B
// (`SMALL_LLM_BASE_URL`). A Jev failure must send NOTHING there either — the
// global-`fetch` count cannot see a call that rides the BAML runtime.
let smallServer: Server
let smallRequests = 0
beforeAll(async () => {
  smallServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      smallRequests++
      res.statusCode = 500
      res.end('{}')
    })
  })
  await new Promise<void>((r) => smallServer.listen(0, '127.0.0.1', r))
  process.env.SMALL_LLM_API_KEY = 'unused'
  process.env.SMALL_LLM_BASE_URL = `http://127.0.0.1:${(smallServer.address() as AddressInfo).port}/v1`
})
afterAll(() => new Promise<void>((r) => smallServer.close(() => r())))

let requests: Array<{ url: string; init: RequestInit }> = []
let respond: () => Promise<Response> = async () => Response.json(JEV_BODY)

beforeEach(() => {
  requests = []
  smallRequests = 0
  respond = async () => Response.json(JEV_BODY)
  process.env.JEV_DECISIONS_API_KEY = 'or-test-key'
  delete process.env.JEV_DECISIONS_URL
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), init })
      return respond()
    }),
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  resetLlmUsageObservers()
  const clients = await import('@hames-ai/harness-baml/clients.server')
  clients.configureConsumerClients(undefined)
})

async function onPrivateTier<T>(fn: () => Promise<T>): Promise<T> {
  const clients = await import('@hames-ai/harness-baml/clients.server')
  clients.assertInferenceTier('verda')
  return withRunFrame({ inference: { tier: 'verda' } }, fn)
}

async function transport() {
  const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
  return createJevTransport()
}
async function adapter() {
  const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
  return createDecideAdapter()
}

describe('the wire shape — ONE request carries every field as a typed question', () => {
  it('sends a single POST to the Decisions API with a choice question per field', async () => {
    const { decideAll } = await transport()
    const r = await decideAll({ spec: SET, state: 'the state' })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(requests[0].init.method).toBe('POST')
    expect((requests[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer or-test-key',
    )
    expect(JSON.parse(requests[0].init.body as string)).toEqual({
      model: 'typesafe/jev-1.13',
      state: 'the state',
      provider: { zdr: true, data_collection: 'deny' },
      questions: {
        route: {
          type: 'choice',
          instructions: 'Which route?',
          criteria: { search: 'look something up', chat: 'just talk' },
        },
        recall: {
          type: 'choice',
          instructions: 'Does this need memory?',
          criteria: { yes: 'needs memory', no: 'does not' },
        },
      },
    })
    expect(r.fields.route).toMatchObject({ method: 'jev', calibrated: true })
    expect(r.fields.route.probs).toEqual({ search: 0.9, chat: 0.1 })
    expect(r.fields.recall.probs).toEqual({ yes: 0.8, no: 0.2 })
  })

  it('normalises rounding: a distribution summing to ~1 is used, not refused', async () => {
    respond = async () =>
      Response.json({
        ...JEV_BODY,
        answers: { 'memory.recall': { type: 'choice', probabilities: { yes: 0.6, no: 0.395 } } },
      })
    const { decide } = await transport()
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.probs.yes + r.probs.no).toBeCloseTo(1, 12)
    expect(r.probs.yes).toBeCloseTo(0.6 / 0.995, 12)
    // No confidence on the answer: not claimed calibrated.
    expect(r.calibrated).toBe(false)
  })

  it('the adapter routes a Jev-resolved client to it (no consumer layer: the mirror names JevDecide)', async () => {
    const decide = await adapter()
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('jev')
    expect(requests).toHaveLength(1)
    expect(r.llmCall).toMatchObject({
      clientName: 'JevDecide',
      provider: 'openrouter',
      hitOutputCap: false,
    })
  })

  it('the set-level adapter makes ONE request on Jev and one pass per field on any other client', async () => {
    const { createDecideAdapter, createDecideAllAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const all = createDecideAllAdapter(createDecideAdapter())
    await all({ spec: SET, state: 's' })
    expect(requests).toHaveLength(1)

    const clients = await import('@hames-ai/harness-baml/clients.server')
    clients.configureConsumerClients((role) =>
      role === 'decide' ? { client: 'AnthropicHaiku45' } : undefined,
    )
    const calls: string[] = []
    const stub = (async (i: { spec: DecisionSpec }) => {
      calls.push(i.spec.key)
      return {
        probs: { yes: 1, no: 0, search: 1, chat: 0 },
        method: 'verbalized',
        calibrated: false,
      }
    }) as unknown as DecideFn
    await createDecideAllAdapter(stub)({ spec: SET, state: 's' })
    expect(calls).toEqual(['route', 'memory.recall'])
    expect(requests).toHaveLength(1) // nothing more went to Jev
  })
})

describe('jev-privacy — OpenRouter provider preferences (O1), own key (O2), endpoint scheme (O4)', () => {
  const lastBody = () => JSON.parse(requests[0].init.body as string)

  it('O1: the body carries zero data retention AND data collection denied on OpenRouter', async () => {
    const { decideAll } = await transport()
    await decideAll({ spec: SET, state: 's' })
    expect(lastBody().provider).toEqual({ zdr: true, data_collection: 'deny' })
  })

  it('O1: no OpenRouter preferences go to a non-OpenRouter endpoint (a loopback fake)', async () => {
    process.env.JEV_DECISIONS_URL = 'http://127.0.0.1:9/api/alpha/decisions'
    const { decideAll } = await transport()
    await decideAll({ spec: SET, state: 's' })
    expect(lastBody()).not.toHaveProperty('provider')
  })

  it.each([
    ['both dropped', {}],
    ['zdr off', { zdr: false, data_collection: 'deny' }],
    ['collection allowed', { zdr: true, data_collection: 'allow' }],
  ])('O1: preferences that cannot be applied (%s) refuse BEFORE any fetch', async (_n, prefs) => {
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    const { LLMCallError } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { decideAll } = createJevTransport({ openRouterPreferences: prefs })
    const err = await decideAll({ spec: SET, state: 's' }).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/provider preferences could not be applied/)
    expect(requests).toHaveLength(0)
    expect(smallRequests).toBe(0)
  })

  it('O2: the embedding provider key is never used — no key of its own, no request', async () => {
    delete process.env.JEV_DECISIONS_API_KEY
    process.env.OPENROUTER_API_KEY = 'embedding-key'
    try {
      const { decideAll } = await transport()
      await expect(decideAll({ spec: SET, state: 's' })).rejects.toThrow(/JEV_DECISIONS_API_KEY/)
      expect(requests).toHaveLength(0)
    } finally {
      delete process.env.OPENROUTER_API_KEY
    }
  })

  it('O2: the bearer is the decision key even when the embedding key is also set', async () => {
    process.env.OPENROUTER_API_KEY = 'embedding-key'
    try {
      const { decideAll } = await transport()
      await decideAll({ spec: SET, state: 's' })
      expect((requests[0].init.headers as Record<string, string>).authorization).toBe(
        'Bearer or-test-key',
      )
    } finally {
      delete process.env.OPENROUTER_API_KEY
    }
  })

  it.each([
    'http://example.com/api/alpha/decisions',
    'http://10.0.0.5/decisions',
    'http://127.0.0.1.evil.example/decisions',
    'http://127.0.0.1@evil.example/decisions',
    'https://evil.example@127.0.0.1/decisions',
    'ftp://127.0.0.1/decisions',
    'not a url',
  ])('O4: %s is refused before the key is read and before any fetch', async (url) => {
    process.env.JEV_DECISIONS_URL = url
    delete process.env.JEV_DECISIONS_API_KEY // a key read first would surface as the key error
    const { decideAll } = await transport()
    await expect(decideAll({ spec: SET, state: 's' })).rejects.toThrow(/Refusing JEV_DECISIONS_URL/)
    expect(requests).toHaveLength(0)
  })

  it.each([
    'https://openrouter.ai/api/alpha/decisions',
    'https://gateway.example.com/decisions',
    'http://localhost:8080/x',
    'http://127.0.0.1:8080/x',
    'http://127.4.5.6/x',
    'http://[::1]:8080/x',
  ])('O4: %s is accepted', async (url) => {
    process.env.JEV_DECISIONS_URL = url
    const { decideAll } = await transport()
    await decideAll({ spec: SET, state: 's' })
    expect(requests).toHaveLength(1)
  })
})

describe('jev-tier-lock — Jev is a public provider and may never take a private-tier call', () => {
  it('the transport refuses on its own under the private tier — before reading the key or sending', async () => {
    delete process.env.JEV_DECISIONS_API_KEY
    const { decideAll, decide } = await transport()
    const { LLMCallError } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const err = await onPrivateTier(() => decideAll({ spec: SET, state: 's' })).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/Refusing the Jev decide transport under the private/)
    await expect(onPrivateTier(() => decide({ spec: SPEC, state: 's' }))).rejects.toThrow(
      /private inference tier/,
    )
    expect(requests).toHaveLength(0)
  })

  it('a consumer mapping decide to JevDecide under the private tier is refused, zero requests', async () => {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    clients.configureConsumerClients((role) =>
      role === 'decide' ? { client: 'JevDecide' } : undefined,
    )
    const { createDecideAdapter, createDecideAllAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter()
    await expect(onPrivateTier(() => decide({ spec: SPEC, state: 's' }))).rejects.toThrow(
      /Refusing decide transport "jev"/,
    )
    await expect(
      onPrivateTier(() => createDecideAllAdapter(decide)({ spec: SET, state: 's' })),
    ).rejects.toThrow(/private inference tier/)
    expect(requests).toHaveLength(0)
  })

  it('core decide() turns the refusal into a fail-closed abstain', async () => {
    const clients = await import('@hames-ai/harness-baml/clients.server')
    clients.configureConsumerClients((role) =>
      role === 'decide' ? { client: 'JevDecide' } : undefined,
    )
    const decide = await adapter()
    const out = await onPrivateTier(() =>
      evaluateDecision({ decide, spec: SPEC, state: 's', policy: { fallback: 'no' } }),
    )
    expect(out.decision).toMatchObject({ abstained: true, reason: 'error', label: 'no' })
    expect(requests).toHaveLength(0)
  })

  it('the deployment-default private tier (USE_VERDA_INFERENCE=1, no run frame) is refused at both layers', async () => {
    process.env.USE_VERDA_INFERENCE = '1'
    try {
      const { decideAll } = await transport()
      await expect(decideAll({ spec: SET, state: 's' })).rejects.toThrow(/private inference tier/)
      const clients = await import('@hames-ai/harness-baml/clients.server')
      clients.configureConsumerClients((role) =>
        role === 'decide' ? { client: 'JevDecide' } : undefined,
      )
      await expect((await adapter())({ spec: SPEC, state: 's' })).rejects.toThrow(/private/)
      expect(requests).toHaveLength(0)
    } finally {
      delete process.env.USE_VERDA_INFERENCE
    }
  })
})

describe('jev-fallback — fail closed, never a downgrade to another provider', () => {
  const failures: Array<[string, () => Promise<Response>]> = [
    ['a connection error', async () => Promise.reject(new TypeError('fetch failed'))],
    [
      'a non-2xx',
      async () => new Response('{"error":{"code":502,"message":"upstream"}}', { status: 502 }),
    ],
    [
      'a non-2xx carrying an answer-shaped body',
      async () => Response.json(JEV_BODY, { status: 502 }),
    ],
    ['a body that is not JSON', async () => new Response('<html>', { status: 200 })],
    [
      'a body with no answers',
      async () => Response.json({ usage: { input_tokens: 1, output_tokens: 0 } }),
    ],
    [
      'an answer with no probabilities',
      async () =>
        Response.json({
          ...JEV_BODY,
          answers: { 'memory.recall': { type: 'choice', choice: 'yes' } },
        }),
    ],
    [
      'probabilities naming none of the labels',
      async () =>
        Response.json({
          ...JEV_BODY,
          answers: { 'memory.recall': { probabilities: { other: 1 } } },
        }),
    ],
    [
      'a label omitted, the rest summing to 1',
      async () =>
        Response.json({ ...JEV_BODY, answers: { 'memory.recall': { probabilities: { yes: 1 } } } }),
    ],
    [
      'a label omitted (mass 0.55)',
      async () =>
        Response.json({
          ...JEV_BODY,
          answers: { 'memory.recall': { probabilities: { yes: 0.55 } } },
        }),
    ],
    [
      'mass that does not sum to 1 (0.5)',
      async () =>
        Response.json({
          ...JEV_BODY,
          answers: { 'memory.recall': { probabilities: { yes: 0.3, no: 0.2 } } },
        }),
    ],
    [
      'a probability above 1',
      async () =>
        Response.json({
          ...JEV_BODY,
          answers: { 'memory.recall': { probabilities: { yes: 3, no: 0 } } },
        }),
    ],
    [
      'a negative probability',
      async () =>
        Response.json({
          ...JEV_BODY,
          answers: { 'memory.recall': { probabilities: { yes: -1, no: 2 } } },
        }),
    ],
  ]

  it.each(failures)(
    '%s abstains "error" on the fallback with exactly one request, to Jev',
    async (_n, r) => {
      respond = r
      const decide = await adapter()
      const out = await evaluateDecision({
        decide,
        spec: SPEC,
        state: 's',
        policy: { fallback: 'no' },
      })
      expect(out.decision).toMatchObject({ label: 'no', abstained: true, reason: 'error' })
      expect(out.error).toBeDefined()
      expect(requests.map((q) => q.url)).toEqual(['https://openrouter.ai/api/alpha/decisions'])
      // … and nothing rode the BAML runtime to the private tier's 4B either.
      expect(smallRequests).toBe(0)
    },
  )

  it('a non-2xx is refused on its STATUS, even with an answer-shaped body', async () => {
    respond = async () => Response.json(JEV_BODY, { status: 502 })
    const out = await evaluateDecision({
      decide: await adapter(),
      spec: SPEC,
      state: 's',
      policy: { fallback: 'no' },
    })
    expect(out.decision).toMatchObject({ label: 'no', abstained: true, reason: 'error' })
    expect(out.error?.error).toMatch(/HTTP 502/)
    expect(requests).toHaveLength(1)
  })

  it('every request carries a timeout signal (an unbounded fetch has none)', async () => {
    const { decideAll } = await transport()
    await decideAll({ spec: SET, state: 's' })
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a missing key is a refusal before any request', async () => {
    delete process.env.JEV_DECISIONS_API_KEY
    const decide = await adapter()
    const out = await evaluateDecision({
      decide,
      spec: SPEC,
      state: 's',
      policy: { fallback: 'no' },
    })
    expect(out.decision).toMatchObject({ abstained: true, reason: 'error' })
    expect(requests).toHaveLength(0)
  })

  it('an answered-but-unparseable response is still ACCOUNTED (it was billed)', async () => {
    const seen: LlmUsageSample[] = []
    observeLlmUsage((s) => seen.push(s))
    respond = async () =>
      Response.json({ answers: {}, usage: { input_tokens: 9, output_tokens: 0, cost: 0.001 } })
    const decide = await adapter()
    await evaluateDecision({ decide, spec: SPEC, state: 's', policy: { fallback: 'no' } })
    expect(seen).toHaveLength(1)
    expect(seen[0].clientName).toBe('JevDecide')
  })
})

describe('jev-limits — the 32k state cap', () => {
  it('reports contextWindow 32000 through the adapter, the transport and the set entry', async () => {
    const { createDecideAdapter, createDecideAllAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter()
    expect(decide.limits!().contextWindow).toBe(32_000)
    expect(createDecideAllAdapter(decide).limits!().contextWindow).toBe(32_000)
    const t = await transport()
    expect(t.decide.limits!().contextWindow).toBe(32_000)
    expect(t.decideAll.limits!().contextWindow).toBe(32_000)
  })

  it('the default state trimmer trims a longer state against it', async () => {
    const decide = await adapter()
    const ctx = createContext<Record<string, never>>('the newest message', {})
    // 40 old messages of ~4k tokens each: ~160k tokens, five times the window.
    const old = 'x'.repeat(16_000)
    ctx.events.unshift(
      ...Array.from({ length: 40 }, (_, i) => ({
        type: 'user_message' as const,
        ts: i,
        patternId: 'test',
        data: { content: `${i}:${old}` },
      })),
    )
    await withRunFrame({}, () =>
      runChain(ctx, [typedDecision({ decide, spec: SPEC, policy: { fallback: 'no' } })]),
    )
    expect(requests).toHaveLength(1)
    const state = JSON.parse(requests[0].init.body as string).state as string
    // Trimmed to the 32k window (≈ 4 chars/token), not shipped whole …
    expect(state.length).toBeLessThan(32_000 * 4)
    // … and the newest message survives the trim.
    expect(state).toContain('the newest message')
  })
})

describe('jev-cost-eur — the provider-reported USD converts at EUR_PER_USD', () => {
  it('a usage.cost of USD N renders as N × EUR_PER_USD on the provider basis', async () => {
    const seen: LlmUsageSample[] = []
    observeLlmUsage((s) => seen.push(s))
    const decide = await adapter()
    const r = await decide({ spec: SPEC, state: 's' })
    const expected = 0.0004 * DEFAULT_EUR_PER_USD
    expect(r.llmCall!.metrics).toMatchObject({
      inputUncachedTokens: 120,
      outputTokens: 0,
      attempts: 1,
      basis: 'provider',
    })
    expect(r.llmCall!.metrics!.costEur).toBeCloseTo(expected, 12)
    // Not the USD figure unconverted, and not a time basis (no `≥` floor).
    expect(r.llmCall!.metrics!.costEur).not.toBeCloseTo(0.0004, 9)
    expect(r.llmCall!.metrics!.timePricedAttempts).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ functionName: 'Decide', clientName: 'JevDecide' })
    expect(seen[0].metrics!.costEur).toBeCloseTo(expected, 12)
  })

  it('follows the host-set EUR_PER_USD (the one conversion rule)', async () => {
    process.env.EUR_PER_USD = '0.5'
    try {
      const decide = await adapter()
      const r = await decide({ spec: SPEC, state: 's' })
      expect(r.llmCall!.metrics!.costEur).toBeCloseTo(0.0002, 12)
    } finally {
      delete process.env.EUR_PER_USD
    }
  })

  it('a response with no usage.cost reads as unknown, never as free', async () => {
    respond = async () =>
      Response.json({ ...JEV_BODY, usage: { input_tokens: 120, output_tokens: 0 } })
    const decide = await adapter()
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.llmCall!.metrics!.costEur).toBeUndefined()
    expect(r.llmCall!.metrics!.inputUncachedTokens).toBe(120)
  })
})
