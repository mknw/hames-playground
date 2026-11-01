/**
 * Scenario 9 — a dead MCP gateway is admitted to, not answered around (#276).
 *
 * This scenario is the red test for a failure the suite had already MEASURED
 * and declined to fix. Scenario 6's header says it, in the paragraph headed
 * "WHICH FAULT, AND WHY NOT THE GATEWAY": a turn with the gateway refusing
 * connections still completed `done`, because every gateway read degrades on
 * purpose — `listTools` logs and returns the app-side tools, `getGraphSchema`
 * warns and returns `''`. Each of those is right on its own. Together they
 * produced the one outcome this suite calls dishonest: `Tools()` yields a
 * ToolSet with no `neo4j` and no `web` key. The info route runs a `simpleLoop`
 * with an empty allowlist; its unavailable signal must survive the enclosing
 * decision loop so the final synthesis cannot compose an ordinary answer.
 *
 * So the assertion is not "the turn fails". It is: **whatever the turn does, the
 * user learns the tools were unavailable.** A refusal that names the outage is
 * honest; an answer that admits it would be honest too. A confident answer with
 * no mention of it is the bug, and that is what this file forbids.
 *
 * Three things make the shape different from scenario 6's four faults:
 *
 *   - it is the TOOL half that dies, not the inference endpoint, so every LLM
 *     call still succeeds and nothing in the chain throws;
 *   - the fault is at pattern-BUILD time (`Tools()`), not inside a turn, which
 *     is why independent cases start fresh conversations — `getOrBuildPatterns`
 *     caches per session. The recovery case deliberately reuses its session;
 *   - it has to come back. The last case is the control: the same question
 *     answers normally once the gateway is listening again, which is what
 *     separates "reports an outage" from "broke the agent".
 *
 * The registered agent is `general-next`. The failure must be
 * visible even when its info route cannot get gateway tools.
 *
 * HERMETIC ONLY. The gateway is faked in both modes, but taking it down is an
 * injected fault, and the live run exists to measure the inference route.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'

let app: AppHandles

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
})

afterAll(async () => {
  // Every later file (and every developer running one scenario at a time)
  // depends on the gateway being up: it is a process-wide singleton.
  await app.fakeGateway.comeBack()
  app.fakeGateway.reset()
  await app.wipe()
})

beforeEach(async () => {
  app.fakeLlm.reset()
  app.fakeGateway.reset()
  await app.setTier('self_deployed')
})

/** Does anything the user can see mention that the tools were unavailable? */
function admitsTheOutage(serializedContext: string, response: string | undefined): boolean {
  const errors = eventsOfType(serializedContext, 'error')
  const inTranscript = errors.some((e) => /unavailable|gateway/i.test(String(e.error ?? '')))
  return inTranscript || /unavailable|gateway/i.test(response ?? '')
}

/**
 * The tool-list shape an outage produces, and the registered agent that carries
 * it (one a user can pick from the header).
 */
const AGENTS = [{ id: 'general-next', surface: 'the gateway-backed info route' }] as const

describe('the tool surface collapses', () => {
  it.each(AGENTS)('$id does not answer as if the tools had been consulted', async (agent) => {
    await app.fakeGateway.goDown()
    const sessionId = newSessionId(`gateway-down-${agent.id}`)

    let response: string | undefined
    try {
      const result = await app.runTurn(sessionId, 'How many nodes are in the graph?', agent.id)
      response = result.response
    } catch {
      // A throw is an acceptable shape — the UI renders the rejection. What is
      // not acceptable is a quiet success, which is what the assertions below
      // are about.
    }

    const row = await app.readRow(sessionId)
    expect(row, 'the pre-seeded row is gone').not.toBeNull()

    expect(
      admitsTheOutage(row!.serializedContext, response),
      `${agent.id} said nothing about the gateway, with ${agent.surface}. ` +
        `status=${row!.status}, response=${JSON.stringify(response)}`,
    ).toBe(true)
    expect(response).toContain('Tools unavailable: the MCP gateway')

    // The specific dishonest outcome: the fake's canned answer, delivered as
    // though the graph had been queried. Before #276 the retired search agent returned this on a `done` row.
    if (response) expect(response).not.toContain(FAKE_ANSWER_MARK)
    expect(row!.status, 'a turn with no tools was persisted as a completed answer').not.toBe('done')
    expect(row!.status, 'the row was left spinning at running').not.toBe('running')
  })

  it('says so in the transcript, with the severity that stopped the chain', async () => {
    await app.fakeGateway.goDown()
    const sessionId = newSessionId('gateway-down-events')

    await app.runTurn(sessionId, 'How many nodes are in the graph?').catch(() => undefined)

    const row = await app.readRow(sessionId)
    const errors = eventsOfType(row!.serializedContext, 'error')
    const outage = errors.find((e) => /unavailable/i.test(String(e.error ?? '')))
    expect(
      outage,
      `no unavailability error in the transcript; got ${JSON.stringify(errors)}`,
    ).toBeDefined()
    // `irrecoverable` is what `runChain` reads to stop the chain, and stopping
    // the chain is what keeps the synthesizer from answering — so this field is
    // load-bearing, not decoration, and the UI paints it as an error rather
    // than a warning because of it.
    expect(outage!.severity).toBe('irrecoverable')

    // And nothing claimed to have answered the question.
    const answers = eventsOfType(row!.serializedContext, 'assistant_message')
    expect(
      answers.every((a) => !String(a.content ?? '').includes(FAKE_ANSWER_MARK)),
      'an assistant message carried a fabricated answer',
    ).toBe(true)
  })

  it('tells an SSE client rather than streaming a healthy-looking answer', async () => {
    await app.fakeGateway.goDown()
    const sessionId = newSessionId('gateway-down-sse')

    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: 'general-next',
    })

    expect(status).toBe(200) // the stream opens; the news rides inside it
    const errorFrame = frames.find((f) => f.event === 'error')
    const doneFrame = frames.find((f) => f.event === 'done')
    const honest =
      errorFrame !== undefined || (doneFrame !== undefined && doneFrame.data.status === 'error')
    expect(
      honest,
      `the stream reported a healthy turn; frames were [${frames.map((f) => f.event).join(', ')}]`,
    ).toBe(true)
    expect(doneFrame?.data.status).toBe('error')
    expect(doneFrame?.data.response).toContain('Tools unavailable: the MCP gateway')
    expect(
      frames.some(
        (f) =>
          f.event === 'message' &&
          f.data.type === 'error' &&
          /Tools unavailable: the MCP gateway/.test(
            String((f.data.data as { error?: string } | undefined)?.error ?? ''),
          ),
      ),
      'the streamed error did not explain that required gateway data was unavailable',
    ).toBe(true)
  })

  it('answers normally again once the gateway is back', async () => {
    // Reuse the affected session: a cached empty tool list would make this
    // later turn fail even though the gateway is listening again.
    await app.fakeGateway.goDown()
    const sessionId = newSessionId('gateway-recovery')
    const question = 'How many Project nodes are in the knowledge graph?'
    const first = await app.runTurn(sessionId, question)
    expect(first.response).toContain('Tools unavailable: the MCP gateway')
    expect((await app.readRow(sessionId))!.status).toBe('error')

    await app.fakeGateway.comeBack()
    const result = await app.runTurn(sessionId, question)

    expect(result.response).toContain(FAKE_ANSWER_MARK)
    const row = await app.readRow(sessionId)
    expect(row!.status).toBe('done')
    const graphRead = eventsOfType(row!.serializedContext, 'tool_result').find(
      (event) => event.tool === 'read_neo4j_cypher',
    )
    expect(graphRead?.success).toBe(true)
    expect(JSON.stringify(graphRead?.result)).toContain('42')
    expect(
      app.fakeGateway.toolCalls.filter((call) => call.name === 'read_neo4j_cypher'),
    ).toHaveLength(1)
  })
})
