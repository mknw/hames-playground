/**
 * Scenario 1 — a fresh conversation completes, on each tier.
 *
 * The baseline this whole suite exists for: a user opens a new chat, sends one
 * message, and gets an answer back. Run once per inference tier, through both
 * of the two real entry points a message can take:
 *
 *   - `processMessageWithAgent` — the server action the chat form calls;
 *   - `POST /api/events` — the SSE route the streaming UI calls.
 *
 * WHAT IT PINS THAT A UNIT TEST DOES NOT. Every layer is the real one:
 * `runTurnAndPersist` resolves the tier from the stored preference, opens the
 * three AsyncLocalStorage scopes, builds the search agent's patterns against a
 * live tool catalog, runs router → route → simpleLoop → compactExecution, and
 * writes the whole event stream to Postgres. The only substitutions are the
 * inference endpoint and the MCP gateway. A client swap that breaks any of
 * that shows up here as a failed turn, which is the gap the preview found the
 * hard way (#263: `ActorController` 400ing on every retry, invisible until a
 * critic first rejected something).
 *
 * The tier assertions are made on the `model` field the fake recorded, not on
 * the preference that was set — the preference is the input, and a routing test
 * that reads its own input proves nothing.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { FAKE_ANSWER_MARK } from '../lib/fake-llm'
import { FAKE_ANTHROPIC_TIER_MODEL, VERDA_MODEL, IS_HERMETIC, TIERS } from '../lib/mode'

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

// `TIERS` is both tiers hermetically and the self-hosted one alone in live
// mode — running the anthropic leg against the real provider would bill a
// metered API for a route the live run is not there to measure (`mode.ts`).
describe.each(TIERS)('a fresh conversation on the %s tier', (tier) => {
  it('completes through the server action and persists a sane row', async () => {
    await app.setTier(tier)
    const sessionId = newSessionId(`fresh-${tier}`)

    const result = await app.runTurn(sessionId, 'How many nodes are in the graph?')

    // 1. The user got an answer.
    expect(result.response, 'the turn produced no response').toBeTruthy()
    if (IS_HERMETIC) expect(result.response).toContain(FAKE_ANSWER_MARK)

    // 2. It is in the context as an assistant message, which is what the UI
    //    replays on reload — a response that never became an event is a
    //    conversation that looks empty the moment the page refreshes.
    const row = await app.readRow(sessionId)
    expect(row, 'no conversation row was persisted').not.toBeNull()
    const assistant = eventsOfType(row!.serializedContext, 'assistant_message')
    expect(assistant.length).toBeGreaterThan(0)

    // 3. The row's status is terminal. `extractStatusFromContext` maps the
    //    harness's never-flipped 'running' to 'done'; anything still saying
    //    'running' here is a row that will spin in the sidebar forever.
    expect(row!.status).toBe('done')
    expect(row!.agentId).toBe('search')
    expect(row!.title, 'the first turn should have named the conversation').toBeTruthy()

    // 4. The turn really ran the loop: a tool was called and its result came
    //    back through the gateway.
    expect(app.fakeGateway.toolCalls.length).toBeGreaterThan(0)
    expect(eventsOfType(row!.serializedContext, 'tool_result').length).toBeGreaterThan(0)
  })

  // Hermetic only: the assertion reads the model id the fake recorded, and a
  // live run has no fake on the Anthropic side to record one. Skipped, not
  // silently passed — a test that asserts nothing is worse than a missing one.
  it.runIf(IS_HERMETIC)(
    'routes the switched roles to that tier and leaves the pinned ones alone',
    async () => {
      await app.setTier(tier)
      await app.runTurn(newSessionId(`route-${tier}`), 'How many nodes are in the graph?')

      const byFn = (name: string) => app.fakeLlm.calls.filter((c) => c.fn === name)
      const controller = byFn('LoopController')
      expect(controller.length, 'the loop controller never ran').toBeGreaterThan(0)

      const expected = tier === 'verda' ? VERDA_MODEL : FAKE_ANTHROPIC_TIER_MODEL
      for (const call of controller) expect(call.model).toBe(expected)

      // The router is NOT in `VERDA_CLIENT_BY_ROLE`, so it stays Anthropic in
      // both switch positions. This is the app-level counterpart of
      // `clients-verda.test.ts`: that file pins the map, this pins that a real
      // turn honours it.
      for (const call of byFn('Router')) expect(call.model).toBe(FAKE_ANTHROPIC_TIER_MODEL)
      // Same for the describe tier — the summariser sees raw tool results and
      // deliberately does not move with the switch.
      for (const call of byFn('ResultDescribeBatch')) {
        expect(call.model).toBe(FAKE_ANTHROPIC_TIER_MODEL)
      }
    },
  )

  it('streams the same turn over SSE and closes the stream', async () => {
    await app.setTier(tier)
    const sessionId = newSessionId(`sse-${tier}`)

    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: 'search',
    })

    expect(status).toBe(200)

    // The `done` frame is the one the client waits on; without it the UI shows
    // a spinner until the socket times out.
    const done = frames.find((f) => f.event === 'done')
    expect(done, `no done frame; got ${frames.map((f) => f.event).join(', ')}`).toBeDefined()
    expect(done!.data.response).toBeTruthy()
    expect(done!.data.status).not.toBe('error')

    // Live events reached the client while the turn ran — this is what the
    // graph panel and the progress indicator consume.
    const live = frames.filter((f) => f.event === 'message')
    expect(live.length, 'the stream carried no live events').toBeGreaterThan(0)
    // Every envelope carries the sessionId so a multi-conversation client can
    // route it (#47).
    for (const frame of live) expect(frame.data.sessionId).toBe(sessionId)

    // No error frame, and the row landed.
    expect(frames.filter((f) => f.event === 'error')).toEqual([])
    expect((await app.readRow(sessionId))?.status).toBe('done')
  })
})
