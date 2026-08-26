/**
 * The cost model: two pricing models, one currency.
 *
 * What this suite is FOR, in one line each — the observability panel used to
 * render a dollar figure built from per-token tables for every client, which
 * was the wrong currency for all of them and the wrong MODEL for the
 * self-hosted GPU, whose tokens are free and whose bill is wall-clock:
 *
 *  1. **Token-priced clients** (Anthropic) keep the per-MTok arithmetic and
 *     convert to EUR at a STATIC rate. A live FX lookup is not wanted; the pin
 *     here is that the conversion happens on the rates, so the `rates` audit
 *     field is the €/MTok that was really applied.
 *  2. **Time-priced clients** (`VerdaQwen`) are `€/h × measured wall-clock`, and
 *     `undefined` — not zero — when nothing measured the call. A time bill with
 *     no time is not a free call.
 *  3. **Attribution is the client BAML SELECTED.** This is the property with
 *     teeth: a call that fell back to Anthropic on a verda-tier turn must be
 *     priced by tokens, and a Verda call on an anthropic-tier turn by time.
 *     Get this wrong and the panel confidently prices the wrong bill.
 *  4. **Locally-served clients** are an exact €0.00 on a third basis, `local`,
 *     rather than absent from both tables. Owner decision 2026-08-26: unknown
 *     means unmeasured, and a call with no marginal bill is not unmeasured.
 *  5. **One formatter, one symbol.** Every surface that renders a price imports
 *     `fmtEur`; there is no second copy to drift.
 *
 * The env overrides are covered here too, including the failure policy: a
 * garbage or non-positive rate falls back with a warning rather than rendering
 * every call as free.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  CACHE_READ_MULT,
  CACHE_WRITE_MULT,
  CLIENT_PRICING,
  DEFAULT_EUR_PER_USD,
  DEFAULT_VERDA_EUR_PER_HOUR,
  LOCAL_PRICED_CLIENTS,
  TIME_PRICED_CLIENT,
  estimateLlmCostEur,
} from '../../lib/settings'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

/** Every `.ts`/`.tsx` under `dir`, recursively, tests excluded. Same walk as
 *  `theme-migration.test.ts` — the house shape for a source-scan pin. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const NO_TOKENS = {
  inputUncachedTokens: 0,
  inputCacheReadTokens: 0,
  inputCacheWriteTokens: 0,
  outputTokens: 0,
}

/** A million of every bucket — makes the per-MTok arithmetic readable. */
const ONE_MTOK_EACH = {
  inputUncachedTokens: 1_000_000,
  inputCacheReadTokens: 1_000_000,
  inputCacheWriteTokens: 1_000_000,
  outputTokens: 1_000_000,
}

describe('the time-priced client is the same one everything else means by "verda"', () => {
  it('TIME_PRICED_CLIENT equals VERDA_CLIENT_NAME', async () => {
    const { VERDA_CLIENT_NAME } = await import('../../lib/inference/verda-activity.server')
    // Two literals in two files (settings.ts must stay client-safe, the warm
    // clock is server-only). A rename that moved only one of them would put the
    // box silently back on per-token pricing — which is a €0 figure, because it
    // has no CLIENT_PRICING entry.
    expect(TIME_PRICED_CLIENT).toBe(VERDA_CLIENT_NAME)
  })

  it('is deliberately absent from the per-token table', () => {
    expect(CLIENT_PRICING[TIME_PRICED_CLIENT]).toBeUndefined()
  })
})

describe('token pricing → EUR', () => {
  it('converts the RATES, so the audit trail is the €/MTok applied', () => {
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5', { eurPerUsd: 0.5 })!
    expect(est.basis).toBe('tokens')
    expect(est.rates).toEqual({ inPerMTok: 1.0, outPerMTok: 5.0 })
    // 1 uncached + 0.1 cache-read + 1.25 cache-write, all at €1/MTok, + €5 out
    expect(est.costEur).toBeCloseTo(1 + CACHE_READ_MULT + CACHE_WRITE_MULT + 5, 9)
  })

  it('scales linearly with the conversion rate', () => {
    const at1 = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicHaiku45', { eurPerUsd: 1 })!
    const at2 = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicHaiku45', { eurPerUsd: 2 })!
    expect(at2.costEur).toBeCloseTo(at1.costEur * 2, 9)
    expect(at2.noCacheEur).toBeCloseTo(at1.noCacheEur * 2, 9)
  })

  it('uses DEFAULT_EUR_PER_USD when no rate is passed', () => {
    const explicit = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5', {
      eurPerUsd: DEFAULT_EUR_PER_USD,
    })!
    const implied = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5')!
    expect(implied.costEur).toBeCloseTo(explicit.costEur, 12)
  })

  it('noCacheEur is the same tokens with nothing cached — the savings baseline', () => {
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5', { eurPerUsd: 1 })!
    expect(est.noCacheEur).toBeCloseTo(3 * 2 + 10, 9)
    expect(est.noCacheEur).toBeGreaterThan(est.costEur)
  })

  it('a duration on a token-priced call changes nothing', () => {
    const timed = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5', { durationMs: 600_000 })!
    const untimed = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5')!
    expect(timed.costEur).toBe(untimed.costEur)
    expect(timed.timeRate).toBeUndefined()
  })

  it('is undefined for an unlisted client, not zero', () => {
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'SomeNewClient')).toBeUndefined()
    expect(estimateLlmCostEur(ONE_MTOK_EACH, undefined)).toBeUndefined()
  })
})

describe('time pricing → EUR', () => {
  it('is €/h × wall-clock, and tokens do not enter it', () => {
    const oneHour = estimateLlmCostEur(NO_TOKENS, TIME_PRICED_CLIENT, {
      durationMs: 3_600_000,
      eurPerHour: 1.819,
    })!
    expect(oneHour.basis).toBe('time')
    expect(oneHour.costEur).toBeCloseTo(1.819, 9)

    // Same duration, a huge token count: identical cost. Tokens are free.
    const withTokens = estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT, {
      durationMs: 3_600_000,
      eurPerHour: 1.819,
    })!
    expect(withTokens.costEur).toBeCloseTo(oneHour.costEur, 12)
  })

  it('prices a realistic call in fractions of a cent', () => {
    // The measured 4.1s single-call latency at the default rate.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT, { durationMs: 4_100 })!
    expect(est.costEur).toBeCloseTo((4.1 / 3600) * DEFAULT_VERDA_EUR_PER_HOUR, 12)
    expect(est.timeRate).toEqual({ eurPerHour: DEFAULT_VERDA_EUR_PER_HOUR, durationMs: 4_100 })
  })

  it('defaults to €1.819/h', () => {
    expect(DEFAULT_VERDA_EUR_PER_HOUR).toBe(1.819)
    const est = estimateLlmCostEur(NO_TOKENS, TIME_PRICED_CLIENT, { durationMs: 3_600_000 })!
    expect(est.costEur).toBeCloseTo(1.819, 9)
  })

  it('offers no caching savings — caching cannot save wall-clock', () => {
    const est = estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT, { durationMs: 5_000 })!
    expect(est.noCacheEur).toBe(est.costEur)
    expect(est.rates).toBeUndefined()
  })

  it('an idle box costs nothing: zero duration is zero, not a minimum charge', () => {
    const est = estimateLlmCostEur(NO_TOKENS, TIME_PRICED_CLIENT, { durationMs: 0 })!
    expect(est.costEur).toBe(0)
    expect(est.basis).toBe('time')
  })

  it('is UNDEFINED, not zero, when the call was not measured', () => {
    // A time bill with no time is not a free call. BAML reports no duration when
    // it measured none, and a 0 here would render as "this call cost nothing" on
    // a box that was demonstrably awake to answer it.
    expect(estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT)).toBeUndefined()
    expect(
      estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT, { durationMs: undefined }),
    ).toBeUndefined()
    expect(
      estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT, { durationMs: Number.NaN }),
    ).toBeUndefined()
    expect(
      estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT, { durationMs: -1 }),
    ).toBeUndefined()
  })
})

describe('attribution: the SELECTED client decides the model', () => {
  it('a token-priced client never gets wall-clock pricing, however long it ran', () => {
    // The failure this pins: pricing by the tier a run intended rather than by
    // the client that answered. Ten minutes on Sonnet must cost tokens.
    const est = estimateLlmCostEur(
      { ...NO_TOKENS, inputUncachedTokens: 1_000_000 },
      'AnthropicSonnet5',
      { durationMs: 600_000, eurPerHour: 1_000_000 },
    )!
    expect(est.basis).toBe('tokens')
    expect(est.timeRate).toBeUndefined()
    expect(est.costEur).toBeCloseTo(2 * DEFAULT_EUR_PER_USD, 9)
  })

  it('a time-priced client never gets token pricing, however many tokens it moved', () => {
    const est = estimateLlmCostEur(ONE_MTOK_EACH, TIME_PRICED_CLIENT, { durationMs: 1_000 })!
    expect(est.basis).toBe('time')
    expect(est.rates).toBeUndefined()
    // Nothing anywhere near a per-MTok figure.
    expect(est.costEur).toBeLessThan(0.001)
  })

  it('a locally-served client is €0.00 on the local basis, never unknown', () => {
    // The coverage hole this closed: `describe` (six of twelve BAML functions,
    // and the frequent ones) moved onto the 4B, and with the client in neither
    // table every private-tier step that summarized a tool result rendered
    // cost-UNKNOWN. Unknown reads as unmeasured; this call is measured and free.
    for (const name of LOCAL_PRICED_CLIENTS) {
      const est = estimateLlmCostEur(ONE_MTOK_EACH, name, { durationMs: 4_000 })
      expect(est, name).toBeDefined()
      expect(est!.basis, name).toBe('local')
      expect(est!.costEur, name).toBe(0)
      // Its own baseline: there is no caching saving to claim on a free call.
      expect(est!.noCacheEur, name).toBe(0)
      expect(est!.rates, name).toBeUndefined()
      expect(est!.timeRate, name).toBeUndefined()
    }
  })

  it('the local set and the two priced tables are disjoint', () => {
    // A client in two of them would price by whichever branch ran first, which
    // is exactly the silent-wrong-figure failure this suite exists for.
    for (const name of LOCAL_PRICED_CLIENTS) {
      expect(CLIENT_PRICING[name], name).toBeUndefined()
      expect(name).not.toBe(TIME_PRICED_CLIENT)
    }
  })

  it('every client in CLIENT_PRICING prices by tokens', () => {
    for (const name of Object.keys(CLIENT_PRICING)) {
      const est = estimateLlmCostEur(ONE_MTOK_EACH, name, { durationMs: 60_000 })
      expect(est, name).toBeDefined()
      expect(est!.basis, name).toBe('tokens')
    }
  })
})

describe('the env overrides (cost-rates.server.ts)', () => {
  const saved = { usd: process.env.EUR_PER_USD, verda: process.env.VERDA_EUR_PER_HOUR }

  afterEach(() => {
    if (saved.usd === undefined) delete process.env.EUR_PER_USD
    else process.env.EUR_PER_USD = saved.usd
    if (saved.verda === undefined) delete process.env.VERDA_EUR_PER_HOUR
    else process.env.VERDA_EUR_PER_HOUR = saved.verda
    vi.restoreAllMocks()
  })

  it('reads both rates, per call, so a host change needs no rebuild', async () => {
    const { eurPerUsdRate, verdaEurPerHour } = await import('../../lib/cost-rates.server')
    process.env.EUR_PER_USD = '0.9'
    process.env.VERDA_EUR_PER_HOUR = '2.5'
    expect(eurPerUsdRate()).toBe(0.9)
    expect(verdaEurPerHour()).toBe(2.5)
    // Changed again without re-importing the module:
    process.env.VERDA_EUR_PER_HOUR = '3'
    expect(verdaEurPerHour()).toBe(3)
  })

  it('falls back to the defaults when unset or blank', async () => {
    const { eurPerUsdRate, verdaEurPerHour } = await import('../../lib/cost-rates.server')
    delete process.env.EUR_PER_USD
    delete process.env.VERDA_EUR_PER_HOUR
    expect(eurPerUsdRate()).toBe(DEFAULT_EUR_PER_USD)
    expect(verdaEurPerHour()).toBe(DEFAULT_VERDA_EUR_PER_HOUR)
    process.env.EUR_PER_USD = '   '
    expect(eurPerUsdRate()).toBe(DEFAULT_EUR_PER_USD)
  })

  it('warns and falls back on a non-positive or garbage rate, never renders free', async () => {
    const { verdaEurPerHour } = await import('../../lib/cost-rates.server')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['0', '-1', 'free', 'NaN']) {
      process.env.VERDA_EUR_PER_HOUR = bad
      expect(verdaEurPerHour(), bad).toBe(DEFAULT_VERDA_EUR_PER_HOUR)
    }
    expect(warn).toHaveBeenCalledTimes(4)
  })
})

describe('the conversion rate is named for the direction it multiplies in', () => {
  it('is EUR_PER_USD, never the reversed name that reads as the 1.16 pair quote', () => {
    // `positiveRate` accepts any positive number, and no sanity band wide enough
    // to allow a real rate move would reject 1.16 — so the NAME is the guard
    // against an operator entering the reciprocal and inflating every price in
    // the app by ~35%. A source scan rather than a render: it also catches the
    // reversed name coming back in a doc comment or a new module.
    const offenders = sourceFiles('src').filter((f) =>
      /USD_EUR_RATE|usdEurRate/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
    // The operator's copy of the name is the one that decides which number they
    // type, so the example file is pinned too.
    const envExample = readFileSync('.env.example', 'utf8')
    expect(envExample).toMatch(/^# EUR_PER_USD=/m)
    expect(envExample).not.toMatch(/USD_EUR_RATE/)
  })

  it('multiplies a USD list price, so 1.0 is parity and 0.86 is less', () => {
    const listed = CLIENT_PRICING.AnthropicSonnet5
    const parity = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5', { eurPerUsd: 1 })!
    expect(parity.rates).toEqual({ inPerMTok: listed.inPerMTok, outPerMTok: listed.outPerMTok })
    const real = estimateLlmCostEur(ONE_MTOK_EACH, 'AnthropicSonnet5', {
      eurPerUsd: DEFAULT_EUR_PER_USD,
    })!
    expect(real.costEur).toBeLessThan(parity.costEur)
  })
})

describe('fmtEur — the one formatter', () => {
  it('is euro, with cents above €0.10 and four places below', async () => {
    const { fmtEur } = await import('../../lib/observability/token-totals')
    expect(fmtEur(0)).toBe('€0.0000')
    expect(fmtEur(0.000_3)).toBe('€0.0003')
    expect(fmtEur(0.099_9)).toBe('€0.0999')
    expect(fmtEur(0.1)).toBe('€0.10')
    expect(fmtEur(12.345)).toBe('€12.35')
  })

  it('is the only price formatter in the app — no surface keeps its own', () => {
    // #122's dashboard shipped a SECOND copy of the USD formatter, which is
    // exactly how one surface could have been converted to euro and the other
    // left in dollars. Reading the source rather than a render also catches a
    // copy nobody renders yet.
    const offenders = sourceFiles('src').filter(
      (f) =>
        !f.endsWith(join('observability', 'token-totals.ts')) &&
        /const fmt(Usd|Eur|Cost|Price|Money)\s*[:=]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('no rendered surface interpolates a price behind a dollar sign', () => {
    // The old tooltips read `At $${rates.inPerMTok}/…`. This catches that shape
    // — a `$` immediately before a JSX interpolation whose expression mentions a
    // price — without banning the dollar sign from prose about USD list prices.
    const offenders = sourceFiles('src/components')
      .concat(sourceFiles('src/routes'))
      .filter((f) => /\$\$\{[^}]*(?:ost|rice|ates?\b|Usd|Eur)/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
