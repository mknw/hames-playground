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
 * ## Two mechanisms, and only one of them was covered
 *
 * All four shapes above resolve THROUGH the turn: the harness catches
 * internally and returns `status: 'error'`, so `runTurnAndPersist` returns
 * normally and the SSE route reports the failure in its `done` frame. That
 * leaves the OTHER mechanism — a turn that actually throws — untested, and it
 * has its own two-line path nothing was exercising:
 *
 *   - `runAndSave` flips the row out of `running` and rethrows (sf-M2/sf-M3);
 *   - the SSE route's `catch` turns the throw into an `error` frame.
 *
 * Deleting that catch's `error` frame and closing the stream silently left this
 * file entirely green (independent review, 2026-08-26) — a silent stop, in the
 * suite named for catching them. The last describe block below is that hole:
 * one turn whose pattern build fails, asserted through both entry points.
 *
 * WHICH FAULT, AND WHY NOT THE GATEWAY. The obvious candidate is a dead MCP
 * gateway, and it does not work: measured here, a turn with the gateway
 * refusing connections still completes `done`, because every gateway read
 * degrades on purpose — `listTools` logs and returns the app-side tools
 * (`mcp-client.server.ts`), and `getGraphSchema` warns, refuses the pattern
 * cache and returns `''`. That is the designed behaviour and this suite is not
 * the place to argue with it. What DOES throw in the interactive path is
 * `getOrBuildPatterns` on an agent id nothing is registered under — a real
 * client-reachable request (a stale bundle, a hand-built POST, a renamed agent
 * whose forward map missed a row: see `registry.server.ts`'s note on exactly
 * that), and the same `pattern build failed` shape the throw path was written
 * for.
 *
 * HERMETIC ONLY for the four injected shapes. There is no responsible way to
 * cause those against the real deployment, and faking them there would only be
 * testing the fake. The throw path needs no injection at all, so it runs in
 * both modes.
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
async function observeFailure(
  app: AppHandles,
  sessionId: string,
  message: string,
  opts: { agentId?: string } = {},
) {
  let threw: unknown = null
  let response: string | undefined
  try {
    const result = await app.runTurn(sessionId, message, opts.agentId)
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

/**
 * The throw path. No fake fault: the turn is asked for an agent that does not
 * exist, which is what `getOrBuildPatterns` throws on — so this runs in live
 * mode too, and costs nothing there because it fails before the first LLM call.
 */
describe('a turn that THROWS still tells the client', () => {
  const NO_SUCH_AGENT = 'e2e-no-such-agent'

  it('sends an SSE error frame rather than closing the stream quietly', async () => {
    const sessionId = newSessionId('throw-sse')

    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: NO_SUCH_AGENT,
    })

    // The response is already committed by the time the turn runs, so the
    // failure has to ride inside the stream — a 500 is not available here.
    expect(status).toBe(200)

    const errorFrames = frames.filter((f) => f.event === 'error')
    expect(
      errorFrames.length,
      `the stream closed without an error frame; frames were ` +
        `[${frames.map((f) => f.event).join(', ')}]. A client sees a spinner that never ` +
        'clears — the silent stop this suite exists to forbid.',
    ).toBe(1)
    // Something a UI can render, and it names the cause rather than 'undefined'.
    expect(String(errorFrames[0].data.error)).toContain(NO_SUCH_AGENT)
    expect(errorFrames[0].data.sessionId).toBe(sessionId)

    // And no fabricated success alongside it.
    expect(frames.filter((f) => f.event === 'done')).toEqual([])
  })

  it('leaves the row at error rather than running, then rethrows', async () => {
    const sessionId = newSessionId('throw-action')

    // Through the server action this time: it does not catch, so the promise
    // the chat form awaits rejects and the UI renders the rejection.
    const seen = await observeFailure(app, sessionId, 'How many nodes are in the graph?', {
      agentId: NO_SUCH_AGENT,
    })

    expect(seen.threw, 'the server action resolved on a turn that could not run').not.toBeNull()
    expect(seen.response).toBeUndefined()

    // `runOneTurn` pre-seeds the row as `running` BEFORE the pattern build, so
    // a throw that did not flip it would leave a conversation spinning in the
    // sidebar for good (sf-M2). Nothing else in this file reaches that flip:
    // the four injected shapes never throw, so `runAndSave`'s catch never runs.
    expect(seen.row, 'the pre-seeded row is gone, so there is nothing to flip').not.toBeNull()
    expect(seen.status, 'the row was left spinning at running after the turn threw').not.toBe(
      'running',
    )
    expect(seen.status).toBe('error')
  })
})
