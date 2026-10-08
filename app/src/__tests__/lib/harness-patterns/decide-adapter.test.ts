/**
 * `createDecideAdapter` — the logprob readout behind the raw `DecideFn` seam
 * (#418, slice T3), against the REAL BAML runtime.
 *
 * What is real and what is not. The BAML runtime, the generated client, the
 * rendered request and the collector are all real: the adapter reads the
 * distribution off `collector.last.calls[].httpResponse.body`, a native getter a
 * stub would only agree with itself about. What is FAKED is the server: a node
 * http listener on an ephemeral loopback port serves a RECORDED response, so the
 * suite is hermetic. The three `llamacpp-*` fixtures are recordings of the real
 * `make llm-small` server (llama-server b9190, Qwen3.5-4B-Instruct-Q8_0, the
 * Makefile's flags) answering the request THIS client renders; the
 * `vllm-variants` fixture is constructed to vLLM's schema (the file says so — no
 * vLLM server was available) and exists for the one thing real top-20 windows
 * rarely show: several variants of one letter. The live counterpart is the
 * slice's PR body, which records the same readout against the real server.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { DecisionCalibrationEntry } from '@hames-ai/harness-patterns/types'
import type { DecisionCalibrationTable } from '@hames-ai/harness-baml/clients.server'

import '../../../lib/inference/config.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const FIXTURES = path.resolve(process.cwd(), 'src/__tests__/fixtures/decide')
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as {
    request?: Record<string, unknown>
    response: Record<string, unknown>
  }

const SPEC = {
  key: 'memory.kind',
  question: 'What kind of memory is the statement in the data?',
  labels: [
    { id: 'episodic', description: 'a specific event that happened at a time and place' },
    { id: 'semantic', description: 'a general fact about the world' },
    { id: 'preference', description: 'something the person likes or dislikes' },
    { id: 'trait', description: 'a lasting characteristic of the person' },
  ],
} as const

let server: Server
let hits: Array<Record<string, unknown>> = []
let serve: Record<string, unknown> = fixture('llamacpp-confident').response

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      hits.push(JSON.parse(raw || '{}'))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(serve))
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
  serve = fixture('llamacpp-confident').response
  const { configureDecisionCalibration } = await import('@hames-ai/harness-baml/clients.server')
  configureDecisionCalibration({})
})

/** Run under the private tier — the only tier the logprob client is reached on. */
async function onPrivateTier<T>(fn: () => Promise<T>): Promise<T> {
  const clients = await import('@hames-ai/harness-baml/clients.server')
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  clients.assertInferenceTier('verda')
  return withRunFrame({ inference: { tier: 'verda' } }, fn)
}

async function adapter() {
  const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
  return createDecideAdapter()
}

describe('the logprob readout — recorded llama.cpp responses', () => {
  it('reads the letter distribution, maps letters back to label ids, and reports coverage', async () => {
    serve = fixture('llamacpp-confident').response
    const decide = await adapter()
    const r = await onPrivateTier(() =>
      decide({ spec: SPEC, state: 'I really prefer dark roast coffee over light roast.' }),
    )
    expect(r.method).toBe('logprob')
    expect(r.probs.preference).toBeGreaterThan(0.99)
    expect(Object.keys(r.probs).sort()).toEqual(['episodic', 'preference', 'semantic', 'trait'])
    expect(Object.values(r.probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    // Coverage is the share of the distribution the window attributed to a
    // label: ≈1 here (the letters are the whole mass), and strictly below 1.
    expect(r.coverage).toBeGreaterThan(0.99)
    expect(r.coverage).toBeLessThan(1)
    // No fitted entry was applied: a raw softmax is measured, not calibrated.
    expect(r.calibrated).toBe(false)
  })

  it('an ambiguous statement stays ambiguous — the readout does not sharpen it', async () => {
    serve = fixture('llamacpp-ambiguous').response
    const decide = await adapter()
    const r = await onPrivateTier(() =>
      decide({ spec: SPEC, state: 'Maybe, I am not sure what to say.' }),
    )
    // The recorded window put 0.37 / 0.33 / 0.18 / 0.12 on the four letters.
    expect(Math.max(...Object.values(r.probs))).toBeLessThan(0.5)
    expect(r.probs.episodic).toBeGreaterThan(r.probs.semantic)
  })

  it('sends the request the readout depends on: letters, the logprob options, the 2-token cap', async () => {
    const decide = await adapter()
    await onPrivateTier(() => decide({ spec: SPEC, state: 'state text' }))
    expect(hits).toHaveLength(1)
    const body = hits[0] as {
      max_tokens: number
      logprobs: boolean
      top_logprobs: number
      messages: Array<{ role: string; content: string }>
    }
    expect(body.logprobs).toBe(true)
    expect(body.top_logprobs).toBe(20)
    expect(body.max_tokens).toBe(2)
    const user = body.messages.find((m) => m.role === 'user')!.content
    // Labels are presented as letters in display order; the ids never reach the model.
    expect(user).toContain('A. a specific event that happened at a time and place')
    expect(user).toContain('D. a lasting characteristic of the person')
    expect(user).not.toContain('episodic')
    expect(user).toContain('state text')
  })

  it('records the call without reading the one-token cap as a truncation (D14)', async () => {
    const decide = await adapter()
    const r = await onPrivateTier(() => decide({ spec: SPEC, state: 'state text' }))
    // The recorded response is `finish_reason: length` with outputTokens at the
    // client's cap; `llmCallHitOutputCap` alone would stamp `true`.
    const { llmCallHitOutputCap } = await import('@hames-ai/harness-baml/baml-adapters.server')
    expect(
      llmCallHitOutputCap({ clientName: r.llmCall!.clientName, usage: r.llmCall!.usage }),
    ).toBe(true)
    expect(r.llmCall!.hitOutputCap).toBe(false)
    expect(r.llmCall!.clientName).toBe('LocalQwenSmallDecide')
    // The state lives in the record's variables and nowhere the policy layer reads.
    expect(r.llmCall!.variables).toMatchObject({ state: 'state text' })
  })

  it('prices the call on the local basis: exactly €0, not unknown', async () => {
    const decide = await adapter()
    const r = await onPrivateTier(() => decide({ spec: SPEC, state: 'state text' }))
    expect(r.llmCall!.metrics).toMatchObject({ costEur: 0, basis: 'local' })
  })
})

describe('letter-variant summing — constructed vLLM-shaped window', () => {
  it('sums B, " B" and "B." for one label, ignores a longer word, and reports the matched mass', async () => {
    serve = fixture('vllm-variants').response
    const decide = await adapter()
    const r = await onPrivateTier(() => decide({ spec: SPEC, state: 's' }))
    // Raw mass: A = .50+.10+.02 = .62; B = .20+.05+.03 = .28; C = .04; D = .01.
    // `Btool`, `<think>` and `x` match nothing; coverage = .95.
    expect(r.coverage).toBeCloseTo(0.95, 4)
    expect(r.probs.episodic).toBeCloseTo(0.62 / 0.95, 4)
    expect(r.probs.semantic).toBeCloseTo(0.28 / 0.95, 4)
    expect(r.probs.preference).toBeCloseTo(0.04 / 0.95, 4)
    expect(r.probs.trait).toBeCloseTo(0.01 / 0.95, 4)
  })
})

describe('calibration is applied when the host fed an entry, and says so', () => {
  it('applies temperature/bias in log space and reports calibrated: true', async () => {
    serve = fixture('llamacpp-trait').response
    const decide = await adapter()
    const raw = await onPrivateTier(() => decide({ spec: SPEC, state: 's' }))
    expect(raw.calibrated).toBe(false)

    const { configureDecisionCalibration } = await import('@hames-ai/harness-baml/clients.server')
    configureDecisionCalibration({
      LocalQwenSmallDecide: { 'memory.kind': { temperature: 4 } },
    })
    const cal = await onPrivateTier(() => decide({ spec: SPEC, state: 's' }))
    expect(cal.calibrated).toBe(true)
    // A temperature above 1 flattens: the top label loses mass to the rest.
    expect(cal.probs.trait).toBeLessThan(raw.probs.trait)
    expect(Object.values(cal.probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    // Coverage is a property of the READOUT, untouched by calibration.
    expect(cal.coverage).toBeCloseTo(raw.coverage!, 9)
  })

  it('keys the entry by (client, spec.key): another key is not calibrated', async () => {
    const { configureDecisionCalibration } = await import('@hames-ai/harness-baml/clients.server')
    configureDecisionCalibration({ LocalQwenSmallDecide: { 'some.other.key': { temperature: 4 } } })
    const decide = await adapter()
    const r = await onPrivateTier(() => decide({ spec: SPEC, state: 's' }))
    expect(r.calibrated).toBe(false)
  })
})

describe('`serving` — what the policy layer reads BEFORE the call', () => {
  it('is filled: the method of the resolved client and the applied calibration entry', async () => {
    const { configureDecisionCalibration } = await import('@hames-ai/harness-baml/clients.server')
    const entry = { temperature: 2, minConfidence: 0.4 }
    configureDecisionCalibration({ LocalQwenSmallDecide: { 'memory.kind': entry } })
    const decide = await adapter()
    expect(typeof decide.serving).toBe('function')
    // Private tier: the logprob client, with its entry.
    expect(await onPrivateTier(async () => decide.serving('memory.kind'))).toEqual({
      method: 'logprob',
      calibration: entry,
    })
    // …and no entry for a key nobody fitted.
    expect(await onPrivateTier(async () => decide.serving('other'))).toEqual({
      method: 'logprob',
      calibration: undefined,
    })
    // Anthropic tier (no frame): the resolved client is Jev (T4), which is
    // calibratable: its method, and its own fitted entry when the host fed one.
    expect(decide.serving('memory.kind')).toEqual({ method: 'jev' })
    const cuts = { minConfidence: 0.4 }
    configureDecisionCalibration({ JevDecide: { 'memory.kind': cuts } })
    expect(decide.serving('memory.kind')).toEqual({ method: 'jev', calibration: cuts })
  })

  it('reports nothing for a client no transport serves (review finding 4)', async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'AnthropicHaiku45' } : undefined,
    )
    try {
      // Verbalized, and no secondary wired: not a 'verbalized' no model will
      // serve; absent means "read it from the result" (G1).
      expect(createDecideAdapter().serving('memory.kind')).toEqual({})
    } finally {
      configureConsumerClients(undefined)
    }
  })

  it('reports the verbalized method only when a secondary is actually wired', async () => {
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'AnthropicHaiku45' } : undefined,
    )
    const wired = createDecideAdapter({ verbalized: (async () => ({})) as never })
    try {
      expect(wired.serving('memory.kind')).toEqual({ method: 'verbalized' })
    } finally {
      configureConsumerClients(undefined)
    }
    // …and the private-tier lock un-wires it again: nothing non-logprob is
    // servable there, so nothing is reported.
    expect(await onPrivateTier(async () => wired.serving('memory.kind'))).toMatchObject({
      method: 'logprob',
    })
  })

  it('reports the model limits of the role per call', async () => {
    const decide = await adapter()
    expect(await onPrivateTier(async () => decide.limits!())).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 2,
    })
  })
})

describe('refusals', () => {
  it('refuses a spec the window cannot cover — 21 labels — before any request is made', async () => {
    const labels = Array.from({ length: 21 }, (_, i) => ({ id: `l${i}`, description: `d${i}` }))
    const decide = await adapter()
    await expect(
      onPrivateTier(() => decide({ spec: { key: 'k', question: 'q', labels }, state: 's' })),
    ).rejects.toThrow(/2\.\.20/)
    expect(hits).toHaveLength(0)
  })

  it('accepts exactly MAX_DECISION_LABELS (20)', async () => {
    serve = fixture('llamacpp-confident').response
    const labels = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, description: `d${i}` }))
    const decide = await adapter()
    const call = onPrivateTier(() =>
      decide({ spec: { key: 'k', question: 'q', labels }, state: 's' }),
    )
    await expect(call).resolves.toBeDefined()
    const r = await call
    expect(Object.keys(r.probs)).toHaveLength(20)
  })
})

// G7: mutation — remove the Jev temperature/bias refusal in the setter.
describe('jev-calibration-cuts-only (G7)', () => {
  it.each<DecisionCalibrationEntry>([
    { temperature: 1 },
    { temperature: 0 },
    { temperature: NaN },
    { bias: {} },
    { bias: { yes: 0 } },
    { minConfidence: 0.4, temperature: 1 },
    { minConfidence: 0.4, bias: { a: 0 } },
  ])('refuses unsupported calibration %j for every Jev client', async (entry) => {
    const { configureDecisionCalibration, decisionCalibrationFor, JEV_CLIENTS } =
      await import('@hames-ai/harness-baml/clients.server')
    for (const client of JEV_CLIENTS) {
      const cuts = { minConfidence: 0.4, minMargin: 0.2 }
      configureDecisionCalibration({ [client]: { route: cuts } })
      expect(() => configureDecisionCalibration({ [client]: { route: entry } })).toThrow(
        /cuts only/,
      )
      expect(decisionCalibrationFor(client, 'route')).toEqual(cuts)
    }
  })

  // Mutations: validate only the first key or only the first client.
  it.each<DecisionCalibrationTable>([
    { JevDecide: { a: { minConfidence: 0.4 }, b: { temperature: 1 } } },
    {
      LocalQwenSmallDecide: { a: { temperature: 1 } },
      JevDecide: { a: { minConfidence: 0.4 }, b: { bias: {} } },
    },
  ])('validates every client and key and preserves prior state on refusal', async (table) => {
    const { configureDecisionCalibration, decisionCalibrationFor } =
      await import('@hames-ai/harness-baml/clients.server')
    const prior = { minConfidence: 0.6 }
    configureDecisionCalibration({ JevDecide: { route: prior } })
    expect(() => configureDecisionCalibration(table)).toThrow(/cuts only/)
    expect(decisionCalibrationFor('JevDecide', 'route')).toEqual(prior)
    expect(decisionCalibrationFor('JevDecide', 'a')).toBeUndefined()
  })

  // Mutations: restore assignment by reference, omit bias copy, omit freezing.
  it('snapshots caller tables, entries and bias and freezes the stored entries', async () => {
    const { configureDecisionCalibration, decisionCalibrationFor } =
      await import('@hames-ai/harness-baml/clients.server')
    const table = {
      JevDecide: { route: { minConfidence: 0.4, temperature: undefined as number | undefined } },
      LocalQwenSmallDecide: { route: { temperature: 2, bias: { yes: 0.1 } } },
    }
    configureDecisionCalibration(table)
    table.JevDecide.route.temperature = 3
    table.JevDecide.route.minConfidence = 0.9
    table.LocalQwenSmallDecide.route.bias.yes = 4
    expect(decisionCalibrationFor('JevDecide', 'route')).toEqual({
      minConfidence: 0.4,
      temperature: undefined,
    })
    const entry = decisionCalibrationFor('LocalQwenSmallDecide', 'route')
    expect(entry).toEqual({ temperature: 2, bias: { yes: 0.1 } })
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry?.bias)).toBe(true)
  })

  it('accepts cuts for Jev and temperature/bias for other clients', async () => {
    const { configureDecisionCalibration, decisionCalibrationFor, JEV_CLIENTS } =
      await import('@hames-ai/harness-baml/clients.server')
    for (const client of JEV_CLIENTS) {
      const cuts = { minConfidence: 0.4, minMargin: 0.2 }
      expect(() => configureDecisionCalibration({ [client]: { route: cuts } })).not.toThrow()
      expect(decisionCalibrationFor(client, 'route')).toEqual(cuts)
    }
    const entry = { temperature: 2, bias: { yes: 0.1 } }
    configureDecisionCalibration({ LocalQwenSmallDecide: { route: entry } })
    expect(decisionCalibrationFor('LocalQwenSmallDecide', 'route')).toEqual(entry)
  })
})

// Unknown runtime types still fail closed after S3 adds score/noul support.
describe('unknown-type adapter backstop', () => {
  it('all raw transports reject an unknown type before any request', async () => {
    const { createVerbalizedDecide } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    const rank = { ...SPEC, type: 'rank' } as never
    for (const fn of [await adapter(), createVerbalizedDecide(), createJevTransport().decide]) {
      for (const spec of [rank]) {
        await expect(fn<string>({ spec, state: 'synthetic' })).rejects.toThrow(
          'Unsupported decision type',
        )
        await expect(onPrivateTier(() => fn<string>({ spec, state: 'synthetic' }))).rejects.toThrow(
          'Unsupported decision type',
        )
      }
    }
    expect(hits).toHaveLength(0)
  })
})

// S3: every pin's executable source mutation is in check-baml-score-noul-mutations.py.
describe('S3 lettered specs', () => {
  const levels = ['none', 'later', 'week', 'today', 'now'].map((id) => ({
    id,
    description: `${id} description`,
  }))
  const score = { type: 'score' as const, key: 's3.score', question: 'How urgent?', levels }
  const noul = {
    type: 'noul' as const,
    key: 's3.noul',
    question: 'A statement holds.',
    criteria: { true: 'Custom yes', false: 'Custom no' },
  }

  // Independent fixture oracle: the recordings contain these exact letter variants.
  // Lowercase and Cyrillic lookalikes are separate tokens and do not name a label.
  const rawMass = (name: string, letters: string[]) => {
    const body = fixture(name).response as {
      choices: Array<{
        logprobs: { content: Array<{ top_logprobs: Array<{ token: string; logprob: number }> }> }
      }>
    }
    const top = body.choices[0].logprobs.content[0].top_logprobs
    return letters.map((letter) =>
      top
        .filter((t) => [letter, ` ${letter}`, `(${letter}`, `"${letter}`].includes(t.token))
        .reduce((sum, t) => sum + Math.exp(t.logprob), 0),
    )
  }

  it('score-order-preserved: letter i maps to level i in the five-letter llama.cpp fixture', async () => {
    serve = fixture('llamacpp-score').response
    const r = await onPrivateTier(() =>
      adapter().then((fn) => fn({ spec: score, state: 'synthetic' })),
    )
    const mass = rawMass('llamacpp-score', ['A', 'B', 'C', 'D', 'E'])
    const total = mass.reduce((a, b) => a + b, 0)
    expect(r.coverage).toBeCloseTo(total, 12)
    expect(total).toBeLessThan(1)
    for (let i = 0; i < levels.length; i++)
      expect(r.probs[levels[i].id]).toBeCloseTo(mass[i] / total, 12)
    expect(Object.values(r.probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    const user = (hits[0].messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user',
    )!.content
    for (let i = 0; i < levels.length; i++)
      expect(user).toContain(`${String.fromCharCode(65 + i)}. ${levels[i].description}`)
    expect(r.llmCall?.clientName).toBe('LocalQwenSmallDecide')
    expect(hits[0].max_tokens).toBe(2)
  })

  it('noul-letter-mapping: A is true, B is false in the two-letter llama.cpp fixture', async () => {
    serve = fixture('llamacpp-noul').response
    const fn = await adapter()
    const r = await onPrivateTier(() => fn({ spec: noul, state: 'synthetic' }))
    const [a, b] = rawMass('llamacpp-noul', ['A', 'B'])
    expect(r.probs).toEqual({ true: expect.any(Number), false: expect.any(Number) })
    expect(r.probs.true).toBeCloseTo(a / (a + b), 12)
    expect(r.probs.false).toBeCloseTo(b / (a + b), 12)
    expect(r.probs.true + r.probs.false).toBeCloseTo(1, 12)
    expect(r.coverage).toBeCloseTo(a + b, 12)
    expect(a + b).toBeLessThan(1)
    const user = (hits[0].messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user',
    )!.content
    expect(user).toContain('A. Custom yes')
    expect(user).toContain('B. Custom no')
    await onPrivateTier(() => fn({ spec: { ...noul, criteria: undefined }, state: 'synthetic' }))
    const defaults = JSON.stringify(hits[1].messages)
    expect(defaults).toContain('A. Yes — the statement holds')
    expect(defaults).toContain('B. No — the statement does not hold')
  })

  it.each([
    ['score', score, 'llamacpp-score', ['A', 'B', 'C', 'D', 'E'], levels.map((l) => l.id)],
    ['noul', noul, 'llamacpp-noul', ['A', 'B'], ['true', 'false']],
  ] as const)(
    'per-letter-calibration: %s uses letter bias and temperature, preserves raw coverage',
    async (_name, spec, recording, letters, ids) => {
      serve = fixture(recording).response
      const mass = rawMass(recording, [...letters])
      const bias = Object.fromEntries(letters.map((letter, i) => [letter, i * 0.7]))
      const { configureDecisionCalibration } = await import('@hames-ai/harness-baml/clients.server')
      configureDecisionCalibration({
        LocalQwenSmallDecide: { [spec.key]: { temperature: 2, bias } },
      })
      const r = await onPrivateTier(() =>
        adapter().then((fn) => fn<string>({ spec, state: 'synthetic' })),
      )
      const weights = mass.map((m, i) => Math.sqrt(m) * Math.exp(bias[letters[i]]))
      const sum = weights.reduce((a, b) => a + b, 0)
      ids.forEach((id, i) =>
        expect(r.probs[id as keyof typeof r.probs]).toBeCloseTo(weights[i] / sum, 12),
      )
      expect(r.calibrated).toBe(true)
      expect(r.coverage).toBeCloseTo(
        mass.reduce((a, b) => a + b, 0),
        12,
      )
    },
  )

  it.each([1, 11])('score transport cap refuses %i levels even without defineScore', async (n) => {
    const fn = await adapter()
    await expect(
      onPrivateTier(() =>
        fn({
          spec: {
            ...score,
            levels: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, description: 'd' })),
          },
          state: 'synthetic',
        }),
      ),
    ).rejects.toThrow(/2\.\.10/)
    expect(hits).toHaveLength(0)
  })

  it('supported-types-same-resolver: one adapter follows tier and per-run overrides at read and call time', async () => {
    const { createVerbalizedDecide } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const fn = await adapter()
    expect(fn.supportedTypes).toEqual(['choice', 'score', 'noul'])
    await onPrivateTier(async () => {
      expect(fn.supportedTypes).toEqual(['choice', 'score', 'noul'])
      expect((await fn({ spec: noul, state: 'synthetic' })).llmCall?.clientName).toBe(
        'LocalQwenSmallDecide',
      )
    })
    await withRunFrame(
      {
        inference: {
          tier: 'anthropic',
          clientOverride: (role) =>
            role === 'decide' ? { client: 'LocalQwenSmallDecide' } : undefined,
        },
      },
      async () => {
        expect(fn.supportedTypes).toEqual(['choice', 'score', 'noul'])
        expect((await fn({ spec: score, state: 'synthetic' })).llmCall?.clientName).toBe(
          'LocalQwenSmallDecide',
        )
      },
    )
    await withRunFrame(
      {
        inference: {
          tier: 'verda',
          clientOverride: (role) => (role === 'decide' ? { client: 'JevDecide' } : undefined),
        },
      },
      async () => {
        expect(fn.supportedTypes).toEqual(['choice'])
        await expect(fn({ spec: noul, state: 'synthetic' })).rejects.toThrow(
          /private inference tier/,
        )
      },
    )
    expect(createVerbalizedDecide().supportedTypes).toEqual(['choice', 'score', 'noul'])
  })

  it('secondary-supported-types: undeclared secondary remains choice-only with zero calls for score/noul', async () => {
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    const secondary = vi.fn(async () => ({ probs: {}, method: 'verbalized', calibrated: false }))
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'AnthropicHaiku45' } : undefined,
    )
    try {
      const fn = createDecideAdapter({ verbalized: secondary as never })
      expect(fn.supportedTypes).toEqual(['choice'])
      for (const spec of [score, noul])
        await expect(fn({ spec, state: 'synthetic' })).rejects.toThrow('Unsupported decision type')
      expect(secondary).not.toHaveBeenCalled()
    } finally {
      configureConsumerClients(undefined)
    }
  })
})

// S2 raw set seam backstop; no new transport type is enabled before S3/S4.
describe('S2 unsupported-type set adapter backstop', () => {
  it('refuses an unknown type before requesting a provider', async () => {
    const { createDecideAllAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    const rank = { ...SPEC, type: 'rank' } as never
    for (const fn of [createDecideAllAdapter(await adapter()), createJevTransport().decideAll]) {
      expect(fn.supportedTypes).toEqual(['choice', 'score', 'noul'])
      const input = {
        spec: { key: 'mixed', fields: { old: SPEC, added: rank } },
        state: 'synthetic',
      }
      await expect(fn(input)).rejects.toThrow('Unsupported decision type')
      await expect(onPrivateTier(() => fn(input))).rejects.toThrow(
        /Refusing|Unsupported decision type/,
      )
    }
    expect(hits).toHaveLength(0)
  })
  it('uses actual set support and refuses undeclared secondary types', async () => {
    const { createDecideAllAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { defineScore, defineNoul } =
      await import('@hames-ai/harness-patterns/patterns/typedDecision.server')
    const { configureDecideSecondary } = await import('@hames-ai/harness-baml/clients.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const fn = createDecideAllAdapter(await adapter())
    expect(fn.supportedTypes).toEqual(['choice', 'score', 'noul'])
    const score = defineScore({ key: 's', question: 'q', levels: SPEC.labels.slice(0, 2) })
    const noul = defineNoul({ key: 'n', question: 'q' })
    await withRunFrame({ inference: { tier: 'anthropic' } }, async () => {
      configureDecideSecondary('DecideAnthropic')
      try {
        expect(fn.supportedTypes).toEqual(['choice'])
        for (const spec of [score, noul]) {
          await expect(
            fn({ spec: { key: 'mixed', fields: { added: spec } }, state: 'synthetic' }),
          ).rejects.toThrow('Unsupported decision type')
        }
      } finally {
        configureDecideSecondary(undefined)
      }
    })
    expect(hits).toHaveLength(0)
  })
})
