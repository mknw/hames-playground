/**
 * Resume inside a route (decision-loop-agent.md slice 6), layer 2: a turn that
 * pauses INSIDE a decisionLoop route, through the real turn runner, SSE, the
 * host's answer path and persistence, and a resume (`mode: 'resume'`) that
 * continues the route from the held call instead of starting the turn again.
 *
 * The gate is synthetic: a test-only host wrapper scopes a transport whose
 * `gated_write` asks the person and returns the held placeholder. The wrapper
 * joins the resumable path with core's exported helpers, the way a host's own
 * wrapper would.
 *
 * MUTATION: rebuild an empty turn log on resume (skip simpleLoop's replay) →
 * the route starts again at turn 0, the controller is called three times and
 * `gated_write` is dispatched a second time → red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns/types'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC } from '../lib/mode'

const AGENT = 'e2e-resume-route'
let app: AppHandles
let actions: typeof import('../../src/lib/harness-client/actions.server')
let hitlActions: typeof import('../../src/lib/hitl/actions.server')
let core: typeof import('@hames-ai/harness-patterns')
/** Every dispatch of the synthetic gated tool, in order. */
const dispatched: string[] = []

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
  actions = await import('../../src/lib/harness-client/actions.server')
  hitlActions = await import('../../src/lib/hitl/actions.server')
  core = await import('@hames-ai/harness-patterns')
  const { amendRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  const { resumableStep, wrapperResumable } =
    await import('@hames-ai/harness-patterns/resume.server')
  const { decisionLoop } = await import('@hames-ai/harness-patterns/patterns/decisionLoop.server')
  const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
  const adapters = await import('@hames-ai/harness-baml/baml-adapters.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')

  const gated = {
    id: 'e2e-gated',
    ownsTool: (name: string) => name === 'gated_write',
    callTool: async () => {
      dispatched.push('gated_write')
      const outcome = await core.askHuman({
        kind: 'graph-write',
        question: 'Write the synthetic change?',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject', unattended: true },
        ],
        defaultOption: 'reject',
      })
      return outcome.status === 'pending'
        ? { success: true, data: core.held(outcome) }
        : { success: true, data: `answered: ${outcome.choice}` }
    },
    listTools: async () => [
      {
        name: 'gated_write',
        description: 'Write the synthetic change',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }
  /** The host's wrapper: it scopes the gated transport and is one resumable
   *  step of the path, holding no state of its own. */
  const withGatedTool = (inner: ConfiguredPattern<SessionData>): ConfiguredPattern<SessionData> => {
    const resumable = wrapperResumable('withGatedTool', inner)
    return {
      ...inner,
      name: `withGatedTool(${inner.name})`,
      children: [inner],
      capabilities: { ...inner.capabilities, resumable },
      fn: (scope, view) =>
        resumableStep('withGatedTool', resumable, () =>
          amendRunFrame({ transports: [gated] }, () => inner.fn(scope, view)),
        ),
    }
  }

  registerAgent({
    id: AGENT,
    name: 'Synthetic route gate',
    description: 'Synthetic pause inside a route',
    welcome: 'Synthetic pause inside a route',
    servers: [],
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns: async () => [
      withGatedTool(
        decisionLoop<SessionData>(
          {
            work: {
              pattern: simpleLoop<SessionData>(
                adapters.createLoopControllerAdapter(),
                ['gated_write'],
                { patternId: 'work', maxTurns: 3 },
              ),
              description: 'Write the synthetic change',
            },
          },
          {
            decide: adapters.createDecideAdapter(),
            answer: 'Answer now',
            patternId: 'orchestrator',
            gatedTools: ['gated_write'],
            // One iteration: the fake decides the first option every time.
            maxIterations: 1,
          },
        ),
      ),
      core.compactExecution<SessionData>({
        mode: 'message',
        synthesize: bamlPatterns().synthesize,
      }),
    ],
  })
})

afterAll(async () => {
  app.fakeLlm.reset()
  await app.wipe()
})

describe.runIf(IS_HERMETIC)('a pause inside a decisionLoop route', () => {
  it('resumes the route from the held call: one dispatch, no repeated decision or round', async () => {
    app.fakeLlm.reset()
    dispatched.length = 0
    await app.setTier('anthropic')
    const sessionId = newSessionId('resume-route')

    const first = await app.runTurnOverSse({
      sessionId,
      agentId: AGENT,
      message: 'Synthetic write',
    })
    expect(first.status).toBe(200)
    expect(first.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
    const paused = await actions.loadConversation(sessionId)
    const [request] = core.readHitl(core.deserializeContext(paused.serialized)).pending
    expect(request.continuation?.map((s) => s.pattern)).toEqual([
      'withGatedTool',
      'decisionLoop',
      'simpleLoop',
    ])
    expect(await hitlActions.answerHitl(sessionId, { [request.requestId]: 'approve' })).toEqual([
      { requestId: request.requestId, outcome: 'answered' },
    ])

    const before = app.fakeLlm.calls.length
    const resumed = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(resumed.status).toBe(200)
    expect(resumed.frames.some((f) => f.event === 'error')).toBe(false)
    expect(resumed.frames.find((f) => f.event === 'done')?.data.response).toContain(
      FAKE_ANSWER_MARK,
    )

    // The held call ran once, before the pause; after it, no decision and no
    // repeated round: one controller call (turn 1, carrying the outcome) and
    // the synthesis.
    expect(dispatched).toEqual(['gated_write'])
    const after = app.fakeLlm.calls.slice(before)
    expect(after.filter((c) => c.endpoint)).toHaveLength(0)
    const controller = after.filter((c) => c.fn === 'LoopController')
    expect(controller).toHaveLength(1)
    expect(controller[0].prompt).toContain('Turn 1. Decide the next action.')
    expect(controller[0].prompt).toContain('The user chose: Approve.')

    const finished = await actions.loadConversation(sessionId)
    expect((await app.readRow(sessionId))?.status).toBe('done')
    expect(eventsOfType(finished.serialized, 'hitl_response')).toEqual([
      expect.objectContaining({ requestId: request.requestId, choice: 'approve', by: 'person' }),
    ])
    expect(
      eventsOfType(finished.serialized, 'decision_made').filter((d) => d.key === 'next_step'),
    ).toHaveLength(1)
  })
})
