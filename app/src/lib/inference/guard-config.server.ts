/** Host guard switches, validated before an agent is built. An unknown value,
 *  the removed GUARD_EGRESS mode, a set retired GUARD_GATE_THRESHOLD, or a set
 *  GUARD_SCREEN 'gated'/'shadow' (the retired gate's modes) refuses rather than
 *  changing routing silently. The three per-tool outgoing variables apply on
 *  both inference tiers.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ByTier } from '@hames-ai/harness-patterns/types'
import type { EgressDetectors, ScreenMode } from '@hames-ai/harness-patterns'
import { SCREEN_POLICY_BY_TIER } from '@hames-ai/agents/types'
import { GUARD_GATE_THRESHOLD } from '@hames-ai/harness-patterns/guard-gate.server'
import {
  GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE,
  GUARD_EGRESS_THRESHOLD,
} from '@hames-ai/harness-patterns/egress-gate.server'

assertServerOnImport()

/** The declared default for the input pseudonymiser. */
const PSEUDONYMISE_DEFAULT = false
/** τe's and N's defaults are the patterns' own constants, the one spelling the
 *  egress gate and general-next share. τi's constant stays as its code-owned
 *  default: since revision 6 no env variable can set it, so the bag below
 *  always carries the pattern's own value. */
const GATE_THRESHOLD_DEFAULT = GUARD_GATE_THRESHOLD
const EGRESS_THRESHOLD_DEFAULT = GUARD_EGRESS_THRESHOLD
const TRIPWIRE_N_DEFAULT = GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE

/** Both screen switches' accepted values (revision 6): 'off' or 'always' per
 *  tier. Both tiers' declared default is 'off' (SCREEN_POLICY_BY_TIER), so no
 *  set value can be weaker than a tier's default and no screen warning
 *  exists — the screen switches' weakening warnings died with the flip. */
const SCREEN_SWITCH_MODES: ReadonlySet<ScreenMode> = new Set<ScreenMode>(['off', 'always'])
/** The screen modes that answered to the retired guard gate (revision 6): a
 *  still-set GUARD_SCREEN value here refuses boot naming the change. */
const RETIRED_SCREEN_MODES: ReadonlySet<string> = new Set(['gated', 'shadow'])
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
  /** τi — always the gate's own default: the env variable is retired (revision 6)
   *  and a still-set value refuses boot. */
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

  // The screen switches read the shared per-tier policy value
  // (SCREEN_POLICY_BY_TIER, revision 6): 'off' on both tiers, so a deployment
  // that sets no switch runs a fully deterministic ingress. 'gated' and
  // 'shadow' answered to the guard gate, which is retired — a still-set one
  // refuses boot naming the change, and no other value warns, because no
  // accepted value is looser than the default.
  const screenRaw = process.env.GUARD_SCREEN
  if (screenRaw && RETIRED_SCREEN_MODES.has(screenRaw.trim().toLowerCase())) {
    throw new Error(
      'GUARD_SCREEN no longer accepts gated or shadow: the guard gate they answered to ' +
        'is retired, replaced by the injection-ingress-guard classification (revision 6). ' +
        'Set off or always, or unset the variable.',
    )
  }
  const selfDeployedScreen = screenRaw
    ? parseMode('GUARD_SCREEN', screenRaw, SCREEN_SWITCH_MODES, 'off, always')
    : SCREEN_POLICY_BY_TIER.self_deployed

  const anthropicRaw = process.env.GUARD_SCREEN_ANTHROPIC
  const anthropicScreen = anthropicRaw
    ? parseMode('GUARD_SCREEN_ANTHROPIC', anthropicRaw, SCREEN_SWITCH_MODES, 'off, always')
    : SCREEN_POLICY_BY_TIER.anthropic

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

  // τi is code-owned since revision 6: the gate question is retired, and a
  // stale threshold in the environment is a misconfiguration — refused here,
  // the same posture as the removed GUARD_EGRESS, never silently applied.
  if (process.env.GUARD_GATE_THRESHOLD !== undefined) {
    throw new Error(
      'GUARD_GATE_THRESHOLD is obsolete; the guard gate question is retired and the ' +
        'injection-ingress-guard classification (GUARD_INGRESS) replaces it. Unset the variable.',
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
      gateThreshold: GATE_THRESHOLD_DEFAULT,
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
