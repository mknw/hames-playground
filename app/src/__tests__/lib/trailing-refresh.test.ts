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
    const landed = [
      ...local,
      ev('mc1', 'model_call'),
      ev('t1', 'tool_result', { result: 'raw', summary: 'summarised' }),
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
    let localCall = 0
    const h = makeHarness(before, async () => fetched)
    // The tick reads the buffer three times before applying (pre-fetch check,
    // post-fetch check, delta) and a fourth time inside applyDelta's re-check.
    h.hooks.local = () => {
      localCall += 1
      return localCall <= 3 ? during : afterStream
    }
    startTrailingRefresh(h.hooks)

    await vi.advanceTimersByTimeAsync(TRAILING_REFRESH_FIRST_DELAY_MS)

    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].map((e) => e.id)).toEqual(['mc2'])
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
