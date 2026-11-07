/** #1029, layer 2: the shipped turn runner reads the stored user zone and a
 * fixed clock. The fake reasons ONLY from the rendered CURRENT TIME block;
 * the real MCP call and persisted tool arguments must carry concrete dates.
 * This proves wiring, not a live model's date arithmetic. Mutation: pass null
 * at the loop-controller call, or drop clock from the host frame -> no dates. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootApp, eventsOfType, newSessionId, settleSummaries, type AppHandles } from '../lib/app'
import { FAKE_DATE_RANGE_QUESTION } from '../lib/fake-llm'
import { IS_HERMETIC } from '../lib/mode'

let app: AppHandles
let priorZone: string | null
beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
  const { getStoredTimeZone } = await import('../../src/lib/db/user-prefs.server')
  priorZone = await getStoredTimeZone(app.userId)
})
afterAll(async () => {
  await app.wipe()
  const { query } = await import('../../src/lib/db/client.server')
  await query('UPDATE user_prefs SET time_zone = $1 WHERE user_id = $2', [priorZone, app.userId])
})

describe.runIf(IS_HERMETIC)('date-relative general-next turn', () => {
  it.each(['anthropic', 'self_deployed'] as const)(
    'last two weeks becomes tool dates (%s)',
    async (tier) => {
      const { setStoredTimeZone } = await import('../../src/lib/db/user-prefs.server')
      await setStoredTimeZone(app.userId, 'Europe/Brussels')
      await app.setTier(tier)
      app.fakeLlm.reset()
      app.fakeGateway.reset()
      const sessionId = newSessionId('current-time')
      const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T23:30:12Z'))
      try {
        const { status, frames } = await app.runTurnOverSse({
          sessionId,
          agentId: 'general-next',
          message: FAKE_DATE_RANGE_QUESTION,
        })
        expect(status).toBe(200)
        expect(frames.find((f) => f.event === 'done')?.data.response).toBeTruthy()
        expect(frames.find((f) => f.event === 'done')?.data.status).not.toBe('error')
      } finally {
        wall.mockRestore()
      }
      await settleSummaries(app, sessionId)
      const expected = { since: '2026-10-22', until: '2026-11-05' }
      const read = app.fakeGateway.toolCalls.find((c) => c.name === 'read_neo4j_cypher')
      expect(read?.args.params).toEqual(expected)
      const row = (await app.readRow(sessionId))!
      expect(row.status).toBe('done')
      expect(eventsOfType(row.serializedContext, 'tool_call')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: 'read_neo4j_cypher',
            args: expect.objectContaining({ params: expected }),
          }),
        ]),
      )
      const calls = app.fakeLlm.calls.filter(
        (c) => c.fn === 'LoopController' || c.fn === 'Synthesize' || c.endpoint,
      )
      expect(calls.length).toBeGreaterThanOrEqual(5)
      for (const call of calls) expect(call.prompt).toContain('Thursday, 2026-11-05T00:30:12+01:00')
    },
  )
})
