/**
 * #624: a failed resume wake survives the real reload action, with the same
 * pause and recorded answer available for retry. Hermetic only: the fault is
 * an immediate refusal of a fake wake, never a request to a live deployment.
 *
 * MUTATION: remove the wake-failure record in runResumeAndSave's catch. The
 * reload still finds the pause, but its warning assertion reddens.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC, SELF_DEPLOYED_MODEL } from '../lib/mode'

const AGENT = 'e2e-resume-wake'
let app: AppHandles
let actions: typeof import('../../src/lib/harness-client/actions.server')
let hitlActions: typeof import('../../src/lib/hitl/actions.server')
let answers: typeof import('../../src/lib/db/hitl.server')
let core: typeof import('@hames-ai/harness-patterns')

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
  actions = await import('../../src/lib/harness-client/actions.server')
  hitlActions = await import('../../src/lib/hitl/actions.server')
  answers = await import('../../src/lib/db/hitl.server')
  core = await import('@hames-ai/harness-patterns')
  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  registerAgent({
    id: AGENT,
    name: 'Synthetic resume gate',
    description: 'Synthetic pause and retry conversation',
    welcome: 'Synthetic pause and retry conversation',
    servers: [],
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns: async () => [
      core.humanGate({
        request: () => ({
          kind: 'confirm',
          key: 'synthetic-resume',
          question: 'Continue the synthetic turn?',
          options: [
            { id: 'continue', label: 'Continue' },
            { id: 'stop', label: 'Stop', stopsRun: true },
          ],
          defaultOption: 'continue',
          unattended: 'park',
        }),
      }),
      core.compactExecution({ mode: 'message', synthesize: bamlPatterns().synthesize }),
    ],
  })
})

afterAll(async () => {
  app.fakeLlm.reset()
  await app.wipe()
})

describe.runIf(IS_HERMETIC)('a resume whose wake fails', () => {
  it('reloads the warning and retries the same answer to completion', async () => {
    app.fakeLlm.reset()
    await app.setTier('self_deployed')
    const sessionId = newSessionId('resume-wake')
    const first = await app.runTurnOverSse({ sessionId, agentId: AGENT, message: 'Synthetic task' })
    expect(first.status).toBe(200)
    expect(first.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
    const paused = await actions.loadConversation(sessionId)
    const request = core.readHitl(core.deserializeContext(paused.serialized)).pending[0]
    expect(request).toBeDefined()
    expect(await hitlActions.answerHitl(sessionId, { [request.requestId]: 'continue' })).toEqual([
      { requestId: request.requestId, outcome: 'answered' },
    ])

    await app.goToSleep()
    app.fakeLlm.reset()
    app.fakeLlm.arm({
      kind: 'status',
      status: 400,
      wake: true,
      model: SELF_DEPLOYED_MODEL,
      times: 1,
    })
    const failed = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(failed.status).toBe(200)
    const failure = failed.frames.find((f) => f.event === 'error')?.data.error
    expect(failure).toEqual(expect.stringContaining('the private inference box did not wake'))
    expect(failed.frames.some((f) => f.event === 'done')).toBe(false)
    expect(app.fakeLlm.calls).toHaveLength(1)
    expect(app.fakeLlm.calls[0]).toMatchObject({
      fn: null,
      outcome: 'status',
      model: SELF_DEPLOYED_MODEL,
    })

    // The actual action the sidebar/reload uses, with no in-memory transcript.
    const restored = await actions.loadConversation(sessionId)
    const ctx = core.deserializeContext(restored.serialized)
    expect(ctx.status).toBe('paused')
    expect((await app.readRow(sessionId))?.status).toBe('paused')
    expect(core.readHitl(ctx).pending).toEqual([request])
    expect(restored.messages).toMatchObject([
      { role: 'user', content: 'Synthetic task' },
      { role: 'warning', content: failure },
    ])
    expect(restored.messages).toHaveLength(2)
    expect(await answers.loadHitlAnswerRows(sessionId, app.userId)).toEqual([
      expect.objectContaining({
        requestId: request.requestId,
        status: 'answered',
        answer: { choice: 'continue' },
      }),
    ])

    // No resubmission and no new question: the answer that never ran is used
    // once. This also proves the failed wake released its claim.
    const retried = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(retried.status).toBe(200)
    expect(retried.frames.some((f) => f.event === 'error')).toBe(false)
    expect(retried.frames.find((f) => f.event === 'done')?.data.response).toContain(
      FAKE_ANSWER_MARK,
    )
    const finished = await actions.loadConversation(sessionId)
    expect((await app.readRow(sessionId))?.status).toBe('done')
    expect(core.readHitl(core.deserializeContext(finished.serialized)).pending).toEqual([])
    expect(eventsOfType(finished.serialized, 'hitl_response')).toEqual([
      expect.objectContaining({ requestId: request.requestId, choice: 'continue', by: 'person' }),
    ])
    expect(finished.messages.filter((m) => m.role === 'warning')).toEqual([
      expect.objectContaining({ content: failure }),
    ])
  })
})
