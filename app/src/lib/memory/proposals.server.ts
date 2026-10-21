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
import { normalizeStoredInferenceTier } from '../inference/tier-value'
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
  parseMemoryProposalPayload as parseStoredMemoryProposalPayload,
} from '@hames-ai/harness-patterns/memory-store.server'
import { loadConversation, updateConversationContextIfUnchanged } from '../db/conversations.server'
import {
  canonicalAnswer,
  claimHitlProposalAnswer,
  closeHitlRows,
  getHitlProposal,
  listHitlProposals,
  listProposalSessionIds,
  putHitlProposal,
  releaseHitlProposalAnswer,
  requireAnsweringBinding,
  type HitlAnswerValue,
} from '../db/hitl.server'
import { createMemoryDbStore } from '../db/memories.server'
import { getMemoryEnabled } from '../db/user-prefs.server'
import { displayText } from './display-text'
import { createMemoryEmbedder } from './embedder.server'

assertServerOnImport()

/** Host vocabulary stays outside core's opaque proposal parser. */
function parseMemoryProposalPayload(value: unknown) {
  const payload = parseStoredMemoryProposalPayload(value)
  const tier = normalizeStoredInferenceTier(payload?.tier)
  return payload && tier ? { ...payload, tier } : null
}

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
  /** Set when a person's answer is already BOUND to this proposal and only its
   *  effects are unfinished (a refused save). The popup then offers that same
   *  answer again and nothing else (#579 review 2). */
  readonly recorded?: { readonly choice: string; readonly flags: Readonly<Record<string, boolean>> }
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
  return (await readMemoryProposals(userId, sessionId, { switchChecked: false })).views
}

/** The list plus the conversation's title, from ONE blob load. `switchChecked`
 *  says the caller has already read the memory switch for this owner, so the
 *  inbox does not pay it once per conversation (#589 F3). */
async function readMemoryProposals(
  userId: string,
  sessionId: string,
  opts: { switchChecked: boolean },
): Promise<{ views: MemoryProposalView[]; title: string | null }> {
  const none = { views: [], title: null }
  // The cheap, indexed read first: the popup polls on every settle and every
  // window focus in every conversation, and nearly all of those find nothing —
  // that must not cost a decrypt of the whole blob (#579 review 5).
  const rows = await listHitlProposals(sessionId, userId, MEMORY_CONFIRM_KIND)
  if (rows.length === 0) return none
  // A proposal is memory text the person has not agreed to keep. With memory
  // off — "Forget everything" and the switch both leave it off — it is not
  // offered, whatever a row still holds (#579 review 1).
  if (!opts.switchChecked && !(await getMemoryEnabled(userId))) return none
  const conv = await loadConversation(sessionId, userId)
  if (!conv) return none
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
  if (open.size === 0) return none

  const views: MemoryProposalView[] = []
  for (const row of rows) {
    if (!open.has(row.requestId)) continue
    const payload = parseMemoryProposalPayload(row.payload)
    if (!payload || payload.conversationId !== sessionId) continue
    views.push({
      requestId: row.requestId,
      ...(row.status === 'answering' && row.answer
        ? { recorded: { choice: row.answer.choice, flags: row.answer.flags ?? {} } }
        : {}),
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
  return { views, title: conv.title ? displayText(conv.title) : null }
}

/** One row of the header inbox: a conversation with a proposal waiting. Display
 *  text only — the title is the person's own, but the count and ids are all the
 *  inbox needs, so no memory text rides here. */
export interface MemoryInboxEntry {
  readonly sessionId: string
  readonly requestId: string
  readonly title: string | null
  readonly itemCount: number
  readonly expiresAt: number | null
}

/** How many conversations one inbox read opens. Each costs a blob decrypt. */
export const MEMORY_INBOX_LIMIT = 20

/**
 * The caller's pending memory proposals across conversations (#433 S8). The
 * same gates as the per-conversation list, because it IS that list per
 * conversation: memory off → nothing; a proposal the blob no longer has open,
 * an expired one, a purged payload → absent. Erased rows disappear with their
 * rows; nothing is cached.
 */
export async function listMemoryInboxFor(userId: string): Promise<MemoryInboxEntry[]> {
  // The switch first: with memory off nothing is offered, and nothing is read.
  if (!(await getMemoryEnabled(userId))) return []
  const sessionIds = await listProposalSessionIds(userId, MEMORY_CONFIRM_KIND, MEMORY_INBOX_LIMIT)
  const entries: MemoryInboxEntry[] = []
  for (const sessionId of sessionIds) {
    const { views, title } = await readMemoryProposals(userId, sessionId, { switchChecked: true })
    for (const v of views) {
      entries.push({
        sessionId,
        requestId: v.requestId,
        title,
        itemCount: v.items.length,
        expiresAt: v.expiresAt,
      })
    }
  }
  return entries
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
        /** Someone (another tab, another request) answered first and chose
         *  differently: that answer stands, this one writes nothing. */
        | 'already-answered'
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
        /** The owner is at M3's hard limit: nothing was written or answered. */
        | 'full'
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

  // FIRST ANSWER WINS, BEFORE ANY WRITE (#579 review 2). Without this a refused
  // save leaves the writes of answer A standing while answer B is recorded, and
  // two concurrent answers each write. The row binds one answer; a retry of that
  // same answer may finish it, nothing else may.
  const bound = { choice: decided.choice, flags: { ...decided.flags } }
  const claim = await claimHitlProposalAnswer({
    requestId,
    userId,
    sessionId,
    kind: MEMORY_CONFIRM_KIND,
    answer: bound,
  })
  if (!claim.claimed) {
    if (!claim.recorded || canonicalAnswer(claim.recorded) !== canonicalAnswer(bound)) {
      return { outcome: 'already-answered' }
    }
  }
  // A refusal before any write gives the answer back, so it cannot turn "Don't
  // save" into `already-answered` — but only if NOTHING is written under it, and
  // that is the DATABASE's call (`memory_sources` for this proposal's source
  // event), not this attempt's report: an earlier attempt of the same answer, or
  // a concurrent one, may have written (#579 review 2a).
  const release = () =>
    releaseHitlProposalAnswer(requestId, userId, payload.eventId, bound).catch((err: unknown) => {
      console.warn('[memory] bound answer not released:', err)
      return false
    })

  let written = 0
  let stale = 0
  if (decided.choice === MEMORY_CONFIRM_SAVE) {
    const report = await applyMemoryProposal(
      ctx,
      {
        // Each item's transaction re-checks, under a row lock, that THIS answer is
        // still the bound one, so a concurrent release cannot slip between the
        // check and the write (#579 review 2a, D3).
        store: createMemoryDbStore(userId, {
          inTransaction: (tx) => requireAnsweringBinding(tx, requestId, userId, bound),
        }),
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
    if (report.skipped === 'disabled') {
      await release()
      return { outcome: 'memory-off' }
    }
    if (report.skipped) {
      await release()
      return { outcome: 'unavailable' }
    }
    if (report.items.some((i) => i.outcome === 'failed')) {
      await release()
      return { outcome: 'failed' }
    }
    // M3's hard limit refused every item and nothing is written: say so, and
    // give the answer back (if the database agrees nothing is written) so the
    // person can decline or make room and retry.
    if (
      report.items.length > 0 &&
      report.items.every((i) => i.outcome === 'full' || i.outcome === 'stale')
    ) {
      if (report.items.some((i) => i.outcome === 'full')) {
        await release()
        return { outcome: 'full' }
      }
    }
    // `written` counts what this answer put in memory, a retry's duplicates
    // included, so a retry does not report "Saved 0."
    written = report.items.filter(
      (i) => i.outcome === 'written' || i.outcome === 'duplicate',
    ).length
    stale = report.items.filter((i) => i.outcome === 'stale' || i.outcome === 'full').length
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
