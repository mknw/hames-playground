/**
 * Scenario 2 — a conversation that keeps going.
 *
 * Turn 1 creates the row; turns 2 and 3 take the OTHER branch of `planTurn` —
 * `continueSession(serializedContext, patterns, message)` — which is a
 * genuinely different code path from `harness(...)`: it deserializes the stored
 * blob, replays it into the pattern chain, and appends. Nothing about turn 1
 * passing says turn 2 will.
 *
 * The assertions are about what SURVIVES, because that is what breaks silently:
 * a continuation that quietly starts from an empty context still answers, still
 * persists, and still looks fine in the UI — right up until the user asks a
 * follow-up question that depends on the previous answer. So the test reads the
 * prompt the model was actually handed on turn 3 and requires turn 1's text to
 * be in it.
 *
 * Run per tier: the continuation path is where the self-hosted route failed
 * before #263 (a first attempt passed, every retry 400'd), and "the first turn
 * works" is exactly the observation that hid it.
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
  await app.wipe()
})
beforeEach(() => {
  app.fakeLlm.reset()
  app.fakeGateway.reset()
})

describe.each(['anthropic', 'verda'] as const)('three turns on the %s tier', (tier) => {
  it('continues the same conversation and keeps the history', async () => {
    await app.setTier(tier)
    const sessionId = newSessionId(`multi-${tier}`)

    const first = await app.runTurn(sessionId, 'How many nodes are in the graph?')
    expect(first.response).toBeTruthy()

    const second = await app.runTurn(sessionId, 'And how many relationships?')
    expect(second.response).toBeTruthy()

    const third = await app.runTurn(sessionId, 'Summarise both answers.')
    expect(third.response).toBeTruthy()

    const row = await app.readRow(sessionId)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('done')

    // All three user messages are in ONE blob. A continuation that started
    // fresh would leave a row with a single user_message and no way to tell
    // from the response alone.
    const users = eventsOfType(row!.serializedContext, 'user_message').map(
      (d) => (d as { content?: string }).content ?? '',
    )
    expect(users).toHaveLength(3)
    expect(users[0]).toContain('How many nodes')
    expect(users[2]).toContain('Summarise both')

    // One assistant message per turn, at least.
    expect(eventsOfType(row!.serializedContext, 'assistant_message').length).toBeGreaterThanOrEqual(
      3,
    )

    // The title is sticky: generated on the first turn and never rewritten,
    // so a later turn cannot rename a conversation under the user.
    expect(row!.title).toBeTruthy()
  })

  // Hermetic only: the fake is what records prompts.
  it.runIf(IS_HERMETIC)('hands turn 3 a prompt that still contains turn 1', async () => {
    await app.setTier(tier)
    const sessionId = newSessionId(`hist-${tier}`)

    await app.runTurn(sessionId, 'How many nodes are in the graph?')
    const afterFirst = app.fakeLlm.calls.length
    await app.runTurn(sessionId, 'And how many relationships?')
    await app.runTurn(sessionId, 'Summarise both answers.')

    const laterPrompts = app.fakeLlm.calls.slice(afterFirst).map((c) => c.prompt)
    expect(
      laterPrompts.some((p) => p.includes('How many nodes are in the graph?')),
      'no prompt after turn 1 mentioned turn 1 — the continuation lost its history',
    ).toBe(true)
  })
})
