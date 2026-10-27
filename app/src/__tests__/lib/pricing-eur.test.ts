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
 *  2. **Time-priced clients** (`SmallQwen` / `PrivateSystemOne`, the metered
 *     small GPU) are `€/h × measured wall-clock`, and `undefined` — not zero —
 *     when nothing measured the call. A time bill with no time is not a free
 *     call.
 *  3. **Provider-priced clients** (`JevDecide`, and since the OpenRouter eval
 *     the two 27B leaves) are the provider's own reported `usage.cost`,
 *     converted once at the static rate. The large box's wall-clock is the
 *     WRONG model for a per-token public API; unknown (not zero) when the
 *     provider reported nothing.
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
    // The 27B leaves are NOT here any more: with the large endpoint on
    // OpenRouter during the eval, a wall-clock bill is the wrong model for
    // their calls — they price off the provider's own usage.cost (the
    // provider-cost set below). This box's rate stays for the INFRASTRUCTURE
    // accounting the eval charges separately.
    expect(TIME_PRICED_CLIENTS).toEqual({
      SmallQwen: 1.54,
      PrivateSystemOne: 1.54,
    })
  })

  it('keeps every time-priced client out of the token, local and provider sets', () => {
    for (const name of Object.keys(TIME_PRICED_CLIENTS)) {
      expect(CLIENT_PRICING[name], name).toBeUndefined()
      expect(LOCAL_PRICED_CLIENTS.has(name), name).toBe(false)
      expect(PROVIDER_COST_CLIENTS.has(name), name).toBe(false)
    }
    expect(LOCAL_PRICED_CLIENTS.has('LocalGLM')).toBe(true)
    // The 27B leaves left this table for the provider basis, and took the
    // thinking twin with them — same model, same endpoint, same bill.
    for (const name of ['LargeQwen', 'LargeQwenThink']) {
      expect(Object.hasOwn(TIME_PRICED_CLIENTS, name), name).toBe(false)
      expect(PROVIDER_COST_CLIENTS.has(name), name).toBe(true)
    }
  })
})

describe('provider pricing → EUR', () => {
  it('prices the 27B leaves from the provider-reported cost, unknown when none was reported', () => {
    for (const name of ['LargeQwen', 'LargeQwenThink', 'JevDecide']) {
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
    for (const name of ['LargeQwen', 'LargeQwenThink']) {
      expect(estimateLlmCostEur(ONE_MTOK_EACH, name), name).toBeUndefined()
      expect(
        estimateLlmCostEur(ONE_MTOK_EACH, name, { durationMs: 6_300, eurPerHour: 1.819 }),
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
    const at1 = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwen', {
      providerCostUsd: 0.01,
      eurPerUsd: 1,
    })!
    const atHalf = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwen', {
      providerCostUsd: 0.01,
      eurPerUsd: 0.5,
    })!
    expect(atHalf.costEur).toBeCloseTo(at1.costEur / 2, 12)
  })

  it('a zero reported cost is a zero bill, not unknown', () => {
    // `0` is a measurement the provider made; only an ABSENT one is unknown.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwen', { providerCostUsd: 0 })!
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
  it.each(['SmallQwen', 'PrivateSystemOne'])(
    'prices %s at €1.54/h and accepts an explicit rate',
    (client) => {
      expect(DEFAULT_SMALL_LLM_EUR_PER_HOUR).toBe(1.54)
      const est = estimateLlmCostEur(ONE_MTOK_EACH, client, { durationMs: 2_000 })!
      expect(est.basis).toBe('time')
      expect(est.costEur).toBeCloseTo((1.54 * 2) / 3600, 12)
      expect(est.timeRate).toEqual({ eurPerHour: 1.54, durationMs: 2_000 })
      expect(est.noCacheEur).toBe(est.costEur)
      expect(
        estimateLlmCostEur(NO_TOKENS, client, {
          durationMs: 2_000,
          eurPerHour: 3,
        })!.costEur,
      ).toBeCloseTo((3 * 2) / 3600, 12)
    },
  )

  it.each(['SmallQwen', 'PrivateSystemOne'])('leaves unmeasured %s cost unknown', (client) => {
    for (const durationMs of [undefined, Number.NaN, -1])
      expect(estimateLlmCostEur(ONE_MTOK_EACH, client, { durationMs })).toBeUndefined()
  })

  it('is €/h × wall-clock, and tokens do not enter it', () => {
    const oneHour = estimateLlmCostEur(NO_TOKENS, 'SmallQwen', {
      durationMs: 3_600_000,
      eurPerHour: 1.54,
    })!
    expect(oneHour.basis).toBe('time')
    expect(oneHour.costEur).toBeCloseTo(1.54, 9)

    // Same duration, a huge token count: identical cost. Tokens are free.
    const withTokens = estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', {
      durationMs: 3_600_000,
      eurPerHour: 1.54,
    })!
    expect(withTokens.costEur).toBeCloseTo(oneHour.costEur, 12)
  })

  it('prices a realistic call in fractions of a cent', () => {
    // A describe-tier call on the metered small box, at the default rate.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'SmallQwen', { durationMs: 4_100 })!
    expect(est.costEur).toBeCloseTo((4.1 / 3600) * DEFAULT_SMALL_LLM_EUR_PER_HOUR, 12)
    expect(est.timeRate).toEqual({ eurPerHour: DEFAULT_SMALL_LLM_EUR_PER_HOUR, durationMs: 4_100 })
  })

  it('the 27B box rate stays exported for the INFRASTRUCTURE accounting, not for calls', () => {
    // DEFAULT_LARGE_LLM_EUR_PER_HOUR no longer prices any CALL: the 27B leaves
    // are provider-priced. It survives as the box's rate for the eval's
    // infrastructure accounting (scenario wall-clock on the boxes) and the
    // operator override that feeds it.
    expect(DEFAULT_LARGE_LLM_EUR_PER_HOUR).toBe(1.819)
    // No call on any client prices off it any more: the time set holds only
    // the small box's clients, at the small rate.
    for (const name of Object.keys(TIME_PRICED_CLIENTS))
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
    // The 27B eval's attribution rule with teeth: the provider reported the
    // cost, so neither the box's €/h nor an invented per-MTok rate may price
    // the call, however long it ran or however many tokens it moved.
    const est = estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwen', {
      durationMs: 600_000,
      eurPerHour: 1_000_000,
      providerCostUsd: 0.01,
    })!
    expect(est.basis).toBe('provider')
    expect(est.timeRate).toBeUndefined()
    expect(est.rates).toBeUndefined()
    expect(est.costEur).toBeCloseTo(0.01 * DEFAULT_EUR_PER_USD, 12)
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
    // with a client in none of the four sets fails here. The provider-priced
    // leaves are measurable only when the provider reported a cost — the
    // owner's recorded consequence of the OpenRouter eval switch — so this
    // prices them WITH the provider figure; the no-cost reading is pinned in
    // the provider describe above.
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
    // The 27B leaves answer on the provider basis, not the box's wall-clock.
    expect(
      estimateLlmCostEur(ONE_MTOK_EACH, 'LargeQwen', {
        durationMs: 4000,
        providerCostUsd: 0.01,
      })?.basis,
    ).toBe('provider')
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
    // JevDecide was the first; the 27B leaves joined when the eval pointed
    // LARGE_LLM_BASE_URL at OpenRouter and the box's wall-clock stopped being
    // the right bill for their calls; the OpenRouter-route twins joined with
    // the reasoning-config slice — same basis, the route changes the wire
    // shape, never the pricing.
    expect([...PROVIDER_COST_CLIENTS].sort()).toEqual([
      'JevDecide',
      'LargeQwen',
      'LargeQwenOR',
      'LargeQwenThink',
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
    ['VerdaQwen', 'LargeQwen', 'provider'],
    ['VerdaQwenThink', 'LargeQwenThink', 'provider'],
    ['LocalQwenSmall', 'SmallQwen', 'time'],
  ] as const)('a stored %s step prices exactly as %s does', (stored, current, basis) => {
    // Under the provider basis (the 27B leaves since the OpenRouter eval), a
    // stored 27B name prices from the provider-reported cost — the SAME
    // statement the old test made on the time basis. The alias must not
    // change what a stored step costs to read, only the name that gets there.
    const opts =
      basis === 'provider' ? { providerCostUsd: 0.01, durationMs: 4_000 } : { durationMs: 4_000 }
    expect(estimateLlmCostEur(ONE_MTOK_EACH, stored, opts)).toEqual(
      estimateLlmCostEur(ONE_MTOK_EACH, current, opts),
    )
    expect(estimateLlmCostEur(ONE_MTOK_EACH, stored, opts)!.basis).toBe(basis)
  })

  it('a stored 27B step without a reported provider cost reads unknown — the recorded consequence', () => {
    // The 27B leaves left the time basis when the large endpoint moved to
    // OpenRouter: a pre-switch VerdaQwen step was STAMPED time-priced at write
    // time and renders its stored figure, but a fresh estimate of such a call
    // without a provider cost is unknown, never the box's wall-clock floor.
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'VerdaQwen')).toBeUndefined()
    expect(estimateLlmCostEur(ONE_MTOK_EACH, 'VerdaQwenThink')).toBeUndefined()
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
      expect(smallLlmEurPerHour()).toBe(1.54)
    }
    for (const raw of ['2.5', '3']) {
      process.env.SMALL_LLM_EUR_PER_HOUR = raw
      expect(smallLlmEurPerHour()).toBe(Number(raw))
    }
    for (const raw of ['0', '-1', 'free', 'NaN', 'Infinity']) {
      process.env.SMALL_LLM_EUR_PER_HOUR = raw
      expect(smallLlmEurPerHour(), raw).toBe(1.54)
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
