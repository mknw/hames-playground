/**
 * The boundary guards' operator switches (boundary guards, slice 6).
 *
 * Four `GUARD_*` variables let an operator weaken a guard without a code
 * change (O2, ruled). Everything else about the guards — the deterministic
 * layers, the thresholds, the tripwire's N, the directory declaration — has no
 * switch on purpose: it costs no model call, or it is a decision a reviewed
 * line of code must own.
 *
 * The variables are read and validated here and nowhere else (the design's
 * "one module"), per call like every other env-backed setting in this tree, so
 * the values `agentDeps()` composes into `AgentDeps.guards` and the warnings
 * boot logs are decided by the same parse and cannot drift apart. The agents'
 * declared per-tier defaults stay the design's; a switch only overrides them.
 *
 * Values and their meanings:
 *
 *   - `GUARD_SCREEN` sets the injection screen's mode on the SELF-DEPLOYED
 *     tier only (`off|shadow|gated|always`; an absent or unknown tier name is
 *     that tier by the one tier rule). One switch covering both tiers would
 *     let `gated` move the Anthropic tier from `'always'` to a mode that sends
 *     every K1-clean body — mail included — to that tier's decisions host by
 *     an env var (security delta N5), so it does not.
 *   - `GUARD_SCREEN_ANTHROPIC` sets the screen's mode on the ANTHROPIC tier,
 *     and accepts only `off` or `always`: `gated` or `shadow` there ask the
 *     gate, which sends the bodies it reads to that tier's decisions host —
 *     the same processor change, and one that belongs in a reviewed line of
 *     code, so the value REFUSES boot.
 *   - `GUARD_EGRESS` sets the egress gate's mode on every tier
 *     (`filter|roster`). `roster` vetoes on a directory match and never asks
 *     the Decide model, so it is below `'filter'` and warns.
 *   - `GUARD_PSEUDONYMISE` (`on|off`, default on) turns the web route's
 *     input pseudonymiser off. `off` is K5's retirement switch (boundary
 *     guards slice 5): retirement is flipping this default, after a fix for
 *     the egress gate's measured gap has itself been measured.
 *
 * Weakening warns once at boot, naming what the value switches off, in the
 * order `off < gated < shadow < always` for the screen (gated asks the gate,
 * which can SKIP the screen; shadow records the gate's answer and screens
 * anyway, so it is weaker than always but stronger than gated) and
 * `roster < filter` for egress. Every value below a tier's DECLARED default
 * warns — the declared defaults are `general-next`'s (the Settings table):
 * `'shadow'` on the self-deployed tier until the eval bar moves it to
 * `'gated'`, `'always'` on the Anthropic tier, `'filter'` for the egress gate,
 * on for the pseudonymiser. A value AT or above the default warns never.
 *
 * An unknown value REFUSES with a message naming the variable and its allowed
 * values — the same refusal `INFERENCE_TIERS` gets — and never echoes the
 * offending value: an env var's value is not a secret, but nothing here needs
 * to quote one to be diagnosable, and the parse's trim/lower-case normalises
 * casing without ever widening the set.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ByTier } from '@hames-ai/harness-patterns/types'
import type { EgressMode, ScreenMode } from '@hames-ai/harness-patterns'

assertServerOnImport()

/** The declared per-tier defaults for the screen (general-next's, and the
 *  design's Settings table). The self-deployed value moves to `'gated'` when
 *  the eval bar is met (slice 7) — flip it here and in the agent together. */
const SCREEN_DEFAULTS = { self_deployed: 'shadow', anthropic: 'always' } as const
/** The declared default for the egress gate's mode. */
const EGRESS_DEFAULT = 'filter' as const
/** The declared default for the input pseudonymiser. */
const PSEUDONYMISE_DEFAULT = true

const SCREEN_MODES: ReadonlySet<ScreenMode> = new Set<ScreenMode>([
  'off',
  'shadow',
  'gated',
  'always',
])
/** The screen switches' order of protection, weakest first. */
const SCREEN_ORDER: Record<ScreenMode, number> = { off: 0, gated: 1, shadow: 2, always: 3 }
const ANTHROPIC_SCREEN_MODES: ReadonlySet<ScreenMode> = new Set<ScreenMode>(['off', 'always'])
const EGRESS_MODES: ReadonlySet<EgressMode> = new Set<EgressMode>(['filter', 'roster'])
const EGRESS_ORDER: Record<EgressMode, number> = { roster: 0, filter: 1 }

export interface GuardSwitches {
  /** The screen's mode, per tier, as the agents' guards take it (`ByTier`). */
  readonly screenMode: ByTier<ScreenMode>
  /** The egress gate's mode, as the gate's config takes it. */
  readonly egressMode: EgressMode
  /** The web route's input pseudonymiser switch; `false` omits the filter. */
  readonly pseudonymise: boolean
}

/** One parse: the effective values, plus the warning each weakened value has
 *  earned. Throwing on an unknown value here means both callers refuse — boot
 *  through `assertGuardsConfigured`, and a guards bag built after that with
 *  the same failure, never a silently-parsed guess. */
function readGuards(): { switches: GuardSwitches; warnings: string[] } {
  const warnings: string[] = []

  const screenRaw = process.env.GUARD_SCREEN
  const selfDeployedScreen = screenRaw
    ? parseMode('GUARD_SCREEN', screenRaw, SCREEN_MODES, 'off, shadow, gated, always')
    : SCREEN_DEFAULTS.self_deployed
  if (screenRaw && SCREEN_ORDER[selfDeployedScreen] < SCREEN_ORDER[SCREEN_DEFAULTS.self_deployed]) {
    warnings.push(
      `[guards] GUARD_SCREEN=${selfDeployedScreen} switches off part of the injection screen on the ` +
        `self-deployed tier (the tier's default is ${SCREEN_DEFAULTS.self_deployed}): content the ` +
        'deterministic layer passes keeps no model screen there. Restore the default by unsetting it.',
    )
  }

  const anthropicRaw = process.env.GUARD_SCREEN_ANTHROPIC
  const anthropicScreen = anthropicRaw
    ? parseMode('GUARD_SCREEN_ANTHROPIC', anthropicRaw, ANTHROPIC_SCREEN_MODES, 'off, always')
    : SCREEN_DEFAULTS.anthropic
  if (anthropicRaw && SCREEN_ORDER[anthropicScreen] < SCREEN_ORDER[SCREEN_DEFAULTS.anthropic]) {
    warnings.push(
      `[guards] GUARD_SCREEN_ANTHROPIC=${anthropicScreen} switches off the injection screen on the ` +
        'Anthropic tier: content read there keeps no model screen. Restore the default by unsetting it.',
    )
  }

  const egressRaw = process.env.GUARD_EGRESS
  const egressMode = egressRaw
    ? parseMode('GUARD_EGRESS', egressRaw, EGRESS_MODES, 'filter, roster')
    : EGRESS_DEFAULT
  if (egressRaw && EGRESS_ORDER[egressMode] < EGRESS_ORDER[EGRESS_DEFAULT]) {
    warnings.push(
      `[guards] GUARD_EGRESS=${egressMode} switches the egress gate to the name list alone: ` +
        'outgoing requests are no longer judged by the decision model. Restore the default by unsetting it.',
    )
  }

  const pseudonymiseRaw = process.env.GUARD_PSEUDONYMISE
  let pseudonymise: boolean = PSEUDONYMISE_DEFAULT
  if (pseudonymiseRaw) {
    if (pseudonymiseRaw === 'on') pseudonymise = true
    else if (pseudonymiseRaw === 'off') pseudonymise = false
    else
      throw new Error(
        'GUARD_PSEUDONYMISE must be one of: on, off; refusing to boot with an unrecognised value.',
      )
  }
  if (pseudonymiseRaw === 'off') {
    warnings.push(
      "[guards] GUARD_PSEUDONYMISE=off switches off the web route's input pseudonymiser: names are " +
        'no longer rewritten before they reach the model. Restore the default by unsetting it.',
    )
  }

  return {
    switches: {
      screenMode: { default: selfDeployedScreen, anthropic: anthropicScreen },
      egressMode,
      pseudonymise,
    },
    warnings,
  }
}

function parseMode<T extends string>(
  variable: string,
  raw: string,
  allowed: ReadonlySet<T>,
  names: string,
): T {
  const value = raw.trim().toLowerCase() as T
  if (!allowed.has(value)) {
    throw new Error(
      `${variable} must be one of: ${names}; refusing to boot with an unrecognised value.`,
    )
  }
  return value
}

/**
 * The guards' switch values, as `agentDeps()` composes them into
 * `AgentDeps.guards` beside `classifyIngress` (the host classifier is wiring,
 * not a switch, and no env variable sets it). Throws on an unrecognised value,
 * so a bag built before boot's assert has fired fails the same way boot would.
 */
export function guardConfig(): GuardSwitches {
  return readGuards().switches
}

/**
 * Boot validation, in the same family as `assertInferenceDeploymentConfigured`:
 * called from the middleware before anything is served. An unrecognised value
 * throws above; each value below a tier's declared default logs its ONE boot
 * warning here, so a restart is the only way to silence one and nothing at
 * run time re-logs it.
 */
export function assertGuardsConfigured(): void {
  for (const warning of readGuards().warnings) console.warn(warning)
}
