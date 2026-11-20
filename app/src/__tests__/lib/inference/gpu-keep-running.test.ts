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
const setGpuState = vi.fn()
vi.mock('../../../lib/db/gpu-state.server', () => ({
  getGpuState: () => getGpuState(),
  setGpuState: (on: boolean) => setGpuState(on),
}))

import {
  startGpuKeepRunningLoop,
  stopGpuKeepRunningLoop,
  gpuKeepTickMs,
  DEFAULT_GPU_KEEP_TICK_MS,
  driveModalSwitch,
  pendingReleaseBoxes,
  releaseBackoffMs,
  resetPendingReleases,
  RELEASE_BACKOFF_BASE_MS,
  RELEASE_BACKOFF_MAX_MS,
  OFF_REASSERT_MS,
} from '../../../lib/inference/gpu-keep-running.server'
import {
  modalBootPendingSince,
  noteModalBootEnded,
  noteModalBootRequested,
  resetModalBootPending,
  resetModalControlCache,
} from '../../../lib/inference/modal-control.server'
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
  resetPendingReleases()
  resetModalBootPending()
  resetModalControlCache()
  vi.clearAllMocks()
  setGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
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

// ============================================================================
// #1057: with the Modal control route configured, the tick drives the
// autoscaler — the shared wake is the fallback
// ============================================================================
//
// The switch's demo promise is "kept running with no browser attached"; with
// the control sidecar reachable, Modal's own autoscaler is what keeps the
// boxes up (min_containers=1), so the tick asserts it and sends NO request to
// either box — a wake ping would be a GPU-second billed for nothing. The
// per-tick assertion also covers the one thing a set-and-forget autoscaler
// cannot: a Modal redeploy resets the override to the app's static value, and
// the next tick is what brings the demo's box back.
describe('#1057: the tick through the Modal control route', () => {
  const MODAL_BASE = 'http://127.0.0.1:8124'
  const autoscalerPosts = () =>
    fetchMock.mock.calls.filter(([u]) => String(u) === `${MODAL_BASE}/autoscaler`)

  beforeEach(() => {
    vi.stubEnv('MODAL_CONTROL_BASE', MODAL_BASE)
    vi.stubEnv('MODAL_CONTROL_TOKEN', 'test-modal-token')
    fetchMock.mockImplementation(((url: unknown) => {
      const u = String(url)
      if (u.startsWith(MODAL_BASE)) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, min_containers: 1 })))
      }
      return Promise.resolve(new Response('{}'))
    }) as never)
  })

  it('asserts min_containers=1 per box and pings NEITHER box', async () => {
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(3 * TICK)

    const posts = autoscalerPosts()
    expect(posts.length).toBeGreaterThanOrEqual(4) // both boxes, several ticks
    const bodies = posts.map(
      ([, init]) =>
        JSON.parse(String((init as RequestInit).body)) as { box: string; min_containers: number },
    )
    expect(bodies.every((b) => b.min_containers === 1)).toBe(true)
    expect(new Set(bodies.map((b) => b.box))).toEqual(new Set(['large', 'small']))
    // THE acceptance: no request to either inference endpoint, at any tick.
    expect(largePings()).toBe(0)
    expect(smallPings()).toBe(0)
  })

  it('asserts only 0 while the switch is off — never a 1, never a ping', async () => {
    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(3 * TICK)
    // The boot tick re-asserts the release once per box (the OFF re-assertion,
    // pinned below); nothing else leaves the process.
    const bodies = autoscalerPosts().map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)) as { min_containers: number },
    )
    expect(bodies.length).toBe(2)
    expect(bodies.every((b) => b.min_containers === 0)).toBe(true)
    expect(urls().filter((u) => !u.startsWith(MODAL_BASE))).toEqual([])
  })

  it('swallows a refused assertion once per cause and keeps the switch on', async () => {
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    fetchMock.mockImplementation(((url: unknown) => {
      const u = String(url)
      if (u.startsWith(MODAL_BASE)) {
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'quota' })))
      }
      return Promise.resolve(new Response('{}'))
    }) as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      startGpuKeepRunningLoop(TICK)
      await vi.advanceTimersByTimeAsync(3 * TICK)
      // One log per cause, not one per tick — the loop runs forever.
      const saids = warn.mock.calls.map(([msg]) => String(msg))
      const failures = saids.filter((msg) => msg.includes('keeping the boxes up'))
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain('quota')
      // And the switch row is untouched by the failure.
      expect(getGpuState).toHaveBeenCalledTimes(4) // one read per tick, nothing else
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a refusing control route OFF the model endpoints — no ping fallback mid-tick', async () => {
    // The tick's autoscaler assertion failing is NOT a reason to start
    // sending keep-warm pings: the boxes are Modal's to hold up, and a ping
    // against a broken control plane would bill GPU seconds for nothing.
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    fetchMock.mockImplementation(((url: unknown) => {
      const u = String(url)
      if (u.startsWith(MODAL_BASE)) {
        return Promise.reject(new Error('the sidecar is gone'))
      }
      return Promise.resolve(new Response('{}'))
    }) as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(2 * TICK)
    expect(largePings()).toBe(0)
    expect(smallPings()).toBe(0)
  })
})

// ============================================================================
// #1057 review round 2: OFF is a promise the loop keeps; ON and OFF never race
// ============================================================================
//
// Round 1 wrote the switch OFF and then asked Modal for `min_containers=0`
// exactly once: a sidecar that was down or slow left the box at 1 (billed)
// under a switch reading OFF, and a tick that had read ON could land its `1`
// AFTER the panel's `0`. Pinned here:
//
//   - an OFF Modal does not CONFIRM (a failure, or an `ok` that does not report
//     0) is retried by the loop with a bounded backoff until it does;
//   - a flip and a tick run under one lock, so a tick that read ON can never
//     land its `1` after the flip's `0`;
//   - a tick that asserted `1` re-reads the switch and takes it back if the
//     switch went OFF meanwhile (the other-instance flip a lock cannot see);
//   - the switch's own boot stamps the boot clock, so a boot Modal never
//     answers is named, not `cold`.
describe('#1057 review: the release is confirmed, retried, and never raced', () => {
  const MODAL_BASE = 'http://127.0.0.1:8124'
  type Posted = { box: string; min_containers: number }
  /** Autoscaler requests in the order they REACHED the sidecar. */
  let posted: Posted[]
  /** What the sidecar answers an autoscaler call with, per request. */
  let answer: (body: Posted) => Response | Promise<Response>

  const bodyOf = (init: unknown): Posted => JSON.parse(String((init as RequestInit).body)) as Posted
  const okAnswer = (body: Posted) =>
    new Response(JSON.stringify({ ok: true, min_containers: body.min_containers }))

  beforeEach(() => {
    vi.stubEnv('MODAL_CONTROL_BASE', MODAL_BASE)
    vi.stubEnv('MODAL_CONTROL_TOKEN', 'test-modal-token')
    posted = []
    answer = okAnswer
    fetchMock.mockImplementation(((url: unknown, init: unknown) => {
      const u = String(url)
      if (u === `${MODAL_BASE}/autoscaler`) {
        const body = bodyOf(init)
        posted.push(body)
        return Promise.resolve(answer(body))
      }
      if (u === `${MODAL_BASE}/state`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              boxes: {
                large: { ok: true, containers: [] },
                small: { ok: true, containers: [] },
              },
            }),
          ),
        )
      }
      return Promise.resolve(new Response('{}'))
    }) as never)
  })

  it('the backoff doubles from 30s and is BOUNDED at 5 min', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(releaseBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ])
    expect(RELEASE_BACKOFF_BASE_MS).toBe(30_000)
    expect(RELEASE_BACKOFF_MAX_MS).toBe(300_000)
  })

  it('an OFF the sidecar refused is retried by the loop until Modal confirms min_containers=0', async () => {
    let up = false
    answer = (body) =>
      up || body.min_containers === 1
        ? okAnswer(body)
        : new Response(JSON.stringify({ ok: false, error: 'sidecar restarting' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const failure = await driveModalSwitch(false, ['large', 'small'])
    expect(failure).toMatchObject({ doing: 'release', reason: 'sidecar restarting' })
    expect(pendingReleaseBoxes().sort()).toEqual(['large', 'small'])
    expect(setGpuState).toHaveBeenCalledWith(false)
    expect(posted).toHaveLength(2)

    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    startGpuKeepRunningLoop(TICK)
    // Before the first backoff elapses (30s): nothing is re-sent.
    await vi.advanceTimersByTimeAsync(20 * TICK)
    expect(posted).toHaveLength(2)
    // The first retry lands at 30s, fails again, and backs off to 60s.
    await vi.advanceTimersByTimeAsync(11 * TICK)
    expect(posted).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(50 * TICK)
    expect(posted).toHaveLength(4) // still inside the 60s backoff
    // Modal comes back: the next retry confirms, and the retrying STOPS.
    up = true
    await vi.advanceTimersByTimeAsync(12 * TICK)
    expect(posted).toHaveLength(6)
    expect(posted.slice(2).every((b) => b.min_containers === 0)).toBe(true)
    expect(pendingReleaseBoxes()).toEqual([])
    await vi.advanceTimersByTimeAsync(200 * TICK)
    expect(posted).toHaveLength(6)
  })

  it('an ok that does not report 0 is not a release', async () => {
    answer = () => new Response(JSON.stringify({ ok: true, min_containers: 1 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = await driveModalSwitch(false, ['small'])
    expect(failure).toMatchObject({ box: 'small', doing: 'release' })
    expect(failure?.reason).toContain('min_containers=1')
    expect(pendingReleaseBoxes()).toEqual(['small'])
  })

  it('a confirmed OFF leaves nothing pending and nothing to retry', async () => {
    const failure = await driveModalSwitch(false, ['large', 'small'])
    expect(failure).toBeNull()
    expect(pendingReleaseBoxes()).toEqual([])
    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(100 * TICK)
    expect(posted).toHaveLength(2) // the flip's own two calls, nothing after
  })

  it('a tick that read ON can never land its 1 AFTER the flip’s 0', async () => {
    // The tick reads ON, and its autoscaler `1` for the first box is held in
    // flight. The panel flips OFF meanwhile. Without the shared lock the flip's
    // `0` reaches the sidecar first and the tick's late `1` is the last word:
    // min_containers=1 under an OFF switch.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let first = true
    answer = (body) => {
      if (body.min_containers === 1 && first) {
        first = false
        return held.then(() => okAnswer(body))
      }
      return okAnswer(body)
    }
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(10) // the boot tick is now inside its first `1`
    expect(posted).toEqual([{ box: 'large', min_containers: 1 }])

    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    const flip = driveModalSwitch(false, ['large', 'small'])
    await vi.advanceTimersByTimeAsync(10)
    // The flip is QUEUED behind the tick's in-flight call: not one `0` has
    // reached the sidecar while the tick's `1` is still open. (The cross-
    // instance re-read below would also take a late `1` back, so the lock is
    // pinned on this ordering, not only on the final state.)
    expect(posted).toEqual([{ box: 'large', min_containers: 1 }])
    release()
    await flip
    await vi.advanceTimersByTimeAsync(5 * TICK)

    const lastPerBox = new Map<string, number>()
    for (const b of posted) lastPerBox.set(b.box, b.min_containers)
    expect([...lastPerBox.entries()].sort()).toEqual([
      ['large', 0],
      ['small', 0],
    ])
  })

  it('a tick whose 1 outlived an OFF on ANOTHER instance takes it back', async () => {
    // Two reads per ON tick: the first says ON, the second (after the `1`s)
    // says OFF — a flip the lock cannot serialise because it ran elsewhere.
    getGpuState
      .mockResolvedValueOnce({ keepRunning: true, switchedOnAt: Date.now() })
      .mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(10)
    expect(posted).toEqual([
      { box: 'large', min_containers: 1 },
      { box: 'small', min_containers: 1 },
      { box: 'large', min_containers: 0 },
      { box: 'small', min_containers: 0 },
    ])
  })

  it('the switch’s own boot starts the boot clock — a boot nothing answers is named, not cold', async () => {
    expect(modalBootPendingSince('large')).toBeNull()
    await driveModalSwitch(true, ['large', 'small'])
    expect(modalBootPendingSince('large')).toBe(Date.now())
    expect(modalBootPendingSince('small')).toBe(Date.now())
    // …and OFF ends it: no stale failure after the owner gave up on the boot.
    await driveModalSwitch(false, ['large', 'small'])
    expect(modalBootPendingSince('large')).toBeNull()
  })

  it('the loop keeps the clock while Modal lists no container, without restarting it', async () => {
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(10)
    const first = modalBootPendingSince('large')
    expect(first).not.toBeNull()
    await vi.advanceTimersByTimeAsync(40 * TICK)
    expect(modalBootPendingSince('large')).toBe(first) // the ORIGINAL ask
  })

  it('an OFF flip does not clear a chat wake’s boot clock, and the wake ending does not clear the switch’s', async () => {
    const t0 = Date.now()
    await driveModalSwitch(true, ['large'])
    noteModalBootRequested('large', t0 + 5_000, 'wake')
    // The wake's poll ends (answered, failed or aborted) while the switch's
    // boot is still unanswered: its clock stands.
    noteModalBootEnded('large', 'wake')
    expect(modalBootPendingSince('large')).toBe(t0)
    // And the other way round: OFF while a turn's wake is still waiting.
    resetModalBootPending()
    noteModalBootRequested('large', t0, 'wake')
    await driveModalSwitch(true, ['large'])
    await driveModalSwitch(false, ['large'])
    expect(modalBootPendingSince('large')).toBe(t0)
  })

  it('an OFF the sidecar confirmed is RE-ASSERTED at the release cap, and Modal’s value is checked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(OFF_REASSERT_MS).toBe(RELEASE_BACKOFF_MAX_MS)
    expect(await driveModalSwitch(false, ['large', 'small'])).toBeNull()
    expect(posted).toHaveLength(2)
    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS - 5 * TICK)
    expect(posted).toHaveLength(2) // not before the cap
    await vi.advanceTimersByTimeAsync(10 * TICK)
    expect(posted.slice(2)).toEqual([
      { box: 'large', min_containers: 0 },
      { box: 'small', min_containers: 0 },
    ])
    await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS)
    expect(posted).toHaveLength(6) // and again one cap later: a steady low rate
    expect(pendingReleaseBoxes()).toEqual([])
    // Modal answering ok but NOT 0 on a re-assertion is an unconfirmed release.
    answer = () => new Response(JSON.stringify({ ok: true, min_containers: 1 }))
    await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS + 2 * TICK)
    expect(pendingReleaseBoxes().sort()).toEqual(['large', 'small'])
  })

  it('a loop that starts under an OFF switch re-asserts 0 at once (a restart forgot the ledger)', async () => {
    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(10)
    expect(posted).toEqual([
      { box: 'large', min_containers: 0 },
      { box: 'small', min_containers: 0 },
    ])
  })

  it('re-asserts the last known OFF during a database outage, including pending releases', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(10) // last successful read is OFF
    expect(posted).toHaveLength(2)
    getGpuState.mockRejectedValue(new Error('database down'))
    // Model an ON from a different instance landing during this outage.
    answer = () => new Response(JSON.stringify({ ok: true, min_containers: 1 }))
    await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS + TICK)
    expect(posted.slice(2)).toEqual([
      { box: 'large', min_containers: 0 },
      { box: 'small', min_containers: 0 },
    ])
    expect(pendingReleaseBoxes().sort()).toEqual(['large', 'small'])
    answer = okAnswer
    await vi.advanceTimersByTimeAsync(RELEASE_BACKOFF_BASE_MS)
    expect(pendingReleaseBoxes()).toEqual([])
    expect(posted).toHaveLength(6)
  })

  describe.each([false, true])(
    '#1070: panel flips before an outage (public large route=%s)',
    (publicLarge) => {
      const boxes = () => (publicLarge ? ['small'] : ['large', 'small']) as ('large' | 'small')[]
      const posts = (min_containers: number) => boxes().map((box) => ({ box, min_containers }))

      beforeEach(() => {
        if (publicLarge) vi.stubEnv('LARGE_LLM_ROUTE', 'openrouter')
        vi.spyOn(console, 'warn').mockImplementation(() => {})
      })

      /** Arm the loop with its boot read either ON (it asserts 1) or failing (unknown). */
      async function armWithLastRead(lastRead: 'ON' | 'unknown'): Promise<void> {
        if (lastRead === 'ON')
          getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
        else getGpuState.mockRejectedValue(new Error('database not up yet'))
        startGpuKeepRunningLoop(TICK)
        await vi.advanceTimersByTimeAsync(0)
        expect(getGpuState).toHaveBeenCalled() // the boot tick ran (an ON tick reads twice)
        expect(posted).toEqual(lastRead === 'ON' ? posts(1) : [])
        posted.length = 0
      }

      // A failed OFF write: a failed write must not record OFF. Mutants that record OFF
      // before (or regardless of) the write send `0` at the first outage tick.
      it.each(['ON', 'unknown'] as const)(
        'a rejected panel OFF write keeps the last read (%s) and sends no release during the outage',
        async (lastRead) => {
          await armWithLastRead(lastRead)
          setGpuState.mockRejectedValueOnce(new Error('write failed'))
          await expect(driveModalSwitch(false, boxes())).rejects.toThrow('write failed')
          expect(setGpuState).toHaveBeenCalledWith(false)
          expect(posted).toEqual([]) // the flip never reached the control route

          getGpuState.mockRejectedValue(new Error('database down'))
          const readsBefore = getGpuState.mock.calls.length
          await vi.advanceTimersByTimeAsync(2 * OFF_REASSERT_MS + TICK)
          // Control: the loop was alive and re-reading every tick of the outage…
          expect(getGpuState.mock.calls.length - readsBefore).toBe((2 * OFF_REASSERT_MS) / TICK + 1)
          // …and sent nothing: neither a guessed 0 nor a new 1, nor a ping.
          expect(posted).toEqual([])
          expect(pendingReleaseBoxes()).toEqual([])
          expect(urls().filter((url) => !url.startsWith(MODAL_BASE))).toEqual([])

          // Recovery: the DB still says ON (the write failed), and the next read acts on it.
          getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
          await vi.advanceTimersByTimeAsync(TICK)
          expect(posted).toEqual(posts(1))
        },
      )

      // A successful OFF is recorded even when the loop has never read the
      // switch. Requiring a prior read would lose its retries in an outage.
      it('a successful panel OFF with the switch never read retries its failed release, then re-asserts, during the outage', async () => {
        await armWithLastRead('unknown')
        answer = () => new Response(JSON.stringify({ ok: false, error: 'control unavailable' }))
        expect(await driveModalSwitch(false, boxes())).toMatchObject({ doing: 'release' })
        expect(posted).toEqual(posts(0))
        expect(pendingReleaseBoxes().sort()).toEqual(boxes().sort())

        answer = okAnswer
        await vi.advanceTimersByTimeAsync(RELEASE_BACKOFF_BASE_MS - TICK)
        expect(posted).toEqual(posts(0)) // the backoff is honoured: not before 30 s
        await vi.advanceTimersByTimeAsync(TICK)
        expect(posted).toEqual([...posts(0), ...posts(0)]) // retried at exactly 30 s
        expect(pendingReleaseBoxes()).toEqual([])

        // The confirmed OFF is then re-asserted at the cap, still with the DB down.
        await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS - TICK)
        expect(posted).toHaveLength(2 * boxes().length)
        await vi.advanceTimersByTimeAsync(TICK)
        expect(posted).toEqual([...posts(0), ...posts(0), ...posts(0)])
        expect(urls().filter((url) => !url.startsWith(MODAL_BASE))).toEqual([])
      })

      it('a confirmed panel OFF with the switch never read is re-asserted at the cap during the outage', async () => {
        await armWithLastRead('unknown')
        expect(await driveModalSwitch(false, boxes())).toBeNull()
        expect(posted).toEqual(posts(0))
        await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS - TICK)
        expect(posted).toEqual(posts(0))
        await vi.advanceTimersByTimeAsync(TICK)
        expect(posted).toEqual([...posts(0), ...posts(0)])
      })

      // Restraint control: a successful ON from unknown sends no `0`
      // and no new `1` during the outage (the record must not over-reach).
      it('a successful panel ON with the switch never read sends nothing more during the outage', async () => {
        await armWithLastRead('unknown')
        expect(await driveModalSwitch(true, boxes())).toBeNull()
        expect(posted).toEqual(posts(1))
        const readsBefore = getGpuState.mock.calls.length
        await vi.advanceTimersByTimeAsync(2 * OFF_REASSERT_MS + TICK)
        expect(getGpuState.mock.calls.length - readsBefore).toBe((2 * OFF_REASSERT_MS) / TICK + 1)
        expect(posted).toEqual(posts(1))
        expect(pendingReleaseBoxes()).toEqual([])
        expect(urls().filter((url) => !url.startsWith(MODAL_BASE))).toEqual([])

        getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
        await vi.advanceTimersByTimeAsync(TICK)
        expect(posted).toEqual([...posts(1), ...posts(0)])
      })

      it('retries a failed panel OFF during an outage after the loop last read ON', async () => {
        getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
        startGpuKeepRunningLoop(TICK)
        await vi.advanceTimersByTimeAsync(0)
        expect(posted).toEqual(posts(1))
        posted.length = 0

        let finish!: (response: Response) => void
        answer = () => new Promise<Response>((resolve) => (finish = resolve))
        const flip = driveModalSwitch(false, boxes())
        await vi.advanceTimersByTimeAsync(0)
        expect(setGpuState).toHaveBeenCalledWith(false)
        getGpuState.mockRejectedValue(new Error('database down immediately after write'))
        // A tick queues behind the flip's held control call, under the same lock.
        const reads = getGpuState.mock.calls.length
        await vi.advanceTimersByTimeAsync(TICK)
        expect(getGpuState).toHaveBeenCalledTimes(reads)
        answer = () => new Response(JSON.stringify({ ok: false, error: 'control unavailable' }))
        finish(new Response(JSON.stringify({ ok: false, error: 'control unavailable' })))
        expect(await flip).toMatchObject({ doing: 'release' })
        expect(pendingReleaseBoxes().sort()).toEqual(boxes().sort())
        expect(posted).toEqual(posts(0))

        answer = okAnswer
        await vi.advanceTimersByTimeAsync(RELEASE_BACKOFF_BASE_MS - TICK)
        expect(posted).toEqual(posts(0)) // retry not due yet
        await vi.advanceTimersByTimeAsync(TICK)
        expect(posted).toEqual([...posts(0), ...posts(0)])
        expect(pendingReleaseBoxes()).toEqual([])
        expect(largePings() + smallPings()).toBe(0)

        // A recovered read is authoritative again, including an external ON.
        getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
        await vi.advanceTimersByTimeAsync(TICK)
        expect(posted.slice(-boxes().length)).toEqual(posts(1))
      })

      it('never reasserts stale OFF after a successful panel ON and an immediate outage', async () => {
        startGpuKeepRunningLoop(TICK)
        await vi.advanceTimersByTimeAsync(0)
        expect(posted).toEqual(posts(0)) // the PRE-flip state is definitely cached
        posted.length = 0

        let finishWrite!: () => void
        setGpuState.mockImplementationOnce(
          () => new Promise<void>((resolve) => (finishWrite = resolve)),
        )
        const flip = driveModalSwitch(true, boxes())
        await vi.advanceTimersByTimeAsync(0)
        expect(posted).toEqual([])
        getGpuState.mockRejectedValue(new Error('database down immediately after write'))
        finishWrite()
        expect(await flip).toBeNull()
        expect(posted).toEqual(posts(1))
        await vi.advanceTimersByTimeAsync(2 * OFF_REASSERT_MS + TICK)
        expect(posted).toEqual(posts(1)) // neither stale 0 nor new 1 during outage
        expect(largePings() + smallPings()).toBe(0)

        getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
        await vi.advanceTimersByTimeAsync(TICK)
        expect(posted.slice(boxes().length)).toEqual(posts(0))
      })
    },
  )

  it('a rejected panel write preserves the last observed OFF during an outage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(0)
    setGpuState.mockRejectedValueOnce(new Error('write failed'))
    await expect(driveModalSwitch(true, ['large', 'small'])).rejects.toThrow('write failed')
    getGpuState.mockRejectedValue(new Error('database down'))
    await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS)
    expect(posted).toEqual([
      { box: 'large', min_containers: 0 },
      { box: 'small', min_containers: 0 },
      { box: 'large', min_containers: 0 },
      { box: 'small', min_containers: 0 },
    ])
  })

  it('does not guess OFF when the database has never answered or was last ON', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getGpuState.mockRejectedValue(new Error('database down'))
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(TICK)
    expect(posted).toEqual([])
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt: Date.now() })
    await vi.advanceTimersByTimeAsync(TICK)
    expect(posted.map((p) => p.min_containers)).toEqual([1, 1])
    getGpuState.mockRejectedValue(new Error('database down'))
    await vi.advanceTimersByTimeAsync(OFF_REASSERT_MS + TICK)
    expect(posted.map((p) => p.min_containers)).toEqual([1, 1])
  })
})

describe('#1060 round 2: an ON request the app abandoned (timeout) still lands at Modal after a confirmed OFF', () => {
  const MODAL_BASE = 'http://127.0.0.1:8124'
  it('the loop leaves min_containers=0 under an OFF switch', async () => {
    vi.stubEnv('MODAL_CONTROL_BASE', MODAL_BASE)
    vi.stubEnv('MODAL_CONTROL_TOKEN', 'test-modal-token')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Modal's real autoscaler value per box, as the sidecar's SDK calls set it.
    const modalMin: Record<string, number> = { large: 0, small: 0 }
    let slowFirstOn = true
    fetchMock.mockImplementation(((url: unknown, init: RequestInit) => {
      const u = String(url)
      if (u === `${MODAL_BASE}/autoscaler`) {
        const body = JSON.parse(String(init.body)) as { box: string; min_containers: number }
        if (body.min_containers === 1 && body.box === 'large' && slowFirstOn) {
          slowFirstOn = false
          // The sidecar thread is inside update_autoscaler (gRPC retries); it applies the
          // value 40 s later whatever the client does. The app aborts at 15 s.
          setTimeout(() => {
            modalMin[body.box] = 1
          }, 40_000)
          return new Promise((_res, rej) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('aborted')
              e.name = 'AbortError'
              rej(e)
            })
          })
        }
        modalMin[body.box] = body.min_containers
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, min_containers: body.min_containers })),
        )
      }
      if (u === `${MODAL_BASE}/state`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              boxes: { large: { ok: true, containers: [] }, small: { ok: true, containers: [] } },
            }),
          ),
        )
      }
      return Promise.resolve(new Response('{}'))
    }) as never)

    // Admin flips ON; the large box's 1 times out at the app (panel shows the error).
    const on = driveModalSwitch(true, ['large', 'small'])
    await vi.advanceTimersByTimeAsync(16_000)
    const onFailure = await on
    expect(onFailure).toMatchObject({ box: 'large', doing: 'boot' })
    // Admin flips OFF: both 0s are confirmed at once.
    getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
    const off = await driveModalSwitch(false, ['large', 'small'])
    expect(off).toBeNull()
    expect(pendingReleaseBoxes()).toEqual([])
    // The loop runs for 10 minutes with the switch OFF.
    startGpuKeepRunningLoop(TICK)
    await vi.advanceTimersByTimeAsync(600 * TICK)
    // Modal: the abandoned 1 landed after the confirmed 0, and nothing re-asserted 0.
    expect(modalMin).toEqual({ large: 0, small: 0 })
  })
})
