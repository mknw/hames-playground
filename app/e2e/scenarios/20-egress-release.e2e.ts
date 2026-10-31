/**
 * Asking the person before an outgoing request (boundary guards slice 10),
 * layer 2: the real turn runner, the real decide adapter against the fake
 * decision endpoint (which answers the egress question `personal`, its first
 * option, so every outgoing call here is one the gate would refuse), the real
 * payload store, and a synthetic outgoing tool on a run-scoped transport.
 *
 * - ATTENDED (a chat turn): the call is HELD. Nothing is sent, the request
 *   holds the arguments in its payload row, and after the owner's Accept the
 *   resume sends exactly that call once and purges the row.
 * - UNATTENDED (a triggered run): the gate refuses as it did before this
 *   slice; no request is raised and nothing is sent.
 *
 * MUTATIONS: drop `askPerson` from the gate → the attended turn refuses
 * instead of pausing → red. Drop the re-dispatch on re-entry → the accepted
 * call is never sent → red. Drop `attended` from `canPauseHere` → the
 * triggered run raises a request instead of refusing → red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns/types'
import { SEND_OUTCOME_UNKNOWN } from '@hames-ai/harness-patterns/mcp-client.server'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { IS_HERMETIC } from '../lib/mode'

const AGENT = 'e2e-egress-release'
const BATCH_AGENT = 'e2e-egress-batch'
let app: AppHandles
let actions: typeof import('../../src/lib/harness-client/actions.server')
let hitlActions: typeof import('../../src/lib/hitl/actions.server')
let core: typeof import('@hames-ai/harness-patterns')
let payloads: typeof import('../../src/lib/db/hitl.server')
/** Every call of the synthetic outgoing tool that got past the gate. */
const sent: Record<string, unknown>[] = []

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
  const { withEgressGate } =
    await import('@hames-ai/harness-patterns/patterns/withEgressGate.server')
  const adapters = await import('@hames-ai/harness-baml/baml-adapters.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')

  const outside = {
    id: 'e2e-outside',
    ownsTool: (name: string) => name === 'synthetic_search',
    callTool: async (_name: string, args: Record<string, unknown>) => {
      sent.push(args)
      return { success: true, data: { hits: ['a synthetic public result'] } }
    },
    listTools: async () => [
      {
        name: 'synthetic_search',
        description: 'Search a synthetic outside service',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }
  /** The host's wrapper: it scopes the outside transport and is one resumable
   *  step of the path. */
  const withOutside = (inner: ConfiguredPattern<SessionData>): ConfiguredPattern<SessionData> => {
    const resumable = wrapperResumable('withOutside', inner)
    return {
      ...inner,
      name: `withOutside(${inner.name})`,
      children: [inner],
      capabilities: { ...inner.capabilities, resumable },
      fn: (scope, view) =>
        resumableStep('withOutside', resumable, () =>
          amendRunFrame({ transports: [outside] }, () => inner.fn(scope, view)),
        ),
    }
  }

  registerAgent({
    id: AGENT,
    name: 'Synthetic egress release',
    description: 'Synthetic outgoing call held for the person',
    welcome: 'Synthetic outgoing call held for the person',
    servers: [],
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns: async () => [
      withOutside(
        withEgressGate({
          local: [],
          catalog: ['synthetic_search'],
          decide: adapters.createDecideAdapter(),
          askPerson: true,
        })(
          decisionLoop<SessionData>(
            {
              work: {
                pattern: simpleLoop<SessionData>(
                  adapters.createLoopControllerAdapter(),
                  ['synthetic_search'],
                  { patternId: 'work', maxTurns: 3 },
                ),
                description: 'Search the synthetic outside service',
              },
            },
            {
              decide: adapters.createDecideAdapter(),
              answer: 'Answer now',
              patternId: 'orchestrator',
              maxIterations: 1,
            },
          ),
        ),
      ),
      core.compactExecution<SessionData>({
        mode: 'message',
        synthesize: bamlPatterns().synthesize,
      }),
    ],
  })

  registerAgent({
    id: BATCH_AGENT,
    name: 'Synthetic egress batch',
    description: 'Two synthetic outside calls held together',
    welcome: 'Synthetic egress batch',
    servers: [],
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns: async () => [
      withOutside(
        withEgressGate({
          local: [],
          catalog: ['synthetic_search'],
          decide: adapters.createDecideAdapter(),
          askPerson: true,
        })(
          decisionLoop<SessionData>(
            {
              work: {
                pattern: simpleLoop<SessionData>(
                  async ({ turn }) => ({
                    action:
                      turn === 0
                        ? {
                            reasoning: 'synthetic batch',
                            tool_name: 'synthetic_search',
                            tool_args: JSON.stringify({ query: 'synthetic-first' }),
                            additional_calls: [
                              {
                                tool_name: 'synthetic_search',
                                tool_args: JSON.stringify({ query: 'synthetic-second' }),
                              },
                            ],
                            status: 'running',
                            is_final: false,
                          }
                        : {
                            reasoning: 'done',
                            tool_name: 'Return',
                            tool_args: 'done',
                            status: 'done',
                            is_final: true,
                          },
                  }),
                  ['synthetic_search'],
                  { patternId: 'work-batch', maxTurns: 3, multiToolCalls: 'parallel' },
                ),
                description: 'Search synthetic outside service twice',
              },
            },
            {
              decide: adapters.createDecideAdapter(),
              answer: 'Answer now',
              patternId: 'orchestrator-batch',
              maxIterations: 1,
            },
          ),
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

describe.runIf(IS_HERMETIC)('an outgoing request the gate would refuse', () => {
  it('attended: held for the person, and sent exactly once after Accept', async () => {
    app.fakeLlm.reset()
    sent.length = 0
    await app.setTier('anthropic')
    const sessionId = newSessionId('egress-release')

    const first = await app.runTurnOverSse({ sessionId, agentId: AGENT, message: 'Search it' })
    expect(first.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
    expect(sent).toEqual([])
    const paused = await actions.loadConversation(sessionId)
    const [request] = core.readHitl(core.deserializeContext(paused.serialized)).pending
    expect(request).toMatchObject({ kind: 'egress-release', defaultOption: 'refuse' })
    const held = await payloads.getHitlPayload(request.payloadRef!, app.userId)
    expect(held).toMatchObject({ kind: 'egress-release', payload: { tool: 'synthetic_search' } })

    await hitlActions.answerHitl(sessionId, { [request.requestId]: 'accept' })
    const resumed = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(resumed.frames.find((f) => f.event === 'done')?.data.status).not.toBe('paused')
    expect(sent).toHaveLength(1)
    const after = await actions.loadConversation(sessionId)
    expect(
      eventsOfType(after.serialized, 'egress_audit').map(
        (d) => (d as { allowedBy: string }).allowedBy,
      ),
    ).toEqual(['person'])
    expect(await payloads.getHitlPayload(request.payloadRef!, app.userId)).toBeNull()
  })

  it('unattended: a triggered run still refuses, and raises no request', async () => {
    app.fakeLlm.reset()
    sent.length = 0
    await app.setTier('anthropic')
    const sessionId = newSessionId('egress-unattended')
    const runner = await import('../../src/lib/harness-client/action-runner.server')
    const trigger = { transcribedCommand: 'Search it', shortDescription: 'Synthetic search' }
    const version = await runner.seedActionRow(sessionId, app.userId, AGENT, trigger)
    await runner.runAgentInBackground(sessionId, app.userId, 'Search it', AGENT, trigger, version)

    const row = await app.readRow(sessionId)
    expect(eventsOfType(row!.serializedContext, 'hitl_request')).toEqual([])
    expect(eventsOfType(row!.serializedContext, 'egress_refused')).toHaveLength(1)
    expect(sent).toEqual([])
  })
})

describe.runIf(IS_HERMETIC)('N8 held outgoing batch', () => {
  // N8-01/02/08. MUTATIONS: remove the barrier, owner-gated payload read, or
  // per-row flag binding → a pre-answer send or wrong second send turns red.
  it('holds one encrypted plan and resumes only the selected exact call', async () => {
    app.fakeLlm.reset()
    sent.length = 0
    await app.setTier('anthropic')
    const sessionId = newSessionId('egress-batch')
    const first = await app.runTurnOverSse({
      sessionId,
      agentId: BATCH_AGENT,
      message: 'Search it',
    })
    expect(first.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
    expect(sent).toEqual([])
    const paused = await actions.loadConversation(sessionId)
    const [request] = core.readHitl(core.deserializeContext(paused.serialized)).pending
    expect(request.kind).toBe('egress-batch-release')
    expect(request.options[0].flags).toHaveLength(2)
    const held = await payloads.getHitlPayload(request.payloadRef!, app.userId)
    expect(held?.payload).toMatchObject({
      v: 1,
      rows: [
        { index: 0, tool: 'synthetic_search', args: { query: 'synthetic-first' } },
        { index: 1, tool: 'synthetic_search', args: { query: 'synthetic-second' } },
      ],
    })
    const flag = request.options[0].flags![0].id
    expect(
      await hitlActions.answerHitl(sessionId, {
        [request.requestId]: { choice: 'continue', flags: { [flag]: true } },
      }),
    ).toEqual([{ requestId: request.requestId, outcome: 'answered' }])
    const resumed = await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(resumed.frames.find((f) => f.event === 'done')?.data.status).not.toBe('paused')
    expect(sent).toEqual([{ query: 'synthetic-first' }])
    const after = await actions.loadConversation(sessionId)
    expect(
      eventsOfType(after.serialized, 'tool_call').some((d) =>
        JSON.stringify(d).includes('synthetic-first'),
      ),
    ).toBe(false)
  })

  // N8-03. MUTATION: retry a started claim → the resumed turn sends the
  // synthetic call a second time despite the other process's committed row.
  it('a claim committed in another process makes resume report outcome unknown without a send', async () => {
    app.fakeLlm.reset()
    sent.length = 0
    await app.setTier('anthropic')
    const sessionId = newSessionId('egress-batch-crash')
    const first = await app.runTurnOverSse({
      sessionId,
      agentId: BATCH_AGENT,
      message: 'Search it',
    })
    expect(first.frames.find((f) => f.event === 'done')?.data.status).toBe('paused')
    const paused = await actions.loadConversation(sessionId)
    const [request] = core.readHitl(core.deserializeContext(paused.serialized)).pending
    const held = await payloads.getHitlPayload(request.payloadRef!, app.userId)
    const plan = held!.payload as { members: { callKey: string; digest: string }[] }
    const claim = {
      userId: app.userId,
      sessionId,
      runId: request.runId,
      callKey: plan.members[0].callKey,
      digest: plan.members[0].digest,
    }
    const probe = `import { claimToolSend, stopHitlSweepTimer } from './src/lib/db/hitl.server.ts';
      import { closePool } from './src/lib/db/client.server.ts';
      (async () => { const result = await claimToolSend(JSON.parse(process.env.N8_CLAIM_KEY!));
        process.stdout.write('N8_PROBE:' + JSON.stringify(result) + '\\n');
        stopHitlSweepTimer(); await closePool(); })().catch((e) => {
          process.stderr.write(String(e)); process.exitCode = 1; });`
    const modules = path.resolve(process.cwd(), '../node_modules/.pnpm')
    const tsx = readdirSync(modules).find((name) => name.startsWith('tsx@'))!
    const cli = path.join(modules, tsx, 'node_modules/tsx/dist/cli.mjs')
    const output = execFileSync(process.execPath, [cli, '-e', probe], {
      cwd: process.cwd(),
      env: { ...process.env, N8_CLAIM_KEY: JSON.stringify(claim) },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(JSON.parse(output.split('N8_PROBE:')[1].split('\n')[0])).toEqual({ status: 'new' })
    const flag = request.options[0].flags![0].id
    await hitlActions.answerHitl(sessionId, {
      [request.requestId]: { choice: 'continue', flags: { [flag]: true } },
    })
    await app.runTurnOverSse({ sessionId, mode: 'resume' })
    expect(sent).toEqual([])
    const after = await actions.loadConversation(sessionId)
    expect(
      eventsOfType(after.serialized, 'tool_result').some(
        (d) => (d as { error?: string }).error === SEND_OUTCOME_UNKNOWN,
      ),
    ).toBe(true)
  })
})
