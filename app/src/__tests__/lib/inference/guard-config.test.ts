// @vitest-environment node
// The GUARD_* operator switches (boundary guards, slices 6 and 16): the
// design's unit rows, plus the wiring pins for each accepted value.
//
// Revision 6 (#938) inverted the screen rows: both tiers' declared default is
//   'off', read from the ONE shared per-tier policy value
//   (SCREEN_POLICY_BY_TIER) the agent's fallback also reads (O35/O40), so no
//   accepted value can be weaker than a tier's default and the screen
//   switches' weakening warnings have no case left; a still-set 'gated' or
//   'shadow' (the retired gate's modes) REFUSES boot naming the change, and a
//   still-set GUARD_GATE_THRESHOLD refuses boot naming the replacement (the
//   GUARD_EGRESS posture). The warnings and the values come from the one
//   `readGuards()` pass, so the pins live here beside the parse they pin.
//
// Env handling: the parse reads `process.env` per call (the same discipline as
// `privateInferenceOnly()`), so each test stubs and unstub its own values and
// the suite stays hermetic — nothing here contacts an endpoint, wakes a box or
// reads a database.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCREEN_POLICY_BY_TIER } from '@hames-ai/agents/types'
import { assertGuardsConfigured, guardConfig } from '../../../lib/inference/guard-config.server'

// The boot validator is the warnings' only logger; the tests read the calls.
let warns: string[]
beforeEach(() => {
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warns.push(String(message))
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the GUARD_* operator switches (boundary guards slice 6)', () => {
  // Slice 16 (O35/O40): both tiers' declared screen default is 'off', read
  // from the shared SCREEN_POLICY_BY_TIER rather than a local literal. MUTATION:
  // restore the old defaults (gated/always) in SCREEN_POLICY_BY_TIER or as local
  // literals here: this pin and the composition pins must turn red.
  it('unset, every value is the declared default, per tier, from the shared value', () => {
    expect(guardConfig()).toEqual({
      screenMode: {
        default: SCREEN_POLICY_BY_TIER.self_deployed,
        anthropic: SCREEN_POLICY_BY_TIER.anthropic,
      },
      egressTools: undefined,
      egressNameMatch: undefined,
      egressDecide: undefined,
      pseudonymise: false,
      // #844: today's numbers, as literals rather than the constants they come
      // from, so moving a constant is a red here and not a silent new default.
      gateThreshold: 0.15,
      egressThreshold: 0.3,
      maxOutgoingRetriesPostTripwire: 0,
    })
    expect(SCREEN_POLICY_BY_TIER).toEqual({ self_deployed: 'off', anthropic: 'off' })
    expect(warns).toEqual([])
  })

  it.each([
    ['off', 'off'],
    ['always', 'always'],
    ['  ALWAYS  ', 'always'],
  ])('GUARD_SCREEN=%j sets the self-deployed tier only (%j)', (raw, want) => {
    vi.stubEnv('GUARD_SCREEN', raw)
    expect(guardConfig().screenMode).toEqual({ default: want, anthropic: 'off' })
  })

  // Revision 6: 'gated' and 'shadow' answered to the retired guard gate, so a
  // still-set one REFUSES boot naming the change — never parsed, never a
  // silent fall-back onto 'always' (the core's no-gate default for 'gated').
  it.each(['gated', 'shadow', '  GATED  ', 'Shadow'])(
    'GUARD_SCREEN=%j refuses boot naming the retired gate, never the value',
    (value) => {
      vi.stubEnv('GUARD_SCREEN', value)
      expect(() => guardConfig()).toThrow(/GUARD_SCREEN no longer accepts gated or shadow/)
      expect(() => guardConfig()).toThrow(
        /retired, replaced by the injection-ingress-guard classification/,
      )
    },
  )

  it('GUARD_SCREEN_ANTHROPIC accepts only off and always, and sets that tier only', () => {
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'off')
    expect(guardConfig().screenMode).toEqual({ default: 'off', anthropic: 'off' })
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'always')
    expect(guardConfig().screenMode).toEqual({ default: 'off', anthropic: 'always' })
  })

  // Security delta N5: gated and shadow on the Anthropic tier would send every
  // body the screen would have read to that tier's decisions host by an env
  // var. REFUSE, naming the variable and its allowed values.
  it.each(['gated', 'shadow', 'always, please'])(
    'GUARD_SCREEN_ANTHROPIC=%j refuses boot with the variable and the allowed values, never the value',
    (value) => {
      vi.stubEnv('GUARD_SCREEN_ANTHROPIC', value)
      expect(() => guardConfig()).toThrow(
        new RegExp('GUARD_SCREEN_ANTHROPIC must be one of: off, always'),
      )
    },
  )

  it('O26 parses the three per-tool switches and refuses the obsolete one', () => {
    vi.stubEnv('GUARD_EGRESS_TOOLS', 'search,tag:egress')
    vi.stubEnv('GUARD_EGRESS_NAME_MATCH', ' REFUSE ')
    vi.stubEnv('GUARD_EGRESS_DECIDE', 'shadow')
    expect(guardConfig()).toMatchObject({
      egressTools: ['search', 'tag:egress'],
      egressNameMatch: 'refuse',
      egressDecide: 'shadow',
    })
    vi.stubEnv('GUARD_EGRESS', 'roster')
    expect(() => guardConfig()).toThrow(/GUARD_EGRESS is obsolete/)
  })

  it("GUARD_PSEUDONYMISE=on|off flips the web route's input filter", () => {
    vi.stubEnv('GUARD_PSEUDONYMISE', 'off')
    expect(guardConfig().pseudonymise).toBe(false)
    vi.stubEnv('GUARD_PSEUDONYMISE', 'on')
    expect(guardConfig().pseudonymise).toBe(true)
  })

  it.each([
    ['GUARD_SCREEN', 'nonsense', 'off, always'],
    ['GUARD_EGRESS_NAME_MATCH', 'by-hope', 'off, evidence, refuse'],
    ['GUARD_EGRESS_DECIDE', 'by-hope', 'off, on, shadow'],
    ['GUARD_PSEUDONYMISE', 'maybe', 'on, off'],
  ])('%s=%j refuses boot, naming the variable and the allowed values', (variable, value, names) => {
    vi.stubEnv(variable, value)
    expect(() => guardConfig()).toThrow(
      new RegExp(`${variable} must be one of: ${names.replaceAll(', ', ',\\s*')}`),
    )
  })

  // A map must name the tiers by the literals the one tier rule resolves:
  // the Anthropic tier by its exact key, the self-deployed one as `default`
  // (the design: the maps name the Anthropic tier and use `default` for the
  // self-deployed tier). A legacy spelling as a KEY would resolve to nothing
  // and silently fall back — the same unreadable-protection class O2 exists
  // to close.
  it('the screen map names the Anthropic tier and puts the self-deployed value under default', () => {
    vi.stubEnv('GUARD_SCREEN', 'always')
    const map = guardConfig().screenMode as Record<string, string>
    expect(map.default).toBe('always')
    expect(map.anthropic).toBe('off')
    expect(Object.keys(map).filter((k) => k !== 'default')).toEqual(['anthropic'])
    expect(map.verda).toBeUndefined()
  })

  // Revision 6: both screen defaults are 'off', so no accepted value is below
  // a tier's default and the screen switches never warn — the weakening
  // warnings died with the flip. (The egress rows below keep their warnings.)
  it('no screen value logs a boot warning; unset logs none', () => {
    vi.stubEnv('GUARD_SCREEN', 'off')
    assertGuardsConfigured()
    vi.stubEnv('GUARD_SCREEN', 'always')
    assertGuardsConfigured()
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'off')
    assertGuardsConfigured()
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'always')
    assertGuardsConfigured()
    vi.unstubAllEnvs()
    assertGuardsConfigured()
    expect(warns).toEqual([])
  })

  it.each([['GUARD_EGRESS_DECIDE', 'off']])(
    '%s=%j logs its own boot warning, naming the variable and what it switches off',
    (variable, value) => {
      vi.stubEnv(variable, value)
      assertGuardsConfigured()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain(variable)
    },
  )

  it('the warnings are one per weakened value per boot, not per call', () => {
    vi.stubEnv('GUARD_SCREEN', 'always')
    vi.stubEnv('GUARD_EGRESS_DECIDE', 'off')
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'always')
    vi.stubEnv('GUARD_PSEUDONYMISE', 'on')
    assertGuardsConfigured()
    expect(warns).toHaveLength(1)
    assertGuardsConfigured()
    expect(warns).toHaveLength(2)
  })

  it.each([undefined, 'off', 'on'])('GUARD_PSEUDONYMISE=%j never warns at boot', (value) => {
    vi.stubEnv('GUARD_PSEUDONYMISE', value)
    assertGuardsConfigured()
    expect(warns).toEqual([])
  })

  it('valid values never refuse boot', () => {
    vi.stubEnv('GUARD_SCREEN', 'off')
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'always')
    vi.stubEnv('GUARD_EGRESS_DECIDE', 'on')
    vi.stubEnv('GUARD_PSEUDONYMISE', 'on')
    expect(() => assertGuardsConfigured()).not.toThrow()
  })
})

// #844: the guards' numbers as settings, and revision 6's retirement of
// the gate threshold's variable. τe and the tripwire N keep their variables
// (each defaults to today's value, takes effect, refuses invalid values
// out of range and warns once when looser); τi's variable is RETIRED — the
// gate question is gone, so a still-set value is a stale misconfiguration
// that refuses boot naming the replacement.
describe('the guard thresholds and the tripwire N as settings (#844)', () => {
  const NUMBERS = [
    ['GUARD_EGRESS_THRESHOLD', 'egressThreshold', 'a number from 0 to 1'],
    [
      'GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE',
      'maxOutgoingRetriesPostTripwire',
      'a whole number, 0 or greater',
    ],
  ] as const

  // Revision 6: the gate question is retired and τi is code-owned, so ANY
  // still-set GUARD_GATE_THRESHOLD refuses boot naming the replacement — the
  // GUARD_EGRESS posture, never a silent parse into the bag. MUTATION: accept
  // it silently (restore the parse into `gateThreshold`): this goes red.
  it.each(['0.15', '0.4', '', '   '])(
    'GUARD_GATE_THRESHOLD=%j refuses boot naming the replacement, never the value',
    (value) => {
      vi.stubEnv('GUARD_GATE_THRESHOLD', value)
      expect(() => guardConfig()).toThrow(/GUARD_GATE_THRESHOLD is obsolete/)
      expect(() => guardConfig()).toThrow(/injection-ingress-guard classification/)
      expect(() => guardConfig()).toThrow(/Unset the variable/)
    },
  )

  // MUTATION: read the wrong variable for one setting (or drop its parse and
  // keep the default): that row goes red.
  it.each([
    ['GUARD_EGRESS_THRESHOLD', '0.5', 'egressThreshold', 0.5],
    ['GUARD_EGRESS_THRESHOLD', '1.0', 'egressThreshold', 1],
    ['GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '2', 'maxOutgoingRetriesPostTripwire', 2],
    ['GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '0', 'maxOutgoingRetriesPostTripwire', 0],
  ] as const)('%s=%j sets %s to %j', (variable, raw, field, want) => {
    vi.stubEnv(variable, raw)
    expect(guardConfig()[field]).toBe(want)
  })

  // Each setting moves its own field only; τi stays at the pattern's own
  // default now that nothing can set it.
  it('each variable sets its own field and leaves the others at their defaults', () => {
    vi.stubEnv('GUARD_EGRESS_THRESHOLD', '0.1')
    expect(guardConfig()).toMatchObject({
      gateThreshold: 0.15,
      egressThreshold: 0.1,
      maxOutgoingRetriesPostTripwire: 0,
    })
  })

  // MUTATION: parse with a bare `Number(raw)` (no digits-only check): '1e-1',
  // '0x0' and '' + spaces coerce to numbers in range and these go green-to-
  // red; widen the range check: '1.5' and '-0' parse.
  const INVALID = [
    '1.5',
    '-0.1',
    '-0',
    '1e-1',
    '0x0',
    'NaN',
    'Infinity',
    'high',
    '0.1.2',
    '+0.2',
    '0. 2',
  ]
  it.each(
    NUMBERS.flatMap(([variable, , range]) =>
      [...INVALID, ...(variable.endsWith('TRIPWIRE') ? ['0.5', '1.0'] : [])].map(
        (value) => [variable, value, range] as const,
      ),
    ),
  )('%s=%j refuses boot, naming the variable and its range', (variable, value, range) => {
    vi.stubEnv(variable, value)
    expect(() => guardConfig()).toThrow(`${variable} must be ${range};`)
    expect(() => assertGuardsConfigured()).toThrow(`${variable} must be ${range};`)
  })

  // Empty and whitespace-only values (#845 review, finding 3): '' keeps the
  // default with no warning (a falsy check, like the mode switches); '   '
  // (whitespace only) refuses boot. MUTATION O2: read the raw value with
  // `!== undefined` instead of truthiness: '' refuses boot and the first row
  // goes red. MUTATION O3: skip the trim (or accept whitespace-only as the
  // default): the second row goes red.
  it.each(NUMBERS.map(([variable]) => variable))(
    '%s (empty) keeps the default and logs no warning',
    (variable) => {
      vi.stubEnv(variable, '')
      expect(() => assertGuardsConfigured()).not.toThrow()
      expect(warns).toEqual([])
    },
  )
  it.each(NUMBERS.map(([variable]) => variable))(
    '%s (whitespace only) refuses boot',
    (variable) => {
      vi.stubEnv(variable, '   ')
      expect(() => assertGuardsConfigured()).toThrow(variable)
    },
  )

  // The refusal never quotes what it refused. MUTATION: interpolate the raw
  // value into the message: red.
  it.each(NUMBERS.map(([variable]) => variable))(
    '%s: the refusal never echoes the value',
    (variable) => {
      const secretish = '7.77-SYNTHETIC-VALUE'
      vi.stubEnv(variable, secretish)
      let message = ''
      try {
        guardConfig()
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain(variable)
      expect(message).not.toContain(secretish)
      expect(message).not.toContain('7.77')
    },
  )

  // MUTATION: drop one warning (or compare with `<` so a looser value is
  // silent): that row's count is 0, red. Warning on `>=` instead: the
  // at-default row below goes red.
  it.each([
    ['GUARD_EGRESS_THRESHOLD', '0.31', 'without a refusal or a prompt'],
    ['GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '1', 'closes at refusal 2'],
  ])('%s=%j (looser) logs ONE boot warning saying what it loosened', (variable, raw, loosened) => {
    vi.stubEnv(variable, raw)
    assertGuardsConfigured()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(variable)
    expect(warns[0]).toContain(loosened)
  })

  it.each([
    ['GUARD_EGRESS_THRESHOLD', '0.3'],
    ['GUARD_EGRESS_THRESHOLD', '0'],
    ['GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '0'],
  ])('%s=%j (at or stricter than the default) logs no warning', (variable, raw) => {
    vi.stubEnv(variable, raw)
    assertGuardsConfigured()
    expect(warns).toEqual([])
  })

  it('a looser value warns once per boot, and building the bag logs nothing', () => {
    vi.stubEnv('GUARD_EGRESS_THRESHOLD', '0.5')
    vi.stubEnv('GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '3')
    assertGuardsConfigured()
    expect(warns).toHaveLength(2)
    guardConfig()
    guardConfig()
    expect(warns).toHaveLength(2)
  })

  // The deployment template carries every guard variable the module reads
  // (#845 review, finding 1). Whole names only: `toContain(variable)` matched
  // substrings, so `GUARD_EGRESS` was found inside `GUARD_EGRESS_THRESHOLD`
  // and `GUARD_SCREEN` inside `GUARD_SCREEN_ANTHROPIC` — deleting those two
  // variables' own lines left the scan green (fix round 2). The form scanned
  // is the one each template uses to document a variable, `NAME='`.
  // MUTATION: drop one variable's block from either template: the scan misses
  // it and this goes red.
  it('every GUARD_* variable read here appears in both env templates', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../lib/inference/guard-config.server.ts'),
      'utf8',
    )
    const read = [...source.matchAll(/process\.env\.(GUARD_[A-Z_]+)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'GUARD_EGRESS')
    expect(read.length).toBeGreaterThan(0)
    // The app package's template and the deployment template at the repo root.
    for (const template of ['.env.example', '../.env.production.example']) {
      const text = readFileSync(resolve(__dirname, '../../../..', template), 'utf8')
      for (const variable of read) {
        expect(text, `${template} does not document ${variable}`).toMatch(
          new RegExp(`\\b${variable}='`),
        )
      }
    }
  })
})
