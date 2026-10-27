/**
 * A blocking request's payload (decision-loop-agent.md slice 8), layer 2: the
 * real turn runner supplies the run's payload store, a gated call holds its
 * arguments there under its logical call key while the person decides, the
 * request names them by `payloadRef` only, and the save after the resume
 * purges them.
 *
 * MUTATIONS: drop `hitlPayloads` from the turn's run frame → the gate cannot
 * hold its payload and the turn does not pause → red. Drop the purge after the
 * resume save → the payload outlives its request → red. Drop the purge after
 * the chat save → a superseded request's payload outlives it → red. Drop
 * `hitlPayloads` from the RESUME's run frame → a second holding request raised
 * in the resumed run throws instead of pausing → red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns/types'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC } from '../lib/mode'

const AGENT = 'e2e-held-payload'
/** The same agent with a second iteration: the fake decides `work` again, so
 *  the resumed run reaches a second gated write. */
const AGENT_TWICE = 'e2e-held-payload-twice'
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

  const register = (id: string, maxIterations: number) =>
    registerAgent({
      id,
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
              // The fake decides the first option every time.
              maxIterations,
            },
          ),
        ),
        core.compactExecution<SessionData>({
          mode: 'message',
          synthesize: bamlPatterns().synthesize,
        }),
      ],
    })
  register(AGENT, 1)
  register(AGENT_TWICE, 2)
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

  // #801 review B3(b): the supersede path.
  it("a new message instead of an answer purges the superseded request's payload", async () => {
    app.fakeLlm.reset()
    await app.setTier('anthropic')
    const sessionId = newSessionId('held-superseded')
    await app.runTurnOverSse({ sessionId, agentId: AGENT, message: 'Synthetic write' })
    const paused = await actions.loadConversation(sessionId)
    const [first] = core.readHitl(core.deserializeContext(paused.serialized)).pending
    expect(await payloads.getHitlPayload(first.payloadRef!, app.userId)).not.toBeNull()

    await app.runTurnOverSse({ sessionId, agentId: AGENT, message: 'Something else instead' })
    expect(await payloads.getHitlPayload(first.payloadRef!, app.userId)).toBeNull()
  })

  // #801 review B3(c): the store on the resume's run frame.
  it('a resumed run that reaches a second gated call pauses again, holding its own payload', async () => {
    app.fakeLlm.reset()
    await app.setTier('anthropic')
    const sessionId = newSessionId('held-twice')
    await app.runTurnOverSse({ sessionId, agentId: AGENT_TWICE, message: 'Synthetic write' })
    const paused = await actions.loadConversation(sessionId)
    const [first] = core.readHitl(core.deserializeContext(paused.serialized)).pending
    await hitlActions.answerHitl(sessionId, { [first.requestId]: 'approve' })

    const resumed = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(resumed.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
    const again = await actions.loadConversation(sessionId)
    const [second] = core.readHitl(core.deserializeContext(again.serialized)).pending
    expect(second.requestId).not.toBe(first.requestId)
    expect(second.payloadRef).not.toBe(first.payloadRef)
    expect(await payloads.getHitlPayload(second.payloadRef!, app.userId)).toMatchObject({
      sessionId,
      payload: { tool: 'gated_write' },
    })
  })
})
