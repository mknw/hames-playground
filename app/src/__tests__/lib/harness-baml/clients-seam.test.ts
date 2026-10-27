/**
 * The harness client seam — the host-side configuration feed (PR-1a of the
 * #225 extraction).
 *
 * Before the split, `harness-baml/clients.server.ts` imported the app's env
 * policy (`lib/inference/*`), the model tables (`lib/settings`) and the EUR
 * rates (`lib/cost-rates.server`) directly: one app, one module graph, so
 * "the app's configuration reaches the resolution" was true BY CONSTRUCTION.
 * The split makes it true by RESOLUTION instead — the host registers the
 * tables, the tier policy and the cost rates through the three `configure*`
 * accessors at its composition root (`lib/inference/config.server.ts`), and
 * the resolution reads them through module-level accessors with safe
 * package-side defaults. Those are the same module only as long as every
 * bundler on the path resolves it once; if one ever doesn't, the registration
 * lands in one instance while the resolution reads another's defaults — the
 * same silent-scope-loss class the #342 seam pin exists for.
 *
 * Mutation-checked (the #342 dual-instance template): pointing the module's
 * READERS at a second store — a second AsyncLocalStorage for the tier scope,
 * a second tables/hook/rates slot — leaves the surrounding suites green and
 * turns the tests here RED. Every mutation below was run and its red is
 * recorded in the PR (verified by mutation, not by reading).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resetTierPolicy } from '../../mocks/reset-tier-policy'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// The wake notice is mocked so the composition root's registered
// `onPrivateCallStart` filter is OBSERVABLE: a private-tier call on the
// client announces the matching box, including the 4B summarizer.
const noteBoxCallStarting = vi.fn()
vi.mock('../../../lib/inference/cold-start.server', () => ({
  noteBoxCallStarting: (...args: unknown[]) => noteBoxCallStarting(...args),
}))

const CLIENTS = '@hames-ai/harness-baml/clients.server'
const CONFIG = '../../../lib/inference/config.server'
const SETTINGS = '../../../lib/settings'

const ENV_KEYS = [
  'USE_SELF_DEPLOYED_INFERENCE',
  'LARGE_LLM_BASE_URL',
  'LARGE_LLM_API_KEY',
  'SMALL_LLM_BASE_URL',
  'SMALL_LLM_DECISIONS_URL',
  'SMALL_LLM_API_KEY',
  'EUR_PER_USD',
  'LARGE_LLM_EUR_PER_HOUR',
  'SMALL_LLM_EUR_PER_HOUR',
] as const

let saved: Record<string, string | undefined>

function enable(): void {
  process.env.USE_SELF_DEPLOYED_INFERENCE = '1'
  process.env.LARGE_LLM_BASE_URL = 'https://example.invalid/deployment/v1'
  process.env.LARGE_LLM_API_KEY = 'test-key'
  process.env.SMALL_LLM_DECISIONS_URL = 'https://private.example/v1/systemone'
  process.env.SMALL_LLM_API_KEY = 'synthetic-private-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.resetModules()
  resetTierPolicy()
  noteBoxCallStarting.mockClear()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** The composition root, then the seam — the wiring every production path
 *  takes (turn runner → tier.server → config.server → clients.server). */
async function loadWired() {
  await import(CONFIG)
  const clients = await import(CLIENTS)
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  // #374: the tier is a SLOT of the run frame, and the fail-closed reachability
  // check the old opener made on the way in is now the host-called
  // `assertInferenceTier`. Bound together here — both, in that order, is what a
  // turn does — so the seam assertions below are unchanged.
  const runWithInferenceTier = async <T>(
    tier: 'self_deployed' | 'anthropic',
    fn: () => Promise<T>,
  ): Promise<T> => {
    clients.assertInferenceTier(tier)
    return withRunFrame({ inference: { tier } }, fn)
  }
  return { ...clients, runWithInferenceTier }
}

describe('the configuration the host registers is the configuration the resolution reads', () => {
  it('a self_deployed scope flows through the seam: override, tables and hook all land', async () => {
    enable()
    const clients = await loadWired()

    await clients.runWithInferenceTier('self_deployed', async () => {
      // The override names the client the host's tables know.
      expect(clients.clientOverrideFor('planner')).toEqual({ client: 'LargeQwen' })
      // The host's model tables: 131 072 window and 4 096 cap for LargeQwen —
      // impossible from the package-side defaults (16 384 / undefined), so
      // these two numbers are a direct readout of which store answered.
      expect(clients.getContextWindow('LargeQwen')).toBe(131_072)
      expect(clients.limitsFor('planner')).toEqual({
        contextWindow: 131_072,
        maxOutputTokens: 4_096,
      })
      // The hook fired for the scale-to-zero client — the composition root's
      // registered filter announced the call to the cold-start module.
      expect(noteBoxCallStarting).toHaveBeenCalled()
    })
  })

  it('the SCOPE, not the host default, is what the resolution reads', async () => {
    // The host's default is the self-deployed tier (the one tier rule), flag OFF
    // and endpoints present (so the default is reachable). The #342 M1 lesson:
    // a mutation that points the reader at a second AsyncLocalStorage passes
    // every default-tier test — a scope that agrees with the default routes
    // exactly like it — and only a test that holds the default at
    // 'self_deployed' while the scope says 'anthropic' catches it.
    process.env.LARGE_LLM_BASE_URL = 'https://example.invalid/deployment/v1'
    process.env.LARGE_LLM_API_KEY = 'test-key'
    process.env.SMALL_LLM_DECISIONS_URL = 'https://private.example/v1/systemone'
    process.env.SMALL_LLM_API_KEY = 'synthetic-private-key'
    process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
    const clients = await loadWired()

    expect(clients.activeInferenceTier()).toBe('self_deployed')
    await clients.runWithInferenceTier('anthropic', async () => {
      expect(clients.activeInferenceTier()).toBe('anthropic')
      expect(clients.clientOverrideFor('controller')).toBeUndefined()
    })
    expect(clients.activeInferenceTier()).toBe('self_deployed')
  })

  it('the 4B summarizer takes the override and announces its own box', async () => {
    enable()
    const clients = await loadWired()

    await clients.runWithInferenceTier('self_deployed', async () => {
      expect(clients.clientOverrideFor('describe')).toEqual({ client: 'SmallQwen' })
      expect(noteBoxCallStarting).toHaveBeenCalledWith('small')
    })
  })

  it('the host default flows: an unfilled frame routes to the self-deployed tier with the flag unset too', async () => {
    // The flag is the BOOT-time switch, not the tier of a run that names none.
    process.env.LARGE_LLM_BASE_URL = 'https://example.invalid/deployment/v1'
    process.env.LARGE_LLM_API_KEY = 'test-key'
    process.env.SMALL_LLM_DECISIONS_URL = 'https://private.example/v1/systemone'
    process.env.SMALL_LLM_API_KEY = 'synthetic-private-key'
    process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
    const clients = await loadWired()

    expect(process.env.USE_SELF_DEPLOYED_INFERENCE).toBeUndefined()
    expect(clients.activeInferenceTier()).toBe('self_deployed')
    expect(clients.clientOverrideFor('controller')).toEqual({ client: 'LargeQwen' })
  })

  it('a self_deployed scope is checked through the registered assert, not opened blind', async () => {
    // Registered directly rather than via the composition root: with the flag
    // on and the env missing, config.server's own module-load check throws at
    // import (its own pin, in clients-self-deployed.test.ts). This test isolates the
    // gate itself — `assertInferenceTier` consulting `assertTierReachable`.
    //
    // #374 moved the tier onto core's generic run frame, which cannot know what
    // 'self_deployed' means, so the gate is no longer on the way INTO a scope: it is
    // this exported check, and the host calls it before it puts a tier in a
    // frame (`turn.server.ts`). Asserted against the check rather than through
    // a frame, because the check is now the whole of the refusal.
    const clients = await import(CLIENTS)
    clients.configureInferencePolicy({
      defaultTier: () => 'anthropic',
      assertTierReachable: () => {
        throw new Error('fixture assert: the scope is not reachable')
      },
    })
    expect(() => clients.assertInferenceTier('self_deployed')).toThrow(
      /fixture assert: the scope is not reachable/,
    )
    // And the anthropic position is never gated — it needs no endpoint.
    expect(() => clients.assertInferenceTier('anthropic')).not.toThrow()
  })

  it('prices small summaries through the host mapping, including floors and missing timing', async () => {
    enable()
    await loadWired()
    const { computeEventMetrics } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { isTimePricedStep } = await import('@hames-ai/harness-patterns/metrics/aggregate')
    const collector = (durationMs?: number) => ({
      logs: [
        {
          calls: [
            {
              clientName: 'SmallQwen',
              timing: { durationMs },
            },
          ],
        },
      ],
    })
    const measured = computeEventMetrics(collector(2_000) as never)!
    expect(measured.attempts).toBe(1)
    expect(measured.costEur).toBeCloseTo((1.54 * 2) / 3600, 12)
    expect(measured.basis).toBe('time')
    expect(measured.timeRate).toEqual({ eurPerHour: 1.54, durationMs: 2_000 })
    expect(measured.timePricedAttempts).toBe(1)
    expect(isTimePricedStep(measured)).toBe(true)
    expect(measured.inputUncachedTokens).toBe(0)
    for (const rate of ['2.5', '3']) {
      process.env.SMALL_LLM_EUR_PER_HOUR = rate
      expect(computeEventMetrics(collector(2_000) as never)!.costEur).toBeCloseTo(
        (Number(rate) * 2) / 3600,
        12,
      )
    }
    const unknown = computeEventMetrics(collector() as never)!
    expect(unknown.attempts).toBe(1)
    expect(unknown.costEur).toBeUndefined()
    expect(unknown.basis).toBeUndefined()
  })

  it('registers exactly the time-priced clients settings.ts prices', async () => {
    const clients = await loadWired()
    const { TIME_PRICED_CLIENTS } = await import(SETTINGS)
    expect(Object.keys(clients.activeCostPricing().timePricedClients ?? {}).sort()).toEqual(
      Object.keys(TIME_PRICED_CLIENTS).sort(),
    )
  })

  it('prices a step spanning the provider and time bases independently', async () => {
    // Each attempt under its OWN client's basis: the 27B leaf off the
    // provider-reported cost, the metered 4B off wall-clock. Pricing either
    // by the other's model would bill one of the two wrong.
    await loadWired()
    const { computeEventMetrics } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { DEFAULT_EUR_PER_USD } = await import(SETTINGS)
    const collector = {
      logs: [
        {
          calls: [
            {
              clientName: 'LargeQwen',
              httpResponse: {
                body: {
                  json: () => ({ usage: { input_tokens: 10, output_tokens: 2, cost: 0.02 } }),
                },
              },
              timing: { durationMs: 2_000 },
            },
            {
              clientName: 'SmallQwen',
              timing: { durationMs: 2_000 },
            },
          ],
        },
      ],
    }
    const measured = computeEventMetrics(collector as never)!
    expect(measured.costEur).toBeCloseTo(0.02 * DEFAULT_EUR_PER_USD + (1.54 * 2) / 3600, 12)
    expect(measured.timePricedAttempts).toBe(1)
    expect(measured.timeRate?.durationMs).toBe(2_000)
  })

  it('retains the published single-client pricing registration', async () => {
    const clients = await loadWired()
    const { estimateLlmCostEur } = await import(SETTINGS)
    clients.configureCostPricing({
      estimate: estimateLlmCostEur,
      // The deprecated compat form: ONE client, and its rate source is the
      // large-box reader regardless of which client is named — its documented
      // shape since the multi-client map arrived.
      timePricedClient: 'SmallQwen',
    })
    process.env.LARGE_LLM_EUR_PER_HOUR = '4'
    const { computeEventMetrics } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const measured = computeEventMetrics({
      logs: [
        {
          calls: [
            {
              clientName: 'SmallQwen',
              timing: { durationMs: 2_000 },
            },
          ],
        },
      ],
    } as never)!
    expect(measured.costEur).toBeCloseTo((4 * 2) / 3600, 12)
    expect(measured.timePricedAttempts).toBe(1)
  })

  it('the host EUR rates flow through the seam, env override included', async () => {
    enable()
    process.env.EUR_PER_USD = '1.25'
    process.env.LARGE_LLM_EUR_PER_HOUR = '2.5'
    await loadWired()
    const bamlAdapters = await import('@hames-ai/harness-baml/baml-adapters.server')
    // computeEventMetrics reads the rates through the seam per step; reading
    // the same store here proves which one is live.
    const { activeCostRates } = await import(CLIENTS)
    expect(activeCostRates().eurPerUsd()).toBe(1.25)
    expect(activeCostRates().largeEurPerHour()).toBe(2.5)
    expect(bamlAdapters).toBeDefined()
  })
})

describe('unregistered — the package-side defaults are safe', () => {
  it('the default tier is anthropic and an unregistered self_deployed scope is REFUSED', async () => {
    enable() // env alone must not route anything: registration is the act, not the flag
    const clients = await import(CLIENTS)

    expect(clients.activeInferenceTier()).toBe('anthropic')
    expect(clients.clientOverrideFor('controller')).toBeUndefined()
    expect(() => clients.assertInferenceTier('self_deployed')).toThrow(
      /no inference policy is registered/,
    )
  })

  it('unknown clients keep the documented fallbacks with no tables registered', async () => {
    const clients = await import(CLIENTS)
    expect(clients.getContextWindow('LargeQwen')).toBe(16_384)
    expect(clients.limitsFor('controller')).toEqual({
      contextWindow: 16_384,
      maxOutputTokens: undefined,
    })
  })

  it('the package-side rate fallbacks are pinned equal to the app defaults they mirror', async () => {
    const clients = await import(CLIENTS)
    const { DEFAULT_EUR_PER_USD, DEFAULT_LARGE_LLM_EUR_PER_HOUR } = await import(SETTINGS)

    const rates = clients.activeCostRates()
    expect(rates.eurPerUsd()).toBe(DEFAULT_EUR_PER_USD)
    expect(rates.largeEurPerHour()).toBe(DEFAULT_LARGE_LLM_EUR_PER_HOUR)
    // The fallback exists so an unregistered consumer still prices sanely; the
    // equality pin is what keeps the two copies from drifting silently.
    expect(DEFAULT_EUR_PER_USD).toBe(0.86)
    expect(DEFAULT_LARGE_LLM_EUR_PER_HOUR).toBe(1.819)
  })

  it('a host that does register gets exactly what it hands over', async () => {
    const clients = await import(CLIENTS)
    const seen: string[] = []
    clients.configureModelTables({ maxOutputTokens: { X: 1 }, contextWindows: { X: 99 } })
    clients.configureInferencePolicy({
      defaultTier: () => 'self_deployed',
      assertTierReachable: () => {},
      onPrivateCallStart: (client: string) => seen.push(client),
    })
    clients.configureCostRates({ eurPerUsd: () => 3, largeEurPerHour: () => 4 })

    expect(clients.getContextWindow('X')).toBe(99)
    expect(clients.activeInferenceTier()).toBe('self_deployed')
    expect(clients.activeCostRates().eurPerUsd()).toBe(3)
    expect(clients.clientOverrideFor('controller')).toEqual({ client: 'LargeQwen' })
    expect(seen).toEqual(['LargeQwen'])
  })
})
