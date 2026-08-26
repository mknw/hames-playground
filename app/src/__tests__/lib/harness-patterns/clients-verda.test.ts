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
 *   - flag set ⇒ exactly the mapped roles move, which since 2026-08-26 is every
 *     conversational role, and the ONE unmapped one (`screen`) provably does
 *     NOT. The widening slip that reads as harmless in a diff now has a single
 *     target, so `screen` is asserted twice over: through the map, and through
 *     a source scan proving no call site can spread an override for it.
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

/** The roles the map routes, and the Anthropic chain each one leaves behind.
 *  `router` / `planner` / `describe` joined on 2026-08-26 (the owner's call:
 *  the router sees the raw user message and describe sees tool results
 *  verbatim, so holding them back left the private tier shipping the two
 *  payloads it exists to keep). */
const ROUTED: Partial<Record<BamlRole, string>> = {
  controller: 'ControllerAnthropic',
  critic: 'CriticAnthropic',
  compactExecution: 'SynthesizerAnthropic',
  router: 'RouterAnthropic',
  planner: 'PlannerAnthropic',
  describe: 'DescribeAnthropic',
}
/** The exception, and the whole of it. `screen` is a security control's client
 *  (SD-4 / SA-M5), not a routing preference, and moving it is a decision the
 *  owner has not made. */
const UNROUTED: Partial<Record<BamlRole, string>> = {
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

  it('routes every conversational role to VerdaQwen', async () => {
    const { resolveClientForRole, clientOverrideFor, verdaInferenceEnabled } = await load()

    expect(verdaInferenceEnabled()).toBe(true)
    for (const [role] of roles(ROUTED)) {
      expect(clientOverrideFor(role)).toEqual({ client: 'VerdaQwen' })
      expect(resolveClientForRole(role)).toBe('VerdaQwen')
    }
  })

  it('leaves the injection screen — and only it — on Anthropic', async () => {
    const { resolveClientForRole, clientOverrideFor } = await load()

    for (const [role, chain] of roles(UNROUTED)) {
      expect(clientOverrideFor(role)).toBeUndefined()
      expect(resolveClientForRole(role)).toBe(chain)
    }
    // SA-M5 in the one place it could regress silently: the injection screen
    // must not follow `describe` — which HAS moved — onto an unmeasured model.
    expect(resolveClientForRole('screen')).toBe('DescribeAnthropic')
    // …and `describe` really did move, so the assertion above is a difference
    // between two roles on the same BAML chain rather than a restatement of a
    // posture nothing has tested.
    expect(resolveClientForRole('describe')).toBe('VerdaQwen')
  })

  it('trims Verda-routed prompts against the 131K server window, not 200K', async () => {
    const { resolveClientForRole } = await load()
    const { getContextWindow } = await import('../../../lib/harness-patterns/token-budget.server')

    // vLLM ran with `--max-model-len 131072`; a prompt sized for 200K is
    // rejected outright, so this is the difference between "the flag works"
    // and "the flag routes to a client that refuses every long turn".
    expect(getContextWindow(resolveClientForRole('controller'))).toBe(131_072)
    // The describe role trims against the same server ceiling now that it
    // moves; `compactBulkData` and the retriever both size off this.
    expect(getContextWindow(resolveClientForRole('describe'))).toBe(131_072)
    // The screen is the one role still sized for Anthropic's window, because it
    // is the one role still calling it.
    expect(getContextWindow(resolveClientForRole('screen'))).toBe(200_000)
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
      'CompactIntent',
      'Critic',
      'GenerateConversationTitle',
      'LoopController',
      'Planner',
      'ReferenceSelector',
      'ResultDescribe',
      'ResultDescribeBatch',
      'RetrieveQuery',
      'Router',
      'Synthesize',
    ])
    // The screen is absent, and that is the whole point of the filter: it runs
    // on Anthropic in BOTH positions, so its duration is the one number that
    // would not compare.
    expect(TIER_SWITCHED_FUNCTIONS.has('ScreenUntrustedContent')).toBe(false)
  })

  it('lists every function that declares the describe chain, not a subset', async () => {
    // The `describe` array in `SWITCHED_FUNCTIONS_BY_ROLE` is a second copy of
    // a list whose home is `baml_src/anthropic-only.baml`, and a copy that can
    // silently go short is worse than none: a seventh describe function added
    // to BAML and forgotten there would keep running on Anthropic through a
    // turn the user asked to keep on the box, with nothing red. So the list is
    // derived from the .baml sources here and compared.
    //
    // `screen` shares the chain in BAML (the separation lives only in
    // `CLIENT_BY_ROLE`), so `injection-screen.baml` is excluded BY FILE — the
    // exclusion is the assertion, not an accounting convenience.
    const bamlDir = path.resolve(process.cwd(), 'baml_src')
    const declaringDescribe: string[] = []
    for (const entry of readdirSync(bamlDir)) {
      if (!entry.endsWith('.baml') || entry === 'injection-screen.baml') continue
      const src = readFileSync(path.join(bamlDir, entry), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
      // `function Name(...) -> T { client DescribeAnthropic` — the client line
      // is what routes the call, so the function is found through it.
      for (const m of src.matchAll(/function\s+(\w+)\s*\([\s\S]*?\bclient\s+(\w+)/g)) {
        if (m[2] === 'DescribeAnthropic') declaringDescribe.push(m[1])
      }
    }
    const { SWITCHED_FUNCTIONS_BY_ROLE } = await load()
    expect(declaringDescribe.sort()).toEqual([...SWITCHED_FUNCTIONS_BY_ROLE.describe!].sort())
    // Guard against a regex that matched nothing: the comparison above would
    // then pass only if the map were empty too.
    expect(declaringDescribe).toHaveLength(6)
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

  /**
   * Source with comments removed.
   *
   * Load-bearing, not tidiness: `baml-adapters.server.ts` DISCUSSES
   * `clientOverrideFor('screen')` at length — explaining that it has no call
   * site — and a scan that reads prose cannot tell a spread from an
   * explanation of why there isn't one. It cut both ways: the "every routed
   * role is wired" test below would also pass on a role that appears only in a
   * comment, which is exactly the reads-like-routing-changes-nothing failure it
   * exists to catch.
   *
   * A `//` inside a string literal (a URL) truncates that line early. Nothing
   * in this corpus spreads an override after a URL on the same line, and the
   * failure mode is a LOUD one — the role reads as unwired — not a silent pass.
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  }

  /** Every .ts under src/lib, comments stripped, as one string. */
  function corpus(): string {
    return sources(path.resolve(process.cwd(), 'src/lib'))
      .filter((f) => !f.endsWith('clients.server.ts'))
      .map((f) => stripComments(readFileSync(f, 'utf8')))
      .join('\n')
  }

  it('spreads clientOverrideFor(role) somewhere in src/lib for each routed role', async () => {
    enable()
    const { clientOverrideFor } = await load()
    const routed = ALL_ROLES.filter((role) => clientOverrideFor(role) !== undefined)
    // Guard against a map that quietly emptied: the assertion below passes
    // trivially over zero roles.
    expect(routed.length).toBeGreaterThanOrEqual(3)

    const code = corpus()
    const unwired = routed.filter((role) => !code.includes(`clientOverrideFor('${role}')`))
    expect(unwired).toEqual([])
  })

  it('spreads it in every FILE that calls a routed function, not just one', async () => {
    // The test above greps once per ROLE, which is exactly as strong as the
    // role with one call site. `describe` has SIX, spread over five files: four
    // of them could lose their spread and it would stay green there, and the
    // e2e tier scenario only ever exercises whichever describe path a given
    // turn took (a one-result turn takes the single-item call, never the
    // batch). So this checks per FILE.
    //
    // Per file rather than per call, deliberately. The adapters render each
    // call TWICE — `hasOpts ? b.X(…, opts) : b.X(…)` — because the generated
    // functions take their arguments positionally and an empty `{}` in the
    // trailing slot is not the same as passing nothing (#154). The
    // no-options branch is correct and a per-call rule would flag it. What
    // cannot be legitimate is a file that reaches a routed function and never
    // mentions the override at all.
    //
    // The two describe sites that SHARE a file (`ResultDescribe` and
    // `ResultDescribeBatch`, both in `baml-adapters.server.ts`) are therefore
    // not separated here; `baml-adapters.test.ts` asserts the options bag of
    // each one individually.
    enable()
    const { SWITCHED_FUNCTIONS_BY_ROLE } = await load()

    const missing: string[] = []
    let callingFiles = 0
    for (const file of sources(path.resolve(process.cwd(), 'src/lib'))) {
      if (file.endsWith('clients.server.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const [role, fns] of Object.entries(SWITCHED_FUNCTIONS_BY_ROLE)) {
        const calls = (fns as readonly string[]).filter((fn) => code.includes(`b.${fn}(`))
        if (calls.length === 0) continue
        callingFiles += 1
        if (!code.includes(`clientOverrideFor('${role}')`)) {
          missing.push(
            `${path.basename(file)} calls ${calls.join(', ')} without a ${role} override`,
          )
        }
      }
    }
    expect(missing).toEqual([])
    // Guard against the scan going vacuous — a changed call shape would
    // otherwise make the assertion above pass over nothing.
    expect(callingFiles).toBeGreaterThanOrEqual(8)
  })

  it('spreads clientOverrideFor(screen) NOWHERE, which is what pins the exception', async () => {
    // The converse of the test above, and since 2026-08-26 it is the load-
    // bearing one. `screen` and `describe` name the SAME chain in BAML and
    // their two call sites sit two functions apart in `baml-adapters.server.ts`;
    // `describe` now carries an override and `screen` must not. Nothing about
    // the map's omission enforces that — an added spread here would route the
    // screen the moment someone put `screen` in the map, or even before, since
    // an unmapped role's override is just `undefined` and a future map edit is
    // one line. A source scan is the only thing that fails on the first half of
    // that mistake.
    const code = corpus()

    expect(code).not.toContain("clientOverrideFor('screen')")
    expect(code).not.toContain('clientOverrideFor("screen")')
    // Not vacuous: the same corpus DOES carry the describe spread, so the scan
    // is looking in a place where these literals really appear.
    expect(code).toContain("clientOverrideFor('describe')")
  })
})
