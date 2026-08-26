/**
 * Cost rates from the environment — Server Only.
 *
 * The two rates `estimateLlmCostEur` needs and `settings.ts` cannot read.
 * `settings.ts` is imported by the client (`DEFAULT_SETTINGS` rides in the
 * settings payload), and `process` is not defined in a browser bundle, so a
 * `process.env` read there would throw at module load and take the whole
 * settings import with it. The defaults live there, next to the arithmetic that
 * uses them; the overrides live here.
 *
 * Both are read PER CALL rather than captured at module load, so an operator can
 * change a rate on the host without a rebuild — the same rule
 * `verdaScaledownSeconds()` follows, and for the same reason.
 *
 * Neither rate is fetched from anywhere. The USD→EUR figure is deliberately
 * static (see `DEFAULT_USD_EUR_RATE`); a live FX lookup would put a network
 * dependency behind a spend estimate and make two page loads of the same
 * conversation disagree.
 */
import { assertServerOnImport } from './harness-patterns/assert.server'
import { DEFAULT_USD_EUR_RATE, DEFAULT_VERDA_EUR_PER_HOUR } from './settings'

assertServerOnImport()

/** Shared shape of both readers: a positive finite number, or the default with
 *  a warning. A `0` or a garbage value would render as "every call was free",
 *  which is the one reading worse than a stale rate. */
function positiveRate(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[cost] ${name}=${JSON.stringify(raw)} is not a positive number; ` +
        `falling back to ${fallback}.`,
    )
    return fallback
  }
  return parsed
}

/** EUR per USD, from `USD_EUR_RATE`. Static by design — see the default's doc. */
export function usdEurRate(): number {
  return positiveRate('USD_EUR_RATE', process.env.USD_EUR_RATE, DEFAULT_USD_EUR_RATE)
}

/** EUR per hour the self-hosted GPU is awake, from `VERDA_EUR_PER_HOUR`. */
export function verdaEurPerHour(): number {
  return positiveRate(
    'VERDA_EUR_PER_HOUR',
    process.env.VERDA_EUR_PER_HOUR,
    DEFAULT_VERDA_EUR_PER_HOUR,
  )
}
