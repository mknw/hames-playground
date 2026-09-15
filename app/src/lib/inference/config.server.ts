/**
 * The inference tier's vocabulary: which tiers exist, and whether the private
 * one is configured well enough to be offered.
 *
 * Moved here from `harness-patterns/clients.server.ts` (#225 Lane A2,
 * byte-for-byte): eight app modules imported nothing else from that file, so
 * holding the `InferenceTier` union there made every later seam diff touch
 * modules that have no seam surface. This module is a leaf — its only import
 * is the configuration assert it wraps — so nothing behind the tier plumbing
 * (user-prefs, the metrics modules, the client-safe `tier-presentation.ts`,
 * whose `import type` of `InferenceTier` is erased) transitively loads the
 * harness on its account, and no import cycle opens (`tier.server.ts` imports
 * `user-prefs.server.ts`, which imports this; putting the type or
 * `verdaConfigured` in `tier.server.ts` would have closed that loop).
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { assertPrivateTierConfigured } from '../harness-patterns/clients.server'

assertServerOnImport()

/**
 * Which inference tier a run is on.
 *
 * `'verda'` is the self-hosted deployment (`VERDA_CLIENT_BY_ROLE` above);
 * `'anthropic'` is "no override at all", i.e. every function runs the chain it
 * declares. Named rather than boolean because it reaches the browser — a
 * header control shows the user which one their chats are on, and a label is
 * what a preview user can act on.
 */
export type InferenceTier = 'verda' | 'anthropic'

/**
 * Whether the private tier is configured well enough to be *offered*.
 *
 * The non-throwing sibling of `assertPrivateTierConfigured()`, and the two are
 * not interchangeable: this one answers "may a user pick this tier?" (a header
 * control, a preference default), while the assert answers "this run says it
 * is on the private tier — is that reachable?" and stops the run when it is
 * not. Reaching for this one where the assert belongs is how the fail-closed
 * posture below would quietly become a fall-through to Anthropic.
 *
 * It asks about BOTH endpoints, because the tier needs both (the 27B and the 4B
 * summarizer). A deployment with only the 27B configured therefore leaves the
 * switch's private position DISABLED and defaults every user to Anthropic — a
 * whole-tier decision the operator can see, rather than a tier that works until
 * the first tool result needs summarizing.
 */
export function verdaConfigured(): boolean {
  try {
    assertPrivateTierConfigured()
    return true
  } catch {
    return false
  }
}
