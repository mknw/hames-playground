// @vitest-environment node
/**
 * The router and the synthesizer — the two time-reasoning calls that do not go
 * through `baml-adapters.server.ts` — pass the turn clock's block as their
 * trailing `current_time`, and the rendered request carries it IN A USER PART.
 *
 * The role is the assertion that matters for Synthesize: its `guide` slot (#985)
 * and `current_time` are adjacent `string | null` slots, so swapping them
 * typechecks. A swapped block renders inside the leading system block's
 * ASSISTANT GUIDE, where a bare `toContain` still passes. So the test renders
 * the arguments the adapter ACTUALLY passed, with a guide and a clock both
 * present, and asserts which part each one lands in.
 *
 * Mutations, each verified to redden this file:
 *   - swap `guide` / `currentTimeBlock()` in `defaults.server.ts` → red.
 *   - pass `null` for `current_time` in `defaults.server.ts` → red.
 *   - pass `null` for `current_time` in `routing.server.ts` → red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import { createSynthesizer } from '@hames-ai/harness-baml/defaults.server'
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
const GUIDE = 'GUIDETOKEN can read your calendar.'
const inTurn = <T>(fn: () => Promise<T>) =>
  withRunFrame({ inference: { tier: 'anthropic' }, clock: CLOCK }, fn)

const SYNTH_INPUT = {
  mode: 'thread',
  userMessage: "What's today's date?",
  intent: "Tell the user today's date",
  loopHistory: { startTime: 0, iterations: [] },
} as unknown as CompactExecutionInput

/** Every content part of a rendered body with its role, on either wire. */
function parts(body: unknown): { role: string; text: string }[] {
  const b = body as {
    system?: string | { text?: string }[]
    messages: { role: string; content: string | { text?: string }[] }[]
  }
  const out: { role: string; text: string }[] = []
  const push = (role: string, c: string | { text?: string }[]) => {
    for (const p of typeof c === 'string' ? [{ text: c }] : c)
      out.push({ role, text: p.text ?? '' })
  }
  if (b.system) push('system', b.system)
  for (const m of b.messages) push(m.role, m.content)
  return out
}
const roleOf = (seq: { role: string; text: string }[], needle: string) =>
  seq.filter((p) => p.text.includes(needle)).map((p) => p.role)

afterEach(() => vi.restoreAllMocks())

describe('current_time on the router and the synthesizer', () => {
  it.each(['AnthropicSonnet5', 'LargeQwen'])(
    'Router receives the block and renders it in a user part (%s)',
    async (client) => {
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
        await b.request.Router(args[0], args[1], args[2], args[3], args[4], { client, env: ENV })
      ).body.json()
      expect(roleOf(parts(body), LOCAL)).toEqual(['user'])
    },
  )

  it.each(['AnthropicSonnet5', 'LargeQwen'])(
    'Synthesize puts the clock in a user part and the guide in the system block (%s)',
    async (client) => {
      const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
      await inTurn(() => createSynthesizer({ guide: GUIDE })(SYNTH_INPUT))
      const args = synth.mock.calls[0]
      expect(args).toHaveLength(10)
      // references, guide, current_time, then the bag.
      expect(args[7]).toBe(GUIDE)
      expect(args[8]).toBe(formatTimeBlock(CLOCK))
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
          args[8],
          { client, env: ENV },
        )
      ).body.json()
      const seq = parts(body)
      expect(roleOf(seq, LOCAL)).toEqual(['user'])
      expect(roleOf(seq, 'GUIDETOKEN')).toEqual(['system'])
      // The FIDELITY list lets the answer state the date from the clock.
      expect(roleOf(seq, 'may come from CURRENT TIME above')).toEqual(['user'])
    },
  )
})
