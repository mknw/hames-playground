/**
 * Scenario 7 — what a whole turn actually puts on the wire, and a second
 * agent shape.
 *
 * Two things that only a full conversation can answer.
 *
 * ## The wire shape
 *
 * `prompt-role-order.test.ts` renders all thirteen BAML functions and pins that
 * no `system` message follows a user or assistant one. That is a TEMPLATE
 * audit, and it is the right one — but a template renders differently with
 * different runtime data, and the argument that made #263 dangerous was that
 * Anthropic hides the defect while vLLM 400s on it. So the fake holds every
 * request bound for the self-hosted model to vLLM's own rule and answers an
 * illegal one with the deployment's real message.
 *
 * That makes the check implicit in every self_deployed-tier scenario — an illegal
 * ordering would fail them all. This test makes it EXPLICIT, because "scenario
 * 2 went red" is a much worse diagnosis than "the wire carried a late system
 * block". It runs a multi-turn conversation, which is where the runtime data
 * (turn logs, attempt logs, prior results) that varies a template's output
 * actually accumulates.
 *
 * ## The second agent shape
 *
 * Everything else in this suite drives `search` (router → routes → simpleLoop →
 * compactExecution). The `Planner` role belongs to a different chain — planner →
 * simpleLoop → compactExecution — that no registered agent is still built as
 * (the `general` agent that was, was removed 2026-10-21; `general-next` runs its
 * planner as a `think` route the fake decisions endpoint never picks). So the
 * chain is registered here, under a test-only id, from the same public patterns:
 * a turn through it is the witness that the planner follows the tier switch.
 *
 * ## Known gap, stated rather than papered over
 *
 * `ActorController` and `Critic` are NOT exercised anywhere in this suite. The
 * only agent that uses `actorCritic` is the sandbox agent, which needs a
 * container runtime — so the pattern whose retry path #263 actually broke is
 * still only covered by the template audit and the evals. Closing that needs a
 * sandbox fake, which is a larger piece of work than this suite.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { FAKE_ANTHROPIC_TIER_MODEL, IS_HERMETIC, TIERS, LARGE_LLM_MODEL } from '../lib/mode'

let app: AppHandles

/** Test-only id for the planner → simpleLoop → compactExecution chain. */
const PLANNER_CHAIN = 'e2e-planner-chain'

beforeAll(async () => {
  app = await bootApp()
  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')
  const { agentDeps } = await import('../../src/lib/harness-client/session.server')
  const { planner, simpleLoop, compactExecution, Tools } =
    await import('@hames-ai/harness-patterns')
  const { bamlPatterns, createLoopControllerAdapter } = await import('@hames-ai/harness-baml')
  registerAgent({
    id: PLANNER_CHAIN,
    name: PLANNER_CHAIN,
    description: 'Test-only planner chain',
    welcome: 'Test-only planner chain',
    servers: [],
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns: async (): Promise<ConfiguredPattern<SessionData>[]> => {
      const tools = (await Tools({ namespaces: agentDeps().toolNamespaces })).neo4j ?? []
      const baml = bamlPatterns()
      return [
        planner<SessionData>(baml.planner(tools), tools, { patternId: 'plan' }),
        simpleLoop<SessionData>(createLoopControllerAdapter(), tools, { patternId: 'execute' }),
        compactExecution<SessionData>({
          mode: 'thread',
          patternId: 'response-synth',
          synthesize: baml.synthesize,
          viewConfig: {
            fromPatterns: ['harness', 'execute'],
            fromLastNTurns: 1,
            eventTypes: ['user_message', 'controller_action', 'tool_call', 'tool_result', 'error'],
          },
        }),
      ]
    },
  })
  await app.wipe()
})
afterAll(async () => {
  await app.wipe()
})
beforeEach(() => {
  app.fakeLlm.reset()
  app.fakeGateway.reset()
})

describe.runIf(IS_HERMETIC)('every request the self-hosted route receives is legal', () => {
  it('puts no late system block on the wire across a multi-turn conversation', async () => {
    await app.setTier('self_deployed')
    const sessionId = newSessionId('wire-shape')

    await app.runTurn(sessionId, 'How many nodes are in the graph?')
    await app.runTurn(sessionId, 'And how many relationships?')
    await app.runTurn(sessionId, 'Summarise both answers.')

    const rejected = app.fakeLlm.calls.filter((c) => c.outcome === 'bad-role-order')
    expect(
      rejected.map((c) => c.fn),
      'the self-hosted endpoint rejected these calls for ordering a system block after a ' +
        'user/assistant one — the #263 failure shape, which Anthropic would have hidden',
    ).toEqual([])

    // Guard against the check going vacuous: it only means something if calls
    // reached the self-hosted model at all.
    const selfDeployedCalls = app.fakeLlm.calls.filter((c) => c.model === LARGE_LLM_MODEL)
    expect(selfDeployedCalls.length, 'no call took the self-hosted route').toBeGreaterThan(0)

    // …and it means much more since the 2026-08-26 widening, because the
    // ordering rule is now enforced over templates that had never met a vLLM
    // server. `prompt-role-order.test.ts` audits all thirteen offline; this is
    // the running-turn half, and `Router` is named explicitly so the widening
    // cannot silently stop being covered here.
    expect(selfDeployedCalls.map((c) => c.fn)).toContain('Router')
  })
})

describe.each(TIERS)('the planner chain on the %s tier', (tier) => {
  it('plans, executes and answers', async () => {
    await app.setTier(tier)
    const sessionId = newSessionId(`planner-chain-${tier}`)

    const result = await app.runTurn(sessionId, 'Count the nodes in the graph.', PLANNER_CHAIN)

    expect(result.response).toBeTruthy()
    const row = await app.readRow(sessionId)
    expect(row!.agentId).toBe(PLANNER_CHAIN)
    expect(row!.status).toBe('done')
    expect(eventsOfType(row!.serializedContext, 'assistant_message').length).toBeGreaterThan(0)
  })

  it.runIf(IS_HERMETIC)('routes the planner to whichever tier the turn is on', async () => {
    await app.setTier(tier)
    await app.runTurn(newSessionId(`plan-${tier}`), 'Count the nodes in the graph.', PLANNER_CHAIN)

    const planner = app.fakeLlm.calls.filter((c) => c.fn === 'Planner')
    expect(planner.length, 'the planner never ran').toBeGreaterThan(0)
    // `planner` joined SELF_DEPLOYED_CLIENT_BY_ROLE on 2026-08-26. It is the role with
    // the harshest failure policy in the repo — one call per chain, over the
    // largest tool catalog, and a structured-output failure throws rather than
    // degrading — which is why it was held back, and why this leg is worth
    // running against the real endpoint rather than only against the fake.
    const expected = tier === 'self_deployed' ? LARGE_LLM_MODEL : FAKE_ANTHROPIC_TIER_MODEL
    for (const call of planner) expect(call.model).toBe(expected)
  })
})
