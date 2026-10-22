// The composition root registers the harness client seam (tier policy, model
// tables, cost rates); the pricing assertions below need the same wiring a
// production turn takes, or every call would read as "unknown".
import { useFlagDrivenDefaultTier } from '../../mocks/flag-default-tier'
/**
 * The describe and screen calls reach the run's observability.
 *
 * Both used to spend tokens (or GPU seconds) on a client and leave no trace in
 * the conversation: their ops return a bare string and a verdict, so the only
 * record was the process-wide usage counter. `withUsageAccounting` now also
 * hands the call's record to an `onCall` sink, built from the same collector
 * and priced by `computeEventMetrics` — i.e. on the client BAML SELECTED, not
 * the tier the run intended. These tests pin that half (the baml side); the
 * core half — the sink becoming a `model_call` event — is pinned in
 * `packages/harness-patterns/__tests__/model-call-event.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Collector } from '@boundaryml/baml'
import { createInjectionGuard } from '@hames-ai/harness-patterns/patterns'
import type { LLMCallRecord } from '@hames-ai/harness-patterns/types'

useFlagDrivenDefaultTier()

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  listTools: vi.fn().mockResolvedValue([]),
}))

/** What the mocked generated client does with the options bag: give the fresh
 *  collector the readings a real call would have left behind. */
let readings: Collector | undefined
let failWith: Error | undefined
function leaveReadings(bag: { collector: Collector }): void {
  if (!readings) return
  const source = readings as unknown as { last: unknown; logs: unknown }
  // `last`/`logs` are prototype getters on the native class, hence defineProperty.
  Object.defineProperty(bag.collector, 'last', { get: () => source.last })
  Object.defineProperty(bag.collector, 'logs', { get: () => source.logs })
}

const mockScreen = vi.fn(async (_source: string, _body: string, bag: { collector: Collector }) => {
  leaveReadings(bag)
  if (failWith) throw failWith
  return { injection_detected: false, reason: 'clean', spans: [] }
})
const mockDescribe = vi.fn(
  async (
    _tool: string,
    _args: string,
    _reasoning: string,
    _result: string,
    bag: { collector: Collector },
  ) => {
    leaveReadings(bag)
    return 'a summary'
  },
)
const mockDescribeBatch = vi.fn(async (_targets: unknown[], bag: { collector: Collector }) => {
  leaveReadings(bag)
  return { summaries: [{ id: '1', summary: 'one' }] }
})
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    ScreenUntrustedContent: (...args: Parameters<typeof mockScreen>) => mockScreen(...args),
    ResultDescribe: (...args: Parameters<typeof mockDescribe>) => mockDescribe(...args),
    ResultDescribeBatch: (...args: Parameters<typeof mockDescribeBatch>) =>
      mockDescribeBatch(...args),
  },
}))

const PROMPT_SENTINEL = 'SENTINEL-PAGE-TEXT-7731'

const HOUR_MS = 3_600_000

/** A collector as the adapters read it: one log, one selected attempt on
 *  `clientName`, with the token usage and the per-attempt duration a
 *  time-priced client is billed on. */
function collectorOn(clientName: string, opts: { durationMs?: number } = {}): Collector {
  const call = {
    selected: true,
    provider: 'openai-generic',
    clientName,
    httpRequest: { body: { text: () => `{"messages":"${PROMPT_SENTINEL}"}` } },
    httpResponse: null,
    usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 },
    ...(opts.durationMs !== undefined ? { timing: { durationMs: opts.durationMs } } : {}),
  }
  const log = {
    calls: [call],
    usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 },
    rawLlmResponse: 'RAW-OUTPUT',
    ...(opts.durationMs !== undefined ? { timing: { durationMs: opts.durationMs } } : {}),
  }
  return { last: log, logs: [log] } as unknown as Collector
}

async function ops() {
  const adapters = await import('@hames-ai/harness-baml/baml-adapters.server')
  return adapters
}

let records: LLMCallRecord[]
const sink = (call: LLMCallRecord): void => void records.push(call)

beforeEach(() => {
  records = []
  readings = undefined
  failWith = undefined
  mockScreen.mockClear()
  mockDescribe.mockClear()
  mockDescribeBatch.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('screen call record', () => {
  it('names the client BAML selected and carries the step metrics', async () => {
    readings = collectorOn('LargeQwen', { durationMs: 4_000 })
    const { createInjectionScreen } = await ops()
    const verdict = await createInjectionScreen()({
      tool: 'fetch_content',
      namespace: 'web',
      content: 'page',
      onCall: sink,
    })

    // The verdict is exactly what it was without a sink.
    expect(verdict).toEqual({ injection_detected: false, reason: 'clean', spans: [] })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      functionName: 'ScreenUntrustedContent',
      clientName: 'LargeQwen',
    })
    expect(records[0].metrics).toMatchObject({ inputUncachedTokens: 1000, outputTokens: 100 })
  })

  it('on a self_deployed-tier turn is priced on wall-clock, never as Anthropic tokens', async () => {
    // One hour of measured duration makes the time bill the rate itself, and
    // the same tokens priced as Anthropic would be a different (token) figure.
    readings = collectorOn('LargeQwen', { durationMs: HOUR_MS })
    const { createInjectionScreen } = await ops()
    await createInjectionScreen()({ tool: 't', namespace: 'web', content: 'c', onCall: sink })

    const m = records[0].metrics!
    expect(m.basis).toBe('time')
    expect(m.timePricedAttempts).toBe(1)
    expect(m.timeRate?.durationMs).toBe(HOUR_MS)
    expect(m.costEur).toBeCloseTo(m.timeRate!.eurPerHour, 6)
    // A token-priced figure would carry the per-MTok rates the time basis does not.
    expect(m.rates).toBeUndefined()
  })

  it('on an Anthropic client is priced on tokens', async () => {
    readings = collectorOn('AnthropicHaiku45')
    const { createInjectionScreen } = await ops()
    await createInjectionScreen()({ tool: 't', namespace: 'web', content: 'c', onCall: sink })

    expect(records[0].clientName).toBe('AnthropicHaiku45')
    expect(records[0].metrics?.basis).toBe('tokens')
    expect(records[0].metrics?.rates).toBeDefined()
    expect(records[0].metrics?.timePricedAttempts).toBeUndefined()
  })

  it('records a call that THREW after reaching the model — it was billed', async () => {
    readings = collectorOn('LargeQwen', { durationMs: 2_000 })
    failWith = new Error('screen unavailable')
    const { createInjectionScreen } = await ops()

    await expect(
      createInjectionScreen()({ tool: 't', namespace: 'web', content: 'c', onCall: sink }),
    ).rejects.toThrow('screen unavailable')

    expect(records).toHaveLength(1)
    expect(records[0].clientName).toBe('LargeQwen')
    expect(records[0].metrics?.costEur).toBeGreaterThan(0)
  })

  it('records nothing when the call never reached a model', async () => {
    readings = { last: null, logs: [] } as unknown as Collector
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createInjectionScreen } = await ops()
    await createInjectionScreen()({ tool: 't', namespace: 'web', content: 'c', onCall: sink })
    expect(records).toHaveLength(0)
    // Mutation: delete the `!last` guard in `reportCallRecord` → the record is
    // built from nothing and the TypeError is swallowed by the same catch, so
    // the count above stays 0; only the log gives it away.
    expect(err).not.toHaveBeenCalled()
  })

  // Mutation: swap the two lines in `withUsageAccounting`'s `finally` (account
  // first) → the refusal throws before the sink is handed the record.
  it('records a call that the thinking-leaf policy then refuses', async () => {
    // `LargeQwenThink` is designated for `PlannerThinking` only; the screen is not.
    readings = collectorOn('LargeQwenThink', { durationMs: 1_000 })
    const { createInjectionScreen } = await ops()

    await expect(
      createInjectionScreen()({ tool: 't', namespace: 'web', content: 'c', onCall: sink }),
    ).rejects.toThrow(/thinking leaf/)

    expect(records).toHaveLength(1)
    expect(records[0].clientName).toBe('LargeQwenThink')
  })

  it('runs without a sink exactly as before', async () => {
    readings = collectorOn('LargeQwen', { durationMs: 1_000 })
    const { createInjectionScreen } = await ops()
    const verdict = await createInjectionScreen()({ tool: 't', namespace: 'web', content: 'c' })
    expect(verdict.injection_detected).toBe(false)
  })

  it('a sink that throws is logged and does not replace the verdict', async () => {
    readings = collectorOn('LargeQwen', { durationMs: 1_000 })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createInjectionScreen } = await ops()

    const verdict = await createInjectionScreen()({
      tool: 't',
      namespace: 'web',
      content: 'c',
      onCall: () => {
        throw new Error('sink is down')
      },
    })

    expect(verdict.injection_detected).toBe(false)
    expect(err).toHaveBeenCalled()
    expect(String(err.mock.calls[0][0])).toContain('ScreenUntrustedContent')
  })

  // The BAML screen THROUGH the guard, with the guard's own recorder failing.
  // Mutation (adapter half): remove the try/catch in `reportCallRecord` → the
  // throw lands in `withUsageAccounting`'s `finally`, replaces the verdict and
  // the guard reports `screenUnavailable`. (Removing only the guard's own
  // try/catch stays green here — the adapter contains it first; the guard's half
  // is pinned with a screen that does not catch, in `model-call-event.test.ts`.)
  it('a recorder that throws in the guard leaves the BAML screen verdict intact', async () => {
    readings = collectorOn('LargeQwen', { durationMs: 1_000 })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createInjectionScreen } = await ops()
    const events: { type: string }[] = []
    const guard = createInjectionGuard(
      { tools: ['fetch_content'], screen: createInjectionScreen() },
      (e) => {
        if (e.type === 'model_call') throw new Error('recorder is down')
        events.push(e)
      },
      'guard',
    )

    const { summary, data } = await guard.sanitize('fetch_content', 'a clean page')

    expect(summary?.screenUnavailable).toBeUndefined()
    expect(data).toBe('a clean page')
    expect(events.map((e) => e.type)).not.toContain('content_sanitized')
    expect(err).toHaveBeenCalled()
  })
})

describe('describe call record', () => {
  it('records the single-result summary with the client it ran on', async () => {
    readings = collectorOn('SmallQwen', { durationMs: HOUR_MS })
    const { describeToolResultOp } = await ops()
    const out = await describeToolResultOp('web_search', '{}', 'why', 'result', sink)

    expect(out).toBe('a summary')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      functionName: 'ResultDescribe',
      clientName: 'SmallQwen',
    })
    // The small box is time-priced, so the step reads as a floor.
    expect(records[0].metrics?.basis).toBe('time')
    expect(records[0].metrics?.timePricedAttempts).toBe(1)
  })

  it('records the batched summary', async () => {
    readings = collectorOn('SmallQwen', { durationMs: HOUR_MS })
    const { describeToolResultsBatchOp } = await ops()
    const byId = await describeToolResultsBatchOp(
      [
        { id: '1', tool: 't', toolArgs: '{}', reasoning: '', result: 'r' },
        { id: '2', tool: 't', toolArgs: '{}', reasoning: '', result: 'r' },
      ],
      sink,
    )

    expect(byId.get('1')).toBe('one')
    expect(records).toHaveLength(1)
    expect(records[0].functionName).toBe('ResultDescribeBatch')
  })

  it('prices a local-basis client as an exact zero, not unknown', async () => {
    readings = collectorOn('LocalGLM')
    const { describeToolResultOp } = await ops()
    await describeToolResultOp('t', '{}', '', 'r', sink)

    expect(records[0].metrics).toMatchObject({ costEur: 0, basis: 'local' })
  })

  it('follows the client of each call, so two calls on two clients price differently', async () => {
    const { describeToolResultOp } = await ops()
    readings = collectorOn('LocalGLM')
    await describeToolResultOp('t', '{}', '', 'r', sink)
    readings = collectorOn('AnthropicHaiku45')
    await describeToolResultOp('t', '{}', '', 'r', sink)

    expect(records.map((r) => r.metrics?.basis)).toEqual(['local', 'tokens'])
  })
})
