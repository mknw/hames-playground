/**
 * settleMemory — the store half of persistent memory (#419 M2) — Server Only
 *
 * After the reply, decide whether the turn contains something worth
 * remembering about the user and, if so, write it. This function WRITES
 * PERSISTENT USER DATA, so every uncertain path ends in "store nothing": each
 * fail-closed path below is named, and each is pinned.
 *
 * ## Where it runs, and why its events are not lost (review F1)
 *
 * `settleMemory(ctx, cfg)` is started FROM INSIDE the host's `compactAndSave`
 * continuation — the position that already holds the request context and the
 * run frame, after the answer was sent — and AWAITED there, so every
 * `memory_written` it records is in `ctx.events` BEFORE that continuation's
 * `saveSession`. One version-conditional save carries the turn's events and
 * the memory references together: no second detached save, no race with the
 * next turn. That holds only while the save lands: the host's trailing save is
 * refused while a newer turn holds the conversation, so a user who replies
 * during this function's wake/extract/embed/merge time commits memories and loses
 * their events. A retry re-records a lost event (see the conflict handling
 * below); the mechanism that avoids the loss is the host's (M5). It writes
 * straight into `ctx.events` and never through `trackEvent`, so nothing here
 * can reach a live listener, which is to say the transcript. It NEVER throws
 * and never touches the conversation row: a failure is a logged line and a
 * returned reason.
 *
 * ## The pipeline, and where it stops
 *
 *  1. owner → switch → tier → window → turn state. No user, switched off, no
 *     tier to stamp, no answered user message, or a turn that ended in `error`
 *     or `paused`: stop.
 *  2. The joint wake (`awaitWake`, bounded): a box that did not come up, or a
 *     rejected wake, stops it. Nothing is ever sent to a public provider
 *     instead.
 *  3. ONE `decideFields` over the question/answer pair (O2): `sensitive`,
 *     `target`, `confirm`, `kind`. Endpoint verdicts decide; failed calls store nothing.
 *  4. `sensitive` or an unanswered sensitivity question stops. `target: none` stops.
 *  5. `resolveStoreRoute`: an organisational-graph outcome ALWAYS asks (F2),
 *     whatever `confirm` said; a personal one may skip the question only for a
 *     routine kind. **Pre-M12 there is no graph writer: an org target stores
 *     nothing and logs (F4). An `ask` stores nothing and logs unless the host
 *     supplies a `confirm` seam (M6); with one, the prepared memories are
 *     PROPOSED to the person (step 5b) and written only by an approval
 *     ({@link applyMemoryProposal}).** "Auto-write" is the one pick that
 *     contradicts O4.
 *  5b. (M6) `route.confirm === 'ask'` with a `confirm` seam runs steps 6–7,
 *     then PREPARES instead of writing: a read-only dedupe preview per
 *     candidate, a non-blocking `memory.confirm` proposal recorded in the
 *     context (metadata only — counts and kinds, never the text), and the
 *     payload held by the host under the proposal's id. Nothing is written
 *     and nothing is sent anywhere; the person's answer is a later call.
 *  6. Extract (the `describe`-role call): at most three candidates, from the
 *     current user message — the evidence rule (D9) is enforced in
 *     {@link acceptCandidate}, not here.
 *  7. Embed the accepted candidates (document side).
 *  8. One transaction PER CANDIDATE under the owner's advisory lock: nearest
 *     neighbour → reinforce | update | insert → the provenance row IN THE SAME
 *     transaction (F9). A primary-key conflict on the provenance row throws and
 *     the transaction rolls back, so a retry of the same event is a no-op and a
 *     partial run can leave neither a memory without its source nor a source
 *     without its memory.
 *  9. One metadata-only `memory_written` per memory, after its commit.
 *
 * ## Erasure semantics (#419 owner decision (b)) — M2 and M3 together
 *
 * An `update` replaces the memory's text IN PLACE and keeps every provenance
 * row, including the ones that no longer support that text, so deleting a
 * conversation removes every memory that ever drew on it (errs toward erasing
 * more). `evidenceEventId` records which event the stored `evidence` quotes,
 * and a failed merge call keeps both memories. SPEC.md "Erasure semantics" is the statement M3 inherits.
 *
 * This step reports `compactionDue` at `softLimit`; the host may opt into M3
 * with `compactMemory` before its save. Inserts also enforce M3's hard cap.
 */

import { assertServerOnImport } from './assert.server'
import { createEvent, generateId } from './context.server'
import { stripThinkBlocks } from './content-transforms'
import { currentRunFrame } from './run-frame.server'
import { setLivePatternEnabled } from './live-event-context.server'
import { trimToFit } from './token-budget.server'
import {
  acceptCandidate,
  MAX_MEMORY_CHARS,
  MEMORY_KINDS,
  type AcceptanceRule,
} from './memory-acceptance.server'
import { decide, decideFields } from './patterns/typedDecision.server'
import { proposeToHuman } from './hitl.server'
import type {
  AssistantMessageEventData,
  ContextEvent,
  DecideAllFn,
  DecideFn,
  DecisionSetSpec,
  DecisionSpec,
  HitlRequest,
  LLMCallRecord,
  MemoryConfirmSeam,
  MemoryEmbedder,
  MemoryExtractFn,
  MemoryKind,
  MemoryNeighbor,
  MemoryProposalItem,
  MemoryProposalPayload,
  MemoryWakeWait,
  MemoryWriteAction,
  MemoryWriteTx,
  MemoryWriteStore,
  MemoryWrittenEventData,
  PatternScope,
  UnifiedContext,
  UserMessageEventData,
} from './types'

assertServerOnImport()

// ============================================================================
// The decisions
// ============================================================================

export const MEMORY_STORE_KEY = 'memory.store'
export const MEMORY_MERGE_KEY = 'memory.merge'

export type MemoryTarget = 'personal_memory' | 'organizational_graph' | 'none'
export type MemoryConfirm = 'ask' | 'skip'
export type MemorySensitivity = 'ordinary' | 'sensitive'
export type MemoryMergeLabel = 'same' | 'update' | 'distinct'

export interface MemoryStoreFields extends Record<string, string> {
  target: MemoryTarget
  confirm: MemoryConfirm
  kind: MemoryKind
  sensitive: MemorySensitivity
}

/**
 * The store gate: ONE set, four typed fields over one state. The label
 * descriptions are the only text the model sees for each label, so they carry
 * the whole criterion. Product 3·2·4·2 = 48 exceeds the joint cap, so the set
 * is served as independent systemone questions in one request.
 */
export const MEMORY_STORE_SET: DecisionSetSpec<MemoryStoreFields> = {
  key: MEMORY_STORE_KEY,
  fields: {
    target: {
      key: `${MEMORY_STORE_KEY}.target`,
      question:
        'Did the user, in their latest message, state something about themselves or about their organisation that is worth remembering for future conversations — and where does it belong?',
      labels: [
        {
          id: 'personal_memory',
          description:
            'The user stated a lasting fact about THEMSELVES: a preference, a habit, their role or circumstances, or a decision they made.',
        },
        {
          id: 'organizational_graph',
          description:
            'The user stated a fact about the ORGANISATION — its people, teams, systems or relationships — that belongs in the shared knowledge graph rather than in a personal note.',
        },
        {
          id: 'none',
          description:
            'Nothing to keep: a question, a request to act on material the message already provides, small talk, or anything the user did not say about themselves or the organisation.',
        },
      ],
    },
    confirm: {
      key: `${MEMORY_STORE_KEY}.confirm`,
      question: 'Should a person confirm this before it is saved?',
      labels: [
        {
          id: 'ask',
          description:
            'Yes: anything uncertain, consequential, about other people, or that the user did not plainly volunteer as a lasting fact.',
        },
        {
          id: 'skip',
          description:
            'No: a routine, low-stakes preference or circumstance the user plainly volunteered about themselves, which is safe to save unasked.',
        },
      ],
    },
    kind: {
      key: `${MEMORY_STORE_KEY}.kind`,
      question: 'What kind of memory is it?',
      labels: [
        {
          id: 'episodic',
          description: 'A one-off event or a situation that holds for now, not a lasting trait.',
        },
        {
          id: 'semantic',
          description: "A stable fact about the user's circumstances: role, team, location, tools.",
        },
        {
          id: 'preference',
          description: 'A stated like, dislike or way the user wants things done.',
        },
        {
          id: 'trait',
          description: 'A habit or characteristic the user states about themselves.',
        },
      ],
    },
    sensitive: {
      key: `${MEMORY_STORE_KEY}.sensitive`,
      question:
        'Does the message touch a special category of personal data, or a secret, that must never be stored?',
      labels: [
        {
          id: 'ordinary',
          description: 'Ordinary working preferences and circumstances.',
        },
        {
          id: 'sensitive',
          description:
            'Health, ethnicity, political opinions, religion, union membership, sexual orientation, genetic or biometric data — or credentials, account numbers, or government identifiers.',
        },
      ],
    },
  },
}

/**
 * The merge question, asked only when a candidate is related to an existing
 * memory of the same kind but not a near-duplicate of it.
 */
export const MEMORY_MERGE_SPEC: DecisionSpec<MemoryMergeLabel> = {
  key: MEMORY_MERGE_KEY,
  question:
    'Is the new statement the same fact as the existing memory, a newer version of it, or a different fact?',
  labels: [
    { id: 'same', description: 'It says the same thing as the existing memory.' },
    {
      id: 'update',
      description: 'It replaces the existing memory: the same subject, now stated differently.',
    },
    { id: 'distinct', description: 'It is a different fact that should be kept alongside.' },
  ],
}

// ============================================================================
// Configuration
// ============================================================================

export interface MemoryStoreSettings {
  /** The user's memory switch. REQUIRED for a write: absent → nothing is stored
   *  (D11, off until the user enables it). A throw stops the store. */
  readonly enabled?: () => boolean | Promise<boolean>
  /** Question/answer pairs the gate and the extractor see. Default 1. */
  readonly storeWindowTurns?: number
  /** Candidates read from one extraction. Default 3. */
  readonly maxPerTurn?: number
  /** τ_dup: cosine similarity at or above which a same-kind candidate only
   *  reinforces its neighbour. Default 0.92. UNMEASURED. */
  readonly dupSimilarity?: number
  /** τ_rel: similarity from which a preference/trait is put to the merge
   *  question. Default 0.75. UNMEASURED. */
  readonly relatedSimilarity?: number
  /** The merge question runs inside the transaction (it must see the lock's
   *  world), so it is bounded: past this the candidate inserts.
   *  Default 10 000 ms. */
  readonly mergeTimeoutMs?: number
  /** How long to wait on the joint wake. Default 180 000 ms. */
  readonly wakeBudgetMs?: number
  /** T_soft: the owner's count from which compaction is due. Default 300. */
  readonly softLimit?: number
  /** M3 ceiling (default 400). Optional host eviction reclaims episodic rows. */
  readonly hardLimit?: number
  /** Kinds a personal memory may be written from WITHOUT a confirmation, when
   *  the gate says `skip`. Default episodic, semantic, preference — `trait` always
   *  asks. */
  readonly routineKinds?: readonly MemoryKind[]
}

export interface MemoryStoreConfig {
  /** REQUIRED: the write seam, bound by the host to the turn's owner. */
  readonly store: MemoryWriteStore
  /** REQUIRED: the systemone decision seam. */
  readonly decide: DecideFn
  /** The one-request provider (Jev), when the host has one. */
  readonly decideAll?: DecideAllFn
  /** REQUIRED: the extractor (`describe` role). */
  readonly extract: MemoryExtractFn
  /** REQUIRED: the embedder, document side included. */
  readonly embed: MemoryEmbedder
  /** REQUIRED: the turn's owner, from the host's request context — never an
   *  argument the store takes. */
  readonly owner: () => string | null
  /** The tier a stored memory is stamped with. Default: the run frame's
   *  `inference.tier`; with neither, nothing is stored. */
  readonly tier?: () => string | undefined
  /** The joint memory wake (`awaitMemoryWake` binds as-is). Absent → no wake
   *  to wait on. */
  readonly awaitWake?: MemoryWakeWait
  /** Where a prepared memory waits for the person's confirmation (M6). Absent:
   *  an `ask` stores nothing (`no-confirmation`), as before M6. */
  readonly confirm?: MemoryConfirmSeam
  readonly settings?: MemoryStoreSettings
}

/** Why a turn stored nothing. */
export type MemoryStoreSkip =
  | 'no-user'
  | 'disabled'
  | 'no-tier'
  | 'turn-failed'
  | 'no-pair'
  /** The user message carries no event id, so a retry could not be recognised. */
  | 'no-event-id'
  | 'waking'
  /** The gate said there is nothing to keep (or was not sure). */
  | 'gate'
  /** The message touches a special category, or the read was uncertain. */
  | 'sensitive'
  /** F4: the route needs a confirmation and the host supplied no `confirm` seam. */
  | 'no-confirmation'
  /** M6: this turn's proposal is already in the context — open, answered or
   *  expired — so it is not raised twice. */
  | 'already-proposed'
  /** F4: the target is the organisational graph and no writer exists yet. */
  | 'org-no-writer'
  | 'extract-error'
  /** Every candidate failed deterministic acceptance, or none came back. */
  | 'no-candidates'
  | 'error'
  | 'full'

/** Why a candidate was dropped: an acceptance rule, or `not-routine` (the route
 *  skipped confirmation for the gate's kind and this candidate's kind must ask). */
export type RejectRule = AcceptanceRule | 'not-routine'

export interface MemorySettleReport {
  readonly skipped?: MemoryStoreSkip
  /** Memories inserted, reinforced or updated. */
  readonly written: number
  /** Memories prepared for a person's confirmation (M6) — not yet written. */
  readonly proposed: number
  /** Candidates whose provenance row existed already: written before, skipped. */
  readonly duplicates: number
  /** Candidates whose transaction failed. */
  readonly failed: number
  /** The routing the gate resolved to, when it got that far. */
  readonly route?: StoreRoute
  /** Rule id → candidates it dropped. */
  readonly rejected: Readonly<Partial<Record<RejectRule, number>>>
  /** The owner's memory count reached `softLimit`. M3 acts on it. */
  readonly compactionDue: boolean
}

const DEFAULT_MAX_PER_TURN = 3
const DEFAULT_DUP_SIMILARITY = 0.92
const DEFAULT_REL_SIMILARITY = 0.75
const DEFAULT_MERGE_TIMEOUT_MS = 10_000
const DEFAULT_WAKE_BUDGET_MS = 180_000
const DEFAULT_SOFT_LIMIT = 300
const DEFAULT_HARD_LIMIT = 400
const DEFAULT_ROUTINE_KINDS: readonly MemoryKind[] = ['episodic', 'semantic', 'preference']
/** Kinds whose related candidates are put to the merge question. */
const MERGEABLE_KINDS: readonly MemoryKind[] = ['preference', 'trait']

/** Error defaults (D15): a failed read stores nothing, asks, and
 *  takes the least durable kind. */
export const MEMORY_STORE_FALLBACKS = {
  target: 'none',
  confirm: 'ask',
  kind: 'episodic',
  sensitive: 'sensitive',
} as const satisfies MemoryStoreFields

// ============================================================================
// Routing
// ============================================================================

export interface StoreRoute {
  readonly target: Exclude<MemoryTarget, 'none'>
  /** What will actually happen: `skip` only for a personal memory of a
   *  routine kind the gate said was routine. */
  readonly confirm: MemoryConfirm
}

/**
 * Resolve what the gate's answers allow (F2). The model's `confirm` is a
 * request, not a decision:
 *
 *  - an organisational-graph write goes into a store OTHER users' turns read,
 *    so it asks regardless of what the field said;
 *  - a personal write may skip the question only when the user is the
 *    principal for their own data AND the kind is routine.
 *
 * Returns null for `target: none`.
 */
export function resolveStoreRoute(
  fields: { target: MemoryTarget; confirm: MemoryConfirm; kind: MemoryKind },
  routineKinds: readonly MemoryKind[] = DEFAULT_ROUTINE_KINDS,
): StoreRoute | null {
  if (fields.target === 'none') return null
  if (fields.target === 'organizational_graph') {
    return { target: 'organizational_graph', confirm: 'ask' }
  }
  const skip = fields.confirm === 'skip' && routineKinds.includes(fields.kind)
  return { target: 'personal_memory', confirm: skip ? 'skip' : 'ask' }
}

// ============================================================================
// The window
// ============================================================================

interface Pair {
  readonly user: string
  readonly assistant: string
}

/** The current turn's question/answer pair and, when `turns > 1`, the pairs
 *  before it. ONLY `user_message` and the FINAL `assistant_message` are read:
 *  `tool_result`, `tool_call`, `controller_action` and `llmCall` records never
 *  enter, so a page that says "remember that …" cannot reach the gate or the
 *  extractor through the window (`input-isolation`). */
export function readStoreWindow(
  events: readonly ContextEvent[],
  turns: number,
): { pairs: Pair[]; userEventId: string | undefined } | undefined {
  const userAt: number[] = []
  events.forEach((e, i) => {
    if (e.type === 'user_message') userAt.push(i)
  })
  if (userAt.length === 0) return undefined

  const pairOf = (from: number, to: number): Pair | undefined => {
    const user = ((events[from].data as UserMessageEventData).content ?? '').trim()
    if (!user) return undefined
    let assistant = ''
    for (let i = to - 1; i > from; i--) {
      const e = stripThinkBlocks(events[i])
      if (e.type === 'assistant_message' && (e.data as AssistantMessageEventData).final === true) {
        assistant = ((e.data as AssistantMessageEventData).content ?? '').trim()
        break
      }
    }
    return assistant ? { user, assistant } : undefined
  }

  const last = userAt.length - 1
  const current = pairOf(userAt[last], events.length)
  if (!current) return undefined

  const pairs: Pair[] = [current]
  for (let k = last - 1; k >= 0 && pairs.length < Math.max(1, turns); k--) {
    const p = pairOf(userAt[k], userAt[k + 1])
    if (p) pairs.unshift(p)
  }
  return { pairs, userEventId: events[userAt[last]].id }
}

const renderPairs = (pairs: readonly Pair[]): string =>
  pairs.map((p) => `User: ${p.user}\nAssistant: ${p.assistant}`).join('\n\n')

// ============================================================================
// Small helpers
// ============================================================================

/** A class name, or `Error` — never the message (it can quote what it read). */
function errorKind(e: unknown): string {
  return e instanceof Error && e.name ? e.name : 'Error'
}

/** One log line per stop: the reason and nothing the user said. */
function logStop(reason: string, extra = ''): void {
  console.warn(`[memory-store] stored nothing: ${reason}${extra ? ` (${extra})` : ''}`)
}

/** The extractor's call record without what it carried: `variables`,
 *  `promptTemplate`, `rawInput`, `rawOutput` and `parsedOutput` are the
 *  candidates and the window — the memory's text. Cost attribution survives. */
export function redactCall(call: LLMCallRecord | undefined): LLMCallRecord | undefined {
  if (!call) return undefined
  return {
    functionName: call.functionName,
    variables: {},
    ...(call.usage ? { usage: call.usage } : {}),
    ...(call.metrics ? { metrics: call.metrics } : {}),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(call.provider ? { provider: call.provider } : {}),
    ...(call.clientName ? { clientName: call.clientName } : {}),
  }
}

/** Insert the provenance row inside the open transaction; on a primary-key
 *  conflict, read what the existing row points at and roll the candidate back. */
async function claim(
  tx: MemoryWriteTx,
  memoryId: string,
  src: { eventId: string; ordinal: number; conversationId: string },
): Promise<void> {
  const r = await tx.addSource({ memoryId, ...src })
  if (!r.inserted) throw new SourceConflict(r.memoryId, await tx.read(r.memoryId))
}

/**
 * M3's hard limit, for EVERY insert — a settle's and an approval's alike. At
 * the limit the oldest episodes are evicted to make room; if that still leaves
 * no room (or a count cannot be read) the insert is refused with
 * {@link MemoryFull} and the transaction rolls back. One helper, so a path that
 * adds a row cannot forget the cap.
 */
async function makeRoomForInsert(tx: MemoryWriteTx, hardLimit: number | undefined): Promise<void> {
  const hard = hardLimit ?? DEFAULT_HARD_LIMIT
  if (!Number.isSafeInteger(hard) || hard < 1) throw new Error('invalid memory hard limit')
  const count = await tx.count()
  if (!Number.isSafeInteger(count) || count < 0) throw new MemoryFull()
  if (count >= hard && tx.evictOldestEpisodes) {
    await tx.evictOldestEpisodes(count - hard + 1)
  }
  const after = await tx.count()
  if (!Number.isSafeInteger(after) || after < 0 || after >= hard) throw new MemoryFull()
}

/** Roll back a candidate whose owner switched memory off while it waited. */
class MemoryDisabled extends Error {}
class MemoryFull extends Error {}

/** Thrown inside a candidate's transaction to roll it back: this candidate's
 *  provenance row exists, so it was written before. */
class SourceConflict extends Error {
  constructor(
    readonly memoryId: string,
    readonly existing: { kind: MemoryKind; content: string } | null,
  ) {
    super('memory source row already exists')
    this.name = 'MemorySourceConflict'
  }
}

const validVector = (v: unknown, dim?: number): v is number[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  (dim === undefined || v.length === dim) &&
  v.every((x) => typeof x === 'number' && Number.isFinite(x))

// ============================================================================
// settleMemory
// ============================================================================

const emptyReport = (): MemorySettleReport => ({
  written: 0,
  proposed: 0,
  duplicates: 0,
  failed: 0,
  rejected: {},
  compactionDue: false,
})

/**
 * Settle a finished turn into memory. NEVER throws: every failure is a stop
 * with a reason. Mutates `ctx.events` (decision and `memory_written` events),
 * so the caller must persist AFTER awaiting it.
 */
export async function settleMemory(
  ctx: UnifiedContext,
  cfg: MemoryStoreConfig,
  turn: { readonly conversationId?: string } = {},
): Promise<MemorySettleReport> {
  const scope: PatternScope<Record<string, never>> = {
    id: 'memory-store',
    events: [],
    data: {},
    startTime: Date.now(),
  }
  try {
    return await run(ctx, cfg, turn, scope)
  } catch (err) {
    // Not a path the pipeline plans for (every step below converts its own
    // failure): still a stop, never a throw into the host's continuation.
    logStop('unexpected failure', errorKind(err))
    return { ...emptyReport(), skipped: 'error' }
  } finally {
    // Decision events ride the context whatever happened — they are the audit
    // of WHY nothing was (or was) stored, and they carry no state text.
    flushDecisions(ctx, scope)
  }
}

/** Move the decision events recorded so far onto the context, in order. */
function flushDecisions(ctx: UnifiedContext, scope: PatternScope<Record<string, never>>): void {
  ctx.events.push(...scope.events.splice(0))
}

async function run(
  ctx: UnifiedContext,
  cfg: MemoryStoreConfig,
  turn: { readonly conversationId?: string },
  scope: PatternScope<Record<string, never>>,
): Promise<MemorySettleReport> {
  const { store, decide: decideFn, decideAll, extract, embed, owner, awaitWake, settings } = cfg
  const stop = (
    skipped: MemoryStoreSkip,
    extra?: string,
    more: Partial<MemorySettleReport> = {},
  ) => {
    logStop(skipped, extra)
    return { ...emptyReport(), ...more, skipped }
  }

  // This step's events are never the transcript: switch the live slot off, so a
  // decision event cannot reach a listener either (L1).
  setLivePatternEnabled(false)
  const userId = owner()
  if (userId === null || userId === undefined || userId === '') return stop('no-user')
  try {
    // D11: memory is off until the user enables it. A host that supplies no
    // switch has not asked for writes.
    if (!settings?.enabled) return stop('disabled', 'no switch configured')
    if (!(await settings.enabled())) return stop('disabled')
  } catch (err) {
    return stop('disabled', `switch unreadable: ${errorKind(err)}`)
  }

  const frameTier = currentRunFrame()?.inference?.tier
  const tier = cfg.tier ? cfg.tier() : frameTier
  // D8: a stamp that disagrees with the tier the calls ran under would recall a
  // private memory into a public-tier turn.
  if (cfg.tier && frameTier !== undefined && tier !== frameTier)
    return stop('no-tier', 'tier override disagrees with the run frame')
  if (typeof tier !== 'string' || tier === '') return stop('no-tier')

  if (ctx.status === 'error' || ctx.status === 'paused') return stop('turn-failed', ctx.status)
  const window = readStoreWindow(ctx.events, settings?.storeWindowTurns ?? 1)
  if (!window) return stop('no-pair')
  // The provenance key is the user message's event id. Without one a retry
  // could not be recognised, and a write that cannot be made idempotent is not
  // made.
  const userEventId = window.userEventId
  if (!userEventId) return stop('no-event-id')
  const current = window.pairs[window.pairs.length - 1]

  // The joint wake: this continuation has already answered the user, so it may
  // wait. A box that did not come up — or a wake that rejected — stores nothing.
  if (awaitWake) {
    let outcome: 'awake' | 'skipped' = 'skipped'
    try {
      outcome = await awaitWake(settings?.wakeBudgetMs ?? DEFAULT_WAKE_BUDGET_MS)
    } catch {
      outcome = 'skipped'
    }
    if (outcome !== 'awake') return stop('waking')
  }

  // --- 3. the gate ---------------------------------------------------------
  let gateWindow = 16_384
  try {
    const w = decideFn.limits?.().contextWindow
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) gateWindow = w
  } catch {
    // an unreadable limit is the default window
  }
  // Oldest pair first to go; the current one always stays.
  const gatePairs = trimToFit([...window.pairs], renderPairs, 300, gateWindow)
  const state = renderPairs(gatePairs)

  const decided = await decideFields(
    scope,
    {
      decide: decideFn,
      ...(decideAll ? { decideAll } : {}),
      set: MEMORY_STORE_SET,
      state,
    },
    { trackHistory: 'decision_made', errorSeverity: 'recoverable' },
  )

  flushDecisions(ctx, scope)
  // Only an answered `ordinary` may proceed.
  if (decided.sensitive.label !== 'ordinary') return stop('sensitive')
  if (decided.target.label === null || decided.target.label === 'none') return stop('gate')

  const route = resolveStoreRoute(
    {
      target: decided.target.label,
      // A kind nobody established is not a PROVABLY routine one (D7/F2): when the
      // kind call failed, the question is asked whatever `confirm` said.
      confirm:
        decided.kind.reason === 'error'
          ? 'ask'
          : (decided.confirm.label ?? MEMORY_STORE_FALLBACKS.confirm),
      kind: decided.kind.label ?? MEMORY_STORE_FALLBACKS.kind,
    },
    settings?.routineKinds ?? DEFAULT_ROUTINE_KINDS,
  )
  if (!route) return stop('gate')
  // F4. Pre-M12: no graph writer. Pre-M6: no confirmation mechanism.
  if (route.target === 'organizational_graph') return stop('org-no-writer', undefined, { route })
  if (route.confirm === 'ask' && !cfg.confirm) return stop('no-confirmation', undefined, { route })

  // --- 6. extract -----------------------------------------------------------
  let extracted: Awaited<ReturnType<MemoryExtractFn>>
  try {
    extracted = await extract({
      kindHint: decided.kind.label ?? MEMORY_STORE_FALLBACKS.kind,
      window: renderPairs(gatePairs),
      latestUser: current.user,
    })
  } catch (err) {
    return stop('extract-error', errorKind(err), { route })
  }
  const llmCall = extracted.call
  const raw = Array.isArray(extracted.value)
    ? extracted.value.slice(0, settings?.maxPerTurn ?? DEFAULT_MAX_PER_TURN)
    : []

  const rejected: Partial<Record<RejectRule, number>> = {}
  const routine = settings?.routineKinds ?? DEFAULT_ROUTINE_KINDS
  const userMessages = window.pairs.map((p) => p.user)
  // A kind the gate was not sure of is stored as the one kind that expires.
  const uncertainKind = decided.kind.reason === 'error'
  const accepted: Array<{ ordinal: number; kind: MemoryKind; content: string; evidence: string }> =
    []
  raw.forEach((candidate, ordinal) => {
    const r = acceptCandidate(candidate, { latestUser: current.user, userMessages })
    if (!r.ok) {
      rejected[r.rule] = (rejected[r.rule] ?? 0) + 1
      return
    }
    const kind = uncertainKind ? MEMORY_STORE_FALLBACKS.kind : r.kind
    // The route skipped the question on the strength of the GATE's kind; a
    // candidate of a kind that must ask cannot ride that answer.
    if (route.confirm === 'skip' && !routine.includes(kind)) {
      rejected['not-routine'] = (rejected['not-routine'] ?? 0) + 1
      return
    }
    accepted.push({ ordinal, kind, content: r.content, evidence: r.evidence })
  })
  if (Object.keys(rejected).length > 0) {
    logStop('candidates dropped by acceptance', JSON.stringify(rejected))
  }
  if (accepted.length === 0) return stop('no-candidates', undefined, { route, rejected })

  // --- 7. embed -------------------------------------------------------------
  let vectors: number[][]
  try {
    vectors = await embed.documents(accepted.map((c) => c.content))
  } catch (err) {
    return stop('error', `embedding failed: ${errorKind(err)}`, { route, rejected })
  }
  const dim = Array.isArray(vectors) ? vectors[0]?.length : undefined
  if (
    !Array.isArray(vectors) ||
    vectors.length !== accepted.length ||
    typeof embed.spaceId !== 'string' ||
    embed.spaceId === '' ||
    !vectors.every((v) => validVector(v, dim))
  ) {
    return stop('error', 'embedder returned unusable vectors', { route, rejected })
  }

  const conversationId = turn.conversationId ?? ctx.sessionId
  const dup = settings?.dupSimilarity ?? DEFAULT_DUP_SIMILARITY
  const rel = settings?.relatedSimilarity ?? DEFAULT_REL_SIMILARITY
  const mergeMs = settings?.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS

  // --- 5b. prepare and propose (M6): nothing is written -----------------------
  if (route.confirm === 'ask' && cfg.confirm) {
    let items: MemoryProposalItem[]
    try {
      items = await store.transaction(async (tx) => {
        // The same re-read as a write: a switch-off while this waited stops it.
        if (!(await settings!.enabled!())) throw new MemoryDisabled()
        const prepared: MemoryProposalItem[] = []
        for (let i = 0; i < accepted.length; i++) {
          const cand = accepted[i]
          const embedding = vectors[i]
          const near = await tx.nearest({ embedding, embedSpace: embed.spaceId, tier })
          const verdict = await chooseAction(cand, near, { dup, rel, mergeMs }, scope, decideFn)
          prepared.push({
            ref: `i${i}`,
            ordinal: cand.ordinal,
            kind: cand.kind,
            content: cand.content,
            evidence: cand.evidence,
            embedding,
            dedupe:
              verdict === 'insert' || !near
                ? 'new'
                : verdict === 'update'
                  ? { updates: near.id, expectedContent: near.content }
                  : { reinforces: near.id, expectedContent: near.content },
          })
        }
        return prepared
      })
    } catch (err) {
      if (err instanceof MemoryDisabled) return stop('disabled', undefined, { route, rejected })
      return stop('error', `proposal preview failed: ${errorKind(err)}`, { route, rejected })
    }
    flushDecisions(ctx, scope)
    return propose(
      ctx,
      cfg.confirm,
      items,
      { tier, embedSpace: embed.spaceId, userEventId, conversationId },
      {
        route,
        rejected,
      },
    )
  }

  // --- 8/9. write, one transaction per candidate ---------------------------
  let written = 0
  let duplicates = 0
  let failed = 0
  let full = false
  let pendingCall: LLMCallRecord | undefined = llmCall

  for (let i = 0; i < accepted.length; i++) {
    const cand = accepted[i]
    const embedding = vectors[i]
    try {
      const done = await store.transaction(async (tx) => {
        // Re-read under the owner lock: wake/extract/embed may outlive a switch-off.
        // Throw so the host rolls this candidate back.
        if (!(await settings!.enabled!())) throw new MemoryDisabled()
        const near = await tx.nearest({ embedding, embedSpace: embed.spaceId, tier })
        const verdict = await chooseAction(cand, near, { dup, rel, mergeMs }, scope, decideFn)
        const src = { eventId: userEventId, ordinal: cand.ordinal, conversationId }

        let memoryId: string
        let action: MemoryWriteAction
        if (verdict === 'insert' || !near) {
          await makeRoomForInsert(tx, settings?.hardLimit)
          memoryId = generateId('mem')
          action = 'inserted'
          await tx.insert({
            id: memoryId,
            kind: cand.kind,
            tier,
            content: cand.content,
            evidence: cand.evidence,
            evidenceEventId: userEventId,
            embedding,
            embedSpace: embed.spaceId,
          })
          await claim(tx, memoryId, src)
        } else {
          memoryId = near.id
          await claim(tx, memoryId, src)
          if (verdict === 'update') {
            action = 'updated'
            await tx.update(memoryId, {
              content: cand.content,
              evidence: cand.evidence,
              evidenceEventId: userEventId,
              embedding,
              embedSpace: embed.spaceId,
            })
          } else {
            action = 'reinforced'
            await tx.reinforce(memoryId)
          }
        }
        return { memoryId, action }
      })

      const data: MemoryWrittenEventData = {
        memoryId: done.memoryId,
        kind: cand.kind,
        tier,
        eventId: userEventId,
        ordinal: cand.ordinal,
        action: done.action,
      }
      // The extractor's call is recorded once, on the first memory it produced —
      // REDACTED: its variables, prompt and output hold the candidates and the
      // window, which is the memory's text.
      flushDecisions(ctx, scope)
      ctx.events.push(createEvent('memory_written', 'memory-store', data, redactCall(pendingCall)))
      pendingCall = undefined
      written++
    } catch (err) {
      if (err instanceof MemoryFull) {
        full = true
        logStop('full')
        continue
      } else if (err instanceof MemoryDisabled) {
        return stop('disabled', undefined, { written, duplicates, failed, route, rejected })
      } else if (err instanceof SourceConflict) {
        duplicates++
        // The memory and its source exist; if the event that references them was
        // lost (the host's save was refused), a retry repairs the reference.
        const recorded = ctx.events.some((e) => {
          if (e.type !== 'memory_written') return false
          const d = e.data as MemoryWrittenEventData
          return d.eventId === userEventId && d.ordinal === cand.ordinal
        })
        if (!recorded && err.existing) {
          flushDecisions(ctx, scope)
          ctx.events.push(
            createEvent('memory_written', 'memory-store', {
              memoryId: err.memoryId,
              kind: err.existing.kind,
              tier,
              eventId: userEventId,
              ordinal: cand.ordinal,
              action: 'reinforced',
            } satisfies MemoryWrittenEventData),
          )
        }
      } else {
        failed++
        logStop('a candidate could not be written', errorKind(err))
      }
    }
  }

  let compactionDue = full
  if (written > 0 && !full) {
    try {
      const n = await store.transaction((tx) => tx.count())
      compactionDue = n >= (settings?.softLimit ?? DEFAULT_SOFT_LIMIT)
    } catch {
      // the count is advice for M3; a failure here changes nothing written
    }
  }
  return {
    written,
    proposed: 0,
    duplicates,
    failed,
    route,
    rejected,
    compactionDue,
    ...(full ? { skipped: 'full' as const } : {}),
  }
}

/** Reinforce a near-duplicate; ask the merge question of a related preference or
 *  trait; otherwise insert. Runs INSIDE the transaction, under the lock. */
async function chooseAction(
  cand: { kind: MemoryKind; content: string },
  near: MemoryNeighbor | null,
  t: { dup: number; rel: number; mergeMs: number },
  scope: PatternScope<Record<string, never>>,
  decideFn: DecideFn,
): Promise<'insert' | 'reinforce' | 'update'> {
  if (!near || near.kind !== cand.kind) return 'insert'
  if (!(near.similarity >= t.rel)) return 'insert'
  if (near.similarity >= t.dup) return 'reinforce'
  // Related, not a duplicate. Episodes and facts only reinforce or insert.
  if (!MERGEABLE_KINDS.includes(cand.kind)) return 'insert'

  // Failed or timed-out merge decisions keep both memories.
  const local: PatternScope<Record<string, never>> = {
    id: scope.id,
    events: [],
    data: {},
    startTime: Date.now(),
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const verdict = await Promise.race([
    decide(local, {
      decide: decideFn,
      spec: MEMORY_MERGE_SPEC,
      state: `Existing memory: ${near.content}\nNew statement: ${cand.content}`,
    }).then((d) => {
      scope.events.push(
        ...local.events.map((e) =>
          e.llmCall ? { ...e, llmCall: redactCall(e.llmCall as LLMCallRecord) } : e,
        ),
      )
      return d.label ?? 'distinct'
    }),
    new Promise<MemoryMergeLabel>((resolve) => {
      timer = setTimeout(() => resolve('distinct'), t.mergeMs)
    }),
  ]).finally(() => clearTimeout(timer))
  return verdict === 'same' ? 'reinforce' : verdict === 'update' ? 'update' : 'insert'
}

// ============================================================================
// Confirmation (#419 M6 = #433 S11)
// ============================================================================

/** The proposal's kind, and the two options a person chooses between. */
export const MEMORY_CONFIRM_KIND = 'memory.confirm'
export const MEMORY_CONFIRM_SAVE = 'save'
export const MEMORY_CONFIRM_DISCARD = 'discard'
/** How long a proposal waits for its person: 7 days (#433 decision record, row 5). */
export const DEFAULT_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The request a prepared memory is proposed under. `save` is the default and a
 * rule may never pick it; `discard` is the only option an unattended rule may
 * pick, and a `park` rule picks nothing. Each item is one flag on `save`, so
 * the person's selection is validated by core against the request EVENT, and
 * the labels are positional ("Item 1") — the memory text never rides the
 * event, which outlives the payload. `summary` carries counts and the closed
 * kind set, nothing the user wrote. The key is the source message's event id,
 * so a settle that runs twice for one turn raises one proposal.
 *
 * Pure; the payload is held by the host, not here.
 */
export function memoryConfirmRequest(
  items: readonly Pick<MemoryProposalItem, 'ref' | 'kind'>[],
  eventId: string,
  expiresInMs: number = DEFAULT_PROPOSAL_TTL_MS,
): HitlRequest {
  return {
    kind: MEMORY_CONFIRM_KIND,
    key: eventId,
    question: items.length === 1 ? 'Save this to memory?' : 'Save these to memory?',
    options: [
      {
        id: MEMORY_CONFIRM_SAVE,
        label: 'Save selected',
        flags: items.map((item, i) => ({
          id: item.ref,
          label: `Item ${i + 1}`,
          default: true,
        })),
      },
      {
        id: MEMORY_CONFIRM_DISCARD,
        label: "Don't save",
        unattended: true,
        tone: 'caution',
      },
    ],
    defaultOption: MEMORY_CONFIRM_SAVE,
    summary: {
      items: items.length,
      kinds: [...new Set(items.map((i) => i.kind))].sort().join(','),
    },
    unattended: 'park',
    expiresInMs,
  }
}

/** Record the proposal in the context and hand the payload to the host. A
 *  host that cannot hold it takes the proposal back out: a request with no
 *  payload is a question nobody can answer. */
async function propose(
  ctx: UnifiedContext,
  confirm: MemoryConfirmSeam,
  items: readonly MemoryProposalItem[],
  at: { tier: string; embedSpace: string; userEventId: string; conversationId: string },
  more: Pick<MemorySettleReport, 'route' | 'rejected'>,
): Promise<MemorySettleReport> {
  const ttl = confirm.expiresInMs ?? DEFAULT_PROPOSAL_TTL_MS
  const before = ctx.events.length
  const outcome = proposeToHuman(ctx, memoryConfirmRequest(items, at.userEventId, ttl), {
    attended: true,
    patternId: 'memory-store',
  })
  // Raised before (open, answered or expired): this turn was proposed already.
  if (ctx.events.length === before) {
    logStop('this turn was already proposed')
    return { ...emptyReport(), ...more, skipped: 'already-proposed' }
  }
  if (outcome.status !== 'pending') {
    // `park` never decides; anything else would have written a response.
    logStop('the proposal was not left pending')
    return { ...emptyReport(), ...more, skipped: 'error' }
  }
  const requestId = outcome.requestId
  try {
    await confirm.hold({
      requestId,
      expiresAt: Date.now() + ttl,
      payload: {
        v: 1,
        tier: at.tier,
        embedSpace: at.embedSpace,
        eventId: at.userEventId,
        conversationId: at.conversationId,
        items,
      },
    })
  } catch (err) {
    ctx.events.splice(before, ctx.events.length - before)
    logStop('the proposal could not be held', errorKind(err))
    return { ...emptyReport(), ...more, skipped: 'error' }
  }
  return { ...emptyReport(), ...more, proposed: items.length }
}

/** Is `value` a payload this module wrote? The payload is server-held, but it
 *  was serialized and read back: anything that does not parse is refused
 *  rather than half-applied. Returns the typed payload, or null. */
export function parseMemoryProposalPayload(value: unknown): MemoryProposalPayload | null {
  const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
  if (typeof value !== 'object' || value === null) return null
  const p = value as Record<string, unknown>
  if (p.v !== 1 || !str(p.tier) || !str(p.embedSpace) || !str(p.eventId) || !str(p.conversationId))
    return null
  if (!Array.isArray(p.items) || p.items.length === 0) return null
  const refs = new Set<string>()
  const dim = Array.isArray(p.items[0]?.embedding) ? p.items[0].embedding.length : undefined
  for (const raw of p.items as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null
    const i = raw as Record<string, unknown>
    if (!str(i.ref) || refs.has(i.ref)) return null
    refs.add(i.ref)
    if (!Number.isInteger(i.ordinal) || (i.ordinal as number) < 0) return null
    if (!(MEMORY_KINDS as readonly unknown[]).includes(i.kind)) return null
    if (!str(i.content) || Array.from(i.content).length > MAX_MEMORY_CHARS) return null
    if (!str(i.evidence)) return null
    if (!validVector(i.embedding, dim)) return null
    const d = i.dedupe
    if (d !== 'new') {
      if (typeof d !== 'object' || d === null) return null
      const o = d as Record<string, unknown>
      const id = 'reinforces' in o ? o.reinforces : o.updates
      if (!str(id) || typeof o.expectedContent !== 'string') return null
    }
  }
  return p as unknown as MemoryProposalPayload
}

export interface MemoryApplyConfig {
  /** The write seam, bound by the host to the person who answered. */
  readonly store: MemoryWriteStore
  /** The embedding space of the embedder in force NOW. A proposal whose
   *  vectors are in another space is refused: they would be stored where
   *  recall refuses them. */
  readonly embedSpace: () => string
  /** The user's memory switch, re-read inside each item's transaction. */
  readonly enabled: () => boolean | Promise<boolean>
  /** τ_dup for an item the preview called `new`. Default 0.92. */
  readonly dupSimilarity?: number
  /** M3's hard limit, applied to an approval's insert exactly as to a settle's
   *  (oldest episodes evicted to make room, else `full`). Default 400. */
  readonly hardLimit?: number
}

export type MemoryApplyOutcome =
  /** Inserted, reinforced or updated. */
  | 'written'
  /** Its provenance row existed: written before; nothing changed. */
  | 'duplicate'
  /** The memory it would reinforce or update is gone or says something else now. */
  | 'stale'
  /** The owner is at M3's hard limit and no episode could be evicted: refused,
   *  nothing written (the next settle's `compactionDue` or M3's sweep makes room). */
  | 'full'
  | 'failed'

export interface MemoryApplyReport {
  /** Why nothing was written, when the whole payload was refused. */
  readonly skipped?: 'malformed' | 'embed-space' | 'disabled'
  readonly items: ReadonlyArray<{
    readonly ref: string
    readonly outcome: MemoryApplyOutcome
    readonly action?: MemoryWriteAction
  }>
  readonly written: number
  /** An item was refused as `full`: compaction is due. */
  readonly compactionDue?: boolean
}

/**
 * Write the items a person approved (M6). NEVER throws; mutates `ctx.events`
 * with one metadata-only `memory_written` per memory, so the caller saves the
 * context AFTER awaiting it, in the same version-checked save as the person's
 * answer.
 *
 * What it writes is exactly what was proposed, and nothing else: `payload` is
 * the server-held record (never client input — the caller passes what its own
 * store returned), `selected` names the refs the answer's flags chose, and an
 * unknown ref selects nothing. No model is consulted. Each item is its own
 * transaction under the owner's advisory lock, provenance row first-class:
 * `(eventId, ordinal)` conflicts make a retry — a double submit, an answer
 * whose context save was refused — a no-op that re-records a lost
 * `memory_written` rather than a second write.
 *
 * A stale answer never overwrites a newer row: an item the preview said would
 * reinforce or update a memory is written only if that memory still says what
 * the preview read (`stale` otherwise, and nothing changes). An item the
 * preview called `new` reinforces a same-kind near-duplicate that has appeared
 * since rather than inserting beside it. The whole payload is refused when it
 * is malformed, its vectors are in another embedding space than the
 * embedder's now, or the user switched memory off.
 */
export async function applyMemoryProposal(
  ctx: Pick<UnifiedContext, 'events'>,
  cfg: MemoryApplyConfig,
  input: { readonly payload: unknown; readonly selected: readonly string[] },
): Promise<MemoryApplyReport> {
  const none = (skipped: NonNullable<MemoryApplyReport['skipped']>): MemoryApplyReport => ({
    skipped,
    items: [],
    written: 0,
  })
  const payload = parseMemoryProposalPayload(input.payload)
  if (!payload) return none('malformed')
  let space: string
  try {
    space = cfg.embedSpace()
  } catch {
    return none('embed-space')
  }
  if (space !== payload.embedSpace) return none('embed-space')

  const chosen = new Set(input.selected)
  const dup = cfg.dupSimilarity ?? DEFAULT_DUP_SIMILARITY
  const results: Array<{ ref: string; outcome: MemoryApplyOutcome; action?: MemoryWriteAction }> =
    []
  let written = 0

  for (const item of payload.items) {
    if (!chosen.has(item.ref)) continue
    const src = {
      eventId: payload.eventId,
      ordinal: item.ordinal,
      conversationId: payload.conversationId,
    }
    try {
      const done = await cfg.store.transaction(async (tx) => {
        if (!(await cfg.enabled())) throw new MemoryDisabled()
        let memoryId: string
        let action: MemoryWriteAction
        if (item.dedupe === 'new') {
          const near = await tx.nearest({
            embedding: item.embedding,
            embedSpace: payload.embedSpace,
            tier: payload.tier,
          })
          if (near && near.kind === item.kind && near.similarity >= dup) {
            memoryId = near.id
            action = 'reinforced'
            await claim(tx, memoryId, src)
            await tx.reinforce(memoryId)
          } else {
            await makeRoomForInsert(tx, cfg.hardLimit)
            memoryId = generateId('mem')
            action = 'inserted'
            await tx.insert({
              id: memoryId,
              kind: item.kind,
              tier: payload.tier,
              content: item.content,
              evidence: item.evidence,
              evidenceEventId: payload.eventId,
              embedding: item.embedding,
              embedSpace: payload.embedSpace,
            })
            await claim(tx, memoryId, src)
          }
        } else {
          memoryId = 'reinforces' in item.dedupe ? item.dedupe.reinforces : item.dedupe.updates
          // Gone: nothing to reinforce or update. Then the provenance row, so a
          // retry of an item that WAS written (the memory now says the new text)
          // reads as a duplicate and not as stale. Then the text the preview read:
          // a mismatch rolls the claim back with everything else.
          const current = await tx.read(memoryId)
          if (!current) throw new StaleItem()
          await claim(tx, memoryId, src)
          if (current.content !== item.dedupe.expectedContent) throw new StaleItem()
          if ('updates' in item.dedupe) {
            action = 'updated'
            await tx.update(memoryId, {
              content: item.content,
              evidence: item.evidence,
              evidenceEventId: payload.eventId,
              embedding: item.embedding,
              embedSpace: payload.embedSpace,
            })
          } else {
            action = 'reinforced'
            await tx.reinforce(memoryId)
          }
        }
        return { memoryId, action }
      })
      ctx.events.push(
        createEvent('memory_written', 'memory-store', {
          memoryId: done.memoryId,
          kind: item.kind,
          tier: payload.tier,
          eventId: payload.eventId,
          ordinal: item.ordinal,
          action: done.action,
        } satisfies MemoryWrittenEventData),
      )
      results.push({ ref: item.ref, outcome: 'written', action: done.action })
      written++
    } catch (err) {
      if (err instanceof MemoryDisabled) return { skipped: 'disabled', items: results, written }
      if (err instanceof MemoryFull) {
        results.push({ ref: item.ref, outcome: 'full' })
        logStop('an approved memory was refused: the hard limit is reached')
      } else if (err instanceof StaleItem) {
        results.push({ ref: item.ref, outcome: 'stale' })
      } else if (err instanceof SourceConflict) {
        results.push({ ref: item.ref, outcome: 'duplicate' })
        const recorded = ctx.events.some((e) => {
          if (e.type !== 'memory_written') return false
          const d = e.data as MemoryWrittenEventData
          return d.eventId === payload.eventId && d.ordinal === item.ordinal
        })
        if (!recorded && err.existing) {
          ctx.events.push(
            createEvent('memory_written', 'memory-store', {
              memoryId: err.memoryId,
              kind: err.existing.kind,
              tier: payload.tier,
              eventId: payload.eventId,
              ordinal: item.ordinal,
              action: 'reinforced',
            } satisfies MemoryWrittenEventData),
          )
        }
      } else {
        results.push({ ref: item.ref, outcome: 'failed' })
        logStop('an approved memory could not be written', errorKind(err))
      }
    }
  }
  const compactionDue = results.some((r) => r.outcome === 'full')
  return { items: results, written, ...(compactionDue ? { compactionDue } : {}) }
}

/** Thrown inside an item's transaction to roll it back: the memory the preview
 *  meant to reinforce or update is gone or has changed. */
class StaleItem extends Error {}
