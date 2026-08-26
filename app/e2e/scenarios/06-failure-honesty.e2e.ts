/**
 * Scenario 6 — when the endpoint fails, the user is told.
 *
 * The failure this suite most wants to prevent is not an outage. It is an
 * outage the interface does not admit to: a turn that ends with an empty
 * bubble, a row stuck at `running`, or — worst — a `done` row carrying a
 * confident answer that no model produced. `turn.server.ts` flips a failed row
 * to `error` before rethrowing (sf-M2/sf-M3) precisely so no row spins forever,
 * and the SSE route turns a throw into an `error` frame. Both are claims about
 * paths nothing exercised end to end until now.
 *
 * Four failure shapes, because they fail in four different layers of the
 * client and a single one of them proves nothing about the others:
 *
 *  | shape        | fails in                                              |
 *  | ------------ | ----------------------------------------------------- |
 *  | HTTP 400     | the provider's response handling (vLLM's rejection)   |
 *  | endpoint down| the TCP connect (no server on the port at all)        |
 *  | mid-stream   | the body reader (headers arrived, the body did not)   |
 *  | tool error   | inside the loop, where the run is expected to CONTINUE|
 *
 * The last row is the control: a tool that fails is a normal event the
 * controller reacts to, and a suite that turned every failure into a red
 * conversation would be wrong in the other direction.
 *
 * HERMETIC ONLY. There is no responsible way to cause these against the real
 * deployment, and faking them there would only be testing the fake.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { IS_HERMETIC } from '../lib/mode'

let app: AppHandles

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
})
afterAll(async () => {
  await app.fakeLlm.comeBack()
  app.fakeLlm.reset()
  await app.wipe()
})
beforeEach(async () => {
  await app.fakeLlm.comeBack()
  app.fakeLlm.reset()
  app.fakeGateway.reset()
  await app.setTier('verda')
})

/**
 * What the user can actually see after a failed turn.
 *
 * A turn fails honestly when it does at least one of: throws out of the server
 * action (the UI renders the rejection), or persists a row the sidebar shows as
 * `error`. It fails DISHONESTLY when it resolves with a `done` row and a
 * response — a fabricated success — or leaves the row at `running`, which is a
 * spinner nothing will ever clear.
 */
async function observeFailure(app: AppHandles, sessionId: string, message: string) {
  let threw: unknown = null
  let response: string | undefined
  try {
    const result = await app.runTurn(sessionId, message)
    response = result.response
  } catch (err) {
    threw = err
  }
  const row = await app.readRow(sessionId)
  return { threw, response, status: row?.status ?? null, row }
}

describe.runIf(IS_HERMETIC)('a failing endpoint is surfaced, never swallowed', () => {
  it('a 400 from the endpoint ends the turn visibly', async () => {
    app.fakeLlm.arm({
      kind: 'status',
      status: 400,
      message: 'System message must be at the beginning.',
    })
    const sessionId = newSessionId('fail-400')

    const seen = await observeFailure(app, sessionId, 'How many nodes are in the graph?')

    expect(
      seen.threw !== null || seen.status === 'error',
      `the turn reported no failure at all (status=${seen.status}, response=${JSON.stringify(seen.response)})`,
    ).toBe(true)
    // The specific dishonest outcomes.
    expect(seen.status, 'a failed turn left the row spinning at running').not.toBe('running')
    if (seen.status === 'done') {
      throw new Error(
        `the row was persisted as 'done' after every LLM call 400'd — the conversation claims ` +
          `an answer nothing produced (response=${JSON.stringify(seen.response)})`,
      )
    }
  })

  it('an endpoint that is not listening ends the turn visibly', async () => {
    await app.fakeLlm.goDown()
    const sessionId = newSessionId('fail-down')

    const seen = await observeFailure(app, sessionId, 'How many nodes are in the graph?')

    expect(
      seen.threw !== null || seen.status === 'error',
      `a refused connection produced no visible failure (status=${seen.status})`,
    ).toBe(true)
    expect(seen.status).not.toBe('running')
  })

  it('a connection dropped mid-response ends the turn visibly', async () => {
    app.fakeLlm.arm({ kind: 'mid-stream' })
    const sessionId = newSessionId('fail-midstream')

    const seen = await observeFailure(app, sessionId, 'How many nodes are in the graph?')

    expect(
      seen.threw !== null || seen.status === 'error',
      `a truncated response produced no visible failure (status=${seen.status})`,
    ).toBe(true)
    expect(seen.status).not.toBe('running')
  })

  it('reports the failure to an SSE client rather than closing quietly', async () => {
    app.fakeLlm.arm({ kind: 'status', status: 400, message: 'injected' })
    const sessionId = newSessionId('fail-sse')

    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: 'search',
    })

    expect(status).toBe(200) // the stream opens; the failure rides inside it
    const errorFrame = frames.find((f) => f.event === 'error')
    const doneFrame = frames.find((f) => f.event === 'done')

    // One of the two has to carry the bad news. A stream that just closed —
    // no error frame, no done frame — leaves the UI spinning forever, which is
    // the exact silent stop this scenario exists to forbid.
    const honest =
      errorFrame !== undefined || (doneFrame !== undefined && doneFrame.data.status === 'error')
    expect(
      honest,
      `the stream closed without telling the client anything; frames were ` +
        `[${frames.map((f) => f.event).join(', ')}]`,
    ).toBe(true)
  })

  it('a failing TOOL is not a failing conversation', async () => {
    // The control case. `read_neo4j_cypher` erroring is ordinary: the loop
    // feeds the error back to the controller and carries on, and the user gets
    // an answer that admits the failure.
    app.fakeGateway.setError('get_neo4j_schema', 'Neo4j is unreachable')
    app.fakeGateway.setError('read_neo4j_cypher', 'Syntax error at line 1')
    const sessionId = newSessionId('tool-error')

    const result = await app.runTurn(sessionId, 'How many nodes are in the graph?')

    expect(result.response, 'a tool error should not swallow the answer').toBeTruthy()
    const row = await app.readRow(sessionId)
    expect(row!.status).toBe('done')
    expect(eventsOfType(row!.serializedContext, 'assistant_message').length).toBeGreaterThan(0)
  })
})
