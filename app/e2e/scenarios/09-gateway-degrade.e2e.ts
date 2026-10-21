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
 * ToolSet with no `neo4j` and no `web` key, every agent turns that into
 * `tools.neo4j ?? []`, the `simpleLoop` runs with an empty allowlist and calls
 * nothing, and the `compactExecution` at the end of the chain composes a
 * confident answer out of an empty execution. A `done` row, an answer no tool
 * contributed to, and not a word about the gateway anywhere.
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
 *     is why a fresh conversation is needed per case — `getOrBuildPatterns`
 *     caches per session;
 *   - it has to come back. The last case is the control: the same question
 *     answers normally once the gateway is listening again, which is what
 *     separates "reports an outage" from "broke the agent".
 *
 * **One agent now, where there were two** (F1 on #278). `search` reads
 * `tools.neo4j ?? []`, and a gateway namespace has no key at all under an
 * outage, so its loop is handed `[]`. The second case was the `general` agent,
 * which read `tools.all`: `listTools` degrades to the app-side tools, so in
 * production it was handed the `graph_*` tools, a surface amputated rather than
 * empty, and while the guard opened with `tools.length > 0` it answered a dead
 * gateway with `E2E-FAKE-ANSWER: the graph reports 42 nodes.` on a `done` row.
 * The agent was removed 2026-10-21 and no registered agent takes `tools.all`
 * any more, so that case has no subject here; the amputated-surface guard is
 * still pinned in layer 1 (`gateway-degrade.test.ts`).
 *
 * HERMETIC ONLY. The gateway is faked in both modes, but taking it down is an
 * injected fault, and the live run exists to measure the inference route.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { IS_HERMETIC } from '../lib/mode'

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
const AGENTS = [{ id: 'search', surface: 'an empty namespace list (`tools.neo4j ?? []`)' }] as const

describe.runIf(IS_HERMETIC)('the tool surface collapses', () => {
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

    // The specific dishonest outcome: the fake's canned answer, delivered as
    // though the graph had been queried. Before #276 this is exactly what came
    // back on `search`, on a `done` row.
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
      agentId: 'search',
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
  })

  it('answers normally again once the gateway is back', async () => {
    // The control, and the reason the refusal is safe to ship: the health state
    // is a record of the LAST gateway read, so one successful `listTools`
    // clears it. Without this case, a permanently-broken agent would pass every
    // assertion above.
    await app.fakeGateway.goDown()
    await app
      .runTurn(newSessionId('gateway-down-first'), 'How many nodes are in the graph?')
      .catch(() => undefined)

    await app.fakeGateway.comeBack()
    const sessionId = newSessionId('gateway-back')

    const result = await app.runTurn(sessionId, 'How many nodes are in the graph?')

    expect(result.response).toContain(FAKE_ANSWER_MARK)
    const row = await app.readRow(sessionId)
    expect(row!.status).toBe('done')
    expect(eventsOfType(row!.serializedContext, 'tool_result').length).toBeGreaterThan(0)
  })
})
