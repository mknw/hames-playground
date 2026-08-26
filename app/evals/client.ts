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
 * ## Two questions, two modes
 *
 * `EVAL_CLIENT=<name>` is the EXPLORATORY question — "would this one client cope
 * with all these roles?" — and it applies that client to every role in
 * `DEFAULT_ROUTED_ROLES`. `EVAL_ROLES` narrows it while bisecting a regression.
 *
 * `EVAL_CLIENT=tier` is the SHIPPED question — "does the private tier, as
 * configured, still work?" — and it resolves each role through production's own
 * map, which since 2026-08-26 is TWO clients: the 27B for the heavy roles and the
 * 4B `LocalQwenSmall` for `describe`. That mode exists because the single-name
 * mode stopped being able to express the shipped route on the day the describe
 * flip landed, and the honest response to that was a second mode rather than a
 * comment claiming the first one still measured it. A default `EVAL_CLIENT=VerdaQwen`
 * run now measures summarization on a model production does not use for it — which
 * is a fair question to ask, just not the same question.
 *
 * ## Roles
 *
 * `DEFAULT_ROUTED_ROLES` is the set a plain `EVAL_CLIENT=X` moves, and it is kept
 * equal to the KEY SET of the production map. After the two 2026-08-26 owner
 * decisions that is EVERY role this suite has a scenario for, `screen`
 * included — the exploratory question `EVAL_ROLES` used to answer ("would this
 * client cope with the router too?") is now the default question, and
 * `EVAL_ROLES` is left for NARROWING a run to one role while bisecting a
 * regression.
 *
 * `screen` was REFUSED here until 2026-08-26, by a `PINNED_ROLES` list this
 * file owned, on the reasoning that a security control's model is not a knob an
 * eval may turn. That refusal is gone, and its removal is the point rather than
 * a relaxation. The owner ruled the same day that no call made under the
 * private tier may be sent to any public AI provider, so production now routes
 * the screen to the self-hosted box — and the two properties a screener needs
 * (it must not be talked out of reporting by the content it reviews; it must
 * copy `spans` VERBATIM, because the guard neutralizes them by literal match)
 * are UNMEASURED on that client. A suite that refuses to point the screen at a
 * candidate client is a suite that guarantees the gap it was protecting
 * against: the refusal was what left `VerdaQwen` unmeasured as a screener in
 * the first place. Measuring a control before shipping it is the opposite of
 * turning a knob on it, and `scenarios/screen.ts` is where that measurement
 * lives.
 *
 * What still holds, and is the reason `screen` remains a role of its own rather
 * than folding into `describe`: nothing may move the screen IMPLICITLY. Here
 * that means the same thing it means in `clients.server.ts` — the screen is its
 * own entry in `DEFAULT_ROUTED_ROLES`, so a run narrowed to `describe` does not
 * silently drag it, and `EVAL_ROLES=screen` is the way to measure it alone.
 */

import {
  resolveClientForRole,
  VERDA_CLIENT_BY_ROLE,
  type BamlRole,
} from '../src/lib/harness-patterns/clients.server'

/** The roles this suite has scenarios for — every `BamlRole` since the planner
 *  scenario landed — plus `actor`, which shares the `controller` role but a
 *  different BAML function and a different chain (`ActorAnthropic`, thinking
 *  left ON). */
export type EvalRole = BamlRole | 'actor'

/** `EvalRole` → the `BamlRole` production resolves it through. */
const PRODUCTION_ROLE: Record<EvalRole, BamlRole> = {
  controller: 'controller',
  actor: 'controller',
  critic: 'critic',
  compactExecution: 'compactExecution',
  router: 'router',
  planner: 'planner',
  describe: 'describe',
  screen: 'screen',
}

/**
 * The roles a plain `EVAL_CLIENT=X` moves — deliberately the same set as
 * `VERDA_CLIENT_BY_ROLE`. Keeping these in step is what makes a default run a
 * measurement of the shipped route rather than of a configuration nobody runs.
 *
 * `router` and `describe` joined on 2026-08-26 with the production map, and
 * `planner` and `screen` followed the same day — the first because a scenario
 * now exists for it, the second because the owner moved it in production. NOT
 * kept in step automatically, and the drift is one-directional: a role added
 * to the production map and forgotten here means the suite quietly stops
 * measuring part of the shipped route — the run still passes, over less. The
 * report header prints this list next to `resolveClientForRole()`'s answer per
 * scenario, which is where a divergence shows.
 *
 * Nothing is held back now, so this list IS the production map plus `actor`.
 * The two roles worth knowing about:
 *
 *  - `planner` closes what was recorded here as a gap: "the role with the
 *    harshest failure policy in the repo now takes the self-hosted route and
 *    nothing here measures it". `planner-plan-shape` measures it. Read the
 *    composite consequence on the `planner:` entry in `VERDA_CLIENT_BY_ROLE`
 *    for what that scenario is standing in front of.
 *  - `screen` is the security control (SD-4). It is measured, not merely
 *    routed — `screen-on-the-tier` asserts the two properties the guard depends
 *    on, and a green run of it is the evidence the production move is owed.
 */
export const DEFAULT_ROUTED_ROLES: readonly EvalRole[] = [
  'controller',
  'actor',
  'critic',
  'compactExecution',
  'router',
  'planner',
  'describe',
  'screen',
]

export interface EvalRouting {
  /** The one client under test, or `undefined` for the declared-chain baseline
   *  AND for the per-role {@link byRole} mode. */
  client?: string
  /** Per-role clients, set only by `EVAL_CLIENT=tier`. When present it OVERRIDES
   *  {@link client} and {@link routed} in {@link evalOverrideFor}: the tier is
   *  not one client, so "which client" is a question per role. */
  byRole?: Partial<Record<EvalRole, string>>
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
  // `EVAL_CLIENT=tier` — the SHIPPED route, read straight off the production map
  // rather than approximated by one client name. `EVAL_ROLES` still narrows it,
  // so bisecting works the same way in both modes.
  if (requested === 'tier') {
    const asked = new Set(requestedRoles())
    const byRole: Partial<Record<EvalRole, string>> = {}
    for (const role of asked) {
      // `actor` shares the `controller` BamlRole; the map is keyed by the latter.
      const client = VERDA_CLIENT_BY_ROLE[PRODUCTION_ROLE[role]]
      if (client) byRole[role] = client
    }
    const routed = [...asked].filter((role) => byRole[role] !== undefined)
    const distinct = [...new Set(Object.values(byRole))].sort()
    return {
      byRole,
      routed,
      note:
        `the shipped private tier — ${distinct.join(' + ')} across ${routed.join(', ')}` +
        (routed.includes('screen') ? '; INCLUDING screen (SD-4)' : ''),
    }
  }
  // No role is refused. The `PINNED_ROLES` machinery this replaced is deleted
  // rather than kept as an empty list: a refusal set with no members is a
  // control that cannot fail, and an unfailable control in a security-adjacent
  // file reads as protection to the next person to open it. If a role ever
  // needs pinning again, the honest version is a fresh list added with the
  // reason and a test that fails without it (SD-4).
  const routed = requestedRoles()
  const notes = [`${requested} on ${routed.join(', ') || '(no roles)'}`]
  if (routed.includes('screen')) {
    notes.push('INCLUDING screen — measuring a security control, not tuning it (SD-4)')
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
  // Per-role first: in `tier` mode there IS no single `routing.client`, and
  // falling through to the branch below would silently run the baseline.
  if (routing.byRole) {
    const client = routing.byRole[role]
    return client ? { client } : undefined
  }
  if (!routing.client) return undefined
  return routing.routed.includes(role) ? { client: routing.client } : undefined
}

/** The client a role will actually be served by in this run: the eval's
 *  override when there is one, else whatever production resolution says. */
export function expectedClientFor(routing: EvalRouting, role: EvalRole): string {
  return evalOverrideFor(routing, role)?.client ?? resolveClientForRole(PRODUCTION_ROLE[role])
}
