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
  it('unset, every value is the declared default, per tier', () => {
    expect(guardConfig()).toEqual({
      screenMode: { default: 'shadow', anthropic: 'always' },
      egressMode: 'filter',
      pseudonymise: true,
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
