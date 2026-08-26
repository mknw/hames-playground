/**
 * Cold-start notice — when it fires, when it stays silent, and what it is
 * allowed to remember.
 *
 * Three failures are pinned here, and none of them shows up as an error:
 *
 * 1. **A notice on a warm box.** Telling a user to expect a two-minute wait
 *    that is about to take four seconds trains them to ignore the notice, which
 *    costs the one case it exists for.
 * 2. **A notice fired more than once per turn** — the second verda-bound call
 *    of a turn is on a box the first one woke, so a second spinner would
 *    announce a wait nobody is paying.
 * 3. **A warm call recorded as a cold start.** This is the expensive one: a
 *    four-second reading in the history drags the median, and every future
 *    estimate quietly understates the wait. The rule is evidence of coldness,
 *    not absence of evidence of warmth — a fresh process has never seen the box
 *    and must measure nothing. Pinned twice over, because the coldness gate is
 *    a necessary and not a sufficient condition: it can only speak for the
 *    scale-down value this process was CONFIGURED with, so the plausibility
 *    floor below covers the two cases where that value is not the deployment's.
 *
 * The routing half — that the notice fires from a verda-bound call and never
 * from an anthropic-tier one — is exercised through `clientOverrideFor` itself
 * rather than by calling `noteVerdaCallStarting` directly, because the tier
 * gate lives there and a test that bypassed it would pass with the wiring
 * removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  COLD_START_FALLBACK_MS,
  COLD_START_PLAUSIBILITY_FLOOR_MS,
  COLD_START_WINDOW,
  coldStartEstimate,
  noteColdStartMeasured,
  noteVerdaCallStarting,
  resetColdStartHistory,
  runWithColdStartWatch,
  settleColdStart,
  type ColdStartEstimate,
} from '../../../lib/inference/cold-start.server'
import {
  beginVerdaTurn,
  endVerdaTurn,
  noteVerdaCallCompleted,
  resetVerdaActivity,
  verdaWarmth,
} from '../../../lib/inference/verda-activity.server'
import {
  clientOverrideFor,
  resolveClientForRole,
  runWithInferenceTier,
} from '../../../lib/harness-patterns/clients.server'

/** A fixed "now" so nothing here depends on the wall clock. */
const NOW = 1_700_000_000_000
/** Comfortably past the 300s default scale-down window. */
const LONG_AGO = NOW - 10 * 60 * 1000

beforeEach(() => {
  resetColdStartHistory()
  resetVerdaActivity()
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://e2e.invalid/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
})

afterEach(() => {
  resetColdStartHistory()
  resetVerdaActivity()
  delete process.env.VERDA_INFERENCE_ENDPOINT
  delete process.env.VERDA_INFERENCE_API_KEY
  delete process.env.USE_VERDA_INFERENCE
  delete process.env.VERDA_SCALEDOWN_SECONDS
})

/** Collect every notice a watched body produces. */
async function noticesFrom(body: () => void | Promise<void>): Promise<ColdStartEstimate[]> {
  const seen: ColdStartEstimate[] = []
  await runWithColdStartWatch(
    (estimate) => seen.push(estimate),
    async () => {
      await body()
    },
  )
  return seen
}

describe('the estimate', () => {
  it('falls back to the single published reading before anything is measured', () => {
    expect(coldStartEstimate()).toEqual({
      estimateMs: COLD_START_FALLBACK_MS,
      basis: 'default',
      samples: 0,
    })
    // The provenance is the point: 146s is what one completion into a sleeping
    // box took on 2026-08-26, not a rounded guess.
    expect(COLD_START_FALLBACK_MS).toBe(146_000)
  })

  it('is the median of what was measured, and says so', () => {
    for (const ms of [100_000, 200_000, 150_000]) noteColdStartMeasured(ms)
    expect(coldStartEstimate()).toEqual({ estimateMs: 150_000, basis: 'measured', samples: 3 })
  })

  it('reports a duration something really took, never an interpolation', () => {
    noteColdStartMeasured(100_000)
    noteColdStartMeasured(200_000)
    // Nearest rank on an even window, like the header's latency median: 150_000
    // is the average of the two and nothing waited that long.
    expect(coldStartEstimate().estimateMs).toBe(100_000)
  })

  it('drops unmeasured readings rather than clamping them to zero', () => {
    noteColdStartMeasured(Number.NaN)
    noteColdStartMeasured(0)
    noteColdStartMeasured(-5)
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('keeps only the most recent window, so it tracks the deployment today', () => {
    // Above the plausibility floor: a reading a cold start could not have taken
    // never reaches the window at all (see the floor's own cases below).
    for (let i = 0; i < COLD_START_WINDOW + 4; i++) noteColdStartMeasured(100_000 + i)
    const { samples, estimateMs } = coldStartEstimate()
    expect(samples).toBe(COLD_START_WINDOW)
    // The four oldest are gone: the smallest surviving reading is 100_004.
    expect(estimateMs).toBeGreaterThanOrEqual(100_004)
  })
})

/**
 * The plausibility floor.
 *
 * The coldness gate one layer up proves less than it reads: it proves THIS
 * process was quiet for longer than the scale-down value it was CONFIGURED
 * with. Two ordinary situations make that a lie in the same direction — a
 * `VERDA_SCALEDOWN_SECONDS` lower than the deployment's own — no longer the
 * committed default's doing (it was settled at 300 on 2026-08-26, matching the
 * live box) but still one env var away on any host whose box differs — and a
 * second app instance that has seen a call finish and then gone quiet. Both admit a warm ~4s call, and a
 * handful of those turn the estimate into a confident "~10 sec" promise for a
 * 146-second wait, which is the exact dishonesty the whole `basis` apparatus
 * exists to prevent.
 */
describe('the plausibility floor', () => {
  it('is a duration no container start plus 27B weight load could match', () => {
    // Pinned as a relation, not a literal: it is a quarter of the one measured
    // cold start, and the load test's WARM p95 at 8-way concurrency is 9.9s —
    // so every warm reading is far below it and every cold one far above.
    expect(COLD_START_PLAUSIBILITY_FLOOR_MS).toBe(COLD_START_FALLBACK_MS / 4)
    expect(COLD_START_PLAUSIBILITY_FLOOR_MS).toBeGreaterThan(10_000)
  })

  it('drops a reading too short to be a cold start, however the gate voted', () => {
    noteColdStartMeasured(COLD_START_PLAUSIBILITY_FLOOR_MS - 1)
    expect(coldStartEstimate().basis).toBe('default')

    noteColdStartMeasured(COLD_START_PLAUSIBILITY_FLOOR_MS)
    expect(coldStartEstimate()).toEqual({
      estimateMs: COLD_START_PLAUSIBILITY_FLOOR_MS,
      basis: 'measured',
      samples: 1,
    })
  })

  it('refuses a warm call the CONFIGURED scale-down window mistook for a cold box', async () => {
    // A host that set the var below its own deployment's setting: the app is told
    // 180s, the box is held for 300s. A 200s idle gap passes the coldness gate —
    // `verdaWarmth` agrees
    // the box is cold — and the call still comes back in 4.1s because the
    // platform never released the GPU.
    process.env.VERDA_SCALEDOWN_SECONDS = '180'
    noteVerdaCallCompleted(NOW - 200_000)
    expect(verdaWarmth(NOW).state).toBe('cold')

    await runWithColdStartWatch(
      () => {},
      async () => {
        noteVerdaCallStarting(NOW)
        settleColdStart(4_100)
      },
    )

    // Without the floor this is `{ estimateMs: 4_100, basis: 'measured' }` — a
    // fabricated measurement, and the notice would promise "~5 sec".
    expect(coldStartEstimate()).toEqual({
      estimateMs: COLD_START_FALLBACK_MS,
      basis: 'default',
      samples: 0,
    })
    delete process.env.VERDA_SCALEDOWN_SECONDS
  })

  it('keeps the estimate honest when most of the window is poisoned', () => {
    // The reviewer's own probe: five warm readings admitted by the gate plus
    // three real cold starts. The nearest-rank median of the raw eight is 4_000
    // — reported as `measured` over 8 samples, i.e. "~5 sec" for a 146s wait.
    for (const ms of [4_000, 4_000, 4_000, 4_000, 4_000, 146_000, 150_000, 140_000]) {
      noteColdStartMeasured(ms)
    }
    const { estimateMs, samples, basis } = coldStartEstimate()
    expect(samples).toBe(3)
    expect(basis).toBe('measured')
    expect(estimateMs).toBeGreaterThanOrEqual(140_000)
  })

  it('still records a genuine cold start well under the published reading', () => {
    // The floor must not be a ceiling on honesty: a box that starts faster than
    // 2026-08-26's 146s is exactly what the window exists to notice.
    noteColdStartMeasured(60_000)
    expect(coldStartEstimate()).toMatchObject({ estimateMs: 60_000, basis: 'measured' })
  })
})

describe('when the notice fires', () => {
  it('fires on a verda-bound call while nothing says the box is up', async () => {
    const seen = await runWithInferenceTier('verda', () =>
      noticesFrom(() => {
        beginVerdaTurn()
        clientOverrideFor('controller')
        endVerdaTurn()
      }),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].estimateMs).toBe(COLD_START_FALLBACK_MS)
  })

  it('stays silent on the anthropic tier — there is no box to start', async () => {
    const seen = await runWithInferenceTier('anthropic', () =>
      noticesFrom(() => {
        expect(clientOverrideFor('controller')).toBeUndefined()
      }),
    )
    expect(seen).toEqual([])
  })

  it('stays silent when a recent call proves the box is warm', async () => {
    noteVerdaCallCompleted(Date.now())
    const seen = await runWithInferenceTier('verda', () =>
      noticesFrom(() => {
        beginVerdaTurn()
        clientOverrideFor('controller')
        endVerdaTurn()
      }),
    )
    expect(seen).toEqual([])
  })

  it('fires at most once per turn — the second call is on a box the first woke', async () => {
    const seen = await runWithInferenceTier('verda', () =>
      noticesFrom(() => {
        beginVerdaTurn()
        clientOverrideFor('controller')
        clientOverrideFor('critic')
        clientOverrideFor('compactExecution')
        endVerdaTurn()
      }),
    )
    expect(seen).toHaveLength(1)
  })

  it('is not fired by a budgeting lookup, which asks the same question', async () => {
    const seen = await runWithInferenceTier('verda', () =>
      noticesFrom(() => {
        beginVerdaTurn()
        // `resolveClientForRole` is how a pattern learns the model's context
        // window before building a prompt. It may run more than once, and it
        // does not mean a call is on the wire.
        expect(resolveClientForRole('controller')).toBe('VerdaQwen')
        endVerdaTurn()
      }),
    )
    expect(seen).toEqual([])
  })

  it('does nothing at all with no watch armed — a script, a triggered run', async () => {
    await runWithInferenceTier('verda', async () => {
      beginVerdaTurn()
      expect(() => clientOverrideFor('controller')).not.toThrow()
      endVerdaTurn()
    })
  })

  it('survives a listener that throws — a status frame is not worth an answer', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runWithInferenceTier('verda', () =>
      runWithColdStartWatch(
        () => {
          throw new Error('the stream is gone')
        },
        async () => {
          beginVerdaTurn()
          expect(() => clientOverrideFor('controller')).not.toThrow()
          endVerdaTurn()
        },
      ),
    )
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe('what the wait is allowed to teach the estimate', () => {
  it('records the wait when this process watched the box go cold', async () => {
    // Evidence of coldness: a call finished, and the scale-down window has
    // long since elapsed.
    noteVerdaCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        noteVerdaCallStarting(NOW)
        settleColdStart(155_000)
      },
    )
    expect(coldStartEstimate()).toEqual({ estimateMs: 155_000, basis: 'measured', samples: 1 })
  })

  it('measures NOTHING on a process that has never seen the box', async () => {
    // No `noteVerdaCallCompleted` at all — the box may well have been warm and
    // this process simply had not noticed (a restart, a second instance). The
    // notice still shows, pessimistically; the reading must not be kept.
    const seen: ColdStartEstimate[] = []
    await runWithColdStartWatch(
      (e) => seen.push(e),
      async () => {
        noteVerdaCallStarting(NOW)
        settleColdStart(4_000)
      },
    )
    expect(seen).toHaveLength(1)
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('records one reading per turn, not one per call', async () => {
    noteVerdaCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        noteVerdaCallStarting(NOW)
        settleColdStart(150_000)
        settleColdStart(2_000)
      },
    )
    expect(coldStartEstimate().samples).toBe(1)
  })

  it('keeps nothing when BAML measured nothing', async () => {
    noteVerdaCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        noteVerdaCallStarting(NOW)
        settleColdStart(undefined)
      },
    )
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('ignores a settle from a turn that never announced anything', async () => {
    noteVerdaCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        settleColdStart(150_000)
      },
    )
    expect(coldStartEstimate().basis).toBe('default')
  })
})
