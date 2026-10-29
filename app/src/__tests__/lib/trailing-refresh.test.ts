/**
 * Tests for `trailing-refresh` — the bounded poll that delivers a settled
 * turn's trailing pass (post-turn summaries, #784 item 12) to the panel
 * buffers without a reload.
 *
 * The module is framework-free, so these are plain unit tests: fake timers
 * drive the poll, fakes stand in for the registry hooks, and no database is
 * touched (`loadConversation` is injected as `fetch`).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import {
  TRAILING_REFRESH_FIRST_DELAY_MS,
  TRAILING_REFRESH_INTERVAL_MS,
  TRAILING_REFRESH_MAX_ATTEMPTS,
  startTrailingRefresh,
  trailingDelta,
  type TrailingRefreshHooks,
} from '../../lib/trailing-refresh'

const ev = (id: string, type: ContextEvent['type'], data: unknown = {}): ContextEvent => ({
  id,
  type,
  ts: 0,
  patternId: 'p',
  data,
})

afterEach(() => {
  vi.useRealTimers()
})

// ============================================================================
// trailingDelta
// ============================================================================

describe('trailingDelta', () => {
  it('returns the persisted events the buffer lacks, in persisted order', () => {
    const local = [ev('a', 'user_message'), ev('b', 'tool_result')]
    const fetched = [
      ev('a', 'user_message'),
      ev('b', 'tool_result'),
      ev('c', 'model_call'),
      ev('d', 'memory_written'),
    ]
    expect(trailingDelta(local, fetched)?.additions.map((e) => e.id)).toEqual(['c', 'd'])
  })

  it('returns summaries the buffer lacks, keyed by event id', () => {
    const local = [ev('t1', 'tool_result', { result: 'raw' })]
    const fetched = [ev('t1', 'tool_result', { result: 'raw', summary: 'summarised' })]
    expect(trailingDelta(local, fetched)?.summaries).toEqual([
      { eventId: 't1', summary: 'summarised' },
    ])
  })

  it('returns null when the persisted context holds nothing new', () => {
    const local = [
      ev('a', 'user_message'),
      ev('t1', 'tool_result', { result: 'raw', summary: 'summarised' }),
    ]
    expect(trailingDelta(local, [...local])).toBeNull()
  })

  it('skips a summary the buffer already carries', () => {
    const local = [ev('t1', 'tool_result', { result: 'raw', summary: 'already' })]
    const fetched = [ev('t1', 'tool_result', { result: 'raw', summary: 'newer' })]
    expect(trailingDelta(local, fetched)).toBeNull()
  })

  it('ignores a summary field on a non-tool_result event and an empty summary', () => {
    const local = [ev('m1', 'controller_action'), ev('t2', 'tool_result')]
    const fetched = [ev('m1', 'controller_action', { summary: 'not a result' })]
    expect(trailingDelta(local, fetched)?.summaries ?? []).toEqual([])
    expect(trailingDelta(local, [ev('t2', 'tool_result', { summary: '' })])).toBeNull()
  })
})

// ============================================================================
// startTrailingRefresh
// ============================================================================

interface Harness {
  appended: ContextEvent[][]
  mapped: Array<(event: ContextEvent) => ContextEvent>
  buffer: ContextEvent[]
  fetchCalls: number
  hooks: TrailingRefreshHooks
}

const makeHarness = (
  initial: ContextEvent[],
  fetchImpl: () => Promise<ContextEvent[]>,
): Harness => {
  const h: Harness = {
    appended: [],
    mapped: [],
    buffer: [...initial],
    fetchCalls: 0,
    hooks: {
      local: () => h.buffer,
      fetch: async () => {
        h.fetchCalls += 1
        return fetchImpl()
      },
      append: (events) => {
        h.appended.push([...events])
        h.buffer = [...h.buffer, ...events]
      },
      map: (map) => {
        h.mapped.push(map)
        h.buffer = h.buffer.map(map)
      },
    },
  }
  return h
}

describe('startTrailingRefresh', () => {
  it('applies the delta at the first tick and stops polling', async () => {
    vi.useFakeTimers()
    const local = [ev('a', 'user_message'), ev('t1', 'tool_result', { result: 'raw' })]
    // The persisted context holds t1 once, enriched — never a duplicate id.
    const landed = [
      ev('a', 'user_message'),
      ev('t1', 'tool_result', { result: 'raw', summary: 'summarised' }),
      ev('mc1', 'model_call'),
    ]
    const h = makeHarness(local, async () => landed)
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)

    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].map((e) => e.id)).toEqual(['mc1'])
    expect(h.buffer.find((e) => e.id === 't1')?.data).toMatchObject({ summary: 'summarised' })
    // Stopped: advancing further triggers no more fetches.
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS * 5)
    expect(h.fetchCalls).toBe(1)
  })

  it('keeps polling while nothing has landed, then applies the first delta', async () => {
    vi.useFakeTimers()
    const local = [ev('a', 'user_message')]
    let calls = 0
    const h = makeHarness(local, async () => {
      calls += 1
      return calls < 3 ? local : [...local, ev('mc1', 'model_call')]
    })
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)
    expect(h.appended).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS)
    expect(h.appended).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS)
    expect(h.appended).toHaveLength(1)
    expect(h.fetchCalls).toBe(3)
  })

  it('stops at the attempt cap', async () => {
    vi.useFakeTimers()
    const local = [ev('a', 'user_message')]
    const h = makeHarness(local, async () => local) // never lands
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(
      TRAILING_REFRESH_FIRST_DELAY_MS +
        TRAILING_REFRESH_INTERVAL_MS * TRAILING_REFRESH_MAX_ATTEMPTS,
    )
    expect(h.fetchCalls).toBe(TRAILING_REFRESH_MAX_ATTEMPTS)
    expect(h.appended).toHaveLength(0)
  })

  it('stops without polling when the buffer is empty (cleared or pruned)', async () => {
    vi.useFakeTimers()
    const h = makeHarness([], async () => [ev('mc1', 'model_call')])
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)
    expect(h.fetchCalls).toBe(0)
    expect(h.appended).toHaveLength(0)
  })

  // S1 (fix round 1): the clear landing INSIDE the fetch must win — the buffer
  // is non-empty when the tick starts and empty when the fetch resolves, so
  // applying the delta would resurrect exactly what the user cleared. Nothing
  // may be appended or mapped; hydration owns the view from there.
  it('does not apply a delta when the buffer went empty during the fetch', async () => {
    vi.useFakeTimers()
    const h = makeHarness([ev('a', 'user_message')], async () => {
      h.buffer = [] // the user's Clear lands inside the round trip
      return [ev('mc1', 'model_call')]
    })
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)

    expect(h.fetchCalls).toBe(1)
    expect(h.appended).toHaveLength(0)
    expect(h.mapped).toHaveLength(0)
    expect(h.buffer).toHaveLength(0)
    // And it stopped: the cleared view is not polled again. (The anchored delta
    // would be null against an empty buffer anyway — no shared ids, no anchor —
    // so this pin is about not spending another fetch on a dead view.)
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS * 2)
    expect(h.fetchCalls).toBe(1)
  })

  it('stops when the fetch rejects (conversation gone)', async () => {
    vi.useFakeTimers()
    const local = [ev('a', 'user_message')]
    const h = makeHarness(local, async () => {
      throw new Error('Conversation not found')
    })
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS + 1)
    expect(h.fetchCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS * 5)
    expect(h.fetchCalls).toBe(1)
  })

  it('re-checks ids at apply time: an event the stream delivered meanwhile is not duplicated', async () => {
    vi.useFakeTimers()
    // local() returns queued buffers: pre-fetch check, delta computation,
    // then the apply-time re-check — where the stream has already delivered
    // `mc1` itself.
    const before = [ev('a', 'user_message')]
    const during = [ev('a', 'user_message')]
    const afterStream = [ev('a', 'user_message'), ev('mc1', 'model_call')]
    const fetched = [...before, ev('mc1', 'model_call'), ev('mc2', 'model_call')]
    // Scripted by WHEN, not by absolute call count: before the fetch resolves
    // the buffer is `before`; the first read after it (the delta) still misses
    // mc1, and applyDelta's re-check sees the stream's copy already in. The
    // number of reads before those two is an implementation detail.
    let fetchedReturned = false
    let postFetchReads = 0
    const h = makeHarness(before, async () => {
      fetchedReturned = true
      return fetched
    })
    h.hooks.local = () => {
      if (!fetchedReturned) return before
      postFetchReads += 1
      return postFetchReads === 1 ? during : afterStream
    }
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)

    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].map((e) => e.id)).toEqual(['mc2'])
  })

  // B1 (fix round 1): the first delta must be the settled turn's trailing
  // pass, not "whatever the buffer lacks". Probe: the user cleared the panel
  // and sent another message, so the buffer holds only [u2, r2] while the
  // persisted context holds the whole earlier history too. The unanchored
  // delta re-added u1/r1 AFTER the current turn's events and stopped, and the
  // pass never showed. The anchored delta refuses that fetch, keeps polling,
  // and delivers exactly what followed this turn.
  it('does not mistake pre-turn history for the pass (clear-then-send)', async () => {
    vi.useFakeTimers()
    const local = [ev('u2', 'user_message'), ev('r2', 'tool_result', { result: 'raw' })]
    const history = [ev('u1', 'user_message'), ev('r1', 'tool_result'), ...local]
    let calls = 0
    const h = makeHarness(local, async () => {
      calls += 1
      if (calls === 1) return history
      return [
        ev('u1', 'user_message'),
        ev('r1', 'tool_result'),
        ev('u2', 'user_message'),
        ev('r2', 'tool_result', { result: 'raw', summary: 'summarised' }),
        ev('mc', 'model_call'),
      ]
    })
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)
    // The anchored delta on the first fetch is null: history is never re-added,
    // and the poll is still running.
    expect(h.appended).toHaveLength(0)
    expect(h.fetchCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS)

    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].map((e) => e.id)).toEqual(['mc'])
    // Order preserved: the pass follows the current turn's own events.
    expect(h.buffer.map((e) => e.id)).toEqual(['u2', 'r2', 'mc'])
    expect(h.buffer.find((e) => e.id === 'r2')?.data).toMatchObject({ summary: 'summarised' })
    expect(h.fetchCalls).toBe(2)
  })

  // Resume shape: core persists a `hitl_response` (with the earlier history)
  // without emitting it live (`harness.server.ts` `recordAnswers`), so on a
  // `resume` turn it sits BEFORE the anchor. It must not end the poll either.
  it('does not stop on a persisted hitl_response the buffer never held (resume)', async () => {
    vi.useFakeTimers()
    const local = [ev('u2', 'user_message'), ev('r2', 'tool_result', { result: 'raw' })]
    const before = [ev('u1', 'user_message'), ev('hr', 'hitl_response'), ...local]
    let calls = 0
    const h = makeHarness(local, async () => {
      calls += 1
      return calls === 1 ? before : [...before, ev('mc', 'model_call')]
    })
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(
      TRAILING_REFRESH_FIRST_DELAY_MS + TRAILING_REFRESH_INTERVAL_MS,
    )

    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].map((e) => e.id)).toEqual(['mc'])
    expect(h.buffer.map((e) => e.id)).toEqual(['u2', 'r2', 'mc'])
  })

  // B1 residual (fix round 2): the anchor covers additions, but a summary on
  // an EARLIER turn's tool_result still reached the poll. The buffer holds a
  // prior turn's result without its summary — an errored turn's pass still
  // runs, a stopped turn, a pass that outlasted the cap, a reload before it
  // landed — while the persisted row already has it. The summaries-only delta
  // was applied (right) but also ENDED the poll, so this turn's pass never
  // landed. Now only an anchored addition stops it. Mutation: stop on any
  // delta (drop the `delta.additions.length > 0` gate) — this goes red.
  it('does not end the poll on a stale summary from an earlier turn (B1 residual)', async () => {
    vi.useFakeTimers()
    const local = [
      ev('u1', 'user_message'),
      ev('r1', 'tool_result'),
      ev('u2', 'user_message'),
      ev('r2', 'tool_result', { result: 'raw' }),
    ]
    const turn1 = [
      ev('u1', 'user_message'),
      ev('r1', 'tool_result', { result: 'raw', summary: 's1' }),
      ev('mc1', 'model_call'),
    ]
    const turn2 = [
      ev('u2', 'user_message'),
      ev('r2', 'tool_result', { result: 'raw', summary: 's2' }),
      ev('mc2', 'model_call'),
    ]
    let calls = 0
    const h = makeHarness(local, async () => {
      calls += 1
      return calls === 1 ? [...turn1, ...local.slice(2)] : [...turn1, ...turn2]
    })
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)
    // Fetch 1 is a summaries-only delta relative to the anchor: r1's summary
    // rides an event BEFORE r2 (the anchor), so mc1 is not an addition. The
    // summary is applied — but the poll keeps running.
    expect(h.buffer.find((e) => e.id === 'r1')?.data).toMatchObject({ summary: 's1' })
    expect(h.fetchCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS)

    // This turn's pass: r2 summarised and mc2 appended, then it stops.
    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].map((e) => e.id)).toEqual(['mc2'])
    expect(h.buffer.map((e) => e.id)).toEqual(['u1', 'r1', 'u2', 'r2', 'mc2'])
    expect(h.buffer.find((e) => e.id === 'r2')?.data).toMatchObject({ summary: 's2' })
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS * 5)
    expect(h.fetchCalls).toBe(2)
  })

  // Fix round 2 (resume pin): the real resume shape INTERLEAVES — the buffer
  // holds the paused turn's events and the resume's own, and core's
  // `hitl_response` sits BETWEEN them in the persisted context. The round-1
  // pin had `hr` before every buffered event, so anchoring on the FIRST shared
  // id instead of the last stayed green there; here that mutation re-adds `hr`
  // and ends the poll on it. Mutation: first-shared anchor — this goes red.
  it('does not stop on an interleaved hitl_response the buffer never held (resume)', async () => {
    vi.useFakeTimers()
    const local = [
      ev('u1', 'user_message'),
      ev('r1', 'tool_result'),
      ev('r2', 'tool_result', { result: 'raw' }),
    ]
    const before = [
      ev('u1', 'user_message'),
      ev('r1', 'tool_result'),
      ev('hr', 'hitl_response'),
      ev('r2', 'tool_result', { result: 'raw' }),
    ]
    let calls = 0
    const h = makeHarness(local, async () => {
      calls += 1
      return calls === 1 ? before : [...before, ev('mc', 'model_call')]
    })
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)
    // `hr` sits before the anchor (r2): it is never re-added, and the poll
    // keeps running for the resume turn's own pass.
    expect(h.appended).toHaveLength(0)
    expect(h.fetchCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_INTERVAL_MS)

    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].map((e) => e.id)).toEqual(['mc'])
    expect(h.buffer.map((e) => e.id)).toEqual(['u1', 'r1', 'r2', 'mc'])
  })
  it('writes a summary without clobbering the event data the user set', async () => {
    vi.useFakeTimers()
    const local = [ev('t1', 'tool_result', { result: 'raw', hidden: true })]
    const landed = [ev('t1', 'tool_result', { result: 'raw', hidden: true, summary: 'summarised' })]
    const h = makeHarness(local, async () => landed)
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)

    expect(h.mapped).toHaveLength(1)
    const written = h.buffer.find((e) => e.id === 't1')
    expect(written?.data).toEqual({ result: 'raw', hidden: true, summary: 'summarised' })
  })
})
