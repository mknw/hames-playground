/**
 * Which client the eval calls go through — and which roles it refuses to move.
 *
 * THIS FILE IS THE ONLY PLACE `EVAL_CLIENT` IS READ. Nothing under `app/src/`
 * knows this suite exists, and that is the point. ADR-0001 and the
 * sensitive-domain brief's SD-12 record the provider posture as a *compliance*
 * property rather than a performance one: there is no configuration that sends
 * a production prompt to a different provider, and the one opt-in that moves
 * traffic (`USE_VERDA_INFERENCE`) is all-or-nothing and documented. An eval
 * runner that added a general "point any role at any client" env var into
 * `src/` would re-introduce exactly the switch that was deleted on 2026-08-24.
 *
 * So the suite reuses the seam instead of widening it. `clientOverrideFor()` in
 * `src/lib/harness-patterns/clients.server.ts` works by spreading
 * `{ client: '<name>' }` into a BAML call's options bag; every scenario here
 * does the same thing with a value this file owns. The production resolution
 * path is untouched and still consulted — `resolveClientForRole()` is what the
 * report prints as the baseline each scenario is compared against.
 *
 * ## Roles
 *
 * By default `EVAL_CLIENT=X` moves exactly the roles that a verda tier decision
 * moves in production (`DEFAULT_ROUTED_ROLES`), so a default run measures the
 * shipped posture rather than a hypothetical one. Since the 2026-08-26 widening
 * that is every role this suite has a scenario for except `screen` — the
 * exploratory question `EVAL_ROLES` used to answer ("would this client cope
 * with the router too?") is now the default question, and `EVAL_ROLES` is left
 * for NARROWING a run to one role while bisecting a regression.
 *
 * `screen` is refused either way. The injection screen resolves through a role
 * of its OWN precisely so that a re-pointing of summarization cannot drag
 * prompt-injection screening along with it (SD-4 / SA-M5): the screen has to
 * copy spans VERBATIM for the guard to neutralize them, and has to be a model
 * that cannot be talked out of reporting by the content it reviews. Neither is
 * a property an unmeasured client gets by default, and a security control's
 * model is not a knob an eval may turn. `screen-pinned.ts` asserts this holds.
 *
 * That refusal did most of its work on 2026-08-26, when `describe` moved to the
 * self-hosted box in production and `screen` — the same chain in BAML, one role
 * apart here — did not. The two are now measured on opposite sides of the same
 * default run, which is exactly the separation the role split exists for.
 */

import { resolveClientForRole, type BamlRole } from '../src/lib/harness-patterns/clients.server'

/** The roles this suite has scenarios for. A subset of `BamlRole` plus
 *  `actor`, which shares the `controller` role but a different BAML function
 *  and a different chain (`ActorAnthropic`, thinking left ON). */
export type EvalRole = Exclude<BamlRole, 'planner'> | 'actor'

/** `EvalRole` → the `BamlRole` production resolves it through. */
const PRODUCTION_ROLE: Record<EvalRole, BamlRole> = {
  controller: 'controller',
  actor: 'controller',
  critic: 'critic',
  compactExecution: 'compactExecution',
  router: 'router',
  describe: 'describe',
  screen: 'screen',
}

/**
 * The roles a plain `EVAL_CLIENT=X` moves — deliberately the same set as
 * `VERDA_CLIENT_BY_ROLE`. Keeping these in step is what makes a default run a
 * measurement of the shipped route rather than of a configuration nobody runs.
 *
 * `router` and `describe` joined on 2026-08-26 with the production map. NOT
 * kept in step automatically, and the drift is one-directional: a role added
 * to the production map and forgotten here means the suite quietly stops
 * measuring part of the shipped route — the run still passes, over less. The
 * report header prints this list next to `resolveClientForRole()`'s answer per
 * scenario, which is where a divergence shows.
 *
 * `planner` is absent because this suite has no planner scenario (see
 * `EvalRole`), not because the production map leaves it out — it does not, as
 * of the same date. That is a coverage gap in the eval suite: the role with the
 * harshest failure policy in the repo now takes the self-hosted route and
 * nothing here measures it.
 */
export const DEFAULT_ROUTED_ROLES: readonly EvalRole[] = [
  'controller',
  'actor',
  'critic',
  'compactExecution',
  'router',
  'describe',
]

/** Never re-pointed, by any combination of env vars. See the SD-4 note above. */
export const PINNED_ROLES: readonly EvalRole[] = ['screen']

export interface EvalRouting {
  /** The client under test, or `undefined` for the declared-chain baseline. */
  client?: string
  /** Roles `client` is applied to. Empty when running the baseline. */
  routed: readonly EvalRole[]
  /** Human-readable note for the report header. */
  note: string
}

/** Roles named in `EVAL_ROLES`, or the default set. Throws on an unknown name
 *  rather than silently evaluating fewer roles than the operator asked for. */
function requestedRoles(): readonly EvalRole[] {
  const raw = process.env.EVAL_ROLES?.trim()
  if (!raw) return DEFAULT_ROUTED_ROLES
  const known = new Set(Object.keys(PRODUCTION_ROLE) as EvalRole[])
  const asked = raw
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean) as EvalRole[]
  const unknown = asked.filter((r) => !known.has(r))
  if (unknown.length > 0) {
    throw new Error(
      `EVAL_ROLES names unknown role(s) ${unknown.join(', ')}. Known: ${[...known].join(', ')}.`,
    )
  }
  return asked
}

/**
 * Resolve the run's routing from the environment.
 *
 * `EVAL_CLIENT` unset, empty, or `default` is the BASELINE: no override is
 * spread anywhere, so every BAML function runs the Anthropic chain it declares
 * in `baml_src/`. That is the run every other run is read against — "did this
 * new client keep the workflows working" is only answerable next to a
 * measurement of the workflows working.
 */
export function resolveEvalRouting(): EvalRouting {
  const requested = process.env.EVAL_CLIENT?.trim()
  if (!requested || requested === 'default') {
    return {
      routed: [],
      note: 'baseline — every function on the Anthropic chain it declares in baml_src/',
    }
  }
  const asked = requestedRoles()
  const pinned = new Set(PINNED_ROLES)
  const refused = asked.filter((r) => pinned.has(r))
  const routed = asked.filter((r) => !pinned.has(r))
  const notes = [`${requested} on ${routed.join(', ') || '(no roles)'}`]
  if (refused.length > 0) {
    notes.push(
      `REFUSED to re-point ${refused.join(', ')} — a screen's model is not an eval knob (SD-4)`,
    )
  }
  if (!process.env.EVAL_ROLES) notes.push('default role set = the production Verda map')
  return { client: requested, routed, note: notes.join('; ') }
}

/**
 * `{ client }` for a role this run routes, otherwise `undefined` — the same
 * shape, and the same spread-into-the-options-bag contract, as
 * `clientOverrideFor()`. Spread it, then branch on whether the bag ended up
 * empty: the generated BAML functions take their arguments POSITIONALLY, so an
 * empty `{}` in the trailing slot is NOT equivalent to passing nothing (#154).
 */
export function evalOverrideFor(
  routing: EvalRouting,
  role: EvalRole,
): { client: string } | undefined {
  if (!routing.client) return undefined
  return routing.routed.includes(role) ? { client: routing.client } : undefined
}

/** The client a role will actually be served by in this run: the eval's
 *  override when there is one, else whatever production resolution says. */
export function expectedClientFor(routing: EvalRouting, role: EvalRole): string {
  return evalOverrideFor(routing, role)?.client ?? resolveClientForRole(PRODUCTION_ROLE[role])
}
