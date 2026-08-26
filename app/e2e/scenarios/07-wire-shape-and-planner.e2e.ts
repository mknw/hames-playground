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
 * That makes the check implicit in every verda-tier scenario — an illegal
 * ordering would fail them all. This test makes it EXPLICIT, because "scenario
 * 2 went red" is a much worse diagnosis than "the wire carried a late system
 * block". It runs a multi-turn conversation, which is where the runtime data
 * (turn logs, attempt logs, prior results) that varies a template's output
 * actually accumulates.
 *
 * ## The second agent shape
 *
 * Everything else in this suite drives `search` (router → routes → simpleLoop →
 * compactExecution). `general` is a different chain — planner → simpleLoop →
 * compactExecution over the whole tool surface — and `Planner` is a role the
 * tier switch deliberately does NOT move, so a turn through it is also a second
 * witness for the pinned-role rule.
 *
 * ## Known gap, stated rather than papered over
 *
 * `ActorController` and `Critic` are NOT exercised anywhere in this suite. The
 * only agents that use `actorCritic` are the two sandbox agents, which need a
 * container runtime — so the pattern whose retry path #263 actually broke is
 * still only covered by the template audit and the evals. Closing that needs a
 * sandbox fake, which is a larger piece of work than this suite.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { FAKE_ANTHROPIC_TIER_MODEL, IS_HERMETIC, VERDA_MODEL } from '../lib/mode'

let app: AppHandles

beforeAll(async () => {
  app = await bootApp()
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
    await app.setTier('verda')
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
    const verdaCalls = app.fakeLlm.calls.filter((c) => c.model === VERDA_MODEL)
    expect(verdaCalls.length, 'no call took the self-hosted route').toBeGreaterThan(0)
  })
})

describe.each(['anthropic', 'verda'] as const)('the general agent on the %s tier', (tier) => {
  it('plans, executes and answers', async () => {
    await app.setTier(tier)
    const sessionId = newSessionId(`general-${tier}`)

    const result = await app.runTurn(sessionId, 'Count the nodes in the graph.', 'general')

    expect(result.response).toBeTruthy()
    const row = await app.readRow(sessionId)
    expect(row!.agentId).toBe('general')
    expect(row!.status).toBe('done')
    expect(eventsOfType(row!.serializedContext, 'assistant_message').length).toBeGreaterThan(0)
  })

  it.runIf(IS_HERMETIC)('leaves the planner on the Anthropic chain in both positions', async () => {
    await app.setTier(tier)
    await app.runTurn(newSessionId(`plan-${tier}`), 'Count the nodes in the graph.', 'general')

    const planner = app.fakeLlm.calls.filter((c) => c.fn === 'Planner')
    expect(planner.length, 'the planner never ran').toBeGreaterThan(0)
    // `planner` is absent from VERDA_CLIENT_BY_ROLE on purpose: it runs once
    // per chain over the largest tool catalog in the repo and throws outright
    // when structured output fails.
    for (const call of planner) expect(call.model).toBe(FAKE_ANTHROPIC_TIER_MODEL)
  })
})
