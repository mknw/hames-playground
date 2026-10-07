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
 *     `target`, `confirm`, `kind`. Fallbacks fail CLOSED (D15) and every field
 *     requires a calibrated read, so an abstained, failed or uncalibrated read
 *     lands on `sensitive` / `none` / `ask` / `episodic`.
 *  4. `sensitive` (including its fallback) stops. `target: none` stops.
 *  5. `resolveStoreRoute`: an organisational-graph outcome ALWAYS asks (F2),
 *     whatever `confirm` said; a personal one may skip the question only for a
 *     routine kind. **Pre-M12 there is no graph writer and pre-M6 there is no
 *     confirmation mechanism: an `ask`, or an org target, stores nothing and
 *     logs (F4).** "Auto-write" is the one pick that contradicts O4.
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
 * Pre-M3 nothing compacts: the report says when the owner's count reaches
 * `softLimit` (`compactionDue`) and M3 acts on it.
 */

import { createHash } from 'node:crypto'
import { assertServerOnImport } from './assert.server'
import { createEvent, generateId } from './context.server'
import { stripThinkBlocks } from './content-transforms'
import { currentRunFrame } from './run-frame.server'
import { setLivePatternEnabled } from './live-event-context.server'
import { trimToFit } from './token-budget.server'
import { acceptCandidate, type AcceptanceRule } from './memory-acceptance.server'
import { decide, decideFields } from './patterns/typedDecision.server'
import type {
  AssistantMessageEventData,
  ContextEvent,
  DecideAllFn,
  DecideFn,
  DecisionMethod,
  DecisionPolicy,
  DecisionSetSpec,
  DecisionSpec,
  LLMCallRecord,
  MemoryEmbedder,
  MemoryExtractFn,
  MemoryKind,
  MemoryNeighbor,
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
 * is served as fields (Jev: one request; logprob: one pass per field).
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

/** The store gate's cuts. UNMEASURED placeholders — layer 4's
 *  `memory-store-gate` calibrates them (and the method-scoped cuts). */
export interface MemoryStoreGateSettings {
  /** Default 0.5. */
  readonly minConfidence?: number
  /** Default 0.25. */
  readonly minMargin?: number
  /** The method the static cuts were fitted on. Default `'logprob'` (#418 F2). */
  readonly thresholdMethod?: DecisionMethod
}

export interface MemoryStoreSettings {
  /** The user's memory switch. REQUIRED for a write: absent → nothing is stored
   *  (D11, off until the user enables it). A throw stops the store. */
  readonly enabled?: () => boolean | Promise<boolean>
  readonly gate?: MemoryStoreGateSettings
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
   *  world), so it is bounded: past this it abstains and the candidate inserts.
   *  Default 10 000 ms. */
  readonly mergeTimeoutMs?: number
  /** How long to wait on the joint wake. Default 180 000 ms. */
  readonly wakeBudgetMs?: number
  /** T_soft: the owner's count from which compaction is due. Default 300. */
  readonly softLimit?: number
  /** Kinds a personal memory may be written from WITHOUT a confirmation, when
   *  the gate says `skip`. Default episodic, semantic, preference — `trait` always
   *  asks. */
  readonly routineKinds?: readonly MemoryKind[]
}

export interface MemoryStoreConfig {
  /** REQUIRED: the write seam, bound by the host to the turn's owner. */
  readonly store: MemoryWriteStore
  /** REQUIRED: the RAW decision seam — this step applies its own policy. */
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
  /** F4: the route needs a confirmation and no mechanism exists yet. */
  | 'no-confirmation'
  /** F4: the target is the organisational graph and no writer exists yet. */
  | 'org-no-writer'
  | 'extract-error'
  /** Every candidate failed deterministic acceptance, or none came back. */
  | 'no-candidates'
  | 'error'

/** Why a candidate was dropped: an acceptance rule, or `not-routine` (the route
 *  skipped confirmation for the gate's kind and this candidate's kind must ask). */
export type RejectRule = AcceptanceRule | 'not-routine'

export interface MemorySettleReport {
  readonly skipped?: MemoryStoreSkip
  /** Memories inserted, reinforced or updated. */
  readonly written: number
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
const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_MIN_MARGIN = 0.25
const DEFAULT_ROUTINE_KINDS: readonly MemoryKind[] = ['episodic', 'semantic', 'preference']
/** Kinds whose related candidates are put to the merge question. */
const MERGEABLE_KINDS: readonly MemoryKind[] = ['preference', 'trait']

/** The fail-closed fallbacks (D15): an uncertain read stores nothing, asks, and
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

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

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
function redactCall(call: LLMCallRecord | undefined): LLMCallRecord | undefined {
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
  const cut = settings?.gate
  const policyFor = <L extends string>(fallback: L): DecisionPolicy<L> => ({
    fallback,
    requireCalibrated: true,
    minConfidence: cut?.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    minMargin: cut?.minMargin ?? DEFAULT_MIN_MARGIN,
    ...(cut?.thresholdMethod ? { thresholdMethod: cut.thresholdMethod } : {}),
  })
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
      policy: {
        target: policyFor<MemoryTarget>(MEMORY_STORE_FALLBACKS.target),
        confirm: policyFor<MemoryConfirm>(MEMORY_STORE_FALLBACKS.confirm),
        kind: policyFor<MemoryKind>(MEMORY_STORE_FALLBACKS.kind),
        sensitive: policyFor<MemorySensitivity>(MEMORY_STORE_FALLBACKS.sensitive),
      },
    },
    { trackHistory: 'decision_made', errorSeverity: 'recoverable' },
  )

  flushDecisions(ctx, scope)
  // Anything but a calibrated, confident `ordinary` is `sensitive`.
  if (decided.sensitive.label !== 'ordinary') return stop('sensitive')
  if (decided.target.label === 'none') return stop('gate')

  const route = resolveStoreRoute(
    {
      target: decided.target.label,
      // A kind nobody established is not a PROVABLY routine one (D7/F2): when the
      // kind read abstained, the question is asked whatever `confirm` said.
      confirm: decided.kind.abstained ? 'ask' : decided.confirm.label,
      kind: decided.kind.label,
    },
    settings?.routineKinds ?? DEFAULT_ROUTINE_KINDS,
  )
  if (!route) return stop('gate')
  // F4. Pre-M12: no graph writer. Pre-M6: no confirmation mechanism.
  if (route.target === 'organizational_graph') return stop('org-no-writer', undefined, { route })
  if (route.confirm === 'ask') return stop('no-confirmation', undefined, { route })

  // --- 6. extract -----------------------------------------------------------
  let extracted: Awaited<ReturnType<MemoryExtractFn>>
  try {
    extracted = await extract({
      kindHint: decided.kind.label,
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
  const uncertainKind = decided.kind.abstained
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

  // --- 8/9. write, one transaction per candidate ---------------------------
  const conversationId = turn.conversationId ?? ctx.sessionId
  const dup = settings?.dupSimilarity ?? DEFAULT_DUP_SIMILARITY
  const rel = settings?.relatedSimilarity ?? DEFAULT_REL_SIMILARITY
  const mergeMs = settings?.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS
  let written = 0
  let duplicates = 0
  let failed = 0
  let pendingCall: LLMCallRecord | undefined = llmCall

  for (let i = 0; i < accepted.length; i++) {
    const cand = accepted[i]
    const embedding = vectors[i]
    try {
      const done = await store.transaction(async (tx) => {
        const near = await tx.nearest({ embedding, embedSpace: embed.spaceId, tier })
        const verdict = await chooseAction(cand, near, { dup, rel, mergeMs }, scope, decideFn, cut)
        const src = { eventId: userEventId, ordinal: cand.ordinal, conversationId }

        let memoryId: string
        let action: MemoryWriteAction
        let stored: string
        if (verdict === 'insert' || !near) {
          memoryId = generateId('mem')
          action = 'inserted'
          stored = cand.content
          await tx.insert({
            id: memoryId,
            kind: cand.kind,
            tier,
            content: cand.content,
            evidence: cand.evidence,
            embedding,
            embedSpace: embed.spaceId,
          })
          await claim(tx, memoryId, src)
        } else {
          memoryId = near.id
          await claim(tx, memoryId, src)
          if (verdict === 'update') {
            action = 'updated'
            stored = cand.content
            await tx.update(memoryId, {
              content: cand.content,
              evidence: cand.evidence,
              embedding,
              embedSpace: embed.spaceId,
            })
          } else {
            action = 'reinforced'
            stored = near.content
            await tx.reinforce(memoryId)
          }
        }
        return { memoryId, action, stored }
      })

      const data: MemoryWrittenEventData = {
        memoryId: done.memoryId,
        kind: cand.kind,
        tier,
        contentHash: sha256(done.stored),
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
      if (err instanceof SourceConflict) {
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
              contentHash: sha256(err.existing.content),
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

  let compactionDue = false
  if (written > 0) {
    try {
      const n = await store.transaction((tx) => tx.count())
      compactionDue = n >= (settings?.softLimit ?? DEFAULT_SOFT_LIMIT)
    } catch {
      // the count is advice for M3; a failure here changes nothing written
    }
  }
  return { written, duplicates, failed, route, rejected, compactionDue }
}

/** Reinforce a near-duplicate; ask the merge question of a related preference or
 *  trait; otherwise insert. Runs INSIDE the transaction, under the lock. */
async function chooseAction(
  cand: { kind: MemoryKind; content: string },
  near: MemoryNeighbor | null,
  t: { dup: number; rel: number; mergeMs: number },
  scope: PatternScope<Record<string, never>>,
  decideFn: DecideFn,
  cut: MemoryStoreGateSettings | undefined,
): Promise<'insert' | 'reinforce' | 'update'> {
  if (!near || near.kind !== cand.kind) return 'insert'
  if (!(near.similarity >= t.rel)) return 'insert'
  if (near.similarity >= t.dup) return 'reinforce'
  // Related, not a duplicate. Episodes and facts only reinforce or insert.
  if (!MERGEABLE_KINDS.includes(cand.kind)) return 'insert'

  const policy: DecisionPolicy<MemoryMergeLabel> = {
    fallback: 'distinct',
    minConfidence: cut?.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    minMargin: cut?.minMargin ?? DEFAULT_MIN_MARGIN,
    ...(cut?.thresholdMethod ? { thresholdMethod: cut.thresholdMethod } : {}),
  }
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
      policy,
    }).then((d) => {
      scope.events.push(
        ...local.events.map((e) =>
          e.llmCall ? { ...e, llmCall: redactCall(e.llmCall as LLMCallRecord) } : e,
        ),
      )
      return d.label
    }),
    new Promise<MemoryMergeLabel>((resolve) => {
      timer = setTimeout(() => resolve('distinct'), t.mergeMs)
    }),
  ]).finally(() => clearTimeout(timer))
  return verdict === 'same' ? 'reinforce' : verdict === 'update' ? 'update' : 'insert'
}
