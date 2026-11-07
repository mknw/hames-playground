// @vitest-environment node
/** C1, #1030: serialized pause/resume retains time across midnight and a zone
 * change. Mutations: omit the persisted clock, ignore it on resume, keep it on
 * a new message. Each must fail a rendered decision/controller/synthesis input. */
import { afterEach, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import { createLoopControllerAdapter } from '@hames-ai/harness-baml/baml-adapters.server'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import { harness, continueSession, resumeHarness } from '@hames-ai/harness-patterns/harness.server'
import { decisionLoop } from '@hames-ai/harness-patterns/patterns/decisionLoop.server'
import { simpleLoop } from '@hames-ai/harness-patterns/patterns/simpleLoop.server'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import { askHuman, held } from '@hames-ai/harness-patterns/hitl.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { formatTimeBlock } from '@hames-ai/harness-patterns/clock'
import type { HarnessData } from '@hames-ai/harness-patterns/harness.server'
import type { DecideFn } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  listTools: vi.fn(async () => [
    { name: 'clock_gate', description: 'Read records', inputSchema: { type: 'object' } },
  ]),
  callTool: vi.fn(async () => {
    const outcome = await askHuman({
      kind: 'clock-test',
      key: 'records',
      question: 'Continue reading records?',
      options: [
        { id: 'continue', label: 'Continue' },
        { id: 'stop', label: 'Stop', unattended: true },
      ],
      defaultOption: 'stop',
    })
    return { success: true, data: outcome.status === 'pending' ? held(outcome) : 'records' }
  }),
}))

type Data = HarnessData & Record<string, unknown>
const opts = {
  client: 'LargeQwen',
  env: { LARGE_LLM_BASE_URL: 'https://example.invalid/v1', LARGE_LLM_API_KEY: 'offline' },
}
function replay<A extends unknown[]>(args: A): A {
  const copy = [...args] as A
  copy[copy.length - 1] = opts
  return copy
}
afterEach(() => vi.restoreAllMocks())

it.each([{ timeZone: 'Europe/Brussels' }, { timeZone: 'UTC', zoneUnknown: true }])(
  'serialized pause/resume retains $timeZone until the next message',
  async (zone) => {
    const original = { instant: Date.parse('2026-11-04T23:30:12Z'), ...zone }
    const next = { instant: original.instant + 86_400_000, timeZone: 'America/New_York' }
    const wall = vi.spyOn(Date, 'now').mockReturnValue(original.instant)
    const controller = vi
      .spyOn(b, 'LoopController')
      .mockResolvedValueOnce({
        reasoning: 'Read',
        tool_name: 'clock_gate',
        tool_args: '{}',
        is_final: false,
      })
      .mockResolvedValue({
        reasoning: 'Done',
        tool_name: 'Return',
        tool_args: 'records',
        is_final: true,
      })
    const synthesis = vi.spyOn(b, 'Synthesize').mockResolvedValue('records')
    const states: string[] = []
    const decide = Object.assign(
      (async ({ spec, state }) => {
        if (!('labels' in spec)) throw new Error('Expected a choice question')
        states.push(state)
        const choice = states.length === 1 ? 'lookup' : 'answer'
        return {
          probs: Object.fromEntries(spec.labels.map((l) => [l.id, l.id === choice ? 1 : 0])),
          method: 'jev',
        }
      }) as DecideFn,
      { supportedTypes: ['choice'], limits: () => ({ contextWindow: 131_072 }) },
    )
    const patterns = [
      decisionLoop<Data>(
        {
          lookup: {
            pattern: simpleLoop<Data>(createLoopControllerAdapter(), ['clock_gate'], {
              patternId: 'lookup',
            }),
            description: 'Read records',
          },
        },
        { decide, answer: 'Answer', patternId: 'orchestrator', gatedTools: ['clock_gate'] },
      ),
      compactExecution<Data>({
        mode: 'thread',
        patternId: 'synth',
        viewConfig: { fromPatterns: ['orchestrator'] },
        synthesize: defaultSynthesize,
      }),
    ]
    const frame = (clock: typeof original | typeof next) => ({
      clock,
      inference: { tier: 'anthropic' },
      hitl: { attended: true },
    })
    const paused = await withRunFrame(frame(original), () =>
      harness(...patterns)('Find records from yesterday'),
    )
    expect(paused.status).toBe('paused')
    if (paused.status !== 'paused') throw new Error('Expected serialized pause')
    expect(JSON.parse(paused.serialized).turnClock).toEqual(original)

    wall.mockReturnValue(next.instant)
    const resumed = await withRunFrame(frame(next), () =>
      resumeHarness(paused.serialized, patterns, { [paused.pending[0].requestId]: 'continue' }),
    )
    expect(resumed.status).not.toBe('paused')
    expect(resumed.context.turnClock).toEqual(original)
    expect(states).toHaveLength(2)
    for (const state of states) expect(state).toContain(formatTimeBlock(original))
    expect(controller).toHaveBeenCalledTimes(2)
    for (const args of controller.mock.calls) {
      const rendered = await b.request.LoopController(...replay(args))
      expect(JSON.stringify(rendered.body.json())).toContain(
        formatTimeBlock(original).split('\n')[1],
      )
    }
    const rendered = await b.request.Synthesize(...replay(synthesis.mock.calls[0]))
    expect(JSON.stringify(rendered.body.json())).toContain(formatTimeBlock(original).split('\n')[1])

    const continued = await withRunFrame(frame(next), () =>
      continueSession(resumed.serialized, patterns, 'What about today?'),
    )
    expect(continued.context.turnClock).toEqual(next)
    expect(states.at(-1)).toContain(formatTimeBlock(next))
    expect(synthesis.mock.calls.at(-1)?.[8]).toBe(formatTimeBlock(next))
  },
)
