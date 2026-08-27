/**
 * Which inference tier a CONVERSATION runs on — Server Only.
 *
 * The tier used to be a property of the user (`user_prefs.inference_tier`, one
 * row, read once per turn). It is now a property of the conversation, because
 * the two things a person actually wants are per-thread: start an Anthropic
 * chat while a private one is still waking, and keep a thread that must stay
 * on company infrastructure there whatever they did in the last one.
 *
 * ## The resolution order, and what each step means
 *
 *   1. **The conversation's own column** — `conversations.inference_tier`. Set
 *      by the switch beside the agent selector, and recorded by the first turn
 *      of every conversation (`saveConversation`'s COALESCE), so a thread that
 *      has ever run has a tier of its own.
 *   2. **The user's last-used tier** — `user_prefs.inference_tier`, which is
 *      now a SEED rather than a setting: every flip writes it, so a new
 *      conversation starts where the last one left off. This is the step a
 *      brand-new chat takes, since its row does not exist until its first turn.
 *   3. **The deployment default** — `defaultInferenceTier()`: the private tier
 *      when its endpoints are configured, Anthropic when they are not. The
 *      second half is a fail-closed constraint rather than a second policy —
 *      see that function.
 *
 * The narrowing lives here rather than in the repository: `conversations.
 * server.ts` returns the column verbatim so that the db bootstrap's import
 * graph stays clear of `clients.server.ts` and its module-load assert (the
 * reason is written on `StoredInferenceTier`). A value this build does not
 * recognise therefore falls to step 2, which is what an unknown tier should do
 * — passing it to `runWithInferenceTier` would be a silent no-op that reads
 * like a choice.
 *
 * Deliberately NOT a `'use server'` module: both functions take a `userId`,
 * which would let a browser caller choose whose conversation to read or
 * re-route. The RPC surface is `harness-client/actions.server.ts`, which
 * resolves the owner from the session and passes it in — the same contract
 * `turn.server.ts` and `db/user-prefs.server.ts` carry.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import {
  getConversationInferenceTier,
  setConversationInferenceTier,
} from '../db/conversations.server'
import {
  defaultInferenceTier,
  getStoredInferenceTier,
  isInferenceTier,
  setStoredInferenceTier,
} from '../db/user-prefs.server'
import { verdaConfigured, type InferenceTier } from '../harness-patterns/clients.server'

assertServerOnImport()

/**
 * The tier a conversation's next turn runs on: its own, else the user's
 * last-used, else the deployment default.
 *
 * Takes the stored column rather than reading it, so the two callers that
 * already hold a row — the sidebar list, which resolves 200 of them against
 * one seed — do not pay a lookup each. {@link resolveConversationTier} is the
 * lookup.
 */
export function resolveTier(
  conversationTier: string | null,
  seed: InferenceTier | null,
): InferenceTier {
  if (isInferenceTier(conversationTier)) return conversationTier
  return seed ?? defaultInferenceTier()
}

/**
 * The tier `sessionId`'s next turn runs on, for the owner `userId`.
 *
 * An unknown or unowned id is not an error here: it is a conversation that does
 * not exist yet, which is every chat before its first message. It resolves
 * through the seed, and the tier it lands on is what the first turn records on
 * the row it creates.
 *
 * Both reads are indexed single-row lookups and independent, so they go
 * together — this runs once per turn, in front of the run.
 */
export async function resolveConversationTier(
  sessionId: string,
  userId: string,
): Promise<InferenceTier> {
  const [stored, seed] = await Promise.all([
    getConversationInferenceTier(sessionId, userId),
    getStoredInferenceTier(userId),
  ])
  return resolveTier(stored, seed)
}

/**
 * Put one conversation on `tier`, and make it this user's seed for the next new
 * chat. Returns the tier now in force for that conversation.
 *
 * **Both writes, always, and the order matters only for the failure case.** The
 * seed is what a conversation with no row yet resolves through, so a flip made
 * before the first message has nowhere else to land; the row write is what
 * makes a flip stick to THIS conversation once one exists. A flip on a
 * conversation that has not been persisted yet is therefore a seed write and
 * nothing more, and the pre-seed of its first turn copies it onto the row.
 *
 * **`'verda'` is refused when the endpoint is unconfigured**, exactly as the
 * header switch it replaces refused it: storing it would leave a row that
 * `runWithInferenceTier` throws on, turning one click into a chat that cannot
 * take another message — and the one thing that must never happen instead, a
 * quiet fall-through to Anthropic, is refused by design upstream. The switch
 * renders that position disabled for the same reason; this is the server half,
 * because a disabled control is a courtesy and not a gate.
 */
export async function chooseConversationTier(
  sessionId: string,
  userId: string,
  tier: unknown,
): Promise<InferenceTier> {
  if (!isInferenceTier(tier)) {
    throw new Error(`Unknown inference tier: ${JSON.stringify(tier)}`)
  }
  if (tier === 'verda' && !verdaConfigured()) {
    throw new Error(
      'The self-hosted inference endpoint is not configured on this deployment, so it cannot ' +
        'be selected. Set VERDA_INFERENCE_ENDPOINT, VERDA_INFERENCE_API_KEY and ' +
        'SMALL_LLM_BASE_URL (see app/.env.example).',
    )
  }
  // Owner-scoped both sides: the row write no-ops on someone else's id, and the
  // seed is keyed by the resolved user. Neither takes an owner from the caller.
  //
  // SEQUENTIAL, row first, rather than a concurrent pair. The seed is the
  // observable half — it is one row per user, so it is what a test or another
  // reader can wait on — and doing them concurrently lets it commit while the
  // conversation's own write is still in flight, i.e. a window in which the
  // choice looks landed and the conversation is still on the old tier. Ordering
  // them makes the seed's arrival imply the row's. It also fails in the better
  // direction: a row write that throws leaves the seed alone, so a failed flip
  // does not silently re-aim the user's next new chat.
  await setConversationInferenceTier(sessionId, userId, tier)
  await setStoredInferenceTier(userId, tier)
  return tier
}

/** Whether the private tier may be OFFERED on this deployment — the switch's
 *  disabled state. Re-exported here so the one server action behind the switch
 *  has a single import for everything it answers. */
export { verdaConfigured }
