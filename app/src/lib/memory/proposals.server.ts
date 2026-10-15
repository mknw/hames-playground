/**
 * The app's half of memory confirmation (#419 M6 = #433 S11) — Server Only.
 *
 * `settleMemory` PREPARES a memory and proposes it (core: a non-blocking
 * `memory.confirm` request in the conversation blob, metadata only); this module
 * holds the prepared payload, offers it to its person and — on an approval —
 * writes it. It is NOT a `'use server'` module: every function here takes the
 * owner, so the browser-reachable surface is `confirm-actions.server.ts`, which
 * authenticates first and passes the session's user down (SD-13).
 *
 * ## Authority
 *
 * The decision state is the blob's `hitl_*` events (ADR-0009). The
 * `hitl_requests` row is the payload's holder and nothing else: a proposal is
 * offered only if the blob has it OPEN, and an answer is bound to that request
 * event by core's `answerProposal` — the request id, the options, the flags,
 * the expiry. What a client supplies is a choice id and flags; the payload, the
 * principal and the memory text all come from here.
 *
 * ## The write, and why it cannot overwrite a newer row
 *
 * `answerMemoryProposalFor` runs, in this order: bind the answer (core), write
 * the approved memories (core's `applyMemoryProposal`, one transaction per item
 * under the owner's advisory lock, idempotent by the provenance key), then save
 * the context ONCE with the response and the `memory_written` events in it,
 * conditional on the version it read (`updateConversationContextIfUnchanged`:
 * refused while a turn holds the conversation, and when the row moved on).
 *
 * Memory first, context second, on purpose: the memory write is idempotent, so a
 * save that is refused ("conflict") costs the person one retry and never a
 * double write or a lost choice, while the other order could record "saved" for
 * a write that failed. A retry finds the provenance rows, writes nothing, and
 * re-records the lost `memory_written`. An item meant to update or reinforce a
 * memory that has since changed is refused as stale, item by item
 * (`applyMemoryProposal`): a stale approval never overwrites a newer row.
 *
 * Nothing here calls a model, wakes a box or reaches a public provider: the
 * vectors were computed when the proposal was prepared, and the tier stamp is
 * the one the proposing turn ran under.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  deserializeContext,
  expireHitl,
  HitlAnswerError,
  readHitl,
  readProposals,
  serializeContext,
  type MemoryConfirmSeam,
  type MemoryKind,
  type HitlAnswerErrorCode,
} from '@hames-ai/harness-patterns'
import { answerProposal } from '@hames-ai/harness-patterns/hitl.server'
import {
  applyMemoryProposal,
  MEMORY_CONFIRM_KIND,
  MEMORY_CONFIRM_SAVE,
  parseMemoryProposalPayload,
} from '@hames-ai/harness-patterns/memory-store.server'
import { loadConversation, updateConversationContextIfUnchanged } from '../db/conversations.server'
import {
  closeHitlRows,
  getHitlProposal,
  listHitlProposals,
  putHitlProposal,
  type HitlAnswerValue,
} from '../db/hitl.server'
import { createMemoryDbStore } from '../db/memories.server'
import { getMemoryEnabled } from '../db/user-prefs.server'
import { displayText } from './display-text'
import { createMemoryEmbedder } from './embedder.server'

assertServerOnImport()

/** Where the proposing hook parks a prepared payload (`MemoryConfig.confirm`). */
export function createMemoryConfirmSeam(owner: () => string | null): MemoryConfirmSeam {
  return {
    hold: async ({ requestId, expiresAt, payload }) => {
      const userId = owner()
      if (!userId) throw new Error('a memory proposal needs an owner')
      await putHitlProposal({
        requestId,
        userId,
        sessionId: payload.conversationId,
        kind: MEMORY_CONFIRM_KIND,
        runId: payload.eventId,
        expiresAt: new Date(expiresAt),
        payload,
      })
    },
  }
}

/** What the popup shows for one prepared memory. Every string is display text:
 *  untrusted, stripped of what a text node cannot defend against, and meant to
 *  be rendered as a text node. No vector, no id of a stored memory. */
export interface MemoryProposalItemView {
  readonly ref: string
  readonly kind: MemoryKind
  readonly content: string
  readonly evidence: string
  /** What saving it does: add a memory, count another sighting of one the
   *  person already has, or replace one's text (shown as `previous`). */
  readonly effect: 'new' | 'reinforces' | 'updates'
  readonly previous?: string
}

export interface MemoryProposalView {
  readonly requestId: string
  /** ms since epoch, or null for none. */
  readonly expiresAt: number | null
  readonly items: readonly MemoryProposalItemView[]
}

/**
 * The open memory proposals of one conversation, for its owner. Offered only
 * when the blob has the request open AND the row still holds a payload this
 * module can read; anything else — purged, expired, malformed, another
 * conversation's — is simply absent. An expired proposal is closed lazily here
 * (its closing event, its payload) unless a run is paused, which the resume's
 * own expiry path owns.
 */
export async function listMemoryProposalsFor(
  userId: string,
  sessionId: string,
): Promise<MemoryProposalView[]> {
  const conv = await loadConversation(sessionId, userId)
  if (!conv) return []
  let ctx = deserializeContext(conv.serializedContext)
  if (readHitl(ctx).pending.length === 0) {
    const closed = expireHitl(conv.serializedContext, Date.now())
    if (closed) {
      const ids = closed.expired
      await updateConversationContextIfUnchanged(
        sessionId,
        userId,
        closed.serialized,
        conv.version,
      ).catch((err: unknown) => console.warn('[memory] expired proposals not closed:', err))
      await closeHitlRows(ids, userId, 'expired').catch((err: unknown) =>
        console.warn('[memory] expired proposal rows not closed:', err),
      )
      ctx = deserializeContext(closed.serialized)
    }
  }
  const open = new Set(
    readProposals(ctx, Date.now())
      .filter((r) => r.kind === MEMORY_CONFIRM_KIND)
      .map((r) => r.requestId),
  )
  if (open.size === 0) return []

  const rows = await listHitlProposals(sessionId, userId, MEMORY_CONFIRM_KIND)
  const views: MemoryProposalView[] = []
  for (const row of rows) {
    if (!open.has(row.requestId)) continue
    const payload = parseMemoryProposalPayload(row.payload)
    if (!payload || payload.conversationId !== sessionId) continue
    views.push({
      requestId: row.requestId,
      expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
      items: payload.items.map((i): MemoryProposalItemView => {
        const effect =
          i.dedupe === 'new' ? 'new' : 'reinforces' in i.dedupe ? 'reinforces' : 'updates'
        return {
          ref: i.ref,
          kind: i.kind,
          content: displayText(i.content),
          evidence: displayText(i.evidence),
          effect,
          ...(i.dedupe !== 'new' ? { previous: displayText(i.dedupe.expectedContent) } : {}),
        }
      }),
    })
  }
  return views
}

/** What became of one answer. The client renders `outcome`; nothing here quotes
 *  what it sent. */
export type MemoryAnswerOutcome =
  | {
      readonly outcome: 'saved'
      /** Memories inserted, reinforced or updated by this answer. */
      readonly written: number
      /** Items that changed under the proposal and were not written. */
      readonly stale: number
    }
  | { readonly outcome: 'discarded' }
  | {
      readonly outcome:
        | 'unknown-request'
        | 'expired'
        | 'invalid-choice'
        | 'unavailable-option'
        | 'invalid-flag'
        | 'required-flag'
        /** The payload is gone, unreadable, or in another embedding space:
         *  this proposal can no longer be saved (it can still be discarded
         *  once the row is purged by expiry). */
        | 'unavailable'
        /** The user's memory switch is off: nothing was written or answered. */
        | 'memory-off'
        /** A write failed: nothing was answered; the same answer may be retried. */
        | 'failed'
        /** The conversation moved on (a turn is running, or it was saved):
         *  nothing was answered; the same answer may be retried. */
        | 'conflict'
    }

const REFUSAL: Partial<Record<HitlAnswerErrorCode, MemoryAnswerOutcome['outcome']>> = {
  'unknown-request': 'unknown-request',
  expired: 'expired',
  'invalid-choice': 'invalid-choice',
  'unavailable-option': 'unavailable-option',
  'invalid-flag': 'invalid-flag',
  'required-flag': 'required-flag',
}

/**
 * Answer one open memory proposal as `userId`. See the module header for the
 * order and its reasons. `answer` is the only client-supplied input, already
 * shape-checked by the RPC (`isAnswerShape`); core checks it again against the
 * request event.
 */
export async function answerMemoryProposalFor(
  userId: string,
  sessionId: string,
  requestId: string,
  answer: string | HitlAnswerValue,
): Promise<MemoryAnswerOutcome> {
  const conv = await loadConversation(sessionId, userId)
  if (!conv) return { outcome: 'unknown-request' }
  const ctx = deserializeContext(conv.serializedContext)

  const open = readProposals(ctx).find(
    (r) => r.requestId === requestId && r.kind === MEMORY_CONFIRM_KIND,
  )
  if (!open) return { outcome: 'unknown-request' }
  if (open.expiresAt !== undefined && Date.now() >= open.expiresAt) return { outcome: 'expired' }

  const row = await getHitlProposal(requestId, userId)
  if (!row || row.sessionId !== sessionId || row.kind !== MEMORY_CONFIRM_KIND) {
    return { outcome: 'unavailable' }
  }
  const payload = parseMemoryProposalPayload(row.payload)
  if (!payload || payload.conversationId !== sessionId) return { outcome: 'unavailable' }

  let accepted
  try {
    accepted = answerProposal(
      ctx,
      { [requestId]: answer },
      { principal: userId, patternId: 'memory-confirm' },
    )
  } catch (err) {
    const mapped = err instanceof HitlAnswerError ? REFUSAL[err.code] : undefined
    if (mapped) return { outcome: mapped } as MemoryAnswerOutcome
    throw err
  }
  const [decided] = accepted

  let written = 0
  let stale = 0
  if (decided.choice === MEMORY_CONFIRM_SAVE) {
    const report = await applyMemoryProposal(
      ctx,
      {
        store: createMemoryDbStore(userId),
        embedSpace: () => createMemoryEmbedder().spaceId,
        enabled: () => getMemoryEnabled(userId),
      },
      {
        payload,
        selected: Object.entries(decided.flags)
          .filter(([, chosen]) => chosen === true)
          .map(([ref]) => ref),
      },
    )
    if (report.skipped === 'disabled') return { outcome: 'memory-off' }
    if (report.skipped) return { outcome: 'unavailable' }
    if (report.items.some((i) => i.outcome === 'failed')) return { outcome: 'failed' }
    written = report.written
    stale = report.items.filter((i) => i.outcome === 'stale').length
  }

  // ONE save: the person's answer and the references to what it wrote.
  const saved = await updateConversationContextIfUnchanged(
    sessionId,
    userId,
    serializeContext(ctx),
    conv.version,
  )
  if (!saved) return { outcome: 'conflict' }
  // The payload's job is done; purge it now rather than at expiry. A failure
  // leaves the encrypted payload for the sweep.
  await closeHitlRows([requestId], userId, 'applied').catch((err: unknown) =>
    console.warn('[memory] answered proposal row not closed:', err),
  )
  return decided.choice === MEMORY_CONFIRM_SAVE
    ? { outcome: 'saved', written, stale }
    : { outcome: 'discarded' }
}
