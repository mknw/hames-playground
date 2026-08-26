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
 *   - flag set ⇒ exactly the mapped roles move, which since 2026-08-26 is EVERY
 *     role — the injection screen included, on the owner's explicit decision
 *     that no call made under the private tier may be sent to any public AI
 *     provider (answer 7). There is no unmapped role left, so the assertion
 *     that used to matter most has been inverted rather than deleted: `screen`
 *     is asserted twice over in the OTHER direction, through the map and
 *     through a source scan proving its call site really does spread an
 *     override. An entry with no spread routes nothing; a spread with no entry
 *     is dead. Both halves are required and each one is separately red.
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
  // `screen` is a security control's client (SD-4 / SA-M5), which is why it was
  // the last role to move and why it moved by a named owner decision rather
  // than with the widening. It is in this map now, and listed LAST so the diff
  // that added it is readable as what it is.
  screen: 'DescribeAnthropic',
}
/** Nothing is held back any more. Kept as an empty map rather than deleted:
 *  every test below iterates it, so a future exception is added in one place
 *  and is immediately asserted in both flag positions. */
const UNROUTED: Partial<Record<BamlRole, string>> = {}
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

  it('moves the injection screen too, and leaves nothing behind', async () => {
    const { resolveClientForRole, clientOverrideFor } = await load()

    // The inverse of what this test asserted until 2026-08-26. The screen is a
    // security control's client (SD-4 / SA-M5) and it moved on an owner
    // decision — "no call made under the private tier may be sent to any
    // public AI provider" — not on a widening, so it is pinned as its own
    // claim rather than folded into the loop above.
    expect(clientOverrideFor('screen')).toEqual({ client: 'VerdaQwen' })
    expect(resolveClientForRole('screen')).toBe('VerdaQwen')

    // Nothing is held back. Asserted over ALL_ROLES rather than over ROUTED,
    // so a role added to `BamlRole` and forgotten in the map is red here
    // instead of silently running on Anthropic through a private-tier turn.
    const unmoved = ALL_ROLES.filter((role) => clientOverrideFor(role) === undefined)
    expect(unmoved).toEqual([])
    for (const [role] of roles(UNROUTED)) {
      expect(clientOverrideFor(role)).toBeUndefined()
    }
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
    // The screen sizes against the same server ceiling now that it moves. This
    // is the half of the screen's move that is easy to forget: the guard hands
    // it up to 20 000 characters of fetched content, so a screen budgeted for
    // 200K against a 131K server is the flag being "on" and quietly broken on
    // exactly the payload it exists to read.
    expect(getContextWindow(resolveClientForRole('screen'))).toBe(131_072)
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
      'ScreenUntrustedContent',
      'Synthesize',
    ])
    // The screen is PRESENT, which is the inverse of what this line asserted
    // until 2026-08-26. Its duration compares across the two positions now
    // because it really does run on both, so excluding it would understate the
    // Anthropic window by the one call that is slowest per character.
    expect(TIER_SWITCHED_FUNCTIONS.has('ScreenUntrustedContent')).toBe(true)
    // Thirteen: every function declared in `baml_src/`. The filter that reads
    // this set therefore excludes nothing today, and the honest way to pin
    // that is to say so rather than to let a subset look deliberate.
    expect(TIER_SWITCHED_FUNCTIONS.size).toBe(13)
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

  /**
   * The ARGUMENT LIST of the single `b.ScreenUntrustedContent(...)` call, by
   * balanced parentheses from the opening one.
   *
   * A regex cannot do this: the arguments contain their own parentheses
   * (`clientOverrideFor('screen')`), so a `[^)]*` stops too early and a bounded
   * `[\s\S]{0,N}?` runs too far — past the call's own closing paren and into
   * whatever follows, which is exactly how the first version of this pin was
   * defeated by a decoy two statements below the call.
   *
   * Depth counting only, no string/template awareness: the arguments at this
   * site are identifiers and an object spread, with no string literal
   * containing a paren. A future argument that did carry one would end the
   * extraction early and the assertion would FAIL — loud, and in the safe
   * direction.
   */
  function screenCallArgs(code: string): string {
    const marker = 'b.ScreenUntrustedContent('
    const start = code.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    let depth = 0
    for (let i = start + marker.length - 1; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1
      else if (code[i] === ')') {
        depth -= 1
        if (depth === 0) return code.slice(start + marker.length, i)
      }
    }
    throw new Error('unbalanced parentheses after b.ScreenUntrustedContent(')
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
    // THREE sites share `baml-adapters.server.ts` — `ResultDescribe`,
    // `ResultDescribeBatch` and, since 2026-08-26, `ScreenUntrustedContent` —
    // so this scan cannot separate them. `baml-adapters.test.ts` asserts the
    // options bag of each describe site individually, and the screen's own
    // spread is pinned ON its call expression by the last test in this file,
    // because a file-level check would stay green with a security control's
    // override deleted.
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
    // otherwise make the assertion above pass over nothing. Nine (role, file)
    // pairs today; the screen's is the ninth.
    expect(callingFiles).toBeGreaterThanOrEqual(9)
  })

  it('routes the screen through BOTH halves — map entry AND the one call site', async () => {
    // THE INVERSION. Until 2026-08-26 this test asserted the opposite: that
    // `clientOverrideFor('screen')` appeared NOWHERE in `src/lib`, because the
    // injection screen was the one role a tier decision left on Anthropic. The
    // owner then ruled that no call made under the private tier may be sent to
    // any public AI provider (answer 7), so the screen moves — and an absence
    // pin inverts into something that has to be stronger than a presence pin,
    // because routing a security control takes TWO independent halves and
    // either one can rot on its own:
    //
    //   * the map entry alone routes nothing (`clientOverrideFor` returns the
    //     client, no call site spreads it, every screen call still goes to
    //     Anthropic while the map says otherwise);
    //   * the spread alone routes nothing (an unmapped role's override is
    //     `undefined`), and reads as wired.
    //
    // Both are asserted here, separately, so each half is its own red.
    enable()
    const { clientOverrideFor } = await load()

    // Half one: the map. Not folded into the ROUTED loop above — that loop
    // would keep passing if `screen` were quietly dropped from BOTH the map and
    // that fixture, which is precisely the two-line edit this guards.
    expect(clientOverrideFor('screen')).toEqual({ client: 'VerdaQwen' })

    // Half two: the call site, pinned ON the call rather than merely in its
    // file. The per-file scan above cannot separate the screen from the two
    // describe sites that share `baml-adapters.server.ts`, so a file-level
    // check would stay green with the screen's own spread deleted.
    //
    // Extracted by BALANCED PARENS rather than by a bounded regex, and that is
    // the second attempt: `/b\.ScreenUntrustedContent\([\s\S]{0,200}?…/` was
    // written first and a mutation defeated it — leaving the literal in the
    // file a couple of statements BELOW the call satisfied the lazy run, which
    // is the per-file blind spot wearing a per-call disguise. The argument list
    // is the only text that can route this call, so the argument list is what
    // gets read.
    const code = corpus()
    const calls = code.match(/b\.ScreenUntrustedContent\(/g) ?? []
    expect(calls).toHaveLength(1) // one call site is what makes the next line total
    expect(screenCallArgs(code)).toContain("clientOverrideFor('screen')")

    // Nothing ELSE spreads it. A second screen override would be a second
    // decision about a security control's model, made in a file nobody
    // reviewed for it; the count is bounded rather than merely non-zero.
    expect(code.match(/clientOverrideFor\('screen'\)/g) ?? []).toHaveLength(1)
    expect(code).not.toContain('clientOverrideFor("screen")')

    // WHAT THIS DEMANDS, said plainly because it is stricter than "the screen
    // is routed": the spread must be a LITERAL at that one call site. A
    // correct-but-indirect form (`const r: BamlRole = 'screen'`, then
    // `clientOverrideFor(r)`) routes the screen perfectly well and still turns
    // this red. That is deliberate and it is the direction the old absence-pin
    // could not manage: the reviewer of #275 showed the variable form slipping
    // past a scan looking for an absence, and it cannot slip past one looking
    // for a presence. A false positive here costs a reviewer one minute; a
    // false negative sends untrusted content to a provider the tier exists to
    // avoid, or leaves a security control on an unmeasured model. Verified by
    // mutation in both directions.

    // Not vacuous: the same corpus carries the describe spread too, so the
    // scan is looking in a place where these literals really appear.
    expect(code).toContain("clientOverrideFor('describe')")
  })
})
