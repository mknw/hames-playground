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
 *  2. **Time-priced clients** (`LargeQwen` / `LargeQwenThink` at
 *     `LARGE_LLM_EUR_PER_HOUR`, `SmallQwen` / `PrivateSystemOne` at
 *     `SMALL_LLM_EUR_PER_HOUR`) are `€/h × measured wall-clock`, and
 *     `undefined` — not zero — when nothing measured the call. A time bill
 *     with no time is not a free call.
 *  3. **Provider-priced clients** (`JevDecide`, plus the OpenRouter-route
 *     twins `LargeQwenOR` / `LargeQwenThinkOR`) are the provider's own
 *     reported `usage.cost`, converted once at the static rate. A per-token
 *     public API priced by wall-clock would be the WRONG model; unknown
 *     (not zero) when the provider reported nothing.
 *  4. **Attribution is the client BAML SELECTED.** This is the property with
 *     teeth: a call that fell back to Anthropic on a self_deployed-tier turn must be
 *     priced by tokens, and a self-deployed call on an anthropic-tier turn by its own
 *     basis. Get this wrong and the panel confidently prices the wrong bill.
 *  5. **Locally-served clients** are an exact €0.00 on a third basis, `local`,
 *     rather than absent from both tables. Owner decision 2026-08-26: unknown
 *     means unmeasured, and a call with no marginal bill is not unmeasured.
 *  6. **One formatter, one symbol.** Every surface that renders a price imports
 *     `fmtEur`; there is no second copy to drift.
 *
 * The env overrides are covered here too, including the failure policy: a
 * garbage or non-positive rate falls back with a warning rather than rendering
 * every call as free.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { modalBoxUsdPerHour } from '../../lib/modal-pricing'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  CACHE_READ_MULT,
  CACHE_WRITE_MULT,
  CLIENT_PRICING,
  DEFAULT_EUR_PER_USD,
  DEFAULT_LARGE_LLM_EUR_PER_HOUR,
  DEFAULT_SMALL_LLM_EUR_PER_HOUR,
  LEGACY_CLIENT_NAMES,
  LOCAL_PRICED_CLIENTS,
  PROVIDER_COST_CLIENTS,
  TIME_PRICED_CLIENTS,
  canonicalClientName,
  estimateLlmCostEur,
} from '../../lib/settings'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
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

// Independent arithmetic: these literals are the listed 2026-10-30 Modal rates,
// rather than the production table or helper. Mutation of a source rate goes red.
const LARGE_MODAL_EXPECTED = (3.95 + 4 * 0.0000131 * 3600 + 64 * 0.00000222 * 3600) * 1.15 * 0.86
const SMALL_MODAL_EXPECTED = (0.8 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15 * 0.86
const A10_MODAL_EXPECTED = (1.1 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15 * 0.86

describe('dated Modal resource defaults', () => {
  it('uses full container resources and the COMPUTE region for broad and narrow EU', () => {
    expect(DEFAULT_LARGE_LLM_EUR_PER_HOUR).toBeCloseTo(LARGE_MODAL_EXPECTED, 12)
    expect(DEFAULT_SMALL_LLM_EUR_PER_HOUR).toBeCloseTo(SMALL_MODAL_EXPECTED, 12)
    expect(modalBoxUsdPerHour('H100', 4, 64, 'eu-west') * 0.86).toBeCloseTo(
      (3.95 + 4 * 0.0000131 * 3600 + 64 * 0.00000222 * 3600) * 1.75 * 0.86,
      12,
    )
    expect(A10_MODAL_EXPECTED / SMALL_MODAL_EXPECTED).toBeLessThan(1.375)
  })
})

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

describe('the time-priced client mapping', () => {
  it('contains exactly the metered clients and their default rates', async () => {
    // Both boxes' clients are here under the owner's 2026-10-13
    // metered-infrastructure decision: the 27B leaves at the large GPU's rate,
    // the 4B summarizer and the private systemone client at the small GPU's.
    expect(TIME_PRICED_CLIENTS).toEqual({
      LargeQwen: LARGE_MODAL_EXPECTED,
      LargeQwenThink: LARGE_MODAL_EXPECTED,
      SmallQwen: SMALL_MODAL_EXPECTED,
      PrivateSystemOne: SMALL_MODAL_EXPECTED,
    })
  })

  it('keeps every time-priced client out of the token, local and provider sets', () => {
    for (const name of Object.keys(TIME_PRICED_CLIENTS)) {
      expect(CLIENT_PRICING[name], name).toBeUndefined()
      expect(LOCAL_PRICED_CLIENTS.has(name), name).toBe(false)
      expect(PROVIDER_COST_CLIENTS.has(name), name).toBe(false)
    }
    expect(LOCAL_PRICED_CLIENTS.has('LocalGLM')).toBe(true)
    // The 27B leaves are back in this table (2026-10-13): their endpoint is
    // the metered large GPU, so the wall-clock loop above covers them too.
    expect(Object.hasOwn(TIME_PRICED_CLIENTS, 'LargeQwen')).toBe(true)
    expect(Object.hasOwn(TIME_PRICED_CLIENTS, 'LargeQwenThink')).toBe(true)
  })
})

describe('provider pricing → EUR', () => {
  it('prices the provider-reported clients from the reported cost, unknown when none was reported', () => {
    for (const name of ['JevDecide', 'LargeQwenOR', 'LargeQwenThinkOR']) {
      const est = estimateLlmCostEur(ONE_MTOK_EACH, name, { providerCostUsd: 0.02 })!
      expect(est.basis, name).toBe('provider')
      expect(est.costEur, name).toBeCloseTo(0.02 * DEFAULT_EUR_PER_USD, 12)
      expect(est.noCacheEur, name).toBe(est.costEur)
      // Tokens and duration do not enter it: no invented per-MTok or per-hour
      // figure on a basis the provider measured.
      expect(est.rates, name).toBeUndefined()
      expect(est.timeRate, name).toBeUndefined()
    }
  })

  it('a provider-priced client with no reported cost is unknown, never free and never a time floor', () => {
    // The OpenRouter probe verified usage.cost on every response; when a
    // provider does NOT report one (a routed-away call, a malformed usage),
    // the honest reading is unknown. In particular NOT the box's €/h floor:
    // the call never touched the box, and a floor would understate a real
    // spend as a fraction of a cent.
    for (const name of ['JevDecide', 'LargeQwenOR', 'LargeQwenThinkOR']) {
      expect(estimateLlmCostEur(ONE_MTOK_EACH, name), name).toBeUndefined()
      expect(
        estimateLlmCostEur(ONE_MTOK_EACH, name, {
          durationMs: 6_300,
          eurPerHour: LARGE_MODAL_EXPECTED,
        }),
        name,
      ).toBeUndefined()
      for (const bad of [-1, Number.NaN])
        expect(
          estimateLlmCostEur(ONE_MTOK_EACH, name, { providerCostUsd: bad }),
          name,
        ).toBeUndefined()
    }
  })

  it('scales with EUR_PER_USD like every USD figure', () => {
    const at1 = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwenOR', {
      providerCostUsd: 0.01,
      eurPerUsd: 1,
    })!
    const atHalf = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwenOR', {
      providerCostUsd: 0.01,
      eurPerUsd: 0.5,
    })!
    expect(atHalf.costEur).toBeCloseTo(at1.costEur / 2, 12)
  })

  it('a zero reported cost is a zero bill, not unknown', () => {
    // `0` is a measurement the provider made; only an ABSENT one is unknown.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwenOR', { providerCostUsd: 0 })!
    expect(est).toMatchObject({ basis: 'provider', costEur: 0, noCacheEur: 0 })
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
  it.each([
    ['LargeQwen', LARGE_MODAL_EXPECTED],
    ['LargeQwenThink', LARGE_MODAL_EXPECTED],
    ['SmallQwen', SMALL_MODAL_EXPECTED],
    ['PrivateSystemOne', SMALL_MODAL_EXPECTED],
  ] as const)('prices %s at €%s/h and accepts an explicit rate', (client, rate) => {
    expect(DEFAULT_SMALL_LLM_EUR_PER_HOUR).toBe(SMALL_MODAL_EXPECTED)
    const est = estimateLlmCostEur(ONE_MTOK_EACH, client, { durationMs: 2_000 })!
    expect(est.basis).toBe('time')
    expect(est.costEur).toBeCloseTo((rate * 2) / 3600, 12)
    expect(est.timeRate).toEqual({ eurPerHour: rate, durationMs: 2_000 })
    expect(est.noCacheEur).toBe(est.costEur)
    expect(
      estimateLlmCostEur(NO_TOKENS, client, {
        durationMs: 2_000,
        eurPerHour: 3,
      })!.costEur,
    ).toBeCloseTo((3 * 2) / 3600, 12)
  })

  it.each(['LargeQwen', 'LargeQwenThink', 'SmallQwen', 'PrivateSystemOne'])(
    'leaves unmeasured %s cost unknown',
    (client) => {
      for (const durationMs of [undefined, Number.NaN, -1])
        expect(estimateLlmCostEur(ONE_MTOK_EACH, client, { durationMs })).toBeUndefined()
    },
  )

  it('is €/h × wall-clock, and tokens do not enter it', () => {
    const oneHour = estimateLlmCostEur(NO_TOKENS, 'SmallQwen', {
      durationMs: 3_600_000,
      eurPerHour: SMALL_MODAL_EXPECTED,
    })!
    expect(oneHour.basis).toBe('time')
    expect(oneHour.costEur).toBeCloseTo(SMALL_MODAL_EXPECTED, 9)

    // Same duration, a huge token count: identical cost. Tokens are free.
    const withTokens = estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', {
      durationMs: 3_600_000,
      eurPerHour: SMALL_MODAL_EXPECTED,
    })!
    expect(withTokens.costEur).toBeCloseTo(oneHour.costEur, 12)
  })

  it('prices a realistic call in fractions of a cent', () => {
    // A describe-tier call on the metered small box, at the default rate.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', { durationMs: 4_100 })!
    expect(est.costEur).toBeCloseTo((4.1 / 3600) * DEFAULT_SMALL_LLM_EUR_PER_HOUR, 12)
    expect(est.timeRate).toEqual({ eurPerHour: DEFAULT_SMALL_LLM_EUR_PER_HOUR, durationMs: 4_100 })
  })

  it('the 27B box rate prices the 27B calls again (2026-10-13 metered infrastructure)', () => {
    // DEFAULT_LARGE_LLM_EUR_PER_HOUR prices the large GPU's calls' wall-clock
    // once more: the owner's 2026-10-13 decision puts the box's clients back on
    // the time basis. It never stopped feeding the eval's INFRASTRUCTURE
    // accounting (scenario wall-clock on the boxes).
    expect(DEFAULT_LARGE_LLM_EUR_PER_HOUR).toBe(LARGE_MODAL_EXPECTED)
    // The 27B leaves are the entries on this rate; the small box's clients ride
    // the small rate.
    expect(TIME_PRICED_CLIENTS.LargeQwen).toBe(DEFAULT_LARGE_LLM_EUR_PER_HOUR)
    expect(TIME_PRICED_CLIENTS.LargeQwenThink).toBe(DEFAULT_LARGE_LLM_EUR_PER_HOUR)
    for (const name of ['SmallQwen', 'PrivateSystemOne'])
      expect(TIME_PRICED_CLIENTS[name]).toBe(DEFAULT_SMALL_LLM_EUR_PER_HOUR)
  })

  it('offers no caching savings — caching cannot save wall-clock', () => {
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', { durationMs: 5_000 })!
    expect(est.noCacheEur).toBe(est.costEur)
    expect(est.rates).toBeUndefined()
  })

  it('an idle box costs nothing: zero duration is zero, not a minimum charge', () => {
    const est = estimateLlmCostEur(NO_TOKENS, 'SmallQwen', { durationMs: 0 })!
    expect(est.costEur).toBe(0)
    expect(est.basis).toBe('time')
  })

  it('is UNDEFINED, not zero, when the call was not measured', () => {
    // A time bill with no time is not a free call. BAML reports no duration when
    // it measured none, and a 0 here would render as "this call cost nothing" on
    // a box that was demonstrably awake to answer it.
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen')).toBeUndefined()
    expect(
      estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', { durationMs: undefined }),
    ).toBeUndefined()
    expect(
      estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', { durationMs: Number.NaN }),
    ).toBeUndefined()
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', { durationMs: -1 })).toBeUndefined()
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
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', { durationMs: 1_000 })!
    expect(est.basis).toBe('time')
    expect(est.rates).toBeUndefined()
    // Nothing anywhere near a per-MTok figure.
    expect(est.costEur).toBeLessThan(0.001)
  })

  it('a provider-priced client never gets wall-clock or token pricing', () => {
    // The attribution rule with teeth: the provider reported the cost, so
    // neither a €/h rate nor an invented per-MTok rate may price the call,
    // however long it ran or however many tokens it moved.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwenOR', {
      durationMs: 600_000,
      eurPerHour: 1_000_000,
      providerCostUsd: 0.01,
    })!
    expect(est.basis).toBe('provider')
    expect(est.timeRate).toBeUndefined()
    expect(est.rates).toBeUndefined()
    expect(est.costEur).toBeCloseTo(0.01 * DEFAULT_EUR_PER_USD, 12)
  })

  it('a time-priced 27B client never gets provider pricing, even if a cost rode along', () => {
    // The 2026-10-13 decision's attribution rule: the metered box's bill is
    // wall-clock, so a provider-reported figure on the response changes
    // nothing about what the call costs.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwen', {
      durationMs: 6_000,
      providerCostUsd: 0.01,
    })!
    expect(est.basis).toBe('time')
    expect(est.timeRate).toEqual({ eurPerHour: LARGE_MODAL_EXPECTED, durationMs: 6_000 })
    expect(est.costEur).toBeCloseTo((LARGE_MODAL_EXPECTED * 6) / 3600, 12)
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

  it('every client the private tier routes a role to has a pricing basis, never silently unknown when measurable', async () => {
    // Derived from the route map rather than listed, so a role added to the tier
    // with a client in none of the four sets fails here. No value in the map is
    // provider-priced today, so the provider figure below is inert for the
    // current sets; it is passed anyway so a FUTURE provider-priced map value
    // is priced WITH the provider figure rather than unknown — the no-cost
    // reading is pinned in the provider describe above.
    const { SELF_DEPLOYED_CLIENT_BY_ROLE } = await import('@hames-ai/harness-baml/clients.server')
    const clients = new Set(Object.values(SELF_DEPLOYED_CLIENT_BY_ROLE))
    expect(clients).toContain('PrivateSystemOne')
    for (const name of clients) {
      const est = estimateLlmCostEur(ONE_MTOK_EACH, name, {
        durationMs: 4_000,
        providerCostUsd: 0.01,
      })
      expect(est, name).toBeDefined()
    }
    // The private systemone client shares the metered small box.
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'PrivateSystemOne', { durationMs: 4000 })?.basis).toBe(
      'time',
    )
    // The 27B leaves answer on the metered box's wall-clock (2026-10-13).
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwen', { durationMs: 4000 })?.basis).toBe('time')
  })

  it('the local set and the two priced tables are disjoint', () => {
    // A client in two of them would price by whichever branch ran first, which
    // is exactly the silent-wrong-figure failure this suite exists for.
    for (const name of LOCAL_PRICED_CLIENTS) {
      expect(CLIENT_PRICING[name], name).toBeUndefined()
      expect(Object.hasOwn(TIME_PRICED_CLIENTS, name), name).toBe(false)
    }
  })

  it('the provider-cost set is the fourth basis and is disjoint from the other three (#418 T4)', () => {
    // JevDecide was the first; the OpenRouter-route twins joined with the
    // reasoning-config slice — a per-token public API has no GPU-hour bill, so
    // those calls price off the reported cost. The box twins LEFT with the
    // 2026-10-13 metered-infrastructure decision: their endpoint is the metered
    // large GPU, so their bill is wall-clock again (TIME_PRICED_CLIENTS).
    expect([...PROVIDER_COST_CLIENTS].sort()).toEqual([
      'JevDecide',
      'LargeQwenOR',
      'LargeQwenThinkOR',
    ])
    for (const name of PROVIDER_COST_CLIENTS) {
      expect(CLIENT_PRICING[name], name).toBeUndefined()
      expect(LOCAL_PRICED_CLIENTS.has(name), name).toBe(false)
      expect(Object.hasOwn(TIME_PRICED_CLIENTS, name), name).toBe(false)
    }
  })

  it('a provider-priced call is the reported USD × EUR_PER_USD, unknown when none was reported', () => {
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'JevDecide', { providerCostUsd: 0.01 })
    expect(est).toMatchObject({ basis: 'provider' })
    expect(est!.costEur).toBeCloseTo(0.01 * DEFAULT_EUR_PER_USD, 12)
    expect(est!.noCacheEur).toBe(est!.costEur)
    expect(
      estimateLlmCostEur(ONE_MTOK_EACH, 'JevDecide', { eurPerUsd: 0.5, providerCostUsd: 0.01 })!
        .costEur,
    ).toBeCloseTo(0.005, 12)
    // Tokens alone never price it: no invented per-MTok rate.
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'JevDecide')).toBeUndefined()
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'JevDecide', { providerCostUsd: -1 })).toBeUndefined()
  })

  it('every client in CLIENT_PRICING prices by tokens', () => {
    for (const name of Object.keys(CLIENT_PRICING)) {
      const est = estimateLlmCostEur(ONE_MTOK_EACH, name, { durationMs: 60_000 })
      expect(est, name).toBeDefined()
      expect(est!.basis, name).toBe('tokens')
    }
  })
})

describe('persisted client names keep their pricing basis', () => {
  // Saved conversations carry the pre-rename `llmCall.clientName`. They are read
  // through the one alias table in settings.ts; dropping it turns every stored
  // step on the box into "cost unknown" (mutation: `legacy-client-alias`).
  it('maps the three legacy names to the new ones, and nothing else', () => {
    expect(LEGACY_CLIENT_NAMES).toEqual({
      VerdaQwen: 'LargeQwen',
      VerdaQwenThink: 'LargeQwenThink',
      LocalQwenSmall: 'SmallQwen',
    })
    expect(canonicalClientName('VerdaQwen')).toBe('LargeQwen')
    expect(canonicalClientName('LargeQwen')).toBe('LargeQwen')
    expect(canonicalClientName('toString')).toBe('toString')
    expect(canonicalClientName(undefined)).toBeUndefined()
    for (const name of Object.values(LEGACY_CLIENT_NAMES))
      expect(name in LEGACY_CLIENT_NAMES).toBe(false)
  })

  it.each([
    ['VerdaQwen', 'LargeQwen', 'time'],
    ['VerdaQwenThink', 'LargeQwenThink', 'time'],
    ['LocalQwenSmall', 'SmallQwen', 'time'],
  ] as const)('a stored %s step prices exactly as %s does', (stored, current, basis) => {
    // On the time basis (the 27B leaves since the 2026-10-13 decision), a
    // stored 27B name prices wall-clock — the SAME statement the pre-eval test
    // made. The alias must not change what a stored step costs to read, only
    // the name that gets there.
    const opts = { durationMs: 4_000 }
    expect(estimateLlmCostEur(ONE_MTOK_EACH, stored, opts)).toEqual(
      estimateLlmCostEur(ONE_MTOK_EACH, current, opts),
    )
    expect(estimateLlmCostEur(ONE_MTOK_EACH, stored, opts)!.basis).toBe(basis)
  })

  it('a stored 27B step prices wall-clock again; without a duration it reads unknown', () => {
    // The 27B leaves came back to the time basis with the 2026-10-13
    // metered-infrastructure decision: a fresh estimate of a stored 27B step
    // prices wall-clock. Without a measured duration it reads unknown — a time
    // bill with no time is not a free call — never a confident figure from the
    // wrong model.
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'VerdaQwen')).toBeUndefined()
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'VerdaQwenThink')).toBeUndefined()
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'VerdaQwen', { durationMs: 4_000 })!.basis).toBe(
      'time',
    )
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'VerdaQwenThink', { durationMs: 4_000 })!.basis).toBe(
      'time',
    )
  })

  it('the local basis is LocalGLM alone and is untouched by the alias', () => {
    expect([...LOCAL_PRICED_CLIENTS]).toEqual(['LocalGLM'])
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'LocalGLM')).toMatchObject({
      basis: 'local',
      costEur: 0,
    })
  })

  it('the observability panel shows the current name for a stored one', () => {
    const tabs = readFileSync(
      join(__dirname, '../../components/ark-ui/observability/LLMCallTabs.tsx'),
      'utf8',
    )
    expect(tabs).toContain('{canonicalClientName(props.llmCall.clientName)}')
  })

  it('the three pricing sets stay disjoint under the new names', () => {
    const token = new Set(Object.keys(CLIENT_PRICING))
    const time = new Set(Object.keys(TIME_PRICED_CLIENTS))
    for (const name of [...LOCAL_PRICED_CLIENTS, ...PROVIDER_COST_CLIENTS, ...time, ...token]) {
      const homes = [
        token.has(name),
        time.has(name),
        LOCAL_PRICED_CLIENTS.has(name),
        PROVIDER_COST_CLIENTS.has(name),
      ].filter(Boolean)
      expect(homes.length, name).toBe(1)
      // A legacy spelling is an alias, never a second entry in any table.
      expect(name in LEGACY_CLIENT_NAMES, name).toBe(false)
    }
  })
})

describe('the env overrides (cost-rates.server.ts)', () => {
  const saved = {
    usd: process.env.EUR_PER_USD,
    self_deployed: process.env.LARGE_LLM_EUR_PER_HOUR,
    small: process.env.SMALL_LLM_EUR_PER_HOUR,
  }

  afterEach(() => {
    if (saved.usd === undefined) delete process.env.EUR_PER_USD
    else process.env.EUR_PER_USD = saved.usd
    if (saved.self_deployed === undefined) delete process.env.LARGE_LLM_EUR_PER_HOUR
    else process.env.LARGE_LLM_EUR_PER_HOUR = saved.self_deployed
    if (saved.small === undefined) delete process.env.SMALL_LLM_EUR_PER_HOUR
    else process.env.SMALL_LLM_EUR_PER_HOUR = saved.small
    vi.restoreAllMocks()
  })

  it('reads the small GPU rate per call with positive finite validation', async () => {
    const { smallLlmEurPerHour } = await import('../../lib/cost-rates.server')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const raw of [undefined, '', '   ']) {
      if (raw === undefined) delete process.env.SMALL_LLM_EUR_PER_HOUR
      else process.env.SMALL_LLM_EUR_PER_HOUR = raw
      expect(smallLlmEurPerHour()).toBe(SMALL_MODAL_EXPECTED)
    }
    for (const raw of ['2.5', '3']) {
      process.env.SMALL_LLM_EUR_PER_HOUR = raw
      expect(smallLlmEurPerHour()).toBe(Number(raw))
    }
    for (const raw of ['0', '-1', 'free', 'NaN', 'Infinity']) {
      process.env.SMALL_LLM_EUR_PER_HOUR = raw
      expect(smallLlmEurPerHour(), raw).toBe(SMALL_MODAL_EXPECTED)
    }
    expect(warn).toHaveBeenCalledTimes(5)
  })

  it('reads both rates, per call, so a host change needs no rebuild', async () => {
    const { eurPerUsdRate, largeEurPerHour } = await import('../../lib/cost-rates.server')
    process.env.EUR_PER_USD = '0.9'
    process.env.LARGE_LLM_EUR_PER_HOUR = '2.5'
    expect(eurPerUsdRate()).toBe(0.9)
    expect(largeEurPerHour()).toBe(2.5)
    // Changed again without re-importing the module:
    process.env.LARGE_LLM_EUR_PER_HOUR = '3'
    expect(largeEurPerHour()).toBe(3)
  })

  it('converts each Modal default once at the configured FX rate, then honors hourly overrides', async () => {
    const { largeEurPerHour, smallLlmEurPerHour } = await import('../../lib/cost-rates.server')
    delete process.env.LARGE_LLM_EUR_PER_HOUR
    delete process.env.SMALL_LLM_EUR_PER_HOUR
    process.env.EUR_PER_USD = '0.9'
    expect(largeEurPerHour()).toBeCloseTo(LARGE_MODAL_EXPECTED * (0.9 / 0.86), 12)
    expect(smallLlmEurPerHour()).toBeCloseTo(SMALL_MODAL_EXPECTED * (0.9 / 0.86), 12)
    process.env.LARGE_LLM_EUR_PER_HOUR = '7'
    process.env.SMALL_LLM_EUR_PER_HOUR = '2'
    expect(largeEurPerHour()).toBe(7)
    expect(smallLlmEurPerHour()).toBe(2)
  })

  it('falls back to the defaults when unset or blank', async () => {
    const { eurPerUsdRate, largeEurPerHour } = await import('../../lib/cost-rates.server')
    delete process.env.EUR_PER_USD
    delete process.env.LARGE_LLM_EUR_PER_HOUR
    expect(eurPerUsdRate()).toBe(DEFAULT_EUR_PER_USD)
    expect(largeEurPerHour()).toBe(DEFAULT_LARGE_LLM_EUR_PER_HOUR)
    process.env.EUR_PER_USD = '   '
    expect(eurPerUsdRate()).toBe(DEFAULT_EUR_PER_USD)
  })

  it('warns and falls back on a non-positive or garbage rate, never renders free', async () => {
    const { largeEurPerHour } = await import('../../lib/cost-rates.server')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['0', '-1', 'free', 'NaN']) {
      process.env.LARGE_LLM_EUR_PER_HOUR = bad
      expect(largeEurPerHour(), bad).toBe(DEFAULT_LARGE_LLM_EUR_PER_HOUR)
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
    const { fmtEur } = await import('@hames-ai/harness-patterns/observability/token-totals')
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
