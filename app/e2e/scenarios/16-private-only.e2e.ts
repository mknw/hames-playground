/** Layer 2: stored public choices cannot escape a private-only deployment. */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { bootApp, newSessionId, settleSummaries, type AppHandles } from '../lib/app'
import { IS_HERMETIC, LARGE_LLM_MODEL, SMALL_MODEL } from '../lib/mode'

let app: AppHandles
beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  await app.wipe()
})

describe('private-only deployment', () => {
  it.runIf(IS_HERMETIC)(
    'clamps legacy choices, refuses public actions and routes turns, titles and summaries privately with no public key',
    async () => {
      vi.stubEnv('INFERENCE_TIERS', 'private')
      vi.stubEnv('ANTHROPIC_API_KEY', '')
      const actions = await import('../../src/lib/harness-client/actions.server')
      const session = newSessionId('private-only')
      // Write the historical fact directly, as an earlier deployment could have.
      await app.setTier('anthropic', session)
      expect(await actions.getConversationTier(session)).toEqual({
        tier: 'self_deployed',
        selfDeployedAvailable: true,
        anthropicAvailable: false,
      })
      await expect(actions.setConversationTier(session, 'anthropic')).rejects.toThrow(
        /private inference only/,
      )
      app.fakeLlm.reset()
      const result = await app.runTurn(session, 'Count the nodes in the graph')
      expect(
        result.response,
        JSON.stringify(result.context?.events?.filter((e) => e.type === 'error')),
      ).toBeTruthy()
      await settleSummaries(app, session)
      // Force an actual legacy conversation column after the first persisted turn.
      await app.setTier('anthropic', session)
      expect((await actions.getConversationTier(session)).tier).toBe('self_deployed')
      await app.runTurn(session, 'Summarise the answer')
      await settleSummaries(app, session)
      await actions.regenerateConversationTitle(session)
      const calls = app.fakeLlm.calls.filter((call) => call.fn !== null)
      for (const fn of ['Router', 'LoopController', 'Synthesize', 'GenerateConversationTitle']) {
        expect(
          calls.some((call) => call.fn === fn),
          `missing ${fn}`,
        ).toBe(true)
      }
      expect(calls.some((call) => call.fn?.startsWith('ResultDescribe'))).toBe(true)
      for (const call of calls) expect([LARGE_LLM_MODEL, SMALL_MODEL]).toContain(call.model)
      expect((await app.readRow(session))?.status).toBe('done')
    },
  )
})
