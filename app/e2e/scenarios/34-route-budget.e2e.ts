/** #1017, layer 2: the post-route pause through scenario 18's real host
 * answer/SSE/resume/persistence path. All fixtures are invented. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC } from '../lib/mode'
import type { SessionData } from '../../src/lib/harness-client/session.server'

const AGENT = 'e2e-route-budget'
let app: AppHandles
let actions: typeof import('../../src/lib/harness-client/actions.server')
let hitlActions: typeof import('../../src/lib/hitl/actions.server')
let core: typeof import('@hames-ai/harness-patterns')
const budgets: number[] = []

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
  actions = await import('../../src/lib/harness-client/actions.server')
  hitlActions = await import('../../src/lib/hitl/actions.server')
  core = await import('@hames-ai/harness-patterns')
  const adapters = await import('@hames-ai/harness-baml/baml-adapters.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')
  registerAgent({
    id: AGENT,
    name: 'Synthetic route exhaustion',
    description: 'Invented bounded lookup',
    welcome: 'Invented bounded lookup',
    servers: [],
    egressPolicy: 'local-only',
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns: async () => {
      const make = (maxTurns: number) =>
        core.simpleLoop<SessionData>(
          async () => ({
            action: {
              tool_name: 'get_neo4j_schema',
              tool_args: '{}',
              reasoning: 'Invented lookup with no final answer',
              is_final: false,
            },
          }),
          ['get_neo4j_schema'],
          { patternId: 'work', maxTurns, rememberPriorTurns: false },
        )
      return [
        core.decisionLoop<SessionData>(
          {
            work: {
              pattern: make(1),
              description: 'Read the invented schema',
              withBudget: (n) => {
                budgets.push(n)
                return make(n)
              },
            },
          },
          {
            patternId: 'orchestrator',
            decide: adapters.createDecideAdapter(),
            answer: 'Answer from partial results',
            maxIterations: 1,
          },
        ),
        core.compactExecution<SessionData>({
          mode: 'thread',
          viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 },
          synthesize: bamlPatterns().synthesize,
        }),
      ]
    },
  })
})

afterAll(async () => {
  app.fakeLlm.reset()
  await app.wipe()
})

describe.runIf(IS_HERMETIC)('route budget pause and both answers (#1017)', () => {
  it.each(['answer', 'continue'] as const)(
    'persists the question and resumes %s through the real host',
    async (choice) => {
      app.fakeLlm.reset()
      budgets.length = 0
      await app.setTier('anthropic')
      const sessionId = newSessionId(`route-budget-${choice}`)
      const first = await app.runTurnOverSse({
        sessionId,
        agentId: AGENT,
        message: 'Perform the invented bounded lookup',
      })
      expect(first.status).toBe(200)
      expect(first.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
      const paused = await actions.loadConversation(sessionId)
      const [q] = core.readHitl(core.deserializeContext(paused.serialized)).pending
      expect(q.kind).toBe('route-budget')
      expect(q.options.map((o) => o.id)).toEqual(['answer', 'continue'])
      expect(q.summary).toMatchObject({ originalBudget: 1, retryBudget: 4 })
      expect(q.summary.continuation).toContain('may repeat file writes in the sandbox')
      expect(q.continuation?.map((s) => [s.pattern, s.phase])).toEqual([
        ['decisionLoop', 'route-budget'],
      ])
      expect((await app.readRow(sessionId))?.status).toBe('paused')
      expect(await hitlActions.answerHitl(sessionId, { [q.requestId]: choice })).toEqual([
        { requestId: q.requestId, outcome: 'answered' },
      ])
      const before = app.fakeLlm.calls.length
      const done = await app.runTurnOverSse({ sessionId, mode: 'resume' })
      expect(done.status).toBe(200)
      expect(done.frames.some((f) => f.event === 'error')).toBe(false)
      expect(done.frames.find((f) => f.event === 'done')?.data.response).toContain(FAKE_ANSWER_MARK)
      const row = await app.readRow(sessionId)
      expect(row?.status).toBe('done')
      expect(budgets).toEqual(choice === 'continue' ? [4] : [])
      expect(app.fakeLlm.calls.slice(before).filter((c) => c.endpoint)).toEqual([])
      const finished = await actions.loadConversation(sessionId)
      expect(eventsOfType(finished.serialized, 'hitl_request')).toHaveLength(1)
      expect(eventsOfType(finished.serialized, 'hitl_response')).toEqual([
        expect.objectContaining({ requestId: q.requestId, choice, by: 'person' }),
      ])
      expect(
        eventsOfType(finished.serialized, 'tool_call').filter((c) => c.tool === 'get_neo4j_schema'),
      ).toHaveLength(choice === 'continue' ? 5 : 1)
      expect(eventsOfType(finished.serialized, 'decision_made')).toHaveLength(1)
    },
  )

  it('a triggered run takes the unattended answer without parking or enlarging its budget', async () => {
    app.fakeLlm.reset()
    budgets.length = 0
    await app.setTier('anthropic')
    const sessionId = newSessionId('route-budget-unattended')
    const runner = await import('../../src/lib/harness-client/action-runner.server')
    const trigger = { transcribedCommand: 'Invented lookup', shortDescription: 'Invented lookup' }
    const version = await runner.seedActionRow(sessionId, app.userId, AGENT, trigger)
    await runner.runAgentInBackground(
      sessionId,
      app.userId,
      'Invented lookup',
      AGENT,
      trigger,
      version,
    )
    const row = await app.readRow(sessionId)
    expect(row?.status).toBe('done')
    expect(budgets).toEqual([])
    expect(eventsOfType(row!.serializedContext, 'hitl_response')).toEqual([
      expect.objectContaining({ choice: 'answer', by: 'unattended' }),
    ])
    expect(eventsOfType(row!.serializedContext, 'tool_call')).toHaveLength(1)
    expect(core.readHitl(core.deserializeContext(row!.serializedContext)).pending).toEqual([])
  })
})
