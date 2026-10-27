/**
 * A blocking request's payload (decision-loop-agent.md slice 8), layer 2: the
 * real turn runner supplies the run's payload store, a gated call holds its
 * arguments there under its logical call key while the person decides, the
 * request names them by `payloadRef` only, and the save after the resume
 * purges them.
 *
 * MUTATIONS: drop `hitlPayloads` from the turn's run frame → the gate cannot
 * hold its payload and the turn does not pause → red. Drop the purge after the
 * resume save → the payload outlives its request → red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns/types'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC } from '../lib/mode'

const AGENT = 'e2e-held-payload'
let app: AppHandles
let actions: typeof import('../../src/lib/harness-client/actions.server')
let hitlActions: typeof import('../../src/lib/hitl/actions.server')
let core: typeof import('@hames-ai/harness-patterns')
let payloads: typeof import('../../src/lib/db/hitl.server')
/** Every dispatch of the synthetic gated tool, in order. */
const dispatched: string[] = []

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
  actions = await import('../../src/lib/harness-client/actions.server')
  hitlActions = await import('../../src/lib/hitl/actions.server')
  core = await import('@hames-ai/harness-patterns')
  payloads = await import('../../src/lib/db/hitl.server')
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
    callTool: async (_name: string, args: Record<string, unknown>) => {
      dispatched.push('gated_write')
      const outcome = await core.askHumanHolding(
        {
          kind: 'graph-write',
          question: 'Write the synthetic change?',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject', unattended: true },
          ],
          defaultOption: 'reject',
        },
        { tool: 'gated_write', args },
      )
      if (outcome.status === 'rebound') return { success: false, data: null, error: 'rebound' }
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
    name: 'Synthetic held payload',
    description: 'Synthetic pause holding a payload',
    welcome: 'Synthetic pause holding a payload',
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

describe.runIf(IS_HERMETIC)('a gated call holding its payload', () => {
  it('holds the arguments under the call while the person decides, and purges them after the resume', async () => {
    app.fakeLlm.reset()
    dispatched.length = 0
    await app.setTier('anthropic')
    const sessionId = newSessionId('held-payload')

    const first = await app.runTurnOverSse({
      sessionId,
      agentId: AGENT,
      message: 'Synthetic write',
    })
    expect(first.status).toBe(200)
    expect(first.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
    const paused = await actions.loadConversation(sessionId)
    const [request] = core.readHitl(core.deserializeContext(paused.serialized)).pending
    expect(request.payloadRef).toEqual(expect.any(String))
    // The request carries a handle, never the arguments.
    expect(JSON.stringify(request)).not.toContain('gated_write')
    const held = await payloads.getHitlPayload(request.payloadRef!, app.userId)
    expect(held).toMatchObject({ sessionId, kind: 'graph-write', payload: { tool: 'gated_write' } })
    const call = eventsOfType(paused.serialized, 'tool_call').find((c) => c.tool === 'gated_write')
    expect(call?.callKey).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
    expect(request.key).toContain(`:${call?.callKey}`)

    await hitlActions.answerHitl(sessionId, { [request.requestId]: 'approve' })
    const resumed = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(resumed.frames.find((f) => f.event === 'done')?.data.response).toContain(
      FAKE_ANSWER_MARK,
    )
    expect(dispatched).toEqual(['gated_write'])
    expect(await payloads.getHitlPayload(request.payloadRef!, app.userId)).toBeNull()
  })
})
