import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Keep the GPUs running until switched off (#1047) — the server half.
 *
 * `startGpuKeepRunningLoop` is the only driver that acts with no browser
 * attached, so what is pinned here is the decision the spec is about: the
 * Postgres switch ON means the process touches the boxes through the ONE
 * shared wake (and at the wake's own keep-warm cadence, not a new one), and
 * OFF means it stops — every case below is red without the loop existing.
 *
 * The wake itself is real (`ensurePrivateTierAwake`), reached with a stubbed
 * `fetch`, so the assertions are about the request the loop puts on the wire —
 * the same hermetic style as `keep-warm-while-open.test.ts`, whose subject is
 * the browser-driven half of the same cadence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('../../../lib/inference/small-gpu.server', () => ({ resampleSmallBoxGpu: vi.fn() }))

const getGpuState = vi.fn()
vi.mock('../../../lib/db/gpu-state.server', () => ({
  getGpuState: () => getGpuState(),
}))

import {
  startGpuKeepRunningLoop,
  stopGpuKeepRunningLoop,
  gpuKeepTickMs,
  DEFAULT_GPU_KEEP_TICK_MS,
} from '../../../lib/inference/gpu-keep-running.server'
import {
  keepWarmIntervalMs,
  resetLargeWake,
  resetSmallWake,
} from '../../../lib/inference/wake.server'
import {
  resetSmallActivity,
  resetSmallColdStartHistory,
  resetColdStartHistory,
} from '../../../lib/inference/cold-start.server'
import { resetLargeActivity } from '../../../lib/inference/large-activity.server'

const SMALL = 'https://example.invalid/small/health'
const LARGE = 'https://example.invalid/large/v1/chat/completions'

/** The tick interval the loop is armed with in these tests: fast enough to
 *  advance several ticks, slow enough that a single `advanceTimersByTimeAsync`
 *  step is one tick. */
const TICK = 1_000

let fetchMock: ReturnType<typeof vi.fn>
const urls = () => fetchMock.mock.calls.map(([url]) => String(url))
const largePings = () => urls().filter((u) => u === LARGE).length
const smallPings = () => urls().filter((u) => u === SMALL).length

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'))
  stopGpuKeepRunningLoop()
  resetLargeWake()
  resetSmallWake()
  resetLargeActivity()
  resetSmallActivity()
  resetColdStartHistory()
  resetSmallColdStartHistory()
  vi.clearAllMocks()
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-key')
  vi.stubEnv('LARGE_LLM_BASE_URL', 'https://example.invalid/large/v1')
  vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic-large-key')
  for (const name of [
    'LARGE_LLM_SCALEDOWN_SECONDS',
    'SMALL_LLM_SCALEDOWN_SECONDS',
    'LARGE_LLM_ROUTE',
    'GPU_KEEP_TICK_MS',
  ])
    vi.stubEnv(name, undefined)
  getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  stopGpuKeepRunningLoop()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetLargeActivity()
  resetSmallActivity()
})

describe('the tick reads the switch', () => {
  it('sends nothing while the switch is off, and reads the row every tick', async () => {
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(TICK * 5)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getGpuState).toHaveBeenCalledTimes(6) // the boot tick, then five
  })

  it('wakes BOTH boxes through the shared wake once the switch is on', async () => {
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(TICK)
    expect(urls().sort()).toEqual([LARGE, SMALL].sort())
    const large = fetchMock.mock.calls.find(([u]) => u === LARGE)!
    expect((large[1] as RequestInit).method).toBe('POST')
    const small = fetchMock.mock.calls.find(([u]) => u === SMALL)!
    expect((small[1] as RequestInit).method).toBe('GET')
  })

  it('re-reads the row per tick, so a flip to off stops the pings within one tick', async () => {
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(TICK)
    expect(largePings()).toBe(1)

    // Flipped off by another browser/process — this loop must NOTICE.
    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    await vi.advanceTimersByTimeAsync(TICK * 10)
    expect(largePings()).toBe(1)
    expect(smallPings()).toBe(1)
  })

  it('re-uses the wake keep-warm cadence: a tick inside the fraction pings nothing', async () => {
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(TICK) // the waking tick; stamps the clocks
    const afterWake = largePings()

    // Inside the keep-warm fraction: the loop ticks, the wake says "fresh
    // enough" — this is the keep-warm DECISION, driven by the loop.
    await vi.advanceTimersByTimeAsync(TICK * 3)
    expect(largePings()).toBe(afterWake)

    // Past the fraction: the box is due a touch, and the next tick sends one.
    await vi.advanceTimersByTimeAsync(keepWarmIntervalMs())
    expect(largePings()).toBeGreaterThan(afterWake)
  })

  it('is idempotent: arming twice does not double the ticks', async () => {
    startGpuKeepRunningLoop(TICK)
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(TICK * 4)
    expect(getGpuState).toHaveBeenCalledTimes(5)
  })

  it('survives a failing wake: the tick swallows it and the wake keeps retrying', async () => {
    // A tight poll interval so the wake's own retry cadence is visible inside
    // a few fake ticks — the wake POLLS on a transport error (its documented
    // "things a box that is coming up does" case), which is part of what
    // "the loop retries" means here.
    vi.stubEnv('LARGE_LLM_WAKE_POLL_INTERVAL_MS', '1')
    vi.stubEnv('SMALL_LLM_WAKE_POLL_INTERVAL_MS', '1')
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    fetchMock.mockRejectedValue(new Error('box unreachable'))
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(TICK * 3)
    // Neither the loop nor the switch died: attempts kept going out.
    expect(largePings()).toBeGreaterThanOrEqual(3)
    expect(getGpuState.mock.calls.length).toBeGreaterThanOrEqual(4)

    // The box comes back; a later attempt answers, on the still-on switch.
    const failing = largePings()
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await vi.advanceTimersByTimeAsync(TICK)
    expect(largePings()).toBeGreaterThan(failing)
  })
})

describe('gpuKeepTickMs', () => {
  it('defaults to 30s and reads GPU_KEEP_TICK_MS per call', () => {
    expect(gpuKeepTickMs()).toBe(DEFAULT_GPU_KEEP_TICK_MS)
    vi.stubEnv('GPU_KEEP_TICK_MS', '500')
    expect(gpuKeepTickMs()).toBe(500)
  })

  it('refuses a non-positive override with the default', () => {
    vi.stubEnv('GPU_KEEP_TICK_MS', '0')
    expect(gpuKeepTickMs()).toBe(DEFAULT_GPU_KEEP_TICK_MS)
  })
})

describe('the boot hook and the timer it arms', () => {
  // Two pins the CI layer did not hold before review round 2: the loop's
  // ARMING and its unref'd timer were covered only by browser scenario 21,
  // which does not run in CI — removing either kept the unit suite green.

  it('is armed from the server-boot hook, so it runs with no route opened', () => {
    // A source scan, for the reason every middleware pin in this suite gives:
    // importing `src/middleware.ts` for real would arm the routine scheduler,
    // the usage recorder AND this loop in a unit run. Mutation: delete the
    // call from `middleware.ts` and this reddens — the property only the
    // browser layer covered before. The call must be a bare top-level
    // statement: the loop is the one driver that acts with no browser
    // attached, so an arming hidden behind a request would be no arming.
    const middleware = readFileSync(join(__dirname, '../../../middleware.ts'), 'utf8')
    const code = middleware.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).toMatch(
      /^import \{ startGpuKeepRunningLoop \} from '\.\/lib\/inference\/gpu-keep-running\.server'$/m,
    )
    expect(code).toMatch(/^startGpuKeepRunningLoop\(\)$/m)
  })

  it('unrefs the timer so it never holds the process open', () => {
    const unref = vi.fn()
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)
    startGpuKeepRunningLoop(TICK)
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
  })
})
