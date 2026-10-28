// @vitest-environment node
// The GUARD_* operator switches (boundary guards, slice 6): the design's two
// unit rows, plus the wiring pins for each accepted value.
//
// The design's rows (New pins, marked 6):
//   - "A weakening GUARD_* value logs the boot warning; an unknown value
//     refuses boot" — here, in the same file as the parse they pin, because
//     the warnings and the values come from the one `readGuards()` pass and a
//     pin elsewhere could drift from a re-shape of this module.
//   - "GUARD_SCREEN=gated leaves the Anthropic tier at 'always';
//     GUARD_SCREEN_ANTHROPIC=gated or shadow refuses boot; GUARD_SCREEN=gated
//     while the self-deployed default is 'shadow' logs the weakening warning
//     (security delta N5)" — `guardConfig()`'s map and the refusal, here; the
//     Anthropic tier's 'always' reaching the guards is the agent-side pin
//     (`general-next.test.ts`, "the operator switch ..."), whose own mutation
//     is the wiring.
//
// Env handling: the parse reads `process.env` per call (the same discipline as
// `privateInferenceOnly()`), so each test stubs and unstub its own values and
// the suite stays hermetic — nothing here contacts an endpoint, wakes a box or
// reads a database.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  // The pseudonymiser's default is ON (boundary guards slice 5, owner ruling
  // (c) of 2026-10-28): retirement is flipping it, after a fix for the egress
  // gate's measured gap has been measured. MUTATION: `PSEUDONYMISE_DEFAULT =
  // false`: red here, and in guard-switches.test.ts's composition chain.
  it('unset, every value is the declared default, per tier', () => {
    expect(guardConfig()).toEqual({
      screenMode: { default: 'shadow', anthropic: 'always' },
      egressMode: 'filter',
      pseudonymise: true,
      // #844: today's numbers, as literals rather than the constants they come
      // from, so moving a constant is a red here and not a silent new default.
      gateThreshold: 0.15,
      egressThreshold: 0.3,
      maxOutgoingRetriesPostTripwire: 0,
    })
    expect(warns).toEqual([])
  })

  it.each([
    ['off', 'off'],
    ['shadow', 'shadow'],
    ['gated', 'gated'],
    ['always', 'always'],
    ['  ALWAYS  ', 'always'],
  ])('GUARD_SCREEN=%j sets the self-deployed tier only (%j)', (raw, want) => {
    vi.stubEnv('GUARD_SCREEN', raw)
    expect(guardConfig().screenMode).toEqual({ default: want, anthropic: 'always' })
  })

  it('GUARD_SCREEN=gated leaves the Anthropic tier at its own default (N5)', () => {
    vi.stubEnv('GUARD_SCREEN', 'gated')
    expect(guardConfig().screenMode).toMatchObject({ anthropic: 'always' })
  })

  it('GUARD_SCREEN_ANTHROPIC accepts only off and always, and sets that tier only', () => {
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'off')
    expect(guardConfig().screenMode).toEqual({ default: 'shadow', anthropic: 'off' })
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'always')
    expect(guardConfig().screenMode).toEqual({ default: 'shadow', anthropic: 'always' })
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

  it.each(['filter', 'roster', ' ROSTER '])(
    'GUARD_EGRESS=%j sets the gate mode on every tier',
    (raw) => {
      vi.stubEnv('GUARD_EGRESS', raw)
      expect(guardConfig().egressMode).toBe(raw.trim().toLowerCase())
    },
  )

  it("GUARD_PSEUDONYMISE=on|off flips the web route's input filter", () => {
    vi.stubEnv('GUARD_PSEUDONYMISE', 'off')
    expect(guardConfig().pseudonymise).toBe(false)
    vi.stubEnv('GUARD_PSEUDONYMISE', 'on')
    expect(guardConfig().pseudonymise).toBe(true)
  })

  it.each([
    ['GUARD_SCREEN', 'nonsense', 'off, shadow, gated, always'],
    ['GUARD_EGRESS', 'by-hope', 'filter, roster'],
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
    vi.stubEnv('GUARD_SCREEN', 'off')
    const map = guardConfig().screenMode as Record<string, string>
    expect(map.default).toBe('off')
    expect(map.anthropic).toBe('always')
    expect(Object.keys(map).filter((k) => k !== 'default')).toEqual(['anthropic'])
    expect(map.verda).toBeUndefined()
  })

  // The boot warning for any value below a tier's default, in the order
  // off < gated < shadow < always: GUARD_SCREEN=gated (below the self-deployed
  // default 'shadow', until the eval bar moves it) and =off warn;
  // GUARD_SCREEN=shadow or always (at or above) do not. MUTATION: warn only
  // when the value is literally 'off' — the gated case here goes red.
  it('a value below a tier default logs ONE warning naming the variable; at or above logs none', () => {
    vi.stubEnv('GUARD_SCREEN', 'gated')
    assertGuardsConfigured()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('GUARD_SCREEN')

    warns = []
    vi.stubEnv('GUARD_SCREEN', 'off')
    assertGuardsConfigured()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('GUARD_SCREEN')

    warns = []
    vi.stubEnv('GUARD_SCREEN', 'shadow')
    assertGuardsConfigured()
    vi.stubEnv('GUARD_SCREEN', 'always')
    assertGuardsConfigured()
    vi.unstubAllEnvs()
    assertGuardsConfigured()
    expect(warns).toEqual([])
  })

  it.each([
    ['GUARD_SCREEN_ANTHROPIC', 'off'],
    ['GUARD_EGRESS', 'roster'],
    ['GUARD_PSEUDONYMISE', 'off'],
  ])(
    '%s=%j logs its own boot warning, naming the variable and what it switches off',
    (variable, value) => {
      vi.stubEnv(variable, value)
      assertGuardsConfigured()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain(variable)
    },
  )

  it('the warnings are one per weakened value per boot, not per call', () => {
    vi.stubEnv('GUARD_SCREEN', 'off')
    vi.stubEnv('GUARD_EGRESS', 'roster')
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'off')
    vi.stubEnv('GUARD_PSEUDONYMISE', 'off')
    assertGuardsConfigured()
    expect(warns).toHaveLength(4)
    assertGuardsConfigured()
    expect(warns).toHaveLength(8)
  })

  it('valid values never refuse boot', () => {
    vi.stubEnv('GUARD_SCREEN', 'gated')
    vi.stubEnv('GUARD_SCREEN_ANTHROPIC', 'always')
    vi.stubEnv('GUARD_EGRESS', 'filter')
    vi.stubEnv('GUARD_PSEUDONYMISE', 'on')
    expect(() => assertGuardsConfigured()).not.toThrow()
  })
})

// #844: the guards' numbers as settings. Each variable's default is today's
// value exactly (the unset pin above), each one takes effect, an invalid value
// refuses boot naming the variable and its range and never the value, and a
// value looser than the default warns once at boot, never per call.
describe('the guard thresholds and the tripwire N as settings (#844)', () => {
  const NUMBERS = [
    ['GUARD_GATE_THRESHOLD', 'gateThreshold', 'a number from 0 to 1'],
    ['GUARD_EGRESS_THRESHOLD', 'egressThreshold', 'a number from 0 to 1'],
    [
      'GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE',
      'maxOutgoingRetriesPostTripwire',
      'a whole number, 0 or greater',
    ],
  ] as const

  // MUTATION: read the wrong variable for one setting (or drop its parse and
  // keep the default): that row goes red.
  it.each([
    ['GUARD_GATE_THRESHOLD', '0.4', 'gateThreshold', 0.4],
    ['GUARD_GATE_THRESHOLD', ' .05 ', 'gateThreshold', 0.05],
    ['GUARD_GATE_THRESHOLD', '0', 'gateThreshold', 0],
    ['GUARD_GATE_THRESHOLD', '1', 'gateThreshold', 1],
    ['GUARD_EGRESS_THRESHOLD', '0.5', 'egressThreshold', 0.5],
    ['GUARD_EGRESS_THRESHOLD', '1.0', 'egressThreshold', 1],
    ['GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '2', 'maxOutgoingRetriesPostTripwire', 2],
    ['GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '0', 'maxOutgoingRetriesPostTripwire', 0],
  ] as const)('%s=%j sets %s to %j', (variable, raw, field, want) => {
    vi.stubEnv(variable, raw)
    expect(guardConfig()[field]).toBe(want)
  })

  // Each setting moves its own field only.
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
    ['GUARD_GATE_THRESHOLD', '0.16', 'skips the screen'],
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
    ['GUARD_GATE_THRESHOLD', '0.15'],
    ['GUARD_GATE_THRESHOLD', '0.05'],
    ['GUARD_EGRESS_THRESHOLD', '0.3'],
    ['GUARD_EGRESS_THRESHOLD', '0'],
    ['GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '0'],
  ])('%s=%j (at or stricter than the default) logs no warning', (variable, raw) => {
    vi.stubEnv(variable, raw)
    assertGuardsConfigured()
    expect(warns).toEqual([])
  })

  // Once: the parse that builds the agents' bag never logs, so a bag built per
  // agent registration cannot repeat a warning; only the boot assert does.
  // MUTATION: log the warnings inside `readGuards()` itself: the guardConfig()
  // calls here log and this goes red.
  it('a looser value warns once per boot, and building the bag logs nothing', () => {
    vi.stubEnv('GUARD_GATE_THRESHOLD', '0.5')
    vi.stubEnv('GUARD_EGRESS_THRESHOLD', '0.5')
    vi.stubEnv('GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', '3')
    assertGuardsConfigured()
    expect(warns).toHaveLength(3)
    guardConfig()
    guardConfig()
    expect(warns).toHaveLength(3)
  })

  // The deployment template carries every guard variable the module reads
  // (#845 review, finding 1). MUTATION: drop one variable's block from either
  // template: the scan misses it and this goes red.
  it('every GUARD_* variable read here appears in both env templates', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../lib/inference/guard-config.server.ts'),
      'utf8',
    )
    const read = [...source.matchAll(/process\.env\.(GUARD_[A-Z_]+)/g)].map((m) => m[1])
    expect(read.length).toBeGreaterThan(0)
    // The app package's template and the deployment template at the repo root.
    for (const template of ['.env.example', '../.env.production.example']) {
      const text = readFileSync(resolve(__dirname, '../../../..', template), 'utf8')
      for (const variable of read) {
        expect(text, `${template} does not document ${variable}`).toContain(variable)
      }
    }
  })
})
