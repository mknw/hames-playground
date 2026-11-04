/**
 * Keep warm while open (owner, 2026-11-04) — the wake module's half.
 *
 * `ensurePrivateTierAwake({ keepWarm: true })` is the SAME wake a turn runs,
 * with one difference: it skips a box only when this process saw it answer
 * within `KEEP_WARM_FRACTION` of its idle window, not merely within the window.
 * These cases pin that difference, that the turn's own short-circuit did not
 * move, which request each box gets, the cadence's margin and the setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePrivateTierAwake,
  keepWarmIntervalMs,
  KEEP_WARM_MIN_INTERVAL_MS,
  resetLargeWake,
  resetSmallWake,
  warmWhileOpenEnabled,
  warmIdleCapMs,
  DEFAULT_PRIVATE_TIER_WARM_IDLE_MINUTES,
} from '../../../lib/inference/wake.server'
import {
  noteSmallCallCompleted,
  resetSmallActivity,
  resetSmallColdStartHistory,
  resetColdStartHistory,
  runWithColdStartWatch,
  coldStartEstimate,
  smallColdStartEstimate,
} from '../../../lib/inference/cold-start.server'
import {
  noteLargeCallCompleted,
  resetLargeActivity,
} from '../../../lib/inference/large-activity.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('../../../lib/inference/small-gpu.server', () => ({ resampleSmallBoxGpu: vi.fn() }))

const SMALL = 'https://example.invalid/small/health'
const LARGE = 'https://example.invalid/large/v1/chat/completions'
let fetchMock: ReturnType<typeof vi.fn>

const urls = () => fetchMock.mock.calls.map(([url]) => String(url))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
  resetSmallWake()
  resetLargeWake()
  resetSmallActivity()
  resetLargeActivity()
  resetSmallColdStartHistory()
  resetColdStartHistory()
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-key')
  vi.stubEnv('LARGE_LLM_BASE_URL', 'https://example.invalid/large/v1')
  vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic-large-key')
  for (const name of [
    'LARGE_LLM_SCALEDOWN_SECONDS',
    'SMALL_LLM_SCALEDOWN_SECONDS',
    'LARGE_LLM_ROUTE',
    'PRIVATE_TIER_WARM_WHILE_OPEN',
    'PRIVATE_TIER_WARM_IDLE_MINUTES',
  ])
    vi.stubEnv(name, undefined)
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetSmallActivity()
  resetLargeActivity()
})

/** Both boxes answered `agoMs` ago. */
function answered(agoMs: number): void {
  noteLargeCallCompleted(Date.now() - agoMs)
  noteSmallCallCompleted(Date.now() - agoMs)
}

describe('ensurePrivateTierAwake({ keepWarm: true })', () => {
  it('touches nothing when both boxes answered inside the keep-warm fraction', async () => {
    answered(keepWarmIntervalMs() - 1)
    await ensurePrivateTierAwake({ keepWarm: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('touches each box with its cheapest wake once the fraction has passed, though still warm', async () => {
    // 101s into a 300s window: proven warm, so a TURN would skip both boxes,
    // and 199s from scaling down, so keep-warm must not.
    answered(keepWarmIntervalMs() + 1_000)
    await ensurePrivateTierAwake({ keepWarm: true })

    expect(urls().sort()).toEqual([LARGE, SMALL].sort())
    const small = fetchMock.mock.calls.find(([u]) => u === SMALL)!
    expect((small[1] as RequestInit).method).toBe('GET')
    const large = fetchMock.mock.calls.find(([u]) => u === LARGE)!
    const body = JSON.parse(String((large[1] as RequestInit).body))
    expect((large[1] as RequestInit).method).toBe('POST')
    expect(body.max_tokens).toBe(1)
  })

  it('leaves the turn wake unchanged: a proven-warm box is skipped without keepWarm', async () => {
    answered(keepWarmIntervalMs() + 1_000)
    await ensurePrivateTierAwake()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('wakes cold boxes on load, like the button', async () => {
    await ensurePrivateTierAwake({ keepWarm: true })
    expect(
      urls()
        .filter((u) => u === LARGE || u === SMALL)
        .sort(),
    ).toEqual([LARGE, SMALL].sort())
  })

  it('stamps the warm clock, so the next keep-warm inside the fraction is free', async () => {
    await ensurePrivateTierAwake({ keepWarm: true })
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(keepWarmIntervalMs() - 1_000)
    await ensurePrivateTierAwake({ keepWarm: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('JOINS a turn wake already in flight rather than sending its own', async () => {
    const releases: (() => void)[] = []
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          if (url !== LARGE && url !== SMALL) return resolve(new Response('{}'))
          releases.push(() => resolve(new Response('{}', { status: 200 })))
        }),
    )
    const turn = ensurePrivateTierAwake()
    const open = ensurePrivateTierAwake({ keepWarm: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(urls().filter((u) => u === LARGE || u === SMALL)).toHaveLength(2)
    releases.forEach((r) => r())
    await Promise.all([turn, open])
    expect(urls().filter((u) => u === LARGE || u === SMALL)).toHaveLength(2)
  })

  it('resolves whether it reached a box: false when keep-warm skipped both, true otherwise', async () => {
    answered(1_000)
    expect(await ensurePrivateTierAwake({ keepWarm: true })).toBe(false)
    answered(keepWarmIntervalMs() + 1_000)
    expect(await ensurePrivateTierAwake({ keepWarm: true })).toBe(true)
  })

  it('a turn that JOINS a poll keep-warm started records no cold-start reading', async () => {
    // Both boxes provably went cold, so a turn that STARTED this wake would
    // record its 15s wait. One that joins keep-warm's poll waited a fragment of
    // it, and keep-warm itself records nothing: the history must not move. With
    // keep-warm on by default, this is why a cold start is rarely learned.
    answered(3_600_000)
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response('{}', { status: 200 })), 15_000),
        ),
    )
    const open = ensurePrivateTierAwake({ keepWarm: true })
    const turn = runWithColdStartWatch(
      () => {},
      () => ensurePrivateTierAwake(),
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await Promise.all([open, turn])
    expect(urls().filter((u) => u === LARGE || u === SMALL)).toHaveLength(2)
    expect([coldStartEstimate().samples, smallColdStartEstimate().samples]).toEqual([0, 0])
  })

  it('does not keep a 27B on OpenRouter warm — it is not our box', async () => {
    vi.stubEnv('LARGE_LLM_ROUTE', 'openrouter')
    await ensurePrivateTierAwake({ keepWarm: true })
    expect(urls()).not.toContain(LARGE)
    expect(urls()).toContain(SMALL)
  })
})

describe('keepWarmIntervalMs', () => {
  it('is a third of the shipped 300s windows', () => {
    expect(keepWarmIntervalMs()).toBe(100_000)
  })

  it('leaves margin: the worst-case gap between touches is inside each window', () => {
    // A check landing just inside the fraction defers the touch by one more
    // interval, so the gap is at most two intervals plus a request.
    for (const [large, small] of [
      ['300', '300'],
      ['600', '300'],
      ['300', '1800'],
      ['90', '90'],
    ]) {
      vi.stubEnv('LARGE_LLM_SCALEDOWN_SECONDS', large)
      vi.stubEnv('SMALL_LLM_SCALEDOWN_SECONDS', small)
      const window = Math.min(Number(large), Number(small)) * 1000
      expect(2 * keepWarmIntervalMs()).toBeLessThanOrEqual(window - window / 4)
    }
  })

  it('follows the SHORTER of the two windows', () => {
    vi.stubEnv('LARGE_LLM_SCALEDOWN_SECONDS', '1800')
    vi.stubEnv('SMALL_LLM_SCALEDOWN_SECONDS', '90')
    expect(keepWarmIntervalMs()).toBe(30_000)
  })

  it('ignores the 27B window when the 27B is on OpenRouter', () => {
    vi.stubEnv('LARGE_LLM_ROUTE', 'openrouter')
    vi.stubEnv('LARGE_LLM_SCALEDOWN_SECONDS', '30')
    vi.stubEnv('SMALL_LLM_SCALEDOWN_SECONDS', '600')
    expect(keepWarmIntervalMs()).toBe(200_000)
  })

  it('has a floor, so a tiny window cannot turn an open tab into a request loop', () => {
    vi.stubEnv('LARGE_LLM_SCALEDOWN_SECONDS', '1')
    vi.stubEnv('SMALL_LLM_SCALEDOWN_SECONDS', '1')
    expect(keepWarmIntervalMs()).toBe(KEEP_WARM_MIN_INTERVAL_MS)
  })
})

describe('PRIVATE_TIER_WARM_WHILE_OPEN', () => {
  it('defaults ON (owner release decision, 2026-11-04)', () => {
    expect(warmWhileOpenEnabled()).toBe(true)
  })

  it.each([
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['true', true],
  ])('reads %j as %s', (raw, expected) => {
    vi.stubEnv('PRIVATE_TIER_WARM_WHILE_OPEN', raw)
    expect(warmWhileOpenEnabled()).toBe(expected)
  })

  it('warns on an unreadable value and keeps the default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('PRIVATE_TIER_WARM_WHILE_OPEN', 'sometimes')
    expect(warmWhileOpenEnabled()).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PRIVATE_TIER_WARM_WHILE_OPEN'))
  })
})

describe('PRIVATE_TIER_WARM_IDLE_MINUTES', () => {
  it('defaults to 30 minutes (FRONT, 2026-11-04)', () => {
    expect(DEFAULT_PRIVATE_TIER_WARM_IDLE_MINUTES).toBe(30)
    expect(warmIdleCapMs()).toBe(30 * 60_000)
  })

  it('reads a positive number of minutes', () => {
    vi.stubEnv('PRIVATE_TIER_WARM_IDLE_MINUTES', '2.5')
    expect(warmIdleCapMs()).toBe(150_000)
  })

  it.each(['0', '-5', 'never', 'Infinity'])('warns on %j and keeps the default', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('PRIVATE_TIER_WARM_IDLE_MINUTES', raw)
    expect(warmIdleCapMs()).toBe(30 * 60_000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PRIVATE_TIER_WARM_IDLE_MINUTES'))
  })
})
