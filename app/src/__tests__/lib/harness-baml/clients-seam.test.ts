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

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// The wake notice is mocked so the composition root's registered
// `onPrivateCallStart` filter is OBSERVABLE: a private-tier call on the
// scale-to-zero client announces itself; a call on the 4B summarizer does not.
const noteVerdaCallStarting = vi.fn()
vi.mock('../../../lib/inference/cold-start.server', () => ({
  noteVerdaCallStarting: (...args: unknown[]) => noteVerdaCallStarting(...args),
}))

const CLIENTS = '../../../lib/harness-baml/clients.server'
const CONFIG = '../../../lib/inference/config.server'
const SETTINGS = '../../../lib/settings'

const ENV_KEYS = [
  'USE_VERDA_INFERENCE',
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
  'SMALL_LLM_BASE_URL',
  'EUR_PER_USD',
  'VERDA_EUR_PER_HOUR',
] as const

let saved: Record<string, string | undefined>

function enable(): void {
  process.env.USE_VERDA_INFERENCE = '1'
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.resetModules()
  noteVerdaCallStarting.mockClear()
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
  return await import(CLIENTS)
}

describe('the configuration the host registers is the configuration the resolution reads', () => {
  it('a verda scope flows through the seam: override, tables and hook all land', async () => {
    enable()
    const clients = await loadWired()

    await clients.runWithInferenceTier('verda', async () => {
      // The override names the client the host's tables know.
      expect(clients.clientOverrideFor('planner')).toEqual({ client: 'VerdaQwen' })
      // The host's model tables: 131 072 window and 4 096 cap for VerdaQwen —
      // impossible from the package-side defaults (16 384 / undefined), so
      // these two numbers are a direct readout of which store answered.
      expect(clients.getContextWindow('VerdaQwen')).toBe(131_072)
      expect(clients.limitsFor('planner')).toEqual({
        contextWindow: 131_072,
        maxOutputTokens: 4_096,
      })
      // The hook fired for the scale-to-zero client — the composition root's
      // registered filter announced the call to the cold-start module.
      expect(noteVerdaCallStarting).toHaveBeenCalled()
    })
  })

  it('the SCOPE, not the env default, is what the resolution reads', async () => {
    // Flag OFF (so the default tier is anthropic) with the endpoints present
    // (so the registered assert lets the scope open). The #342 M1 lesson: a
    // mutation that points the reader at a second AsyncLocalStorage passes
    // every default-tier test — with the flag on, the default tier routes
    // exactly like the scope — and only a test that holds the default at
    // 'anthropic' while the scope says 'verda' catches it.
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
    const clients = await loadWired()

    expect(clients.activeInferenceTier()).toBe('anthropic')
    await clients.runWithInferenceTier('verda', async () => {
      expect(clients.activeInferenceTier()).toBe('verda')
      expect(clients.clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
    })
    expect(clients.activeInferenceTier()).toBe('anthropic')
  })

  it('the 4B summarizer takes the override but never the GPU countdown — the filter is host-side', async () => {
    enable()
    const clients = await loadWired()

    await clients.runWithInferenceTier('verda', async () => {
      expect(clients.clientOverrideFor('describe')).toEqual({ client: 'LocalQwenSmall' })
      expect(noteVerdaCallStarting).not.toHaveBeenCalled()
    })
  })

  it('the host env default flows: USE_VERDA_INFERENCE=1 outside any scope still routes', async () => {
    enable()
    const clients = await loadWired()

    expect(clients.activeInferenceTier()).toBe('verda')
    expect(clients.clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
  })

  it('a verda scope is checked through the registered assert, not opened blind', async () => {
    // Registered directly rather than via the composition root: with the flag
    // on and the env missing, config.server's own module-load check throws at
    // import (its own pin, in clients-verda.test.ts). This test isolates the
    // SCOPE-path gate — runWithInferenceTier consulting assertTierReachable.
    const clients = await import(CLIENTS)
    clients.configureInferencePolicy({
      defaultTier: () => 'anthropic',
      assertTierReachable: () => {
        throw new Error('fixture assert: the scope is not reachable')
      },
    })
    await expect(clients.runWithInferenceTier('verda', async () => {})).rejects.toThrow(
      /fixture assert: the scope is not reachable/,
    )
  })

  it('the host EUR rates flow through the seam, env override included', async () => {
    enable()
    process.env.EUR_PER_USD = '1.25'
    process.env.VERDA_EUR_PER_HOUR = '2.5'
    await loadWired()
    const bamlAdapters = await import('../../../lib/harness-baml/baml-adapters.server')
    // computeEventMetrics reads the rates through the seam per step; reading
    // the same store here proves which one is live.
    const { activeCostRates } = await import(CLIENTS)
    expect(activeCostRates().eurPerUsd()).toBe(1.25)
    expect(activeCostRates().verdaEurPerHour()).toBe(2.5)
    expect(bamlAdapters).toBeDefined()
  })
})

describe('unregistered — the package-side defaults are safe', () => {
  it('the default tier is anthropic and an unregistered verda scope is REFUSED', async () => {
    enable() // env alone must not route anything: registration is the act, not the flag
    const clients = await import(CLIENTS)

    expect(clients.activeInferenceTier()).toBe('anthropic')
    expect(clients.clientOverrideFor('controller')).toBeUndefined()
    await expect(clients.runWithInferenceTier('verda', async () => {})).rejects.toThrow(
      /no inference policy is registered/,
    )
  })

  it('unknown clients keep the documented fallbacks with no tables registered', async () => {
    const clients = await import(CLIENTS)
    expect(clients.getContextWindow('VerdaQwen')).toBe(16_384)
    expect(clients.limitsFor('controller')).toEqual({
      contextWindow: 16_384,
      maxOutputTokens: undefined,
    })
  })

  it('the package-side rate fallbacks are pinned equal to the app defaults they mirror', async () => {
    const clients = await import(CLIENTS)
    const { DEFAULT_EUR_PER_USD, DEFAULT_VERDA_EUR_PER_HOUR } = await import(SETTINGS)

    const rates = clients.activeCostRates()
    expect(rates.eurPerUsd()).toBe(DEFAULT_EUR_PER_USD)
    expect(rates.verdaEurPerHour()).toBe(DEFAULT_VERDA_EUR_PER_HOUR)
    // The fallback exists so an unregistered consumer still prices sanely; the
    // equality pin is what keeps the two copies from drifting silently.
    expect(DEFAULT_EUR_PER_USD).toBe(0.86)
    expect(DEFAULT_VERDA_EUR_PER_HOUR).toBe(1.819)
  })

  it('a host that does register gets exactly what it hands over', async () => {
    const clients = await import(CLIENTS)
    const seen: string[] = []
    clients.configureModelTables({ maxOutputTokens: { X: 1 }, contextWindows: { X: 99 } })
    clients.configureInferencePolicy({
      defaultTier: () => 'verda',
      onPrivateCallStart: (client: string) => seen.push(client),
    })
    clients.configureCostRates({ eurPerUsd: () => 3, verdaEurPerHour: () => 4 })

    expect(clients.getContextWindow('X')).toBe(99)
    expect(clients.activeInferenceTier()).toBe('verda')
    expect(clients.activeCostRates().eurPerUsd()).toBe(3)
    expect(clients.clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
    expect(seen).toEqual(['VerdaQwen'])
  })
})
