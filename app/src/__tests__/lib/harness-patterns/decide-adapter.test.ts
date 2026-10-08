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
    const r = await onPrivateTier(() =>
      decide({ spec: { key: 'k', question: 'q', labels }, state: 's' }),
    )
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

// S1 guards the widened seam; S3/S4 will explicitly add type support.
describe('S1 unsupported-type adapter backstop', () => {
  it('all shipped raw transports remain choice-only and reject before any request', async () => {
    const { createVerbalizedDecide } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { createJevTransport } = await import('@hames-ai/harness-baml/jev-decide.server')
    const { defineScore, defineNoul } =
      await import('@hames-ai/harness-patterns/patterns/typedDecision.server')
    const score = defineScore({ key: 's', question: 'q', levels: SPEC.labels.slice(0, 2) })
    const noul = defineNoul({ key: 'n', question: 'q' })
    const rank = { ...SPEC, type: 'rank' } as never
    for (const fn of [await adapter(), createVerbalizedDecide(), createJevTransport().decide]) {
      expect(fn.supportedTypes).toBeUndefined()
      for (const spec of [score, noul, rank]) {
        await expect(fn({ spec, state: 'synthetic' })).rejects.toThrow('Unsupported decision type')
        await expect(onPrivateTier(() => fn({ spec, state: 'synthetic' }))).rejects.toThrow(
          'Unsupported decision type',
        )
      }
    }
    expect(hits).toHaveLength(0)
  })
})
