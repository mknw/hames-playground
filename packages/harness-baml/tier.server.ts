/**
 * The tier module — which inference tier a run is on, and the ONE rule that
 * answers it (boundary guards, slice 9; ruling E, coordinator proposal 4).
 *
 * MOVED here from `clients.server.ts`, which re-exports every name, so no
 * importer changes its path. What moved is the vocabulary (`InferenceTier`),
 * the host-fed policy (`configureInferencePolicy`) and the three readers of it:
 * {@link activeInferenceTier}, {@link onExplicitAnthropicTier} and
 * {@link assertInferenceTier}.
 *
 * ## The rule
 *
 * A frame tier is the Anthropic tier only when it says exactly `'anthropic'`
 * (and the deployment is not restricted to the self-deployed tier). An absent
 * or empty tier is whatever the HOST'S policy names as its default — which the
 * reference host sets to `'self_deployed'` — and, with no host policy
 * registered, the package's own fallback, `'anthropic'`: a library user has no
 * self-deployed tier to default to. A PRESENT but unrecognised tier is the
 * self-deployed tier, so an unreachable one is refused on every host rather
 * than taken as the public tier.
 *
 * ## One function, two readers
 *
 * Routing (`clientOverrideFor`, `resolveClientForRole`, the decisions client)
 * and the guards used to read "no tier" two ways, so a run with no tier routed
 * to one provider while a guard behaved as if it were on the other. This module
 * registers {@link activeInferenceTier} into core's run-frame module as
 * `effectiveTier()` at load; core interprets no tier string and calls what was
 * registered, and every guard-side reader asks core. Both sides therefore name
 * the same tier by construction rather than by two copies of a comparison.
 *
 * ## A default that cannot be taken is refused
 *
 * When no recognised tier is named and the tier read is the self-deployed one (an
 * absent or empty frame value that takes a self-deployed default, or a present but
 * unrecognised one, which this module reads as the self-deployed tier), reachability
 * is asserted on every read. An unconfigured
 * host therefore refuses the call before any request — it never routes to the
 * Anthropic tier, which is the one outcome the self-deployed tier exists to
 * prevent. A frame that NAMES the tier was already asserted by the host before
 * it filled the slot ({@link assertInferenceTier}).
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { currentRunFrame, registerEffectiveTier } from '@hames-ai/harness-patterns/run-frame.server'

assertServerOnImport()

/**
 * Which inference tier a run is on.
 *
 * `'self_deployed'` is the self-hosted deployment (`SELF_DEPLOYED_CLIENT_BY_ROLE`
 * in `clients.server.ts`); `'anthropic'` is "no override at all", i.e. every
 * function runs the chain it declares. Named rather than boolean because it
 * reaches the browser — a header control shows the user which one their chats
 * are on, and a label is what a preview user can act on.
 */
export type InferenceTier = 'self_deployed' | 'anthropic'

/** The app-policy half of the tier seam: what a run takes when it names no
 *  tier, whether a 'self_deployed' scope is reachable, and what to announce
 *  when a private-tier client is about to take a call. */
export interface InferenceTierPolicy {
  /** The tier of a run that names none: no frame, or a frame whose `inference`
   *  slot nobody filled or filled with an empty value (a script, a
   *  background job). A present but unrecognised value is not this: it is the
   *  self-deployed tier, refused when unreachable. The reference host answers `'self_deployed'`; the
   *  package-side default, with no host policy, is `'anthropic'`. */
  defaultTier: () => InferenceTier
  /** Restrict this deployment to the built-in private clients. Unset preserves all routing. */
  privateOnly?: () => boolean
  /** Fail-closed reachability check, run by {@link assertInferenceTier} before
   *  a host puts 'self_deployed' in a run frame (the host's
   *  `assertPrivateTierConfigured`), and on every read of a DEFAULTED
   *  self-deployed tier. Unregistered → the tier is REFUSED, not opened. */
  assertTierReachable?: (tier: InferenceTier) => void
  /** A private-tier client (`SELF_DEPLOYED_CLIENT_BY_ROLE`'s values) is about to take
   *  a call. The host decides what that means — the wake/cold-start notice
   *  filters on its own scale-to-zero client name here, keeping the "which
   *  client scales to zero" knowledge host-side. */
  onPrivateCallStart?: (client: string) => void
}

/**
 * The policy lives on a `globalThis` symbol, the way core keeps the run frame
 * and the registered tier reader: every copy of this module registers its own
 * reader at load (last wins), so a policy held per copy would let a second copy
 * answer the guards from the package fallback while routing reads the host's.
 * One holder means every loaded copy reads the one policy the host configured.
 */
const POLICY_KEY: unique symbol = Symbol.for('hames.harness-baml.tier-policy') as never
type PolicyHolder = { policy: InferenceTierPolicy }
const policyGlobal = globalThis as unknown as Record<symbol, PolicyHolder | undefined>
const policyHolder: PolicyHolder = (policyGlobal[POLICY_KEY] ??= {
  policy: { defaultTier: () => 'anthropic' },
})

/** Feed the host's tier policy in. Called once at the composition root. */
export function configureInferencePolicy(policy: InferenceTierPolicy): void {
  policyHolder.policy = policy
}

/** The policy in force, for the routing seam's private-call hook. */
export function notePrivateCallStart(client: string): void {
  policyHolder.policy.onPrivateCallStart?.(client)
}

/** Whether the host restricts this deployment to the built-in private tier. */
export function privateInferenceOnly(): boolean {
  return policyHolder.policy.privateOnly?.() === true
}

/**
 * Refuse a tier this deployment cannot actually take — the check that used to
 * live inside `runWithInferenceTier` before the run frame replaced it.
 *
 * The scope moved to core and core is GENERIC: the frame's `inference.tier` is
 * an opaque string, and core neither knows what `'self_deployed'` means nor what would
 * make it unreachable (ruling D1, issue #374 — provider specifics stay in this
 * companion). So the fail-closed gate moved here, and the HOST calls it before
 * it puts a tier in a frame.
 *
 * FAIL CLOSED on `'self_deployed'`: checked through the host-registered
 * `assertTierReachable`, and refused outright when NO policy is registered —
 * matching every other gate on this tier. The alternative — shrug and let BAML
 * fall through to the declared Anthropic chain — is the one failure this whole
 * route exists to prevent, and it is no less dangerous for having come from a
 * user's preference row than from an env var.
 *
 * Throws synchronously. Its predecessor rejected instead, because its contract
 * was "hand me a callback, get a promise" and a caller that only wrote
 * `.catch()` would otherwise have taken the throw on the stack. This one takes
 * no callback, so there is no such caller to protect.
 */
export function assertInferenceTier(tier: InferenceTier): void {
  if (privateInferenceOnly() && tier !== 'self_deployed') {
    throw new Error(
      'Private-only inference: the Anthropic tier is disabled on this deployment; no request was made.',
    )
  }
  if (tier !== 'self_deployed') return
  const assertReachable = policyHolder.policy.assertTierReachable
  if (!assertReachable) {
    throw new Error(
      "The 'self_deployed' inference tier was requested but no inference policy is registered. " +
        'The host registers one at its composition root (lib/inference/config.server.ts, ' +
        'via configureInferencePolicy); refusing rather than guessing is the fail-closed default.',
    )
  }
  assertReachable(tier)
}

/**
 * The tier in force right now: the open run frame's `inference.tier` when it
 * names a tier this module knows; a present but unrecognised one is the
 * self-deployed tier (refused when unreachable); an absent or empty one is the
 * policy's default (see the module header — the ONE rule).
 *
 * THE ONE IMPORT THIS PACKAGE TAKES FROM CORE'S FRAME for the tier. A tier is a
 * property of the RUN, not of a call site; it is a slot of the single run frame
 * the harness entry points open, read here at CALL time, which is what makes
 * one turn's tier cover every adapter inside it without threading a parameter
 * anywhere.
 *
 * The frame carries the tier as an OPAQUE STRING, because core must not know
 * provider vocabulary. The narrowing back to this module's union happens here,
 * and an unrecognised value is never trusted as the Anthropic tier: a host
 * that writes a typo into the slot gets the self-deployed tier — refused when
 * it is unreachable — not an unrouted one. Only an ABSENT or empty tier takes
 * the policy's default. `'verda'` is the pre-rename
 * spelling of `'self_deployed'` (and only that spelling).
 */
export function activeInferenceTier(): InferenceTier {
  const tier = currentRunFrame()?.inference?.tier
  const named: InferenceTier | undefined =
    tier === 'verda' || tier === 'self_deployed'
      ? 'self_deployed'
      : tier === 'anthropic'
        ? tier
        : undefined
  // An ABSENT or empty tier takes the host default; a tier that is present but
  // unrecognised is never the Anthropic tier (ruling E) — it is the self-deployed
  // tier, so an unreachable one is refused below instead of reaching a public
  // provider on a host whose default is Anthropic.
  const active = named ?? (tier ? 'self_deployed' : policyHolder.policy.defaultTier())
  // A tier a frame names was asserted by the host before the slot was filled;
  // one taken by default has not been, so the assertion happens here, per read.
  if (privateInferenceOnly() || (!named && active === 'self_deployed')) {
    assertInferenceTier(active)
  }
  return active
}

/** True only when the run is on the Anthropic tier by the one rule — a frame
 *  that names it, or no tier named on a deployment whose default it is. Reads
 *  {@link activeInferenceTier}, so it cannot disagree with routing. */
export function onExplicitAnthropicTier(): boolean {
  return activeInferenceTier() === 'anthropic'
}

// Registered at load, last registration wins. Every path that can reach a guard
// or a BAML call loads this module (`clients.server.ts` re-exports it).
registerEffectiveTier(activeInferenceTier)
