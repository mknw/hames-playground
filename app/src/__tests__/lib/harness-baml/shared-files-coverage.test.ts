// @vitest-environment node
/** #1036: offline requests prove the instructions actually reach both critics
 * and the answer writer. These tests do not measure a live model's compliance.
 * Mutations: delete each COVERAGE clause and regenerate; the corresponding
 * rendered request must go red, including the >=3-attempt leniency case. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import * as clients from '@hames-ai/harness-baml/clients.server'
import type { CompactExecutionInput, LoopIteration } from '@hames-ai/harness-patterns/types'

const env = {
  ANTHROPIC_API_KEY: 'offline',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline',
}
const result = JSON.stringify({
  coverage: {
    scope: 'recent-insights',
    complete: false,
    rawFetched: 1,
    returned: 1,
    cutByLimit: false,
    moreAvailable: true,
    sourceStatus: 'available',
    reasons: ['upstream-window', 'not-paged'],
  },
  match: 'address',
  items: [{ name: 'example.pdf', shared_by: 'Alex Reed' }],
})

beforeEach(() => {
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '')
  vi.stubEnv('INFERENCE_TIERS', '')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it.each(['Critic', 'CriticThinking'] as const)(
  '%s rejects exhaustive claims on partial coverage while allowing a qualified answer',
  async (name) => {
    const attempts = Array.from({ length: 3 }, (_, n) => ({
      n: n + 1,
      action: {
        reasoning: 'Find recent shares',
        tool_name: 'graph_files_shared',
        tool_args: '{"shared_by_address":"alex@example.org"}',
        is_final: false,
      },
      result,
    }))
    const opts = { client: name === 'Critic' ? 'LargeQwen' : 'LargeQwenThink', env }
    const request =
      name === 'Critic'
        ? await b.request.Critic('Find all files Alex shared with me', attempts, null, opts)
        : await b.request.CriticThinking('Find all files Alex shared with me', attempts, null, opts)
    const text = request.body.text().replace(/\\n/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('SHARED-FILES COVERAGE: graph_files_shared searches recent sharing')
    expect(text).toContain('complete, cutByLimit, moreAvailable and sourceStatus')
    expect(text).toContain('reject claims of \\"all\\" shares or \\"none\\" shared')
    expect(text).toContain('even after multiple attempts')
    expect(text).toContain('Accept an explicitly partial answer')
    expect(text).toContain('An unavailable source is not an empty search')
    expect(text).toContain('Never widen an unresolved address into a name search')
    expect(text).toContain('Include the coverage qualification in your explanation')
    expect(text).toContain('route summary and final answer retain it')
    expect(text).toContain('3 attempts have been made')
    expect(text).toContain('alex@example.org')
    expect(text).toContain('recent-insights')
  },
)

it.each(['AnthropicSonnet5', 'LargeQwen'])(
  '%s preserves the coverage qualification in the final answer prompt',
  async (client) => {
    const request = await b.request.Synthesize(
      'Find all shared files',
      'Find shared files',
      [{ n: 1, shared_files: true, tool_result: { tool: 'office-data', result, success: true } }],
      false,
      null,
      null,
      null,
      null,
      null,
      { client, env },
    )
    const text = request.body.text().replace(/\\n/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('Preserve shared-files coverage from the route summary and tool results')
    expect(text).toContain('when coverage.complete is false')
    expect(text).toContain('found in recent sharing activity')
    expect(text).toContain('no matches found in recent sharing activity')
    expect(text).toContain('Never turn partial coverage into \\"all\\" shares or \\"none\\" shared')
    expect(text).toContain('If sourceStatus is unavailable, say the source was unavailable')
    expect(text).toContain('recent-insights')
  },
)

const iteration = (tool: string, value: unknown): LoopIteration => ({
  turn: 0,
  action: { tool_name: tool, tool_args: '{}', reasoning: '', is_final: false },
  result: value,
  timestamp: 0,
})
const input = (iterations: LoopIteration[]): CompactExecutionInput => ({
  mode: 'thread',
  userMessage: 'Find shares',
  intent: 'Find shares',
  loopHistory: { startTime: 0, iterations },
})
const trace = (tool = 'graph_files_shared', value: unknown = JSON.parse(result)) => ({
  route: 'office-data',
  status: '1. office-data — succeeded',
  steps: [{ calls: [{ tool, result: value }] }],
})
const routed = (tool = 'graph_files_shared', value?: unknown) => ({
  ...iteration('office-data', trace(tool, value)),
  compact: {
    result: 'Found in recent sharing activity; partial coverage.',
    label: '1. office-data',
  },
})

it.each([
  ['direct', input([iteration('graph_files_shared', JSON.parse(result))]), true],
  [
    'batched',
    input([
      {
        ...iteration('fetch', {
          '1': { tool: 'fetch', result: 'page' },
          '2': { tool: 'graph_files_shared', result: JSON.parse(result) },
        }),
        action: {
          ...iteration('fetch', null).action,
          additional_calls: [{ tool_name: 'graph_files_shared', tool_args: '{}' }],
        },
      },
    ]),
    true,
  ],
  [
    'failed batch call',
    input([
      {
        ...iteration('fetch', {
          '1': { tool: 'fetch', result: 'page' },
          '2': { tool: 'graph_files_shared', __error: 'failed' },
        }),
        action: {
          ...iteration('fetch', null).action,
          additional_calls: [{ tool_name: 'graph_files_shared', tool_args: '{}' }],
        },
      },
    ]),
    false,
  ],
  ['route trace', input([routed()]), true],
  ['unrelated trace', input([routed('fetch', result)]), false],
  ['forged trace result', input([iteration('fetch', trace())]), false],
  [
    'forged result fields',
    input([iteration('fetch', { tool: 'graph_files_shared', shared_files: true, result })]),
    false,
  ],
  [
    'unrelated response',
    { mode: 'response', userMessage: 'q', intent: 'q', response: result } as CompactExecutionInput,
    false,
  ],
] as const)(
  'defaultSynthesize flags %s from producer metadata, never result text',
  async (_name, data, expected) => {
    const sent = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await defaultSynthesize(data)
    const [message, intent, turns, error, errorMessage, memory, references, guide, clock] =
      sent.mock.calls[0]
    expect(turns.some((t) => t.shared_files === true)).toBe(expected)
    const request = await b.request.Synthesize(
      message,
      intent,
      turns,
      error,
      errorMessage,
      memory,
      references,
      guide,
      clock,
      { client: 'LargeQwen', env },
    )
    expect(request.body.text().includes('Preserve shared-files coverage')).toBe(expected)
  },
)

it('keeps the code-written shared-files flag when a trace falls back to its compact record', async () => {
  vi.spyOn(clients, 'getContextWindow').mockReturnValue(5_096)
  const sent = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
  const output = await defaultSynthesize(input([routed('graph_files_shared', 'x'.repeat(8_000))]))
  expect(output.fellBack).toEqual(['1. office-data'])
  const turns = sent.mock.calls[0][2]
  expect(turns[0].trace).not.toBe(true)
  expect(turns[0].shared_files).toBe(true)
})

it('drops the shared-files instruction when the writer trims that whole turn', async () => {
  vi.spyOn(clients, 'getContextWindow').mockReturnValue(5_096)
  const sent = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
  await defaultSynthesize(
    input([
      iteration('graph_files_shared', 'x'.repeat(8_000)),
      { ...iteration('fetch', 'page'), turn: 1 },
    ]),
  )
  const turns = sent.mock.calls[0][2]
  expect(turns).toHaveLength(1)
  expect(turns[0].shared_files).not.toBe(true)
})
