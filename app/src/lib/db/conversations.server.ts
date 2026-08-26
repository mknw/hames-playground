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
    'SELECT id, user_id, agent_id, title, context, kind, source, status, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2',
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
    `INSERT INTO conversations (id, user_id, agent_id, title, context, kind, source, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       agent_id   = EXCLUDED.agent_id,
       context    = EXCLUDED.context,
       title      = COALESCE(conversations.title, EXCLUDED.title),
       status     = EXCLUDED.status,
       updated_at = NOW()
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
 * How long a row may sit at `status='running'` with NO write of its own before
 * the sweep below calls it abandoned.
 *
 * It has to exceed the longest turn that is still legitimately in flight,
 * because a running row is not touched again between the pre-seed and the
 * final `saveSession` — there is no mid-turn heartbeat, so "no state change"
 * cannot distinguish a slow turn from a dead process. The longest measured
 * legitimate wait is the self-hosted tier's cold start plus a queued burst:
 * 146s of boot (#273) against a 600s per-call `request_timeout_ms`, and a turn
 * makes several calls. 20 minutes clears that with room, and is still short
 * enough that a person who left a spinner running comes back to an answer or
 * an error rather than to the spinner.
 *
 * Lower it and a long turn is reaped out from under itself: the reap writes
 * `error`, the turn finishes and writes `done` over it, and the row lies in
 * whichever order they land. Raise it and an abandoned row spins for longer.
 * Both are worse than the current value; change it against a measurement, not
 * a hunch.
 */
export const STUCK_RUN_TIMEOUT_MINUTES = 20

/**
 * Reconcile abandoned runs: every row still at `status='running'` whose last
 * write is older than {@link STUCK_RUN_TIMEOUT_MINUTES} becomes `'error'`.
 * Returns the ids it changed (for the caller's log and for tests).
 *
 * The rows this exists for are the ones no code path will ever finish: the
 * process died mid-turn, so the `catch` in `turn.server.ts#runAndSave` that
 * normally flips a failed row out of `running` (sf-M2/sf-M3) never ran. In the
 * sidebar such a row is a spinner nothing can clear, which is the same
 * dishonesty the app-path e2e suite exists to forbid — just at rest rather
 * than in a turn.
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
    'SELECT id, agent_id, title, kind, source, status, updated_at FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200',
    [userId],
  )
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    title: decryptFieldOrNull(r.title, 'conversations.title'),
    kind: r.kind,
    source: r.source,
    status: r.status,
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
