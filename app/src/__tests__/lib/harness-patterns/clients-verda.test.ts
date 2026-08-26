/**
 * `USE_VERDA_INFERENCE=1` — the role → client override for the self-hosted
 * (Verda / DataCrunch) vLLM deployment.
 *
 * CI has no access to that endpoint, so everything here is hermetic: it pins
 * the *routing decision*, not the model. The live proof is manual —
 * `src/lib/harness-patterns/scripts/smoke-verda.ts`.
 *
 * What is pinned, and why each one is the failure that matters:
 *   - flag unset ⇒ NOTHING changes. Every role still resolves to its Anthropic
 *     chain and no options bag gains a `client` key. This is the whole default
 *     posture, so it is asserted role by role rather than in aggregate.
 *   - flag set ⇒ exactly the mapped roles move, and the unmapped ones (router,
 *     describe, screen, planner) provably do NOT — a widening slip is the kind
 *     of change that reads as harmless in a diff.
 *   - the flag is `'1'`, not truthiness. `USE_VERDA_INFERENCE=0` used to be the
 *     classic way to switch a feature ON by accident.
 *   - the trim window follows the override. A routed role that keeps sizing its
 *     prompt against Anthropic's 200K window would overflow a 131K server on
 *     the first long turn — the override would be "on" and quietly broken.
 *   - EVERY routed role has a wired call site. An entry in the map with no
 *     `clientOverrideFor(role)` spread at the call site is a config that reads
 *     like routing and changes nothing; this test is the only thing standing
 *     between that and a silent no-op.
 *   - misconfiguration throws at module load (fail closed). The alternative is
 *     confidential-compute traffic quietly going to Anthropic instead.
 *   - the SWITCHED-FUNCTION set follows the routed roles, and is the same set in
 *     both flag positions. It is what the header's latency median filters on, so
 *     a role added to the map without its BAML functions would drop out of the
 *     tier comparison rather than join it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import type { BamlRole } from '../../../lib/harness-patterns/clients.server'

const ENV_KEYS = [
  'USE_VERDA_INFERENCE',
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
] as const

const ALL_ROLES: BamlRole[] = [
  'controller',
  'planner',
  'critic',
  'compactExecution',
  'router',
  'describe',
  'screen',
]

/** The roles the map routes, and the Anthropic chain each one leaves behind. */
const ROUTED: Partial<Record<BamlRole, string>> = {
  controller: 'ControllerAnthropic',
  critic: 'CriticAnthropic',
  compactExecution: 'SynthesizerAnthropic',
}
const UNROUTED: Partial<Record<BamlRole, string>> = {
  planner: 'PlannerAnthropic',
  router: 'RouterAnthropic',
  describe: 'DescribeAnthropic',
  screen: 'DescribeAnthropic',
}
const roles = (map: Partial<Record<BamlRole, string>>): [BamlRole, string][] =>
  Object.entries(map) as [BamlRole, string][]

let saved: Record<string, string | undefined>

/** A configured-and-enabled environment. The values are fakes: nothing here
 *  opens a socket, and the endpoint only has to satisfy the shape check. */
function enable(): void {
  process.env.USE_VERDA_INFERENCE = '1'
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
}

async function load() {
  vi.resetModules()
  return await import('../../../lib/harness-patterns/clients.server')
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('USE_VERDA_INFERENCE unset — the default posture is untouched', () => {
  it('every role resolves to its Anthropic chain and no call gets a client override', async () => {
    const { resolveClientForRole, clientOverrideFor, verdaInferenceEnabled } = await load()

    expect(verdaInferenceEnabled()).toBe(false)
    for (const [role, chain] of roles({ ...ROUTED, ...UNROUTED })) {
      expect(resolveClientForRole(role)).toBe(chain)
      expect(clientOverrideFor(role)).toBeUndefined()
    }
  })

  it('an unconfigured endpoint is not an error while the flag is off', async () => {
    // Importing must not throw: the vast majority of runs have no Verda env at
    // all, and a boot-time throw there would be a self-inflicted outage.
    await expect(load()).resolves.toBeDefined()
  })
})

describe('USE_VERDA_INFERENCE=1 — exactly the mapped roles move', () => {
  beforeEach(enable)

  it('routes controller, critic and compactExecution to VerdaQwen', async () => {
    const { resolveClientForRole, clientOverrideFor, verdaInferenceEnabled } = await load()

    expect(verdaInferenceEnabled()).toBe(true)
    for (const [role] of roles(ROUTED)) {
      expect(clientOverrideFor(role)).toEqual({ client: 'VerdaQwen' })
      expect(resolveClientForRole(role)).toBe('VerdaQwen')
    }
  })

  it('leaves router, describe, screen and planner on Anthropic', async () => {
    const { resolveClientForRole, clientOverrideFor } = await load()

    for (const [role, chain] of roles(UNROUTED)) {
      expect(clientOverrideFor(role)).toBeUndefined()
      expect(resolveClientForRole(role)).toBe(chain)
    }
    // SA-M5 in the one place it could regress silently: the injection screen
    // must not follow `describe` — or anything else — onto an unmeasured model.
    expect(resolveClientForRole('screen')).toBe('DescribeAnthropic')
  })

  it('trims Verda-routed prompts against the 131K server window, not 200K', async () => {
    const { resolveClientForRole } = await load()
    const { getContextWindow } = await import('../../../lib/harness-patterns/token-budget.server')

    // vLLM ran with `--max-model-len 131072`; a prompt sized for 200K is
    // rejected outright, so this is the difference between "the flag works"
    // and "the flag routes to a client that refuses every long turn".
    expect(getContextWindow(resolveClientForRole('controller'))).toBe(131_072)
    expect(getContextWindow(resolveClientForRole('router'))).toBe(200_000)
  })
})

describe('the flag is `1`, not truthiness', () => {
  it.each(['0', 'false', 'true', 'yes', ''])('%o does not enable it', async (value) => {
    process.env.USE_VERDA_INFERENCE = value
    const { verdaInferenceEnabled, clientOverrideFor } = await load()

    expect(verdaInferenceEnabled()).toBe(false)
    expect(clientOverrideFor('controller')).toBeUndefined()
  })
})

describe('misconfiguration fails closed', () => {
  it('throws at module load when the flag is on and the env is missing', async () => {
    process.env.USE_VERDA_INFERENCE = '1'
    // No endpoint, no key: the dangerous outcome is a shrug and a fall-through
    // to Anthropic, which is precisely what the flag was set to prevent.
    await expect(load()).rejects.toThrow(/VERDA_INFERENCE_ENDPOINT and VERDA_INFERENCE_API_KEY/)
  })

  it('names only the variable that is actually missing', async () => {
    enable()
    delete process.env.VERDA_INFERENCE_API_KEY
    await expect(load()).rejects.toThrow(/VERDA_INFERENCE_API_KEY is not set/)
  })

  it('rejects an endpoint that is not the OpenAI-compatible base', async () => {
    enable()
    // The value the deployment hands you is the root; BAML appends
    // `/chat/completions` to base_url verbatim, so a root URL 404s every call.
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/'
    await expect(load()).rejects.toThrow(/must be the OpenAI-compatible base URL/)
  })

  it('accepts /v1 with or without a trailing slash', async () => {
    enable()
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1/'
    await expect(load()).resolves.toBeDefined()
  })

  it('assertVerdaConfigured is callable directly, for script preflights', async () => {
    enable()
    const { assertVerdaConfigured } = await load()
    expect(() => assertVerdaConfigured()).not.toThrow()
    delete process.env.VERDA_INFERENCE_ENDPOINT
    expect(() => assertVerdaConfigured()).toThrow(/VERDA_INFERENCE_ENDPOINT is not set/)
  })
})

describe('settings and baml_src agree about VerdaQwen', () => {
  it('the client is declared, capped at 16384, and asks for no caching', async () => {
    // Comments stripped the way client-output-caps.test.ts does it: the file
    // DISCUSSES caching at length, and a test that reads prose cannot tell a
    // declaration from an explanation of why there isn't one.
    const declared = readFileSync(path.resolve(process.cwd(), 'baml_src/verda-client.baml'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(declared).toMatch(/client<llm>\s+VerdaQwen/)
    expect(declared).toMatch(/provider\s+openai-generic/)
    expect(declared).toMatch(/max_tokens\s+16384/)
    expect(declared).toMatch(/base_url\s+env\.VERDA_INFERENCE_ENDPOINT/)
    expect(declared).toMatch(/api_key\s+env\.VERDA_INFERENCE_API_KEY/)
    // The confidential-compute posture: this client must not opt into prompt
    // caching, and `allowed_role_metadata` is what would forward the
    // controller templates' `cache_control` breakpoints to the server (#122).
    // Its ABSENCE is the control, so absence is what gets pinned.
    expect(declared).not.toMatch(/allowed_role_metadata/)
    expect(declared).not.toMatch(/cache_control/)
    // The endpoint scales to zero: a default-ish request timeout would fail
    // every first call of a session. Pinned as "generous", not as an exact
    // number — the point is that it survives a multi-minute cold start.
    const timeout = declared.match(/request_timeout_ms\s+(\d+)/)
    expect(Number(timeout?.[1])).toBeGreaterThanOrEqual(300_000)
  })

  it('settings mirrors the cap and the --max-model-len window', async () => {
    const { CLIENT_MAX_OUTPUT_TOKENS, MODEL_CONTEXT_WINDOWS, CLIENT_PRICING } =
      await import('../../../lib/settings')
    expect(CLIENT_MAX_OUTPUT_TOKENS.VerdaQwen).toBe(16_384)
    expect(MODEL_CONTEXT_WINDOWS.VerdaQwen).toBe(131_072)
    // Billed per GPU-second, not per token — an invented rate here would
    // render as a confident dollar figure. "Unknown" is the honest reading.
    expect(CLIENT_PRICING.VerdaQwen).toBeUndefined()
  })
})

describe('the switched-function set follows the routed roles', () => {
  it('lists BAML functions for exactly the roles the map routes', async () => {
    // The header's latency median counts only these functions, so that both
    // switch positions hold the same role mix and the two figures compare
    // (`metrics/call-latency.server.ts`). A role added to VERDA_CLIENT_BY_ROLE
    // without its functions here would silently drop OUT of that comparison
    // rather than joining it — invisible in a diff, and this is the pin.
    const { SWITCHED_FUNCTIONS_BY_ROLE, TIER_SWITCHED_FUNCTIONS } = await load()

    expect(Object.keys(SWITCHED_FUNCTIONS_BY_ROLE).sort()).toEqual(Object.keys(ROUTED).sort())
    expect([...TIER_SWITCHED_FUNCTIONS].sort()).toEqual([
      'ActorController',
      'Critic',
      'LoopController',
      'Synthesize',
    ])
  })

  it('is the same set whether the flag is on or off', async () => {
    // The filter is about which roles a tier decision CAN move, not about the
    // position it is in: a set that shrank with the flag off would leave the
    // anthropic window unfiltered and the comparison broken again.
    const off = [...(await load()).TIER_SWITCHED_FUNCTIONS].sort()
    enable()
    expect([...(await load()).TIER_SWITCHED_FUNCTIONS].sort()).toEqual(off)
  })
})

describe('every routed role has a wired call site', () => {
  /** Every .ts under src/lib, minus the generated client and tests. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__') sources(full, out)
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        out.push(full)
      }
    }
    return out
  }

  it('spreads clientOverrideFor(role) somewhere in src/lib for each routed role', async () => {
    enable()
    const { clientOverrideFor } = await load()
    const routed = ALL_ROLES.filter((role) => clientOverrideFor(role) !== undefined)
    // Guard against a map that quietly emptied: the assertion below passes
    // trivially over zero roles.
    expect(routed.length).toBeGreaterThanOrEqual(3)

    const corpus = sources(path.resolve(process.cwd(), 'src/lib'))
      .filter((f) => !f.endsWith('clients.server.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')

    const unwired = routed.filter((role) => !corpus.includes(`clientOverrideFor('${role}')`))
    expect(unwired).toEqual([])
  })
})
