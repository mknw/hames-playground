// @vitest-environment node
/** #1029, layer 1: render the arguments the real adapters sent, with one clock
 * and an advancing wall clock. Removing any adapter's currentTimeBlock() or
 * its template's CurrentTime call must redden its case. Placement/cache pins
 * live in current-time-placement.test.ts, including the reasoning twins. */
import { afterEach, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import {
  createActorControllerAdapter,
  createCriticAdapter,
  createLoopControllerAdapter,
  createPlannerAdapter,
} from '@hames-ai/harness-baml/baml-adapters.server'
import { createCompactIntentAdapter } from '@hames-ai/harness-baml/baml-patterns.server'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import { routeMessageOp } from '@hames-ai/harness-baml/routing.server'
import { formatTimeBlock, type TurnClock } from '@hames-ai/harness-patterns/clock'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const instant = Date.parse('2026-11-04T23:30:12Z')
const action = { reasoning: 'done', tool_name: 'Return', tool_args: 'done', is_final: true }
const history = [{ role: 'user' as const, content: 'Find projects' }]
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

it.each([
  { timeZone: 'Europe/Brussels', expected: 'Thursday, 2026-11-05T00:30:12+01:00' },
  { timeZone: 'UTC', zoneUnknown: true, expected: 'Wednesday, 2026-11-04T23:30:12+00:00' },
])('every adapter renders the turn instant in $timeZone', async ({ expected, ...zone }) => {
  const clock: TurnClock = { instant, ...zone }
  const wall = vi.spyOn(Date, 'now').mockReturnValue(instant)
  const loop = vi.spyOn(b, 'LoopController').mockResolvedValue(action)
  const actor = vi.spyOn(b, 'ActorController').mockResolvedValue(action)
  const planner = vi
    .spyOn(b, 'Planner')
    .mockResolvedValue({ reasoning: 'r', plan: 'p', n_steps: 1 })
  const critic = vi
    .spyOn(b, 'Critic')
    .mockResolvedValue({ is_sufficient: true, explanation: 'done' })
  const compact = vi.spyOn(b, 'CompactIntent').mockResolvedValue('Find projects')
  const router = vi.spyOn(b, 'Router').mockResolvedValue({
    needs_tool: false,
    route: null,
    intent: 'Find projects',
    response: 'ok',
  })
  const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('done')

  await withRunFrame({ clock, inference: { tier: 'anthropic' } }, async () => {
    await createCompactIntentAdapter()({ history, latest: 'From the last two weeks' })
    wall.mockReturnValue(instant + 86_400_000)
    await createLoopControllerAdapter()({
      userMessage: 'Find projects',
      intent: 'last two weeks',
      tools: [],
      turns: [],
      turn: 0,
    })
    await createActorControllerAdapter([])('Find projects', 'last two weeks', [], [])
    await createPlannerAdapter([])('Find projects', 'last two weeks')
    await createCriticAdapter()('Find projects', [])
    await routeMessageOp('Find projects', [])
    await defaultSynthesize({
      mode: 'response',
      userMessage: 'Find projects',
      intent: 'last two weeks',
      response: 'done',
    })
  })
  const requests = [
    await b.request.CompactIntent(...replay(compact.mock.calls[0])),
    await b.request.LoopController(...replay(loop.mock.calls[0])),
    await b.request.ActorController(...replay(actor.mock.calls[0])),
    await b.request.Planner(...replay(planner.mock.calls[0])),
    await b.request.Critic(...replay(critic.mock.calls[0])),
    await b.request.Router(...replay(router.mock.calls[0])),
    await b.request.Synthesize(...replay(synth.mock.calls[0])),
  ]
  for (const req of requests) {
    const body = JSON.stringify(req.body.json())
    expect(body).toContain(expected)
    expect(body).toContain(formatTimeBlock(clock).split('\n')[0])
    expect(body.match(/CURRENT TIME \(/g)).toHaveLength(1)
  }
})
