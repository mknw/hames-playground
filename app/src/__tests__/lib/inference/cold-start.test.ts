// The composition root registers the harness client seam (tier policy, model
// tables, cost rates); these tests exercise scopes/rates/windows, so they run
// the same wiring a production turn takes.
import '../../../lib/inference/config.server'
/**
 * Cold-start notice — when it fires, when it stays silent, and what it is
 * allowed to remember.
 *
 * Three failures are pinned here, and none of them shows up as an error:
 *
 * 1. **A notice on a warm box.** Telling a user to expect a two-minute wait
 *    that is about to take four seconds trains them to ignore the notice, which
 *    costs the one case it exists for.
 * 2. **A notice fired more than once per turn** — the second self_deployed-bound call
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
 * The routing half — that the notice fires from a self_deployed-bound call and never
 * from an anthropic-tier one — is exercised through `clientOverrideFor` itself
 * rather than by calling `noteLargeCallStarting` directly, because the tier
 * gate lives there and a test that bypassed it would pass with the wiring
 * removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  COLD_START_FALLBACK_MS,
  COLD_START_PLAUSIBILITY_FLOOR_MS,
  COLD_START_WINDOW,
  SMALL_COLD_START_FALLBACK_MS,
  coldStartEstimate,
  largeColdStartStats,
  noteColdStartMeasured,
  noteLargeCallStarting,
  resetColdStartHistory,
  resetSmallColdStartHistory,
  runWithColdStartWatch,
  settleColdStart,
  smallColdStartStats,
  type ColdStartEstimate,
} from '../../../lib/inference/cold-start.server'
import {
  beginSelfDeployedTurn,
  endSelfDeployedTurn,
  noteLargeCallCompleted,
  resetLargeActivity,
  largeWarmth,
} from '../../../lib/inference/large-activity.server'
import {
  assertInferenceTier,
  clientOverrideFor,
  resolveClientForRole,
} from '@hames-ai/harness-baml/clients.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

/**
 * #374: the tier is a SLOT of the run frame, and the fail-closed reachability
 * check the old opener made on the way in is now the host-called
 * `assertInferenceTier`. Bound together here — both, in that order, is what a
 * turn does — so the assertions below stay as they were.
 */
function runWithInferenceTier<T>(
  tier: 'self_deployed' | 'anthropic',
  fn: () => Promise<T>,
): Promise<T> {
  assertInferenceTier(tier)
  return withRunFrame({ inference: { tier } }, fn)
}

/** A fixed "now" so nothing here depends on the wall clock. */
const NOW = 1_700_000_000_000
/** Comfortably past the 300s default scale-down window. */
const LONG_AGO = NOW - 10 * 60 * 1000

beforeEach(() => {
  resetColdStartHistory()
  resetLargeActivity()
  process.env.LARGE_LLM_BASE_URL = 'https://e2e.invalid/v1'
  process.env.LARGE_LLM_API_KEY = 'test-key'
  // The private tier's second endpoint (the 4B summarizer `describe` runs on).
  // Needed only so a 'self_deployed' frame is allowed to open at all.
  process.env.SMALL_LLM_DECISIONS_URL = 'https://private.example/v1/systemone'
  process.env.SMALL_LLM_API_KEY = 'synthetic-private-key'
  process.env.SMALL_LLM_BASE_URL = 'https://e2e.invalid/small/v1'
})

afterEach(() => {
  resetColdStartHistory()
  resetLargeActivity()
  delete process.env.LARGE_LLM_BASE_URL
  delete process.env.LARGE_LLM_API_KEY
  delete process.env.SMALL_LLM_DECISIONS_URL
  delete process.env.SMALL_LLM_API_KEY
  delete process.env.SMALL_LLM_BASE_URL
  delete process.env.USE_SELF_DEPLOYED_INFERENCE
  delete process.env.LARGE_LLM_SCALEDOWN_SECONDS
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
  it('falls back to the slowest measured snapshot RESTORE before anything is measured', () => {
    expect(coldStartEstimate()).toEqual({
      estimateMs: COLD_START_FALLBACK_MS,
      basis: 'default',
      samples: 0,
    })
    // The provenance is the point: 156.8s is the slowest of six 27B snapshot
    // restores measured through the URL on Modal (11.9, 31.3, 31.3, 36.2, 62.2,
    // 156.8s), rounded up to the second. Deliberately the largest rather than
    // their median: the errors are asymmetric and the owner settled the direction
    // (a pessimistic countdown clears early, an optimistic one is a promise the
    // box breaks). Full boots (505–938s) are a different mode, stated by the
    // notice once this runs out, and must not be folded in here.
    expect(COLD_START_FALLBACK_MS).toBe(157_000)
    expect(COLD_START_FALLBACK_MS).toBeGreaterThanOrEqual(156_800)
    expect(COLD_START_FALLBACK_MS).toBeLessThan(505_000)
  })

  it('seeds the small box from its own slowest measured restore, rounded up', () => {
    // 21.1–31.4s through the URL (`deploy/modal/README.md`, 2026-10-15 L4); the
    // largest, 31.4s, rounds up like the 27B figure — a countdown that clears
    // 0.4s before the slowest measured restore is the promise the rule forbids.
    expect(SMALL_COLD_START_FALLBACK_MS).toBe(32_000)
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
 * `LARGE_LLM_SCALEDOWN_SECONDS` lower than the deployment's own — no longer the
 * committed default's doing (it was settled at 300 on 2026-08-26, matching the
 * live box) but still one env var away on any host whose box differs — and a
 * second app instance that has seen a call finish and then gone quiet. Both admit a warm ~4s call, and a
 * handful of those turn the estimate into a confident "~10 sec" promise for a
 * multi-minute wait, which is the exact dishonesty the whole `basis` apparatus
 * exists to prevent.
 */
describe('the plausibility floor', () => {
  it('sits between a warm wake and the fastest measured snapshot restore', () => {
    // Pinned inside the BAND the measurements define rather than derived from
    // another constant. It was 36.5s, set when the fastest cold start ever seen
    // was 71.7s; on Modal a snapshot restore can answer in 11.9s, and that floor
    // discarded four of the six measured restores, so the history learned only
    // the slow wakes. The fallback and the floor answer different questions —
    // how long a cold start TYPICALLY takes (errs long) vs the fastest one that
    // could be real (must sit under the fastest seen) — so each is pinned
    // against its own evidence.
    expect(COLD_START_PLAUSIBILITY_FLOOR_MS).toBe(10_000)
    // Above the heaviest WARM figure on record (the load test's 8-way p95, 9.9s,
    // 2026-08-25) and far above a warm wake ping (0.34s on Modal), so no warm
    // wake can pass for a cold start...
    expect(COLD_START_PLAUSIBILITY_FLOOR_MS).toBeGreaterThan(9_900)
    // ...and below the FASTEST snapshot restore measured (11.9s), so no real
    // cold start is discarded.
    expect(COLD_START_PLAUSIBILITY_FLOOR_MS).toBeLessThan(11_900)
    // And NOT the old derivation from the fallback.
    expect(COLD_START_PLAUSIBILITY_FLOOR_MS).not.toBe(COLD_START_FALLBACK_MS / 4)
  })

  it('records a fast snapshot restore the old 36.5s floor discarded', () => {
    noteColdStartMeasured(31_300)
    expect(coldStartEstimate()).toEqual({ estimateMs: 31_300, basis: 'measured', samples: 1 })
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
    // `largeWarmth` agrees
    // the box is cold — and the call still comes back in 4.1s because the
    // platform never released the GPU.
    process.env.LARGE_LLM_SCALEDOWN_SECONDS = '180'
    noteLargeCallCompleted(NOW - 200_000)
    expect(largeWarmth(NOW).state).toBe('cold')

    await runWithColdStartWatch(
      () => {},
      async () => {
        noteLargeCallStarting(NOW)
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
    delete process.env.LARGE_LLM_SCALEDOWN_SECONDS
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
  it('fires on a self_deployed-bound call while nothing says the box is up', async () => {
    const seen = await runWithInferenceTier('self_deployed', () =>
      noticesFrom(() => {
        beginSelfDeployedTurn()
        clientOverrideFor('controller')
        endSelfDeployedTurn()
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
    noteLargeCallCompleted(Date.now())
    const seen = await runWithInferenceTier('self_deployed', () =>
      noticesFrom(() => {
        beginSelfDeployedTurn()
        clientOverrideFor('controller')
        endSelfDeployedTurn()
      }),
    )
    expect(seen).toEqual([])
  })

  it('fires at most once per turn — the second call is on a box the first woke', async () => {
    const seen = await runWithInferenceTier('self_deployed', () =>
      noticesFrom(() => {
        beginSelfDeployedTurn()
        clientOverrideFor('controller')
        clientOverrideFor('critic')
        clientOverrideFor('compactExecution')
        endSelfDeployedTurn()
      }),
    )
    expect(seen).toHaveLength(1)
  })

  it('fires for a describe call bound to the small box', async () => {
    const seen = await runWithInferenceTier('self_deployed', () =>
      noticesFrom(() => {
        expect(clientOverrideFor('describe')).toEqual({ client: 'SmallQwen' })
      }),
    )
    expect(seen).toEqual([{ estimateMs: COLD_START_FALLBACK_MS, basis: 'default', samples: 0 }])
  })

  it('still fires for the 27B on a turn that also made describe calls', async () => {
    // The other half: the test above must not pass by having broken the notice.
    // A describe call BEFORE the controller's must not consume the turn's one
    // announcement, or the flip would have silently deleted the cold-start UX for
    // every turn whose first override happened to be a summary.
    const seen = await runWithInferenceTier('self_deployed', () =>
      noticesFrom(() => {
        beginSelfDeployedTurn()
        clientOverrideFor('describe')
        clientOverrideFor('controller')
        endSelfDeployedTurn()
      }),
    )
    expect(seen).toHaveLength(1)
  })

  it('is not fired by a budgeting lookup, which asks the same question', async () => {
    const seen = await runWithInferenceTier('self_deployed', () =>
      noticesFrom(() => {
        beginSelfDeployedTurn()
        // `resolveClientForRole` is how a pattern learns the model's context
        // window before building a prompt. It may run more than once, and it
        // does not mean a call is on the wire.
        expect(resolveClientForRole('controller')).toBe('LargeQwen')
        endSelfDeployedTurn()
      }),
    )
    expect(seen).toEqual([])
  })

  it('does nothing at all with no watch armed — a script, a triggered run', async () => {
    await runWithInferenceTier('self_deployed', async () => {
      beginSelfDeployedTurn()
      expect(() => clientOverrideFor('controller')).not.toThrow()
      endSelfDeployedTurn()
    })
  })

  it('survives a listener that throws — a status frame is not worth an answer', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runWithInferenceTier('self_deployed', () =>
      runWithColdStartWatch(
        () => {
          throw new Error('the stream is gone')
        },
        async () => {
          beginSelfDeployedTurn()
          expect(() => clientOverrideFor('controller')).not.toThrow()
          endSelfDeployedTurn()
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
    noteLargeCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        noteLargeCallStarting(NOW)
        settleColdStart(155_000)
      },
    )
    expect(coldStartEstimate()).toEqual({ estimateMs: 155_000, basis: 'measured', samples: 1 })
  })

  it('measures NOTHING on a process that has never seen the box', async () => {
    // No `noteLargeCallCompleted` at all — the box may well have been warm and
    // this process simply had not noticed (a restart, a second instance). The
    // notice still shows, pessimistically; the reading must not be kept.
    const seen: ColdStartEstimate[] = []
    await runWithColdStartWatch(
      (e) => seen.push(e),
      async () => {
        noteLargeCallStarting(NOW)
        settleColdStart(4_000)
      },
    )
    expect(seen).toHaveLength(1)
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('records one reading per turn, not one per call', async () => {
    noteLargeCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        noteLargeCallStarting(NOW)
        settleColdStart(150_000)
        settleColdStart(2_000)
      },
    )
    expect(coldStartEstimate().samples).toBe(1)
  })

  it('keeps nothing when BAML measured nothing', async () => {
    noteLargeCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        noteLargeCallStarting(NOW)
        settleColdStart(undefined)
      },
    )
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('ignores a settle from a turn that never announced anything', async () => {
    noteLargeCallCompleted(LONG_AGO)
    await runWithColdStartWatch(
      () => {},
      async () => {
        settleColdStart(150_000)
      },
    )
    expect(coldStartEstimate().basis).toBe('default')
  })
})

// ============================================================================
// The dashboard's per-box stats (#931)
// ============================================================================

describe('the dashboard stats', () => {
  beforeEach(() => {
    resetColdStartHistory()
    resetSmallColdStartHistory()
  })

  it('reads the same window the estimate does, and adds the slowest reading', () => {
    for (const ms of [100_000, 200_000, 150_000]) noteColdStartMeasured(ms)
    expect(largeColdStartStats()).toEqual({
      samples: 3,
      medianMs: 150_000,
      slowestMs: 200_000,
      basis: 'measured',
    })
  })

  it('reports nulls and the default basis for a box this process has not measured', () => {
    expect(smallColdStartStats()).toEqual({
      samples: 0,
      medianMs: null,
      slowestMs: null,
      basis: 'default',
    })
  })

  it('keeps the two boxes independent', () => {
    noteColdStartMeasured(120_000)
    expect(largeColdStartStats().samples).toBe(1)
    expect(smallColdStartStats().samples).toBe(0)
  })
})
