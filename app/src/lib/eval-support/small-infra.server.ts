/**
 * The eval runner's small-box infrastructure rate — Server Only.
 *
 * #882: the runner used to capture the small box's rate once, before any
 * wake, at the L4 base — so a run whose box landed on the dearer A10
 * fallback reserved its scale-down tails and charged elapsed infrastructure
 * below the family's real rate, understating the infrastructure floor and
 * the cap. This composes the production GPU-aware seam (`smallGpuServed`,
 * the same read the per-call observer prices `SmallQwen` and
 * `PrivateSystemOne` through) with the runner's own two rules: the
 * committed-default floor the flat rate always had, and a report basis that
 * names the observed family — or states the conservative reservation when
 * none was observed, never silently the cheaper rate.
 *
 * Read per charge, never captured: the sample lands when the wake's `onUp`
 * fires, so a charge before the family is known takes the highest
 * supported-family rate (conservative — the cap cannot be passed by an
 * optimistic assumption) and the charges after price that family. The
 * observer's per-call cost is counted once beside this floor, exactly as
 * before; the overlap is the documented deliberate overcount.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { smallGpuServed } from '../inference/small-gpu.server'
import { DEFAULT_SMALL_LLM_EUR_PER_HOUR } from '../settings'
import { floorHourlyRate } from './spend-budget'

assertServerOnImport()

export interface SmallInfraRate {
  /** The GPU family the box's sample names; null when none was observed. */
  family: 'L4' | 'A10' | null
  /** What the report prints beside the rate: the observed family, or the
   *  conservative rule that priced an unobserved one. */
  basis: string
  /** EUR/hour for cap reservation and elapsed charging, floored at the
   *  committed default like every runner rate. */
  eurPerHour: number
}

export function smallInfraRate(): SmallInfraRate {
  const served = smallGpuServed()
  const eurPerHour = floorHourlyRate(served.eurPerHour, DEFAULT_SMALL_LLM_EUR_PER_HOUR)
  return served.family === undefined
    ? {
        family: null,
        basis: 'small-box GPU not observed — priced at the highest supported-family rate',
        eurPerHour,
      }
    : {
        family: served.family,
        basis: `observed ${served.family} GPU on the small box (status sample)`,
        eurPerHour,
      }
}
