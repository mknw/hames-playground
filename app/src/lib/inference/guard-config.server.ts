/** Host guard switches, validated before an agent is built. Unknown values and
 * the removed GUARD_EGRESS mode refuse rather than changing routing silently.
 * The three per-tool outgoing variables apply on both inference tiers.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ByTier } from '@hames-ai/harness-patterns/types'
import type { EgressDetectors, ScreenMode } from '@hames-ai/harness-patterns'
import { GUARD_GATE_THRESHOLD } from '@hames-ai/harness-patterns/guard-gate.server'
import {
  GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE,
  GUARD_EGRESS_THRESHOLD,
} from '@hames-ai/harness-patterns/egress-gate.server'

assertServerOnImport()

/** The declared per-tier defaults for the screen (general-next's, and the
 *  design's Settings table). Keep both maps in agreement. */
const SCREEN_DEFAULTS = { self_deployed: 'gated', anthropic: 'always' } as const
/** The declared default for the input pseudonymiser. */
const PSEUDONYMISE_DEFAULT = true
/** τi's and τe's defaults are the patterns' own; N's default is the patterns'
 *  constant too, the one spelling the egress gate and general-next share. */
const GATE_THRESHOLD_DEFAULT = GUARD_GATE_THRESHOLD
const EGRESS_THRESHOLD_DEFAULT = GUARD_EGRESS_THRESHOLD
const TRIPWIRE_N_DEFAULT = GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE

const SCREEN_MODES: ReadonlySet<ScreenMode> = new Set<ScreenMode>([
  'off',
  'shadow',
  'gated',
  'always',
])
/** The screen switches' order of protection, weakest first. */
const SCREEN_ORDER: Record<ScreenMode, number> = { off: 0, gated: 1, shadow: 2, always: 3 }
const ANTHROPIC_SCREEN_MODES: ReadonlySet<ScreenMode> = new Set<ScreenMode>(['off', 'always'])
const EGRESS_NAME_MATCHES: ReadonlySet<EgressDetectors['nameMatch']> = new Set([
  'off',
  'evidence',
  'refuse',
])
const EGRESS_DECIDE_MODES: ReadonlySet<EgressDetectors['decide']> = new Set(['off', 'on', 'shadow'])

export interface GuardSwitches {
  /** The screen's mode, per tier, as the agents' guards take it (`ByTier`). */
  readonly screenMode: ByTier<ScreenMode>
  readonly egressTools?: readonly string[]
  readonly egressNameMatch?: EgressDetectors['nameMatch']
  readonly egressDecide?: EgressDetectors['decide']
  /** The web route's input pseudonymiser switch; `false` omits the filter. */
  readonly pseudonymise: boolean
  /** τi, as `createGuardGate`'s `threshold` takes it. */
  readonly gateThreshold: number
  /** τe, as the egress gate's `threshold` takes it. */
  readonly egressThreshold: number
  /** The egress tripwire's N, as `maxOutgoingRetriesPostTripwire`. */
  readonly maxOutgoingRetriesPostTripwire: number
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

  if (process.env.GUARD_EGRESS !== undefined) {
    throw new Error(
      'GUARD_EGRESS is obsolete; use GUARD_EGRESS_TOOLS, GUARD_EGRESS_NAME_MATCH and GUARD_EGRESS_DECIDE.',
    )
  }
  const toolsRaw = process.env.GUARD_EGRESS_TOOLS
  const egressTools = toolsRaw === undefined ? undefined : toolsRaw.split(',').map((s) => s.trim())
  if (egressTools?.some((s) => !s || s === 'tag:' || s.includes(' ')))
    throw new Error('GUARD_EGRESS_TOOLS contains an empty or invalid selector.')
  const nameRaw = process.env.GUARD_EGRESS_NAME_MATCH
  const egressNameMatch =
    nameRaw === undefined
      ? undefined
      : parseMode('GUARD_EGRESS_NAME_MATCH', nameRaw, EGRESS_NAME_MATCHES, 'off, evidence, refuse')
  const decideRaw = process.env.GUARD_EGRESS_DECIDE
  const egressDecide =
    decideRaw === undefined
      ? undefined
      : parseMode('GUARD_EGRESS_DECIDE', decideRaw, EGRESS_DECIDE_MODES, 'off, on, shadow')
  if (egressNameMatch === 'off')
    warnings.push('[guards] GUARD_EGRESS_NAME_MATCH=off disables name matching on selected tools.')
  if (egressDecide === 'off' || egressDecide === 'shadow')
    warnings.push(
      `[guards] GUARD_EGRESS_DECIDE=${egressDecide} disables active Decide on selected tools.`,
    )

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

  const gateRaw = process.env.GUARD_GATE_THRESHOLD
  const gateThreshold = gateRaw
    ? parseProbability('GUARD_GATE_THRESHOLD', gateRaw)
    : GATE_THRESHOLD_DEFAULT
  if (gateThreshold > GATE_THRESHOLD_DEFAULT) {
    warnings.push(
      `[guards] GUARD_GATE_THRESHOLD=${gateThreshold} raises the guard gate's threshold above its ` +
        `default of ${GATE_THRESHOLD_DEFAULT}: where the injection screen is gated, more content the ` +
        'gate scores as possibly manipulative skips the screen. Restore the default by unsetting it.',
    )
  }

  const egressThresholdRaw = process.env.GUARD_EGRESS_THRESHOLD
  const egressThreshold = egressThresholdRaw
    ? parseProbability('GUARD_EGRESS_THRESHOLD', egressThresholdRaw)
    : EGRESS_THRESHOLD_DEFAULT
  if (egressThreshold > EGRESS_THRESHOLD_DEFAULT) {
    warnings.push(
      `[guards] GUARD_EGRESS_THRESHOLD=${egressThreshold} raises the egress gate's threshold above ` +
        `its default of ${EGRESS_THRESHOLD_DEFAULT}: outgoing requests the decision model judges more ` +
        'likely to carry private data go out without a refusal or a prompt. Restore the default by unsetting it.',
    )
  }

  const tripwireRaw = process.env.GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE
  const maxOutgoingRetriesPostTripwire = tripwireRaw
    ? parseCount('GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE', tripwireRaw)
    : TRIPWIRE_N_DEFAULT
  if (maxOutgoingRetriesPostTripwire > TRIPWIRE_N_DEFAULT) {
    warnings.push(
      `[guards] GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE=${maxOutgoingRetriesPostTripwire} keeps a ` +
        `route's outgoing requests open after a refusal (default ${TRIPWIRE_N_DEFAULT}: the first ` +
        `refusal closes the route for the turn): the route now closes at refusal ` +
        `${maxOutgoingRetriesPostTripwire + 1}, so a refused request can be rephrased and asked again. ` +
        'Restore the default by unsetting it.',
    )
  }

  return {
    switches: {
      screenMode: { default: selfDeployedScreen, anthropic: anthropicScreen },
      egressTools,
      egressNameMatch,
      egressDecide,
      pseudonymise,
      gateThreshold,
      egressThreshold,
      maxOutgoingRetriesPostTripwire,
    },
    warnings,
  }
}

/** Plain decimal digits, with an optional fractional part: no sign, exponent,
 *  hex prefix or inner whitespace, all of which `Number()` would coerce. */
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/

/** A threshold: a probability from 0 to 1. Refuses with the variable and the
 *  range, never the value. */
function parseProbability(variable: string, raw: string): number {
  const text = raw.trim()
  const value = DECIMAL.test(text) ? Number(text) : Number.NaN
  if (!(value >= 0 && value <= 1)) {
    throw new Error(
      `${variable} must be a number from 0 to 1; refusing to boot with a value outside that range.`,
    )
  }
  return value
}

/** A count: a whole number, 0 or more. Refuses with the variable and the
 *  range, never the value. */
function parseCount(variable: string, raw: string): number {
  const text = raw.trim()
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `${variable} must be a whole number, 0 or greater; refusing to boot with a value outside that range.`,
    )
  }
  return value
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
