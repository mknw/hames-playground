import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePrivateTierAwake,
  ensureSmallAwake,
  resetSmallWake,
  resetVerdaWake,
  SMALL_LLM_WAKE_FAILED,
  NO_FALLBACK,
  DEFAULT_SMALL_LLM_WAKE_TIMEOUT_MS,
  DEFAULT_SMALL_LLM_WAKE_ATTEMPT_TIMEOUT_MS,
  DEFAULT_SMALL_LLM_WAKE_POLL_INTERVAL_MS,
} from '../../../lib/inference/wake.server'
import {
  noteSmallCallCompleted,
  smallProvenWarm,
  smallScaledownSeconds,
  resetSmallActivity,
  resetSmallColdStartHistory,
  resetColdStartHistory,
  runWithColdStartWatch,
  smallColdStartEstimate,
  coldStartEstimate,
  noteBoxCallStarting,
  settleBoxColdStart,
  noteColdStartMeasured,
  SMALL_COLD_START_FALLBACK_MS,
  SMALL_COLD_START_PLAUSIBILITY_FLOOR_MS,
  type ColdStartEstimate,
} from '../../../lib/inference/cold-start.server'
import {
  noteVerdaCallCompleted,
  resetVerdaActivity,
} from '../../../lib/inference/verda-activity.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const SMALL = 'https://example.invalid/small/health'
const LARGE = 'https://example.invalid/large/v1/chat/completions'
const ok = () => new Response('{}', { status: 200 })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  resetSmallWake()
  resetVerdaWake()
  resetSmallActivity()
  resetVerdaActivity()
  resetSmallColdStartHistory()
  resetColdStartHistory()
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-key')
  vi.stubEnv('VERDA_INFERENCE_ENDPOINT', 'https://example.invalid/large/v1')
  vi.stubEnv('VERDA_INFERENCE_API_KEY', 'synthetic-large-key')
  for (const name of [
    'SMALL_LLM_WAKE_TIMEOUT_MS',
    'SMALL_LLM_WAKE_ATTEMPT_TIMEOUT_MS',
    'SMALL_LLM_WAKE_POLL_INTERVAL_MS',
    'SMALL_LLM_SCALEDOWN_SECONDS',
  ])
    vi.stubEnv(name, undefined)
  fetchMock = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetSmallActivity()
  resetSmallColdStartHistory()
  resetVerdaActivity()
  resetColdStartHistory()
})

function stalled(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal!.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}
function quiet(p: Promise<void>): Promise<unknown> {
  return p.catch((error) => error)
}

describe('small box wake', () => {
  it('polls root health with its own token every 5s until 200', async () => {
    vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1/')
    fetchMock.mockResolvedValueOnce(new Response('starting', { status: 503 }))
    const wake = ensureSmallAwake()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(smallProvenWarm()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await wake
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(SMALL)
      expect(init).toMatchObject({
        method: 'GET',
        headers: { Authorization: 'Bearer synthetic-key' },
      })
      expect(init.body).toBeUndefined()
    }
    expect(smallProvenWarm()).toBe(true)
  })

  it('omits authorization when no optional small key is configured', async () => {
    vi.stubEnv('SMALL_LLM_API_KEY', undefined)
    await ensureSmallAwake()
    expect(fetchMock.mock.calls[0][1].headers).toEqual({})
  })

  it('uses independent bounds sized for health and the measured first boot', async () => {
    expect([
      DEFAULT_SMALL_LLM_WAKE_TIMEOUT_MS,
      DEFAULT_SMALL_LLM_WAKE_ATTEMPT_TIMEOUT_MS,
      DEFAULT_SMALL_LLM_WAKE_POLL_INTERVAL_MS,
      smallScaledownSeconds(),
      SMALL_COLD_START_FALLBACK_MS,
      SMALL_COLD_START_PLAUSIBILITY_FLOOR_MS,
    ]).toEqual([720_000, 10_000, 5_000, 300, 30_000, 10_000])
    vi.stubEnv('SMALL_LLM_WAKE_TIMEOUT_MS', '12000')
    vi.stubEnv('SMALL_LLM_WAKE_ATTEMPT_TIMEOUT_MS', '3000')
    vi.stubEnv('SMALL_LLM_WAKE_POLL_INTERVAL_MS', '1000')
    fetchMock.mockImplementation(stalled)
    const wake = quiet(ensureSmallAwake())
    await vi.advanceTimersByTimeAsync(12_000)
    expect(String(await wake)).toContain('3 attempts over 12s')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([undefined, '60'])(
    'skips a proven warm box until its scale-down window expires (override=%s)',
    async (override) => {
      vi.stubEnv('SMALL_LLM_SCALEDOWN_SECONDS', override)
      const windowMs = (override === undefined ? 300 : 60) * 1000
      noteSmallCallCompleted()
      await vi.advanceTimersByTimeAsync(windowMs - 1)
      await ensureSmallAwake()
      expect(fetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await ensureSmallAwake()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('waits for both boxes in parallel and concurrent turns share each poll', async () => {
    const started = Date.now()
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(ok()), url === SMALL ? 8_000 : 6_000)
        }),
    )
    let finished = false
    const turns = Promise.all([ensurePrivateTierAwake(), ensurePrivateTierAwake()]).then(() => {
      finished = true
    })
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([LARGE, SMALL].sort())
    await vi.advanceTimersByTimeAsync(7_999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await turns
    expect(Date.now() - started).toBe(8_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await ensurePrivateTierAwake()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401])(
    'refuses small HTTP %s immediately, cancels an unshared sibling and records nothing',
    async (status) => {
      noteSmallCallCompleted(Date.now() - 400_000)
      const notices: ColdStartEstimate[] = []
      fetchMock.mockImplementation((url: string, init: RequestInit) =>
        url === SMALL ? Promise.resolve(new Response('refused', { status })) : stalled(url, init),
      )
      const error = await runWithColdStartWatch(
        (e) => notices.push(e),
        () => quiet(ensurePrivateTierAwake()),
      )
      expect(String(error)).toContain(SMALL_LLM_WAKE_FAILED)
      expect(String(error)).toContain(`HTTP ${status}`)
      expect(String(error)).toContain(NO_FALLBACK)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls.find(([url]) => url === LARGE)![1].signal.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      expect(smallColdStartEstimate().basis).toBe('default')
      expect(smallProvenWarm()).toBe(false)
      expect(notices).toHaveLength(1)
    },
  )

  it('names a failed 27B and cancels a small poll sleeping between attempts', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === SMALL
        ? new Response('starting', { status: 503 })
        : new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response('bad key', { status: 401 })), 100),
          ),
    )
    const wake = quiet(ensurePrivateTierAwake())
    await vi.advanceTimersByTimeAsync(100)
    expect(String(await wake)).toContain('VERDA_INFERENCE_ENDPOINT')
    expect(String(await wake)).toContain('27B')
    expect(String(await wake)).toContain(NO_FALLBACK)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a failed turn cannot cancel a sibling poll another caller still needs', async () => {
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === SMALL
        ? stalled(url, init)
        : Promise.resolve(new Response('bad key', { status: 401 })),
    )
    const subscriber = new AbortController()
    const separate = quiet(ensureSmallAwake(Date.now(), subscriber.signal))
    expect(String(await quiet(ensurePrivateTierAwake()))).toContain('27B')
    const signal = fetchMock.mock.calls[0][1].signal
    expect(signal.aborted).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    subscriber.abort()
    await separate
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records total small wait only for the starter, with independent history', async () => {
    noteSmallCallCompleted(Date.now() - 400_000)
    // Four 503s then 200: total 20s, winning health request effectively 0ms.
    let calls = 0
    fetchMock.mockImplementation(async () =>
      ++calls < 5 ? new Response('starting', { status: 503 }) : ok(),
    )
    const first = runWithColdStartWatch(
      () => {},
      () => ensureSmallAwake(),
    )
    await vi.advanceTimersByTimeAsync(12_000)
    const joined = runWithColdStartWatch(
      () => {},
      () => ensureSmallAwake(),
    )
    await vi.advanceTimersByTimeAsync(8_000)
    await Promise.all([first, joined])
    expect(smallColdStartEstimate()).toEqual({ estimateMs: 20_000, basis: 'measured', samples: 1 })
    expect(coldStartEstimate().basis).toBe('default')
  })

  it.each([false, true])(
    'drops implausibly fast small waits, even with coldness evidence=%s',
    async (seen) => {
      if (seen) noteSmallCallCompleted(Date.now() - 400_000)
      await runWithColdStartWatch(
        () => {},
        async () => {
          noteBoxCallStarting('small')
          settleBoxColdStart('small', 9_999)
        },
      )
      expect(smallColdStartEstimate().basis).toBe('default')
      if (!seen) {
        await runWithColdStartWatch(
          () => {},
          async () => {
            noteBoxCallStarting('small')
            settleBoxColdStart('small', 30_000)
          },
        )
        expect(smallColdStartEstimate().basis).toBe('default')
      }
    },
  )

  it('shows the larger cold estimate and carries the chosen estimate basis', async () => {
    const notices: ColdStartEstimate[] = []
    noteSmallCallCompleted(Date.now() - 400_000)
    await runWithColdStartWatch(
      () => {},
      async () => {
        noteBoxCallStarting('small')
        settleBoxColdStart('small', 400_000)
      },
    )
    noteColdStartMeasured(100_000)
    await runWithColdStartWatch(
      (e) => notices.push(e),
      async () => {
        noteBoxCallStarting('verda')
        noteBoxCallStarting('small')
      },
    )
    expect(notices).toEqual([{ estimateMs: 400_000, basis: 'measured', samples: 1 }])
    resetSmallColdStartHistory()
    noteVerdaCallCompleted()
    notices.length = 0
    await runWithColdStartWatch(
      (e) => notices.push(e),
      async () => noteBoxCallStarting('small'),
    )
    expect(notices).toEqual([{ estimateMs: 30_000, basis: 'default', samples: 0 }])
  })
})
