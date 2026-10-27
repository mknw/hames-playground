/** #507 S3, layer 2: W4's RUNNABLE NOW 02-graph-count through the real
 * registered candidate, SSE, adapters, guard and persistence. No sandbox boots
 * on this route. Anthropic explicitly passes through G14; private rewrite and
 * egress are layer-1 evidence in S7, and P4 file-path cases remain gated. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, eventsOfType, newSessionId, settleSummaries, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC } from '../lib/mode'

let app: AppHandles
let uninstallGraph: (() => void) | undefined
beforeAll(async () => {
  app = await bootApp()
  uninstallGraph = await app.installGraphTools()
  await app.wipe()
})
beforeEach(() => {
  app.fakeLlm.reset()
  app.fakeGateway.reset()
})
afterAll(async () => {
  uninstallGraph?.()
  await app.wipe()
})

describe.runIf(IS_HERMETIC)('general-next conversation', () => {
  it('decides, reads the synthetic graph, answers once and persists the route output', async () => {
    await app.setTier('anthropic')
    const sessionId = newSessionId('general-next-count')
    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      agentId: 'general-next',
      message: 'How many Project nodes are in the knowledge graph?',
    })
    expect(status).toBe(200)
    const done = frames.find((f) => f.event === 'done')
    expect(done?.data.response, JSON.stringify(frames)).toContain(FAKE_ANSWER_MARK)
    expect(done?.data.response).toContain('42')
    expect(done?.data.status).not.toBe('error')
    await settleSummaries(app, sessionId)
    const row = (await app.readRow(sessionId))!
    expect(row).not.toBeNull()
    expect(row.agentId).toBe('general-next')
    expect(row.status).toBe('done')
    expect(
      eventsOfType(row.serializedContext, 'decision_made')
        .filter((d) => d.key === 'next_step')
        .map((d) => d.label),
    ).toEqual(['info-retrieval', 'answer'])
    expect(eventsOfType(row.serializedContext, 'tool_result')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'read_neo4j_cypher', success: true }),
        expect.objectContaining({
          tool: 'info-retrieval',
          success: true,
          result: expect.stringContaining('42'),
        }),
      ]),
    )
    const decoded = JSON.parse(row.serializedContext)
    expect(
      decoded.events.filter(
        (e: { type: string; patternId: string }) =>
          e.type === 'tool_result' && e.patternId === 'orchestrator',
      ),
    ).toHaveLength(1)
    expect(app.fakeGateway.toolCalls.filter((c) => c.name === 'read_neo4j_cypher')).toHaveLength(1)
    expect(app.fakeLlm.calls.filter((c) => c.fn === 'Synthesize')).toHaveLength(1)
    // Boundary guards slice 3, ruling O: a graph read is the deployment's own content,
    // so the host's classifier keeps it to the deterministic pass and no screen runs.
    // MUTATION: drop `classify` from general-next's info guard — a screen call appears.
    expect(app.fakeLlm.calls.filter((c) => c.fn === 'ScreenUntrustedContent')).toHaveLength(0)
    const decisions = app.fakeLlm.calls.filter(
      (c) => c.endpoint && JSON.parse(c.prompt).questions.next_step,
    )
    expect(decisions).toHaveLength(2)
    expect(decisions.every((c) => c.endpoint === 'jev')).toBe(true)
    expect(JSON.parse(decisions[1].prompt).state).toContain('42')
    expect(JSON.parse(decisions[1].prompt).state).not.toContain('⟦')
    expect(frames.some((f) => f.event === 'message' && f.data.type === 'decision_made')).toBe(true)
  })

  // FIX08 (#606 run 6, scenario 08): the decisions model read the earlier turn
  // and the route it chose did not, so "the same count" was a guess. Layer 2's
  // own claim, "the second turn saw the first", on the request the route's
  // controller actually sent. MUTATION: drop `conversation` from decisionLoop's
  // child data — turn 2's controller request no longer carries turn 1.
  it("a follow-up's controller request carries the previous turn", async () => {
    await app.setTier('anthropic')
    const sessionId = newSessionId('general-next-follow-up')
    const turn = (message: string) =>
      app.runTurnOverSse({ sessionId, agentId: 'general-next', message })
    expect((await turn('How many Project nodes are in the knowledge graph?')).status).toBe(200)
    const afterFirst = app.fakeLlm.calls.length
    const second = await turn('That failed earlier. Please try the same count again now.')
    expect(second.status).toBe(200)
    const controller = app.fakeLlm.calls
      .slice(afterFirst)
      .find((c) => c.fn === 'LoopController')?.prompt
    expect(controller, 'turn 2 sent no LoopController request').toBeDefined()
    expect(controller).toContain('Earlier conversation')
    expect(controller).toContain('User: "How many Project nodes are in the knowledge graph?"')
    expect(controller).toContain(`Assistant: "${FAKE_ANSWER_MARK}: the graph reports 42 nodes."`)
    expect(controller).toContain('INSTRUCTIONS: That failed earlier. Please try the same count')
  })

  it('P5: shows a visible error when the private decisions shim is absent', async () => {
    await app.setTier('self_deployed')
    const previous = process.env.SMALL_LLM_DECISIONS_URL
    delete process.env.SMALL_LLM_DECISIONS_URL
    try {
      const sessionId = newSessionId('general-next-no-shim')
      const { frames } = await app.runTurnOverSse({
        sessionId,
        agentId: 'general-next',
        message: 'Count Project nodes.',
      })
      expect(JSON.stringify(frames)).toContain('SMALL_LLM_DECISIONS_URL')
      expect(
        frames.some(
          (f) => f.event === 'error' || (f.event === 'done' && f.data.status === 'error'),
        ),
      ).toBe(true)
      expect(
        app.fakeLlm.calls.filter(
          (c) => c.endpoint || c.fn === 'LoopController' || c.fn === 'Synthesize',
        ),
      ).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.SMALL_LLM_DECISIONS_URL
      else process.env.SMALL_LLM_DECISIONS_URL = previous
    }
  })
})
