/**
 * Cross-turn data referencing across conversation switches.
 *
 * The whole point of #22 is that a user can switch to another conversation
 * and back, then ask the agent to use data fetched in earlier turns. That
 * requires three things to survive the save→load round-trip:
 *   1. tool_result events are byte-identical (so `extractGraphElements`
 *      restores the graph state).
 *   2. event ids are preserved (so `ref:<id>` expansion in `simpleLoop`'s
 *      `resolveRefs` can still find the referenced data).
 *   3. event ordering and pattern_enter/exit boundaries are preserved (so
 *      `EventView.fromAll().ofType('tool_result')` returns candidates in
 *      the same order `withReferences` saw them originally).
 *
 * These tests don't drive the LLM — they validate the data-flow contract
 * that downstream patterns (withReferences, simpleLoop's prior-turns
 * channel) rely on.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Bypass server-only guard in jsdom test env
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  createContext,
  serializeContext,
  deserializeContext,
  createEventView,
} from '../../../lib/harness-patterns'
import type { ContextEvent } from '../../../lib/harness-patterns'
import {
  saveSession,
  loadSession,
} from '../../../lib/harness-client/session.server'
import { closePool, query } from '../../../lib/db/client.server'

const TEST_USER = `xtest-${Math.random().toString(36).slice(2, 10)}`

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[cross-turn-persistence.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM conversations WHERE user_id = $1', [TEST_USER])
  await closePool()
})

/** Build a context that mimics a finished conversation with a web search,
 *  shaped the way the harness writes it (pattern_enter/exit + tool_call/result). */
function makeConvoWithWebSearch(sessionId: string) {
  const ctx = createContext('Find info on kubernetes online', { intent: 'web_search' }, sessionId)
  const baseTs = Date.now() - 60_000
  const events: ContextEvent[] = [
    {
      id: 'ev-router-enter',
      type: 'pattern_enter',
      ts: baseTs + 1,
      patternId: 'router',
      data: { pattern: 'router' },
    },
    {
      id: 'ev-router-exit',
      type: 'pattern_exit',
      ts: baseTs + 5,
      patternId: 'router',
      data: { status: 'running' },
    },
    {
      id: 'ev-web-enter',
      type: 'pattern_enter',
      ts: baseTs + 10,
      patternId: 'web-search',
      data: { pattern: 'simpleLoop' },
    },
    {
      id: 'ev-search-call',
      type: 'tool_call',
      ts: baseTs + 20,
      patternId: 'web-search',
      data: { callId: 'call-search-1', tool: 'search', args: { query: 'kubernetes overview' } },
    },
    {
      id: 'ev-search-result',
      type: 'tool_result',
      ts: baseTs + 100,
      patternId: 'web-search',
      data: {
        callId: 'call-search-1',
        tool: 'search',
        result: {
          rows: [
            { title: 'Kubernetes Documentation', url: 'https://kubernetes.io/docs', snippet: 'K8s is an open source container orchestrator…' },
            { title: 'CNCF Kubernetes', url: 'https://www.cncf.io/projects/kubernetes', snippet: 'Graduated CNCF project…' },
          ],
        },
        success: true,
      },
    },
    {
      id: 'ev-web-exit',
      type: 'pattern_exit',
      ts: baseTs + 110,
      patternId: 'web-search',
      data: { status: 'running' },
    },
    {
      id: 'ev-synth-msg',
      type: 'assistant_message',
      ts: baseTs + 200,
      patternId: 'response-synth',
      data: { content: 'Kubernetes is an open source container orchestrator. Two top results: …' },
    },
  ]
  ctx.events.push(...events)
  return ctx
}

describe('cross-turn persistence after conversation switch', () => {
  it('tool_result events round-trip byte-identical (event ids, callIds, payloads)', async () => {
    if (!dbAvailable) return
    const sessionId = `xt-${Math.random().toString(36).slice(2, 10)}`
    const ctx = makeConvoWithWebSearch(sessionId)
    const originalEvents = JSON.parse(JSON.stringify(ctx.events))

    await saveSession(sessionId, TEST_USER, 'default', serializeContext(ctx))
    const loaded = await loadSession(sessionId, TEST_USER)
    expect(loaded).not.toBeNull()
    expect(loaded!.agentId).toBe('default')

    const restored = deserializeContext(loaded!.serializedContext)
    // Every event survives identically — this is what `ref:<id>` expansion,
    // graph extraction, and reference selection all rely on.
    expect(restored.events).toEqual(originalEvents)
  })

  it('EventView on a loaded context exposes prior tool_results to withReferences-style queries', async () => {
    if (!dbAvailable) return
    const sessionId = `xt-${Math.random().toString(36).slice(2, 10)}`
    const ctx = makeConvoWithWebSearch(sessionId)
    await saveSession(sessionId, TEST_USER, 'default', serializeContext(ctx))

    const loaded = await loadSession(sessionId, TEST_USER)
    const restored = deserializeContext(loaded!.serializedContext)

    // This is the exact selector withReferences uses to build candidates.
    const view = createEventView(restored)
    const priorResults = view.fromAll().ofType('tool_result').get()

    expect(priorResults).toHaveLength(1)
    expect(priorResults[0].id).toBe('ev-search-result')
    expect(priorResults[0].patternId).toBe('web-search')

    const data = priorResults[0].data as { tool: string; result: { rows: { title: string }[] } }
    expect(data.tool).toBe('search')
    expect(data.result.rows[0].title).toBe('Kubernetes Documentation')
  })

  it('simulated next turn sees prior events when continueSession-style append happens', async () => {
    if (!dbAvailable) return
    // This validates the shape of `runTurn` after switching back to a conversation:
    //   loaded = loadSession(...) → deserializeContext → continueSession(serialized, ...)
    // continueSession internally appends a new user_message to the existing events
    // before running patterns. We mimic that here and verify the LoopController-style
    // EventView still sees the prior tool_result alongside the new user_message.
    if (!dbAvailable) return
    const sessionId = `xt-${Math.random().toString(36).slice(2, 10)}`
    const ctx = makeConvoWithWebSearch(sessionId)
    await saveSession(sessionId, TEST_USER, 'default', serializeContext(ctx))

    // Load + simulate continueSession's append
    const loaded = await loadSession(sessionId, TEST_USER)
    const restored = deserializeContext(loaded!.serializedContext)
    restored.events.push({
      id: 'ev-followup-msg',
      type: 'user_message',
      ts: Date.now(),
      patternId: 'harness',
      data: { content: 'Add this kubernetes info to the graph' },
    })

    const view = createEventView(restored)

    // The new user_message is visible to the router…
    const userMsgs = view.fromAll().ofType('user_message').get()
    expect(userMsgs.map((e) => (e.data as { content: string }).content)).toEqual([
      'Find info on kubernetes online', // initial input from createContext
      'Add this kubernetes info to the graph',
    ])

    // …and the prior tool_result from the previous turn is still attached as a candidate
    // (this is what `withReferences` reads on entry to the neo4j route).
    const priorResults = view.fromAll().ofType('tool_result').get()
    expect(priorResults.map((e) => e.id)).toEqual(['ev-search-result'])
  })

  it('agent mismatch on resume falls through to a fresh start (no cross-agent leak)', async () => {
    if (!dbAvailable) return
    // Stored as default; if a request comes in claiming agentId="code-mode",
    // runTurn ignores the loaded context. We assert the persistence layer
    // surfaces the stored agentId so the dispatch decision is unambiguous.
    const sessionId = `xt-${Math.random().toString(36).slice(2, 10)}`
    const ctx = makeConvoWithWebSearch(sessionId)
    await saveSession(sessionId, TEST_USER, 'default', serializeContext(ctx))
    const loaded = await loadSession(sessionId, TEST_USER)
    expect(loaded!.agentId).toBe('default')
    // runTurn's dispatch: if request.agentId !== loaded.agentId → fresh harness.
    // (Captured here so a future refactor can't silently flip the contract.)
  })

  it('saving twice keeps the same row (no duplicate conversations on resume)', async () => {
    if (!dbAvailable) return
    const sessionId = `xt-${Math.random().toString(36).slice(2, 10)}`
    const ctx = makeConvoWithWebSearch(sessionId)
    await saveSession(sessionId, TEST_USER, 'default', serializeContext(ctx))

    // Simulate a second turn: append a new event and re-save
    ctx.events.push({
      id: 'ev-second-turn',
      type: 'user_message',
      ts: Date.now(),
      patternId: 'harness',
      data: { content: 'and now retrieve it' },
    })
    await saveSession(sessionId, TEST_USER, 'default', serializeContext(ctx))

    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM conversations WHERE id = $1 AND user_id = $2',
      [sessionId, TEST_USER],
    )
    expect(rows[0].count).toBe('1')

    // And the new event is in the loaded blob.
    const loaded = await loadSession(sessionId, TEST_USER)
    const restored = deserializeContext(loaded!.serializedContext)
    expect(restored.events.find((e) => e.id === 'ev-second-turn')).toBeTruthy()
  })
})

describe('status lifting on save (agent-trigger status column)', () => {
  // The harness leaves a *successful* run as ctx.status='running' (runChain
  // never calls setDone). saveSession is only ever called after the harness
  // returns, so a persisted 'running' means "completed" → it must lift to
  // 'done' for the sidebar badge. 'paused'/'error' are explicit and preserved.
  async function savedStatus(sessionId: string, ctxStatus: string): Promise<string | undefined> {
    const ctx = createContext('hi', {}, sessionId)
    ;(ctx as { status: string }).status = ctxStatus
    await saveSession(sessionId, TEST_USER, 'default', serializeContext(ctx))
    return (await loadSession(sessionId, TEST_USER))?.status
  }

  it("lifts a completed run's 'running' status to 'done'", async () => {
    if (!dbAvailable) return
    expect(await savedStatus(`xt-${Math.random().toString(36).slice(2, 10)}`, 'running')).toBe('done')
  })

  it("preserves 'paused' (awaiting approval) and 'error'", async () => {
    if (!dbAvailable) return
    expect(await savedStatus(`xt-${Math.random().toString(36).slice(2, 10)}`, 'paused')).toBe('paused')
    expect(await savedStatus(`xt-${Math.random().toString(36).slice(2, 10)}`, 'error')).toBe('error')
  })

  it("maps an explicit 'done' through unchanged", async () => {
    if (!dbAvailable) return
    expect(await savedStatus(`xt-${Math.random().toString(36).slice(2, 10)}`, 'done')).toBe('done')
  })
})
