/**
 * memoryRecall Pattern (#419 M1)
 *
 * The recall half of `withMemory`: a chain step that runs BEFORE the turn's
 * routing and, when the user's message plausibly depends on what the system
 * remembers about them, attaches the few best-matching memories to the turn as
 * `data.memories` (structured) and `data.memoryContext` (the formatted block a
 * responder renders). It generates no text.
 *
 *   harness(
 *     memoryRecall({ store, decide, embed, owner, visibleTiers, awaitWake }),
 *     router(),
 *     routes({ ... }),
 *     compactExecution(),
 *   )
 *
 * Shaped after `retriever`: a chain step with `commitStrategy: 'always'`,
 * `errorSeverity: 'recoverable'` and `estimateTurns: () => 0`, with its
 * backends injected. Core stays generic — no database, no network, no
 * provider vocabulary (a tier is an opaque string). The host supplies the
 * {@link MemoryStore}, the raw `DecideFn`, the embedder and the owner; the
 * app's database module implements the store, `bamlPatterns()` supplies the
 * decision seam.
 *
 * ## The pipeline
 *
 * 1. Clear `data.memories` / `data.memoryContext` — FIRST, before anything can
 *    fail. `scope.data` survives the turn boundary, so a failure that returned
 *    it untouched would hand the NEXT turn this turn's memories.
 * 2. Owner (`owner()`; null → `skipped: 'no-user'`), then settings (off →
 *    `'disabled'`), then the count: 0 rows visible in the turn's tiers →
 *    `'empty'` with no gate and no embedding paid.
 * 3. Gate, search and the joint wake run CONCURRENTLY under one deadline
 *    (`gate.timeoutMs`, default 1500 ms), so the turn pays the slowest of the
 *    three and not their sum. The gate asks `memory.recall` over the current
 *    user message and the previous FINAL assistant message — never memory
 *    content.
 * 4. Rank ({@link rankMemories}): BM25 + cosine, floors before fusion, RRF, cap.
 * 5. Attach only when the gate said `retrieve` and its policy passed.
 *
 * ## It never stops what follows it
 *
 * Every failure — a throwing store, an embedder that is down, a gate that
 * errors, an expired deadline — ends in `memories = []` and a RETURN. Nothing
 * is rethrown and no `error` event is recorded: an `error` is a statement about
 * the turn (the synthesizer apologises for one, `settleTurn` fails an empty
 * turn on one), and an unavailable memory is not one. The one record is the
 * `memory_recalled` event: its ids, or why there are none. The user sees
 * nothing.
 *
 * ## The gate's thresholds are METHOD-SCOPED (#418 F2)
 *
 * `gate.minConfidence` / `gate.minMargin` are fitted on the logprob path. They
 * are handed to `evaluateDecision` as the policy's static cuts with
 * `thresholdMethod` naming what they were fitted on, so on a read from another
 * method (Jev on the Anthropic tier) they are NOT applied: the calibration
 * entry the transport reports for that client carries its own cuts, which win,
 * and with no entry the gate abstains `method-mismatch` and attaches nothing.
 * This file applies NO threshold of its own on top — a second static
 * `margin ≥ minMargin` here is exactly the logprob-fitted cut applied to a Jev
 * read, which is the defect the method scope exists to prevent. Pinned by
 * `recall-threshold-method`.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  AssistantMessageEventData,
  ConfiguredPattern,
  Decision,
  DecideFn,
  DecisionMethod,
  DecisionPolicy,
  DecisionSpec,
  EventView,
  MemoryCandidate,
  MemoryGateRecord,
  MemoryKind,
  MemoryQueryEmbedder,
  MemoryRecalledEventData,
  MemorySkipReason,
  MemoryStore,
  MemoryWakeWait,
  ModelLimits,
  PatternCapabilities,
  PatternConfig,
  PatternScope,
  UserMessageEventData,
} from '../types'
import { resolveConfig, trackEvent } from '../context.server'
import { currentRunFrame } from '../run-frame.server'
import { stripThinkBlocks } from '../content-transforms'
import { trimToFit } from '../token-budget.server'
import { capMemories, memoryTokenBudget, rankMemories } from '../memory-ranking.server'
import { evaluateDecision } from './typedDecision.server'

assertServerOnImport()

// ============================================================================
// The decision
// ============================================================================

/** The recall gate's decision key — what layer 4 calibrates and what a
 *  calibration entry is keyed on. */
export const MEMORY_RECALL_KEY = 'memory.recall'

export type MemoryRecallLabel = 'retrieve' | 'skip'

/**
 * The closed question the gate asks. The label descriptions are the ONLY text
 * the model sees for each label, so they carry the whole criterion.
 */
export const MEMORY_RECALL_SPEC: DecisionSpec<MemoryRecallLabel> = {
  key: MEMORY_RECALL_KEY,
  question:
    "Would the answer to the user's latest message be better for knowing facts the user told us about themselves earlier — their preferences, habits, circumstances or past decisions?",
  labels: [
    {
      id: 'retrieve',
      description:
        'The reply depends on something personal the user may have told us before: their preferences, habits, role, circumstances, earlier decisions, or a reference like "as usual" or "like last time".',
    },
    {
      id: 'skip',
      description:
        'The message is self-contained: general knowledge, an action on material it already provides, a follow-up that needs only this conversation, or small talk.',
    },
  ],
}

// ============================================================================
// Configuration
// ============================================================================

/** The recall gate's tunables. EVERY default here is an UNMEASURED placeholder:
 *  layer 4's `memory-recall-relevance` calibrates them (and the method-scoped
 *  cuts), and nothing in this file claims otherwise. */
export interface MemoryGateSettings {
  /** Budget for the gate, the search AND the wake, concurrently. Default 1500. */
  readonly timeoutMs?: number
  /** Static confidence cut, fitted on `thresholdMethod`. Default 0.5. */
  readonly minConfidence?: number
  /** Static margin cut, fitted on `thresholdMethod`. Default 0.25. */
  readonly minMargin?: number
  /** The method the static cuts were fitted on. Default `'logprob'` (#418 F2). */
  readonly thresholdMethod?: DecisionMethod
}

/** How recall searches and caps. UNMEASURED placeholders, as above. */
export interface MemoryRecallSettings {
  /** The user's memory switch. Absent → on. A throw is `skipped: 'error'`. */
  readonly enabled?: () => boolean | Promise<boolean>
  readonly gate?: MemoryGateSettings
  /** τ_v — the semantic floor (cosine similarity). Default 0.5. */
  readonly minSemantic?: number
  /** τ_idf — the lexical floor's rarity bar. Default 0.5. */
  readonly minIdf?: number
  /** Most memories attached. Default 5. */
  readonly maxMemories?: number
  /** Most tokens attached (`estimateTokens`), further capped at 5% of the
   *  responder's context window when `limits` is given. Default 400. */
  readonly maxMemoryTokens?: number
}

export interface MemoryRecallConfig extends PatternConfig {
  /** REQUIRED: the persistence seam, bound by the host to the turn's owner. */
  readonly store: MemoryStore
  /** REQUIRED: the RAW decision seam (`bamlPatterns().decide`), never a
   *  policy-applying wrapper — this step applies its own policy. */
  readonly decide: DecideFn
  /** REQUIRED: embeds the query. */
  readonly embed: MemoryQueryEmbedder
  /** REQUIRED: the turn's owner, from the host's request context — never an
   *  argument the store takes. `null` → `skipped: 'no-user'`. */
  readonly owner: () => string | null
  /** REQUIRED: which stored tiers a turn of this tier may read. Core never
   *  interprets a tier, so the rule lives where the vocabulary does. FAIL
   *  CLOSED: for a turn whose tier is unknown return only the narrowest set. */
  readonly visibleTiers: (turnTier: string | undefined) => readonly string[]
  /** The joint memory wake's bounded wait (`awaitMemoryWake` binds as-is).
   *  Absent → there is no wake to wait on. */
  readonly awaitWake?: MemoryWakeWait
  /** The turn's tier. Default: the run frame's `inference.tier`. */
  readonly tier?: () => string | undefined
  /** The responder's limits, for the 5%-of-window hard ceiling. */
  readonly limits?: () => ModelLimits
  readonly settings?: MemoryRecallSettings
}

/** What `memoryRecall` writes. Both are overwritten on EVERY exit. */
export interface MemoryRecallData {
  memories?: RecalledMemory[]
  /** The formatted block a responder renders; `''` when nothing is attached. */
  memoryContext?: string
}

/** One attached memory. Carries content — it lives in `scope.data`, never in an
 *  event. */
export interface RecalledMemory {
  readonly id: string
  readonly kind: MemoryKind
  readonly tier: string
  readonly content: string
}

const DEFAULT_GATE_TIMEOUT_MS = 1500
const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_MIN_MARGIN = 0.25
const DEFAULT_MIN_SEMANTIC = 0.5
const DEFAULT_MIN_IDF = 0.5
const DEFAULT_MAX_MEMORIES = 5
const DEFAULT_MAX_MEMORY_TOKENS = 400

/** One line per memory. The id never reaches the prompt. */
function renderMemory(m: RecalledMemory): string {
  return `- [${m.kind}] ${m.content.replace(/\s+/g, ' ').trim()}`
}

/** The block a responder renders. */
export function formatMemoryContext(memories: readonly RecalledMemory[]): string {
  return memories.map(renderMemory).join('\n')
}

// ============================================================================
// Gate state
// ============================================================================

interface Query {
  /** The user's latest message — also the search text. */
  readonly latest: string
  /** The gate's state: the latest message and the previous FINAL assistant
   *  message. Never memory content. */
  readonly state: string
}

function readQuery(view: EventView, fn: DecideFn): Query | undefined {
  const msgs = view
    .fromAll()
    .messages()
    .get()
    .map((e) => stripThinkBlocks(e))
  let at = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'user_message') {
      at = i
      break
    }
  }
  if (at < 0) return undefined
  const latest = ((msgs[at].data as UserMessageEventData).content ?? '').trim()
  if (!latest) return undefined

  let previous = ''
  for (let i = at - 1; i >= 0; i--) {
    const e = msgs[i]
    if (e.type === 'assistant_message' && (e.data as AssistantMessageEventData).final === true) {
      previous = ((e.data as AssistantMessageEventData).content ?? '').trim()
      break
    }
  }

  const parts = [...(previous ? [`Assistant: ${previous}`] : []), `User: ${latest}`]
  let window = 16_384
  try {
    const w = fn.limits?.().contextWindow
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) window = w
  } catch {
    // an unreadable limit is the default window
  }
  // Oldest first, so an over-long previous reply is the part that goes.
  const fitted = trimToFit(parts, (p) => p.join('\n\n'), 300, window)
  return { latest, state: fitted.join('\n\n') }
}

// ============================================================================
// The pattern
// ============================================================================

const DEADLINE = Symbol('deadline')

function toMs(v: Date | string | number): number {
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function gateRecord(d: Decision<MemoryRecallLabel>, stateChars: number): MemoryGateRecord {
  return {
    label: d.label,
    top: d.top,
    probs: d.probs as Record<string, number>,
    margin: d.margin,
    confidence: d.confidence,
    abstained: d.abstained,
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.method ? { method: d.method } : {}),
    calibrated: d.calibrated,
    stateChars,
  }
}

/** A class name, or `Error` — never the message (it can quote what it read). */
function errorKind(e: unknown): string {
  return e instanceof Error && e.name ? e.name : 'Error'
}

export function memoryRecall<T extends MemoryRecallData>(
  config: MemoryRecallConfig,
): ConfiguredPattern<T> {
  const { store, decide, embed, owner, visibleTiers, awaitWake, tier, limits, settings } = config
  const {
    store: _s,
    decide: _d,
    embed: _e,
    owner: _o,
    visibleTiers: _v,
    awaitWake: _a,
    tier: _t,
    limits: _l,
    settings: _set,
    ...patternConfig
  } = config

  const gate = settings?.gate ?? {}
  const budgetMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
  const policy: DecisionPolicy<MemoryRecallLabel> = {
    fallback: 'skip',
    minConfidence: gate.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    minMargin: gate.minMargin ?? DEFAULT_MIN_MARGIN,
    ...(gate.thresholdMethod ? { thresholdMethod: gate.thresholdMethod } : {}),
  }
  const maxMemories = settings?.maxMemories ?? DEFAULT_MAX_MEMORIES
  const maxTokens = settings?.maxMemoryTokens ?? DEFAULT_MAX_MEMORY_TOKENS

  const resolved = resolveConfig('memoryRecall', { patternId: 'memory-recall', ...patternConfig })
  const capabilities: PatternCapabilities = { decisionKeys: [MEMORY_RECALL_KEY], memory: true }

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    // Cleared FIRST: whatever happens below, this turn starts with nothing
    // attached, and only the success path at the end writes anything back.
    scope.data = { ...scope.data, memories: [], memoryContext: '' }

    const turnTier = tier ? tier() : currentRunFrame()?.inference?.tier
    let considered = 0
    let survivors = 0
    let gateRec: MemoryGateRecord | undefined
    let wake: 'awake' | 'skipped' | undefined
    let llmCall: Awaited<ReturnType<typeof evaluateDecision>>['llmCall']

    const finish = (
      attached: readonly RecalledMemory[],
      tokens: number,
      extra: { skipped?: MemorySkipReason; errorKind?: string } = {},
    ): PatternScope<T> => {
      if (attached.length > 0) {
        scope.data = {
          ...scope.data,
          memories: [...attached],
          memoryContext: formatMemoryContext(attached),
        }
      }
      const data: MemoryRecalledEventData = {
        attached: attached.map((m) => m.id),
        considered,
        survivors,
        ...(turnTier !== undefined ? { tier: turnTier } : {}),
        tokens,
        ...(extra.skipped ? { skipped: extra.skipped } : {}),
        ...(gateRec ? { gate: gateRec } : {}),
        ...(wake ? { wake } : {}),
        ...(extra.errorKind ? { errorKind: extra.errorKind } : {}),
      }
      trackEvent(scope, 'memory_recalled', data, resolved.trackHistory, llmCall)
      return scope
    }
    const skip = (skipped: MemorySkipReason, extra: { errorKind?: string } = {}): PatternScope<T> =>
      finish([], 0, { skipped, ...extra })

    // The whole body is ONE failure domain: nothing below may escape this
    // function, because a pattern that throws ends the chain (`runChain`
    // `setError`s it) and recall must never take the turn with it.
    try {
      const userId = owner()
      if (userId === null || userId === undefined || userId === '') return skip('no-user')
      if (settings?.enabled && !(await settings.enabled())) return skip('disabled')

      const tiers = visibleTiers(turnTier)
      if (tiers.length === 0 || (await store.count(tiers)) === 0) return skip('empty')

      const query = readQuery(view, decide)
      if (!query) return skip('no-query')

      // Gate, search and wake concurrently, under one deadline. Each is
      // converted to a VALUE here — none can reject — so a branch that loses
      // the race to the deadline cannot surface later as an unhandled rejection.
      const wakeP = (awaitWake ? awaitWake(budgetMs) : Promise.resolve('awake' as const)).then(
        (w) => (wake = w),
        () => (wake = 'skipped' as const),
      )
      const gateP = evaluateDecision({
        decide,
        spec: MEMORY_RECALL_SPEC,
        state: query.state,
        policy,
      })
      const searchP = (async () => {
        const embedding = await embed.query(query.latest)
        return store.candidates({
          embedding,
          ...(embed.spaceId !== undefined ? { embedSpace: embed.spaceId } : {}),
          tiers,
        })
      })().then(
        (rows) => ({ rows }),
        (err: unknown) => ({ err }),
      )

      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), budgetMs)
      })
      const settled = await Promise.race([Promise.all([gateP, searchP, wakeP]), deadline]).finally(
        () => clearTimeout(timer),
      )

      if (settled === DEADLINE) {
        // Which of the three was slow is the thing worth recording: a wake that
        // had not landed is the box starting; anything else is just slow.
        return skip(wake === 'awake' ? 'timeout' : 'waking')
      }
      const [evaluated, search] = settled
      llmCall = evaluated.llmCall
      gateRec = gateRecord(evaluated.decision, query.state.length)

      if (wake === 'skipped') return skip('waking')
      if ('err' in search) {
        console.warn(
          `[memory-recall] search failed: ${search.err instanceof Error ? search.err.message : String(search.err)}`,
        )
        return skip('error', { errorKind: errorKind(search.err) })
      }
      // Only a decided `retrieve` attaches. An abstain, an error or an
      // out-of-set label all land on the fallback (`skip`) — and the policy
      // already ruled on the thresholds, method-scoped. NOTHING is re-checked
      // here against a static cut.
      if (evaluated.decision.label !== 'retrieve') return skip('gate')

      // The tier filter, enforced HERE as well as asked of the store: a store
      // that returned a row from a tier this turn may not read must not be able
      // to leak it into the prompt.
      const visible = new Set(tiers)
      const rows: MemoryCandidate[] = search.rows.filter((r) => visible.has(r.tier))
      considered = rows.length

      // A distance across two embedding spaces is a number that means nothing;
      // refuse loudly rather than rank on it.
      if (embed.spaceId !== undefined) {
        const bad = rows.find((r) => r.embedSpace !== embed.spaceId)
        if (bad) {
          throw new Error(
            `memory embedding space mismatch: a row is in '${bad.embedSpace}', the query in '${embed.spaceId}'`,
          )
        }
      }

      const byId = new Map(rows.map((r) => [r.id, r]))
      const ranking = rankMemories(
        query.latest,
        rows.map((r) => ({
          id: r.id,
          content: r.content,
          semantic: 1 - r.distance,
          lastSeenMs: toMs(r.lastSeenAt),
        })),
        {
          minSemantic: settings?.minSemantic ?? DEFAULT_MIN_SEMANTIC,
          minIdf: settings?.minIdf ?? DEFAULT_MIN_IDF,
        },
      )
      survivors = ranking.ranked.length
      if (survivors === 0) return skip('no-match')

      let window: number | undefined
      try {
        window = limits?.().contextWindow
      } catch {
        window = undefined
      }
      const candidates: RecalledMemory[] = ranking.ranked.map((r) => {
        const row = byId.get(r.id)!
        return { id: row.id, kind: row.kind, tier: row.tier, content: row.content }
      })
      const { kept, tokens } = capMemories(
        candidates,
        renderMemory,
        maxMemories,
        memoryTokenBudget(maxTokens, window),
      )
      if (kept.length === 0) return skip('no-match')
      return finish(kept, tokens)
    } catch (err) {
      // The #398 shape avoided: every failure is a return, never a throw.
      console.warn(
        `[memory-recall] ${err instanceof Error ? err.message : String(err)} — attaching nothing`,
      )
      scope.data = { ...scope.data, memories: [], memoryContext: '' }
      return skip('error', { errorKind: errorKind(err) })
    }
  }

  return {
    name: 'memoryRecall',
    fn,
    config: resolved,
    capabilities,
    estimateTurns: () => 0,
  }
}
