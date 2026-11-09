/** rv-1033 review evidence (proposed test edit for #1032): the trace fallback
 * counts the whole prompt — the template, the user's message and the memory
 * block — not only the turns. Green at e4e17bfc; red when `defaultSynthesize`
 * drops either the template base or the message and memory from the base it
 * hands `degradeToFit` (verified by the reviewer). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import * as clients from '@hames-ai/harness-baml/clients.server'
import type { RouteTrace } from '@hames-ai/harness-patterns/patterns/decisionLoop-trace.server'
import type { CompactExecutionInput, LoopIteration } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

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

const iteration = (n: number, result: unknown, compact: unknown): LoopIteration => ({
  turn: n,
  action: { reasoning: '', tool_name: `route-${n}`, tool_args: '', is_final: false },
  result,
  timestamp: 0,
  compact: { result: compact, label: `${n + 1}. route-${n}` },
})

const input = (userMessage: string, memoryContext?: string): CompactExecutionInput => ({
  mode: 'thread',
  userMessage,
  intent: 'q',
  ...(memoryContext ? { memoryContext } : {}),
  loopHistory: {
    startTime: 0,
    iterations: [
      iteration(0, trace('a', 'x'.repeat(10_000)), 'record a'),
      iteration(1, trace('b', 'x'.repeat(10_000)), 'record b'),
    ],
  },
})

describe('defaultSynthesize: the trace fallback sizes the whole prompt (#1032)', () => {
  // 14 096 − 4 096 reserved = 10 000 tokens = 25 000 characters at 2.5. Two traces
  // add about 20 300 characters, the template 4 000: they fit with a one-character
  // message, and stop fitting once the message or the memory adds 1 000.
  it('falls back when the user message or the memory block tips the prompt over', async () => {
    vi.spyOn(clients, 'getContextWindow').mockReturnValue(14_096)
    vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    expect((await defaultSynthesize(input('q'))).fellBack).toBeUndefined()
    expect((await defaultSynthesize(input('q'.repeat(1_000)))).fellBack).toEqual(['1. route-0'])
    expect((await defaultSynthesize(input('q', 'm'.repeat(1_000)))).fellBack).toEqual([
      '1. route-0',
    ])
  })
})
