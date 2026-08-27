/**
 * Conversations Repository — Server Only
 *
 * One table, one JSONB blob per conversation. The blob is the full
 * `serializeContext()` output; we don't normalize events or messages here.
 *
 * `title` and `context` are encrypted at rest (`crypto.server.ts`): the blob
 * carries verbatim tool results, which since per-user Graph access can include
 * mail bodies and file contents, and the title is derived from the user's first
 * message. Everything else on the row — ids, the agent id, the lifted enums,
 * the timestamps — stays plaintext so the owner scoping, the indexes and the
 * list ordering keep working in SQL.
 *
 * The seam is this module, not `query()`: `query()` takes opaque SQL and an
 * untyped parameter array, so it cannot know which parameter is which column.
 * Encryption therefore happens in the parameter lists and decryption in the row
 * mappers below, which between them cover every statement that touches the
 * table — `encryption-coverage.test.ts` pins that no other production module
 * runs SQL against it.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { query } from './client.server'
import type { QueryRunner } from './migrate-encryption.server'
import { SETTINGS_BOUNDS } from '../settings'
import {
  decryptFieldOrNull,
  decryptJsonb,
  encryptField,
  encryptFieldOrNull,
  encryptJsonb,
} from './crypto.server'

assertServerOnImport()

/** Whether a row is a chat conversation or a triggered agent action. */
export type ConversationKind = 'conversation' | 'action'
/**
 * Immutable provenance: where the row originated.
 *   'chat'    — a user typed into the chat view.
 *   'post'    — `POST /api/agents/:id` (docs/AGENT_TRIGGER.md).
 *   'routine' — a routine fired on its trigger (#131, docs/ROUTINES.md).
 * `'post'` and `'routine'` are both `kind='action'` rows; they differ only in
 * what pulled the trigger.
 */
export type ConversationSource = 'chat' | 'post' | 'routine'
/** Lifted copy of UnifiedContext.status for cheap list filtering + UI badge. */
export type ConversationStatus = 'running' | 'paused' | 'done' | 'error'

/**
 * The tier column, exactly as stored: `'verda'`, `'anthropic'`, or `null` for a
 * row that has none of its own.
 *
 * Deliberately `string | null` rather than the `InferenceTier` union, and this
 * module deliberately does NOT narrow it. Narrowing here would mean importing
 * `isInferenceTier`, whose module imports `clients.server.ts`, whose module load
 * asserts the private tier's configuration when `USE_VERDA_INFERENCE=1` — and
 * this repository is reached from the schema bootstrap, i.e. from the boot path
 * that assert documents itself as being off (see `assertVerdaConfigured`).
 * Pulling it in would move a documented first-harness-call failure onto boot.
 *
 * The narrowing belongs to `lib/inference/tier.server.ts`, which owns the
 * resolution order and already imports both halves. A value this build does not
 * recognise therefore reads as "no tier of its own" there rather than being
 * passed through — see the note on {@link setConversationInferenceTier}.
 */
export type StoredInferenceTier = string | null

export interface ConversationRow {
  id: string
  userId: string
  agentId: string
  title: string | null
  /** Stringified UnifiedContext (matches serializeContext() output). */
  serializedContext: string
  kind: ConversationKind
  source: ConversationSource
  status: ConversationStatus
  /** The tier this conversation's turns run on, as stored. See
   *  {@link StoredInferenceTier} — unnarrowed on purpose. */
  inferenceTier: StoredInferenceTier
  createdAt: Date
  updatedAt: Date
}

export interface ConversationListItem {
  id: string
  agentId: string
  title: string | null
  kind: ConversationKind
  source: ConversationSource
  status: ConversationStatus
  /** As stored — see {@link StoredInferenceTier}. The sidebar renders a tier
   *  glyph per row, so the caller resolves a `null` the same way a turn does. */
  inferenceTier: StoredInferenceTier
  updatedAt: Date
}

interface DbRow {
  id: string
  user_id: string
  agent_id: string
  title: string | null
  /** pg returns JSONB columns as already-parsed JS objects. */
  context: unknown
  kind: ConversationKind
  source: ConversationSource
  status: ConversationStatus
  inference_tier: string | null
  created_at: Date
  updated_at: Date
}

interface DbListRow {
  id: string
  agent_id: string
  title: string | null
  kind: ConversationKind
  source: ConversationSource
  status: ConversationStatus
  inference_tier: string | null
  updated_at: Date
}

function rowToConversation(row: DbRow): ConversationRow {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: decryptFieldOrNull(row.title, 'conversations.title'),
    serializedContext: decryptJsonb(row.context, 'conversations.context'),
    kind: row.kind,
    source: row.source,
    status: row.status,
    inferenceTier: row.inference_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Load a conversation, scoped to the requesting user. Returns null when the
 * id is unknown or belongs to someone else.
 */
export async function loadConversation(
  id: string,
  userId: string,
): Promise<ConversationRow | null> {
  const { rows } = await query<DbRow>(
    'SELECT id, user_id, agent_id, title, context, kind, source, status, inference_tier, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2',
    [id, userId],
  )
  if (rows.length === 0) return null
  return rowToConversation(rows[0])
}

/**
 * The user a conversation belongs to, or null when the id is unknown.
 *
 * Unlike {@link loadConversation} this is not scoped to a caller — it answers
 * "who owns this id?" rather than "may I read it?", which is what the Data
 * Stash ownership resolver needs to compare an id against the requesting user
 * (see `lib/stash/ownership.server.ts`). Returns only the id, never content.
 */
export async function getConversationOwner(id: string): Promise<string | null> {
  const { rows } = await query<{ user_id: string }>(
    'SELECT user_id FROM conversations WHERE id = $1',
    [id],
  )
  return rows.length > 0 ? rows[0].user_id : null
}

export interface SaveConversationInput {
  id: string
  userId: string
  agentId: string
  /** Sticky — only set the first time, ignored on subsequent updates. */
  title: string | null
  /** Full serializeContext() output. Stored as JSONB. */
  serializedContext: string
  /**
   * Lifted copy of the context status, refreshed on every save so the sidebar
   * can filter/badge without deserializing the blob. Defaults to 'running'.
   */
  status?: ConversationStatus
  /**
   * Row kind. Only honoured on INSERT — `kind` is immutable through this upsert
   * path (promotion uses {@link promoteConversation}), so an existing action
   * stays an action across the background run's status saves. Default
   * 'conversation' (the chat path).
   */
  kind?: ConversationKind
  /**
   * Immutable provenance. Only honoured on INSERT (never updated). Default
   * 'chat'. The POST-trigger route passes 'post'.
   */
  source?: ConversationSource
  /**
   * The tier this turn ran on, RECORDED rather than set: written on INSERT, and
   * on UPDATE only when the row has none yet (`COALESCE`, the same stickiness
   * `title` has). A caller that does not know the tier omits it and changes
   * nothing.
   *
   * Sticky because this path runs on every save: refreshing it from the caller
   * would overwrite a mid-conversation flip with whatever tier the turn started
   * on. Fillable because the rows that reach here without one are real — an
   * action row seeded by `seedActionRow` before any tier is resolved, and a
   * legacy row the backfill left alone — and one turn under a tier is exactly
   * what makes that tier this conversation's. {@link setConversationInferenceTier}
   * is the only mutator.
   */
  inferenceTier?: string
}

/**
 * Upsert a conversation row.
 *
 * Stickiness on UPDATE (ON CONFLICT):
 *   - `title`           — sticky via COALESCE (a dedicated rename overrides it).
 *   - `kind` / `source` — NOT in the UPDATE set, so they keep their INSERT
 *     values. This is what lets the route insert `kind='action'` once and have
 *     the background run's later status saves preserve it. Promotion is the
 *     only mutator of `kind` (see {@link promoteConversation}).
 *   - `inference_tier`  — sticky via COALESCE, like `title`: a save fills it if
 *     the row has none and never overwrites one. The dedicated setter
 *     ({@link setConversationInferenceTier}) is what a user's flip goes through.
 *   - `status`          — always refreshed from the latest context.
 *
 * Owner-scoped like every other write in this module: the UPDATE fires only
 * when the row already belongs to `input.userId`, so a save against someone
 * else's conversation id silently no-ops instead of clobbering their context
 * (the same wrong-user contract as {@link promoteConversation} et al.). The
 * user-facing entry points never reach here with a foreign id — `loadSession`
 * is user-scoped, so a foreign session just looks new — which makes this the
 * backstop that keeps the resulting blind INSERT from becoming an UPDATE.
 */
export async function saveConversation(input: SaveConversationInput): Promise<void> {
  await query(
    `INSERT INTO conversations (id, user_id, agent_id, title, context, kind, source, status, inference_tier)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       agent_id       = EXCLUDED.agent_id,
       context        = EXCLUDED.context,
       title          = COALESCE(conversations.title, EXCLUDED.title),
       status         = EXCLUDED.status,
       inference_tier = COALESCE(conversations.inference_tier, EXCLUDED.inference_tier),
       updated_at     = NOW()
     WHERE conversations.user_id = EXCLUDED.user_id`,
    [
      input.id,
      input.userId,
      input.agentId,
      encryptFieldOrNull(input.title),
      encryptJsonb(input.serializedContext),
      input.kind ?? 'conversation',
      input.source ?? 'chat',
      input.status ?? 'running',
      input.inferenceTier ?? null,
    ],
  )
}

/**
 * Promote an action to a regular conversation (flip `kind`). Scoped by
 * user_id, so a wrong userId silently no-ops. Idempotent — promoting an
 * already-promoted row is a harmless no-op write.
 */
export async function promoteConversation(id: string, userId: string): Promise<void> {
  await query(
    `UPDATE conversations SET kind = 'conversation', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND kind = 'action'`,
    [id, userId],
  )
}

/**
 * Update only the lifted `status` column (no context write). Used by the
 * background runner's failure path to flip a stuck 'running' row to 'error'
 * when the run threw before producing a serialized context. Scoped by user_id.
 */
export async function setConversationStatus(
  id: string,
  userId: string,
  status: ConversationStatus,
): Promise<void> {
  await query(
    `UPDATE conversations SET status = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3`,
    [status, id, userId],
  )
}

/**
 * A conversation's tier column alone, or `null` when the row does not exist,
 * belongs to someone else, or has no tier of its own — three cases that mean
 * the same thing to the caller (resolve through the seed) and are deliberately
 * not distinguished.
 *
 * A projection rather than a {@link loadConversation}, because both callers ask
 * this on a hot path — once per turn, and once per conversation the user opens —
 * and loading the row would pull the whole `context` blob across the wire and
 * decrypt it (249 KiB on the dev table, see
 * {@link CONVERSATION_EVENTS_SCAN_LIMIT}) to read one short plaintext column.
 */
export async function getConversationInferenceTier(
  id: string,
  userId: string,
): Promise<StoredInferenceTier> {
  const { rows } = await query<{ inference_tier: string | null }>(
    'SELECT inference_tier FROM conversations WHERE id = $1 AND user_id = $2',
    [id, userId],
  )
  return rows[0]?.inference_tier ?? null
}

/**
 * Set a conversation's inference tier — the per-conversation switch's only
 * write. Scoped by `user_id`, so a wrong userId silently no-ops rather than
 * re-routing someone else's chat.
 *
 * Unconditional, unlike the `COALESCE` in {@link saveConversation}: this IS the
 * deliberate act, and a mid-conversation flip has to be able to replace a tier
 * the row already carries. The scope is per turn (`runWithInferenceTier`), so
 * the flip takes effect on the next turn and no in-flight one changes provider
 * underneath itself.
 *
 * **`updated_at` is deliberately left alone**, for the reason
 * {@link reapStuckConversations} spells out: the column is the app's record of
 * chat activity ({@link countActiveUsers} reads exactly that) and it is what the
 * sidebar renders as "x ago". Choosing where the next turn runs is not a turn,
 * and bumping it would reorder the list and report the owner as chatting.
 *
 * The value is written as given. Validation is the caller's — `lib/inference/
 * tier.server.ts` is the one that narrows to the union and refuses `'verda'` on
 * a deployment with no endpoint, because that refusal is about the deployment
 * rather than about the row.
 */
export async function setConversationInferenceTier(
  id: string,
  userId: string,
  tier: string,
): Promise<void> {
  await query(
    `UPDATE conversations SET inference_tier = $1
     WHERE id = $2 AND user_id = $3`,
    [tier, id, userId],
  )
}

/**
 * One-time migration: give conversations written before the tier column the
 * tier their turns actually ran under.
 *
 * Runs from `initSchema` (`db/client.server.ts`) on the direct runner, like the
 * encryption backfill beside it — `query()` awaits the init promise, so a
 * backfill going through `query()` would wait on itself. It lives HERE because
 * this module owns SQL against `conversations`; `encryption-coverage.test.ts`
 * pins that nothing else does, and dodging that pin by building the statement
 * out of fragments would be worse than the split.
 *
 * **Only from a recorded preference, never from a guess.** Before this change a
 * turn resolved its tier from `user_prefs`, so a user who chose one has a fact
 * about their past runs and it is copied here. A user who never chose does not:
 * their turns ran on `defaultInferenceTier()`, which is host state read per
 * turn, and materialising today's answer onto old rows would claim a routing
 * nobody observed — on a deployment that configured its endpoint late, it would
 * claim the opposite of what happened. Those rows stay NULL and resolve live,
 * which is exactly what they did yesterday.
 *
 * The residual, stated rather than hidden: a NULL row follows its owner's
 * last-used tier, so once such a user flips any conversation's switch their old
 * conversations follow it. That is the pre-existing behaviour, unchanged; what
 * the backfill buys is that everyone who HAD expressed a preference is pinned
 * out of it.
 *
 * Idempotent (`IS NULL` guard) and safe before `user_prefs` exists — that table
 * is bootstrapped lazily by its own repository, so `to_regclass` decides whether
 * there is anything to copy rather than the statement failing the whole boot.
 */
export async function backfillConversationInferenceTier(run: QueryRunner): Promise<void> {
  await run(
    `DO $$
     BEGIN
       IF to_regclass('public.user_prefs') IS NOT NULL THEN
         UPDATE conversations c
            SET inference_tier = p.inference_tier
           FROM user_prefs p
          WHERE p.user_id = c.user_id
            AND c.inference_tier IS NULL
            AND p.inference_tier IN ('verda', 'anthropic');
       END IF;
     END $$;`,
  )
}

/**
 * The per-LLM-call ceiling in force: `VerdaQwen`'s `request_timeout_ms` of
 * 180_000 (`baml_src/verda-client.baml`), which is the only declared one and
 * belongs to the DEPLOYMENT DEFAULT tier. It is the single term below that
 * dominates everything else, so it is the number that moves the threshold.
 *
 * **Three minutes, not ten, since #279** — that PR moved the cold start out in
 * front of the turn (a wake ping, `lib/inference/wake.server.ts`) so the client's
 * own timeout could be sized for a WARM call, and derived it from the halved
 * `max_tokens` of 4 096: a full-cap generation has to finish inside the timeout
 * or the truncation retry can never fire. Both halves of that are one decision
 * and the arithmetic is stated on the client; this constant only mirrors the
 * result, and `stuck-run-reaper.test.ts` pins the mirror against the `.baml`
 * declaration rather than trusting it — BAML exports nothing a module can read
 * the number from, so the copy has to be held by a source scan.
 *
 * This is a MIRROR, exported for the pin and for the derivation's own test. It
 * is not the declaration: change `request_timeout_ms` and this follows, or the
 * scan goes red naming both numbers.
 */
export const PER_CALL_TIMEOUT_MINUTES = 3

/**
 * The most sequential LLM calls one turn can make, on the longest chain a
 * BROWSER can ask for.
 *
 * `SETTINGS_BOUNDS.maxToolTurns[1]` is the tool loop's ceiling and it is
 * client-settable (`SettingsPanel`, clamped server-side), so the reachable
 * bound is the ceiling and not the default of 5. `CHAIN_OVERHEAD_CALLS` covers
 * the single-call patterns a registered chain wraps around that loop — router,
 * compactIntent, planner, compactExecution — plus one spare, because the count
 * is a property of whichever agent is registered and a new one must not
 * silently invalidate the arithmetic.
 *
 * `actorCritic` is the other loop shape and is bounded by
 * `SETTINGS_BOUNDS.maxRetries[1]` at an actor call plus a critic call per
 * attempt; `Math.max` takes whichever loop is worse rather than assuming.
 */
export const CHAIN_OVERHEAD_CALLS = 5
const MAX_SEQUENTIAL_LLM_CALLS =
  Math.max(SETTINGS_BOUNDS.maxToolTurns[1], 2 * SETTINGS_BOUNDS.maxRetries[1]) +
  CHAIN_OVERHEAD_CALLS

/**
 * How long a row may sit at `status='running'` with NO write of its own before
 * the sweep below calls it abandoned.
 *
 * **Derived, not chosen** — the arithmetic is right here because the previous
 * value was not supported by its own stated rationale. A running row is not
 * touched again between the pre-seed and the final `saveSession`, so there is
 * no mid-turn heartbeat and "no state change" cannot distinguish a slow turn
 * from a dead process. The ONLY protection a live turn has is that this
 * threshold outlasts it, which makes the number a bound and not a preference:
 *
 *     worst legitimate turn = MAX_SEQUENTIAL_LLM_CALLS × PER_CALL_TIMEOUT_MINUTES
 *                           = (max(maxToolTurns 15, 2 × maxRetries 10) + 5) × 3 min
 *                           =  25 calls × 3 min = 75 min
 *     threshold             = ceil(worst × MARGIN 1.2) = 90 min
 *
 * **Every term is read from where it lives**, which is the property that makes
 * this survive an edit somewhere else: the two loop bounds come from the
 * exported {@link SETTINGS_BOUNDS}, so widening a slider lengthens this with no
 * edit here, and {@link PER_CALL_TIMEOUT_MINUTES} mirrors the client's
 * `request_timeout_ms` under a source-scan pin. The pin in
 * `stuck-run-reaper.test.ts` imports all three rather than restating them —
 * local copies there were what made the last ceiling change fail with a
 * *misleading* message (N1 on #278): 90 minutes is the right answer at a
 * 3-minute ceiling, and a test holding a stale 250 accused it of being unsafe.
 *
 * The value it replaces was 20 minutes, and 20 minutes is exactly 2 × the 600s
 * per-call ceiling then in force — while CLAUDE.md's own measurement of a burst
 * into a sleeping box is that ceiling being hit *twice in one turn* (controller,
 * then synthesizer). It was therefore a coin flip on the shape it was written
 * against, and a 21-minute turn was in fact reaped out from under itself in
 * review: the reap wrote `error`, the turn later wrote its own outcome over it,
 * and in between the row lied and `sweepStuckRuns` logged an abandonment that
 * had not happened. The owner's "~20 min" was policy intent — reap STUCK runs,
 * never live ones — and the intent is what this honours; the number was never
 * the thing being asked for.
 *
 * **The wake is the one term not in the product, and it fits.** #279 parks a
 * turn on a wake before its first LLM call, for up to
 * `DEFAULT_VERDA_WAKE_TIMEOUT_MS` (600s since 2026-08-27, when the single ping
 * became a poll — `lib/inference/wake.server.ts`), and the row is pre-seeded
 * before that wait — so the worst legitimate turn is really 75 + 10 =
 * **85 minutes against a 90-minute threshold**, 5 minutes clear. It is folded
 * into the margin rather than added as a term because it is bounded, once per
 * turn (concurrent turns share one ping) and two orders of magnitude below the
 * chain; `stuck-run-reaper.test.ts` pins the inequality against the real
 * constant so a longer wake fails here rather than shortening a live turn's
 * protection in silence.
 *
 * **The margin is 1.2, and the wake above is the only other thing it absorbs.**
 * It is not slack for an unaccounted term: every term in the product is a hard
 * ceiling the app enforces, and the margin exists so that a turn sitting at the
 * bound is not racing the sweep.
 *
 * The cost of the larger number is bounded and small: an abandoned row is
 * reconciled later, and nothing else changes — reaping was never what a WAITING
 * user sees (a live run's spinner is `session-registry`'s per-tab
 * `isProcessing` signal, which a reload clears whatever the row says). What the
 * reap buys is honest data at rest, and honest data late beats a wrong status
 * early.
 *
 * It tightens when the per-call ceiling does, and has once already: see
 * {@link PER_CALL_TIMEOUT_MINUTES}, which #279 took from 10 minutes to 3 and
 * this expression from 300 minutes to 90, with no other edit.
 */
const STUCK_RUN_MARGIN = 1.2
export const STUCK_RUN_TIMEOUT_MINUTES = Math.ceil(
  MAX_SEQUENTIAL_LLM_CALLS * PER_CALL_TIMEOUT_MINUTES * STUCK_RUN_MARGIN,
)

/**
 * Reconcile abandoned runs: every row still at `status='running'` whose last
 * write is older than {@link STUCK_RUN_TIMEOUT_MINUTES} becomes `'error'`.
 * Returns the ids it changed (for the caller's log and for tests).
 *
 * The rows this exists for are the ones no code path will ever finish: the
 * process died mid-turn, so the `catch` in `turn.server.ts#runAndSave` that
 * normally flips a failed row out of `running` (sf-M2/sf-M3) never ran. Such a
 * row claims to be working and is not, which is the same dishonesty the
 * app-path e2e suite exists to forbid — just at rest rather than in a turn.
 *
 * **What it is NOT is "a spinner nothing can clear"** — an earlier version of
 * this docstring said that and it was wrong (F4 on #278). A live run's spinner
 * is `session-registry`'s client-side `isProcessing` signal, per browser tab; it
 * is never seeded from the persisted status and a reload clears it whatever the
 * row says. What the reap actually buys is honest data AT REST — a
 * `kind='action'` row's badge, the row's own status wherever it is read, and a
 * conversation that no longer reports itself as running to anything that asks.
 * `rowIndicator` shows a conversation's `error` since F4, so the correction is
 * "a reaped row now says so", not "a spinner stops".
 *
 * **Multi-instance safe, and it has to be, because nothing elects a leader.**
 * Every input is in the database:
 *
 *   - the freshness test is `updated_at` against the DATABASE's `NOW()`, so two
 *     app instances agree on the deadline even with skewed host clocks, and an
 *     instance that just booted judges another instance's rows correctly — it
 *     holds no memory of which turns are live, and must not, since its own
 *     in-flight set says nothing about anyone else's;
 *   - `status = 'running'` in the WHERE clause is the claim. Postgres takes a
 *     row lock per UPDATE, so two concurrent sweeps serialize: the first flips
 *     the row and the second no longer matches it, which is why `RETURNING`
 *     reports each reaped row to exactly one sweeper and the sweep is
 *     idempotent rather than merely repeatable.
 *
 * The one interleaving left is a turn that outlives the threshold: it is reaped
 * mid-flight and then overwrites the reap with its own outcome. That is the
 * threshold's job to prevent, not this statement's — see the constant.
 *
 * Cross-user by design (no `user_id` scope): this is a process-wide sweep, not
 * a request, and an abandoned row is abandoned whoever owns it. It reads and
 * writes only plaintext columns — `status`, `updated_at`, and `id` for the
 * report — so no key is needed and no `context` blob is touched. Like
 * {@link countActiveUsers}, it lives here because this module owns SQL against
 * `conversations` (`encryption-coverage.test.ts` pins that nothing else does).
 *
 * `paused` is deliberately untouched: an approval gate waits for a person, for
 * as long as that takes, and reaping one would discard resumable work.
 *
 * **`updated_at` is left alone**, which is the one place this write differs
 * from every other write in this module. Two reasons, both about what the
 * column means: it is the app's record of "this user did something"
 * ({@link countActiveUsers} reads exactly that, per poll, per tab), and a sweep
 * is not something the user did — bumping it would report every reaped
 * conversation's owner as active. It is also what the sidebar renders as "x
 * ago", where the abandonment time is the honest answer and the reap time is
 * not. Nothing depends on it advancing here: the idempotence above comes from
 * `status`, not from the timestamp.
 */
export async function reapStuckConversations(): Promise<string[]> {
  // The interval is a constant, never a caller value — inlined for the same
  // reason `countActiveUsers` inlines its window (readability over
  // `make_interval` with a bound parameter).
  const { rows } = await query<{ id: string }>(
    `UPDATE conversations
        SET status = 'error'
      WHERE status = 'running'
        AND updated_at < NOW() - INTERVAL '${STUCK_RUN_TIMEOUT_MINUTES} minutes'
      RETURNING id`,
  )
  return rows.map((r) => r.id)
}

/**
 * List a user's conversations, newest-created first.
 *
 * Deliberately `created_at`, not `updated_at` (#105): every turn-save bumps
 * `updated_at`, so with concurrent runs an activity-ordered list reshuffles
 * on each refetch — the thread under the cursor jumps to the top. Creation
 * order is stable for a conversation's whole lifetime. `updated_at` is still
 * returned for display ("x ago" shows activity, it just doesn't sort).
 */
export async function listConversations(userId: string): Promise<ConversationListItem[]> {
  const { rows } = await query<DbListRow>(
    'SELECT id, agent_id, title, kind, source, status, inference_tier, updated_at FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200',
    [userId],
  )
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    title: decryptFieldOrNull(r.title, 'conversations.title'),
    kind: r.kind,
    source: r.source,
    status: r.status,
    inferenceTier: r.inference_tier,
    updatedAt: r.updated_at,
  }))
}

/** A conversation reduced to its event stream — the metrics dashboard's input. */
export interface ConversationEventsRow {
  id: string
  agentId: string
  title: string | null
  updatedAt: Date
  /** `context.events` straight out of the JSONB blob (already parsed by pg). */
  events: unknown
}

/** Row ceiling for {@link listConversationEvents}. Exported so the dashboard can
 *  say "most recent N" instead of implying it folded everything.
 *
 *  Since encryption it is a **memory** ceiling too, not only a row one: the
 *  whole blob is now materialised in this process, so at the dev table's
 *  average 249 KiB per `context` this bounds one dashboard load at ~65 MB read
 *  and ~150 MiB of heap churn. Raising it is a memory decision. */
export const CONVERSATION_EVENTS_SCAN_LIMIT = 200

/**
 * Load every conversation's event stream for a user (#132).
 *
 * This used to project `context -> 'events'` in SQL so the dashboard never
 * pulled the whole blob — pattern `data` payloads (graph elements, tool
 * outputs) can dwarf the events. **At-rest encryption removes that option**:
 * the column now holds one opaque envelope, so there is no sub-path for
 * Postgres to reach into and the projection has to move into this process. The
 * cost is real and is the price of the column being unreadable in a dump; the
 * 200-row ceiling from {@link listConversations} is what keeps it bounded, and
 * it is the only reason this is a bounded regression rather than a structural
 * one. Measured at the dev table's own average blob size (249 KiB x 200 rows,
 * the PR that introduced encryption has the table): ~1.1x the old SQL
 * projection in wall clock, both dominated by the JSON parse — but ~200 ms and
 * ~65 MB read in absolute terms, which is the number that matters on a small
 * VM. See {@link CONVERSATION_EVENTS_SCAN_LIMIT}.
 */
export async function listConversationEvents(userId: string): Promise<ConversationEventsRow[]> {
  const { rows } = await query<{
    id: string
    agent_id: string
    title: string | null
    updated_at: Date
    context: unknown
  }>(
    `SELECT id, agent_id, title, updated_at, context
     FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CONVERSATION_EVENTS_SCAN_LIMIT}`,
    [userId],
  )
  return rows.map((r) => {
    const context = JSON.parse(decryptJsonb(r.context, 'conversations.context')) as {
      events?: unknown
    } | null
    return {
      id: r.id,
      agentId: r.agent_id,
      title: decryptFieldOrNull(r.title, 'conversations.title'),
      updatedAt: r.updated_at,
      events: context?.events ?? null,
    }
  })
}

/**
 * Delete a conversation. No-op when the id doesn't belong to the user.
 */
export async function deleteConversation(id: string, userId: string): Promise<void> {
  await query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, userId])
}

/**
 * Delete a batch of conversations in one round trip, scoped to the user.
 * Ids that don't exist or belong to someone else are silently skipped —
 * same contract as {@link deleteConversation}. Returns the ids actually
 * deleted so callers can patch caches from ground truth.
 */
export async function deleteConversations(ids: string[], userId: string): Promise<string[]> {
  if (ids.length === 0) return []
  const { rows } = await query<{ id: string }>(
    'DELETE FROM conversations WHERE id = ANY($1) AND user_id = $2 RETURNING id',
    [ids, userId],
  )
  return rows.map((r) => r.id)
}

/**
 * Authoritative title override. Bypasses the COALESCE-sticky rule that
 * `saveConversation` applies on upsert — used by the LLM title generator
 * to replace the heuristic title with a model-authored one once it lands.
 *
 * Safe by construction: the WHERE clause includes `user_id`, so a wrong
 * userId silently no-ops (zero rows affected) rather than overwriting
 * another user's title.
 */
export async function updateConversationTitle(
  id: string,
  userId: string,
  title: string,
): Promise<void> {
  await query(
    `UPDATE conversations SET title = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3`,
    [encryptField(title), id, userId],
  )
}

/**
 * Derive a sticky title from the first user message: trimmed, single-line,
 * capped at 60 chars. Returns null if the input is empty.
 */
export function deriveTitle(firstUserMessage: string): string | null {
  const cleaned = firstUserMessage.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned.length > 60 ? cleaned.slice(0, 60) + '…' : cleaned
}

// ============================================================================
// Cross-user aggregates
// ============================================================================

/**
 * How recently a conversation must have been touched to count its owner as
 * active. 15 minutes — long enough to cover a user reading an answer, short
 * enough that the number means "right now".
 */
export const ACTIVE_WINDOW_MINUTES = 15

/**
 * Distinct users whose conversations were touched in the last
 * {@link ACTIVE_WINDOW_MINUTES} minutes. Feeds the preview header's "active"
 * counter (`metrics/preview-counters.server.ts` owns the rest of that strip's
 * numbers, in a table of its own).
 *
 * **It lives in this module because this module owns SQL against
 * `conversations`.** That is the #260 seam: encryption cannot live in
 * `query()`, which takes opaque SQL and an untyped parameter array, so
 * encrypt-on-write / decrypt-on-read live in the four repositories that own the
 * encrypted tables — and `encryption-coverage.test.ts` pins that nothing else
 * names one of those tables in SQL. A counter module reaching into
 * `conversations` for itself would have been the fifth namer: not a leak today,
 * because the two columns below are plaintext by design, but a second door onto
 * an encrypted table that the pin exists to keep from opening. The aggregate is
 * cheap and reads no personal data, so it comes to the door rather than the
 * door being widened.
 *
 * Only `user_id` and `updated_at` are read, and only in aggregate: no title, no
 * `context` blob, no row identity, and nothing per-user leaves this function —
 * the caller gets a count (SD-10).
 *
 * `conversations.updated_at` is bumped by every `saveSession`, so it is the
 * app's existing record of "this user did something", with no new write path
 * and no new table. It is a *chat* activity signal specifically: a signed-in
 * user staring at the dashboard is not counted, which is the honest reading of
 * "active" for this app and is how the label is worded.
 *
 * The interval is inlined rather than parameterised because it is a constant,
 * and `make_interval` with a bound parameter is the alternative — this keeps
 * the SQL readable; the value never comes from a caller, let alone a client.
 *
 * **This is only cheap because of `conversations_updated_idx`**
 * (`db/client.server.ts`), which leads on `updated_at`. The two composite
 * indexes on that table lead on `user_id`, so without the recency-only one this
 * degrades to a full index-only scan — O(every conversation ever) rather than
 * O(the 15-minute window) — on a query that runs per poll, per tab, per user,
 * on every route. Do not drop it while that surface polls.
 */
export async function countActiveUsers(): Promise<number> {
  const { rows } = await query<{ active: string | number }>(
    `SELECT COUNT(DISTINCT user_id) AS active
       FROM conversations
      WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MINUTES} minutes'`,
  )
  // `COUNT` arrives from `pg` as a string (BIGINT), so it is parsed rather than
  // trusted to be a number.
  return Number(rows[0]?.active ?? 0) || 0
}
