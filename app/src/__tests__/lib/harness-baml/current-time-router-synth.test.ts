// @vitest-environment node
/**
 * The router and the synthesizer — the two time-reasoning calls that do not go
 * through `baml-adapters.server.ts` — pass the turn clock's block as their
 * trailing `current_time`, and the rendered request carries it.
 *
 * Mutation: pass `null` for `current_time` in `routing.server.ts` or in
 * `defaults.server.ts` → that case goes red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import { routeMessageOp } from '@hames-ai/harness-baml/routing.server'
import { formatTimeBlock } from '@hames-ai/harness-patterns/clock'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type { CompactExecutionInput } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
}
// A Brussels user just after midnight UTC: the block must say Thursday 5 November.
const CLOCK = { instant: Date.parse('2026-11-04T23:30:00Z'), timeZone: 'Europe/Brussels' }
const LOCAL = 'Thursday, 2026-11-05, 00:30 UTC+01:00 (Europe/Brussels)'
const inTurn = <T>(fn: () => Promise<T>) =>
  withRunFrame({ inference: { tier: 'anthropic' }, clock: CLOCK }, fn)

const SYNTH_INPUT: CompactExecutionInput = {
  mode: 'thread',
  userMessage: "What's today's date?",
  intent: "Tell the user today's date",
  loopHistory: { startTime: 0, iterations: [] },
} as unknown as CompactExecutionInput

afterEach(() => vi.restoreAllMocks())

describe('current_time on the router and the synthesizer', () => {
  it('Router receives the block and renders it', async () => {
    const router = vi.spyOn(b, 'Router').mockResolvedValue({
      needs_tool: false,
      route: null,
      intent: 'date',
      response: 'ok',
    } as never)
    await inTurn(() => routeMessageOp("What's today's date?", []))
    const args = router.mock.calls[0]
    expect(args[4]).toBe(formatTimeBlock(CLOCK))
    const body = (
      await b.request.Router(args[0], args[1], args[2], args[3], args[4], {
        client: 'AnthropicSonnet5',
        env: ENV,
      })
    ).body.text()
    expect(body).toContain(LOCAL)
  })

  it('Synthesize receives the block and renders it', async () => {
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await inTurn(() => defaultSynthesize(SYNTH_INPUT))
    const args = synth.mock.calls[0]
    expect(args[7]).toBe(formatTimeBlock(CLOCK))
    const body = (
      await b.request.Synthesize(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
        args[7],
        { client: 'AnthropicSonnet5', env: ENV },
      )
    ).body.text()
    expect(body).toContain(LOCAL)
  })
})
