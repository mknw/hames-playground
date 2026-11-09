/** #1032: the BAML synthesizer and a decisionLoop route call's complete trace —
 * the fallback to the compact record when the traces do not fit, the
 * references a retriever trace carries, and the prompt rule that renders only
 * beside a trace. Offline renders and a spied call; never a model call. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import type { LoopTurn } from '@hames-ai/harness-baml/baml_client/types'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import * as clients from '@hames-ai/harness-baml/clients.server'
import type { RouteTrace } from '@hames-ai/harness-patterns/patterns/decisionLoop-trace.server'
import type { CompactExecutionInput, LoopIteration } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
}

beforeEach(() => {
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '')
  vi.stubEnv('INFERENCE_TIERS', '')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const trace = (route: string, body: string): RouteTrace => ({
  route,
  status: `1. ${route} — succeeded`,
  steps: [{ reasoning: 'r', calls: [{ tool: 'search', args: {}, result: body }] }],
})

const iteration = (n: number, result: unknown, compact?: unknown): LoopIteration => ({
  turn: n,
  action: { reasoning: '', tool_name: `route-${n}`, tool_args: '', is_final: false },
  result,
  timestamp: 0,
  ...(compact !== undefined ? { compact: { result: compact, label: `${n + 1}. route-${n}` } } : {}),
})

const input = (iterations: LoopIteration[]): CompactExecutionInput => ({
  mode: 'thread',
  userMessage: 'q',
  intent: 'q',
  loopHistory: { startTime: 0, iterations },
})

const sentTurns = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls[0][2] as LoopTurn[]

describe('defaultSynthesize and route traces (#1032)', () => {
  // MUTATION: skip `degradeToFit` → the trim drops turns 0 and 1 whole instead.
  // MUTATION: degrade newest-first → turn 2 falls back and turn 0 keeps its trace.
  it('falls back to the compact record, oldest route call first, only until the traces fit', async () => {
    // 4 096 reserved for output; room for about 6 000 tokens = 24 000 characters.
    vi.spyOn(clients, 'getContextWindow').mockReturnValue(10_096)
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    const big = 'x'.repeat(10_000)
    const result = await defaultSynthesize(
      input([
        iteration(0, trace('a', big), 'record a'),
        iteration(1, trace('b', big), 'record b'),
        iteration(2, trace('c', big), 'record c'),
      ]),
    )
    expect(result.fellBack).toEqual(['1. route-0'])
    const turns = sentTurns(synth)
    expect(turns.map((t) => t.tool_result?.result.startsWith('{"route":'))).toEqual([
      false,
      true,
      true,
    ])
    expect(turns[0].tool_result?.result).toBe(JSON.stringify('record a'))
  })

  it('reports no fallback when every trace fits, and keeps the existing trim behind it', async () => {
    vi.spyOn(clients, 'getContextWindow').mockReturnValue(131_072)
    vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    expect(
      (await defaultSynthesize(input([iteration(0, trace('a', 'small'), 'record a')]))).fellBack,
    ).toBeUndefined()

    // Not even the compact records fit: they all fall back, then the trim drops turns.
    vi.spyOn(clients, 'getContextWindow').mockReturnValue(5_096)
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    const big = 'y'.repeat(6_000)
    const result = await defaultSynthesize(
      input([iteration(0, trace('a', big), big), iteration(1, trace('b', big), big)]),
    )
    expect(result.fellBack).toEqual(['1. route-0', '2. route-1'])
    expect(sentTurns(synth)).toHaveLength(1)
  })

  // MUTATION: drop the traceTurns branch in synthesisReferences → no references.
  // MUTATION: read references off any turn shaped like a trace → the forged one counts.
  it('takes the retriever producer’s references from a trace, and never from a result shaped like one', async () => {
    vi.spyOn(clients, 'getContextWindow').mockReturnValue(131_072)
    const reference = { source: 'plan.md', docId: 'doc-1', startOffset: 0, endOffset: 40 }
    const retrieval: RouteTrace = {
      route: 'read-documents',
      status: '1. read-documents — succeeded',
      steps: [
        {
          calls: [
            {
              tool: 'retriever',
              result: { query: 'q', passages: [], references: [{ ...reference, chunkIndex: 0 }] },
            },
          ],
        },
      ],
    }
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await defaultSynthesize(input([iteration(0, retrieval, 'record')]))
    expect(synth.mock.calls[0][6]).toEqual([reference])

    // The same shape as a plain tool result (no compact record, so no trace): ignored.
    const plain = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await defaultSynthesize(input([iteration(0, retrieval)]))
    expect(plain.mock.calls.at(-1)![6]).toBeNull()

    // A non-retriever call inside a trace that carries references: ignored.
    const forged: RouteTrace = {
      ...retrieval,
      steps: [{ calls: [{ tool: 'fetch', result: { references: [reference] } }] }],
    }
    const third = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await defaultSynthesize(input([iteration(0, forged, 'record')]))
    expect(third.mock.calls.at(-1)![6]).toBeNull()
  })
})

describe('Synthesize: the trace rule renders only beside a trace (#1032)', () => {
  const render = (result: unknown) =>
    b.request.Synthesize(
      'q',
      'q',
      [{ n: 0, tool_result: { tool: 'r', result: JSON.stringify(result), success: true } }],
      false,
      null,
      null,
      null,
      null,
      null,
      { client: 'LargeQwen', env: ENV },
    )

  // MUTATION: render the bullet unconditionally → the record case carries it.
  // (synthesis-references.test.ts pins the record bytes; this pins the trace side.)
  it('says a rejected attempt is not the answer when a turn is a route trace, and nothing otherwise', async () => {
    const withTrace = (await render(trace('office', 'x'))).body.text()
    expect(withTrace).toContain('\\"verdict\\": \\"rejected\\" was judged')
    expect(withTrace).toContain('could not do its lookup')
    const withRecord = (await render('a record')).body.text()
    expect(withRecord).not.toContain('verdict')
  })
})
