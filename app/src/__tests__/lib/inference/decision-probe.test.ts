/**
 * decision-probe-per-tier (#418 T6, F4).
 *
 * A `requireCalibrated` decision with no calibration entry abstains on every
 * call. The probe says so once per configured TIER, naming it — a tier-less
 * warning would be silenced by whichever tier happened to have an entry.
 *
 * Wired through the real composition root (`config.server` registers the tier
 * policy `verdaConfigured` and `resolveClientForRole` read), so the tier →
 * client mapping asserted here is the resolver's, not a copy of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const CLIENTS = '@hames-ai/harness-baml/clients.server'
const CONFIG = '../../../lib/inference/config.server'
const PROBE = '../../../lib/inference/decision-probe.server'
const SESSION = '../../../lib/harness-client/session.server'

const ENV_KEYS = [
  'USE_VERDA_INFERENCE',
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
  'SMALL_LLM_BASE_URL',
] as const

let saved: Record<string, string | undefined>
let warn: ReturnType<typeof vi.spyOn>

function enablePrivateTier(): void {
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.resetModules()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  warn.mockRestore()
})

async function load() {
  await import(CONFIG)
  const clients = await import(CLIENTS)
  const probe = await import(PROBE)
  const { typedDecision, decisionRouter } =
    await import('@hames-ai/harness-patterns/patterns/typedDecision.server')
  const decide = (async () => ({
    probs: { yes: 1, no: 0 },
    method: 'logprob',
    calibrated: true,
  })) as never
  const spec = {
    key: 'memory.store.kind',
    question: 'q',
    labels: [
      { id: 'yes', description: 'y' },
      { id: 'no', description: 'n' },
    ],
  }
  const strict = (key = spec.key) =>
    typedDecision({
      decide,
      spec: { ...spec, key },
      policy: { fallback: 'no', requireCalibrated: true },
    })
  const lax = () => typedDecision({ decide, spec, policy: { fallback: 'no' } })
  return { clients, probe, strict, lax, decisionRouter, decide }
}

describe('decision-probe-per-tier', () => {
  it('warns once per configured tier, naming the tier and the client it resolves to', async () => {
    enablePrivateTier()
    const { clients, probe, strict } = await load()
    const out: string[] = await probe.probeDecisionCalibration('a1', [strict()])

    expect(out).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(2)
    const priv = out.find((m) => m.includes("'verda' tier"))
    const pub = out.find((m) => m.includes("'anthropic' tier"))
    expect(priv).toContain('LocalQwenSmallDecide')
    expect(pub).toBeDefined()
    // The client is the resolver's answer under that tier, not a literal here.
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const anthropicClient = await withRunFrame({ inference: { tier: 'anthropic' } }, async () =>
      clients.resolveClientForRole('decide'),
    )
    expect(pub).toContain(`client ${anthropicClient}`)
  })

  it('probes only the tiers this deployment can serve', async () => {
    const { probe, strict } = await load()
    const out: string[] = await probe.probeDecisionCalibration('a1', [strict()])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("'anthropic' tier")
    expect(out[0]).not.toContain("'verda'")
  })

  it('stays quiet for a tier whose client has an entry, and warns for the other', async () => {
    enablePrivateTier()
    const { clients, probe, strict } = await load()
    clients.configureDecisionCalibration({
      LocalQwenSmallDecide: { 'memory.store.kind': { n: 10 } },
    })
    const out: string[] = await probe.probeDecisionCalibration('a1', [strict()])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("'anthropic' tier")
  })

  it('does not warn about a key whose policy does not require calibration', async () => {
    enablePrivateTier()
    const { probe, lax } = await load()
    expect(await probe.probeDecisionCalibration('a1', [lax()])).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once per (tier, key) per process, not once per agent', async () => {
    enablePrivateTier()
    const { probe, strict } = await load()
    await probe.probeDecisionCalibration('a1', [strict()])
    warn.mockClear()
    const again: string[] = await probe.probeDecisionCalibration('a2', [strict()])
    expect(again).toEqual([])
    // A different key is its own finding.
    const other: string[] = await probe.probeDecisionCalibration('a2', [
      strict('document.injection'),
    ])
    expect(other).toHaveLength(2)
  })

  it('carries no question, label text or state in the warning', async () => {
    enablePrivateTier()
    const { probe, decisionRouter, decide } = await load()
    const router = decisionRouter(
      { secretroute: 'a secret route description' },
      { decide, policy: { fallback: 'secretroute', requireCalibrated: true } },
    )
    const out: string[] = await probe.probeDecisionCalibration('a1', [router])
    expect(out.length).toBeGreaterThan(0)
    for (const m of out) {
      expect(m).not.toContain('secret route description')
      expect(m).not.toContain('latest message')
    }
  })

  it('never rejects, even when the walk throws', async () => {
    const { probe } = await load()
    const hostile = {
      get capabilities(): never {
        throw new Error('boom')
      },
    }
    await expect(probe.probeDecisionCalibration('a1', [hostile as never])).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not probe agent'))
  })

  it('is wired where an agent’s patterns are built (getOrBuildPatterns)', async () => {
    const { strict } = await load()
    const { registerAgent } = await import('../../../lib/harness-client/registry.server')
    const { getOrBuildPatterns } = await import(SESSION)
    registerAgent({
      id: 'probe-agent',
      name: 'Probe',
      description: 'd',
      welcome: 'w',
      servers: [],
      icon: 'i-material-symbols-rule',
      accent: 'cyan',
      createPatterns: async () => [strict()],
    } as never)
    await getOrBuildPatterns('probe-session', 'probe-agent')
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent 'probe-agent'")),
    )
  })
})
