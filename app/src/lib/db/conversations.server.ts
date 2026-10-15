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

import { randomBytes } from 'node:crypto'

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { query, withTransaction } from './client.server'
import { deleteHitlRowsForConversations } from './hitl.server'
import { deleteMemoriesForConversations } from './memories.server'
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

export type MemoryRunOrigin = 'interactive' | 'triggered'

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
  /**
   * The version of `context` this read saw: `context_version`, bumped by every
   * write of the blob and by every turn claim, and by nothing else. Every save
   * names the version it read and lands only if the row still has it — see
   * {@link saveConversation} and {@link updateConversationContextIfUnchanged}.
   * Compare it, never parse it.
   */
  version: string
  /**
   * When a `chain-changed` refusal terminally ended this conversation's HITL
   * pause (#433 S7, owner item 1 on review 6004200697), or null. The row's
   * `error` is then FINAL for the pause: the m3 load-restore must not
   * resurrect `paused` from the blob, which still says `paused` because a
   * refusal records nothing. Cleared by the conversation's next successful
   * save ({@link saveConversation}), which is the turn that moved it on.
   *
   * Plaintext like every timestamp (crypto.server.ts doctrine): a timestamp
   * says nothing about what was said.
   */
  hitlEndedAt: Date | null
  memoryRunOrigin: MemoryRunOrigin | null
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
  /** When the user pinned this row, or null when it is not pinned. Drives both
   *  the sidebar's pin glyph and the list ordering below. */
  pinnedAt: Date | null
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
  version: string
  hitl_ended_at: Date | null
  memory_run_origin: MemoryRunOrigin | null
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
  pinned_at: Date | null
}

/** Every column a {@link ConversationRow} is built from, for a SELECT or a RETURNING. */
const ROW_COLUMNS =
  'id, user_id, agent_id, title, context, kind, source, status, inference_tier, created_at, updated_at, context_version::text AS version, hitl_ended_at, memory_run_origin'

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
    version: row.version,
    hitlEndedAt: row.hitl_ended_at ?? null,
    memoryRunOrigin: row.memory_run_origin ?? null,
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
    `SELECT ${ROW_COLUMNS} FROM conversations WHERE id = $1 AND user_id = $2`,
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

// ============================================================================
// Writing `context`: one turn at a time, every save at the version it read
// ============================================================================
//
// The row has three writers of `context`, and until #458 two of them were
// last-writer-wins: the turn's own end-of-turn save, and the summary pass it
// starts detached after the answer (`compactAndSave`). A summary pass that
// outlasted the next turn replaced that turn's events with the context of the
// turn before; two turns on one conversation (a second tab, a double submit)
// kept only the later save; and a flag flipped mid-turn was reported saved and
// then overwritten by the turn. The third writer, `/api/stash`, already checked
// a version — the only one that did.
//
// The rule now, enforced in the statements below rather than by convention:
//
//  1. **A turn CLAIMS its conversation before it runs, and while the claim is
//     live it is the only writer of `context`.** A second turn is refused
//     ({@link ConversationBusyError}); a writer that is not a turn (the summary
//     pass, a flag flip) waits until no claim is live. Refused rather than
//     queued: a queue would itself be state held outside the context.
//  2. **Every write of `context` names the version it read**
//     (`context_version`), lands only if the row still has it, and moves it
//     on. The turn's version is the one its claim returned. Every new value
//     comes from one sequence ({@link NEXT_VERSION}), never from `+ 1`: a
//     per-row count restarts when a conversation is deleted and its id
//     recreated, and a turn still holding the deleted row's number would
//     then save into the new one.
//  3. **A claim is a lease.** The holder renews it every
//     {@link TURN_CLAIM_RENEW_MS}; one not renewed for
//     {@link TURN_CLAIM_TTL_SECONDS} is dead and the next turn may take the
//     row. Taking it moves the version on, so the dead holder's late save —
//     should its process turn out to be alive after all — is refused instead
//     of landing over the new turn's work.
//
// Why the lease, and not the stuck-run reaper's old status-plus-age check, is
// the liveness signal: that check was a bound on the LONGEST LEGITIMATE TURN,
// because with no heartbeat "nothing has been written" cannot tell a slow turn
// from a dead process. Used as a lock expiry it would have refused every
// conversation whose turn died in a deploy or a restart for hours. The renewal
// is that heartbeat, which lets the expiry measure "is the holder alive"
// instead of "how long can a turn be" — and keeps the lock out of `status` and
// `updated_at`, both of which mean something else to the sidebar and the
// active-user count. The reaper now reads the SAME lease ({@link NO_LIVE_CLAIM},
// so it and a taking-over turn can never disagree about "dead") and keeps the
// age bound only as {@link HUNG_TURN_BACKSTOP_MINUTES}, for a process that is
// alive, renewing, and never finishing (#507 P2).

/**
 * How long a claim survives without a renewal. Four renewal intervals, so a
 * slow round trip or a stalled event loop costs a live turn nothing; the price
 * of the number is how long a conversation whose turn's process died stays
 * refused.
 */
export const TURN_CLAIM_TTL_SECONDS = 120

/** How often the turn holding a conversation renews its claim. */
export const TURN_CLAIM_RENEW_MS = 30_000

/** No turn holds the row: nobody claimed it, or the claim was not renewed in time. */
const NO_LIVE_CLAIM = `(turn_claimed_at IS NULL OR turn_claimed_at < NOW() - INTERVAL '${TURN_CLAIM_TTL_SECONDS} seconds')`

/**
 * The next `context_version`. The column's insert default is the same
 * sequence (`client.server.ts`), so no number is ever handed out twice, across
 * rows, deletes and recreates alike.
 */
const NEXT_VERSION = `nextval('conversations_context_version_seq')`

/**
 * A claim older than this has missed at least one renewal: one and a half
 * renewal intervals, so a single slow round trip does not count but a missed
 * renewal does. Its holder is presumably gone (a deploy, a crash), and a
 * refusal says so instead of telling the user to wait for a turn that will
 * never finish.
 */
const INTERRUPTED_AFTER_SECONDS = (TURN_CLAIM_RENEW_MS / 1000) * 1.5

/**
 * A turn was refused because another turn holds the conversation. The message
 * reaches the user verbatim (the SSE route's `event: error`, an error bubble),
 * so it says what happened and what to do.
 *
 * `claimAgeSeconds` is how long ago the holder last renewed. Past
 * {@link INTERRUPTED_AFTER_SECONDS} the holder is presumed dead, and the
 * message says the turn was interrupted and when the lease lets go — rather
 * than "still running", which after a deploy or a crash is untrue.
 */
export class ConversationBusyError extends Error {
  constructor(claimAgeSeconds?: number | null) {
    super(
      claimAgeSeconds != null && claimAgeSeconds > INTERRUPTED_AFTER_SECONDS
        ? 'The last turn in this conversation was interrupted. You can send again in about ' +
            `${Math.max(1, Math.ceil(TURN_CLAIM_TTL_SECONDS - claimAgeSeconds))} seconds.`
        : 'A turn is still running in this conversation. Wait for it to finish, then send again.',
    )
    this.name = 'ConversationBusyError'
  }
}

/**
 * A save found the row at a different version than its writer read — another
 * writer got there first — and wrote nothing. Like {@link ConversationBusyError}
 * its message is user-facing; the detail goes to the log.
 */
export class ConversationConflictError extends Error {
  constructor() {
    super('This conversation changed while the turn was running, so the turn was not saved.')
    this.name = 'ConversationConflictError'
  }
}

export interface CreateConversationInput {
  id: string
  userId: string
  agentId: string
  title: string | null
  /** Full serializeContext() output. Stored as JSONB. */
  serializedContext: string
  /** Lifted copy of the context status. Defaults to 'running': a row is
   *  created for the turn that is about to run on it. */
  status?: ConversationStatus
  /** Row kind, immutable from here on (promotion uses
   *  {@link promoteConversation}). Default 'conversation'. */
  kind?: ConversationKind
  /** Immutable provenance. Default 'chat'. */
  source?: ConversationSource
  /** The tier the creating turn resolved, recorded on the row it creates. */
  inferenceTier?: string
}

/**
 * Create a conversation row, CLAIMED by the turn creating it, and return the
 * version that turn holds.
 *
 * The two creators are the interactive pre-seed of a brand-new chat (#105) and
 * `seedActionRow` for a triggered run; both create the row for a turn that is
 * about to run on it, so the claim is taken in the same statement — there is
 * no moment at which the row exists unclaimed and a second turn could slip in.
 *
 * Never an upsert. An id that already exists is one of two things, and both
 * refuse:
 *  - it is the caller's own — a second first message on the same new chat
 *    whose first already created the row: {@link ConversationBusyError};
 *  - it belongs to someone else (`/?c=<their id>`: `loadSession` is
 *    user-scoped, so a foreign id looks new): THROWS, and the browser is told
 *    only that the turn could not be saved. "Belongs to another user" is an
 *    ownership fact for the log, not for the caller. Whether the product
 *    should instead re-mint the id is an open owner call; this only stops the
 *    write from landing on their row.
 */
export async function createConversation(input: CreateConversationInput): Promise<string> {
  const { rows } = await query<{ version: string }>(
    `INSERT INTO conversations
       (id, user_id, agent_id, title, context, kind, source, status, inference_tier, turn_claimed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, NOW())
     ON CONFLICT (id) DO NOTHING
     RETURNING context_version::text AS version`,
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
  if (rows.length > 0) return rows[0].version
  if ((await getConversationOwner(input.id)) === input.userId) throw new ConversationBusyError()
  console.error(
    `[db] creating conversation ${input.id} wrote no rows: the id exists and belongs to another ` +
      'user.',
  )
  throw new Error(`[db] conversation ${input.id} could not be saved; the turn is not persisted.`)
}

/**
 * Claim an existing conversation for one turn and return it as claimed —
 * `version` is the version that turn now holds. `null` when the user has no
 * such conversation (unknown id, or someone else's).
 *
 * Claim and read are one statement, so the turn runs on exactly the context
 * its claim covers: nothing can land between the read and the claim.
 *
 * Throws {@link ConversationBusyError} when another turn's claim is live. A
 * claim that has not been renewed for {@link TURN_CLAIM_TTL_SECONDS} is not
 * live: its turn's process is presumed dead, and this claim takes the row.
 * Taking it moves the version on, which is what refuses the old holder's save
 * if it was only slow.
 *
 * Does NOT touch `updated_at` or `status`: a claim is not chat activity, and
 * the turn's own save sets both when it ends.
 */
export async function claimConversation(
  id: string,
  userId: string,
): Promise<ConversationRow | null> {
  const { rows } = await query<DbRow>(
    `UPDATE conversations
        SET turn_claimed_at = NOW(), context_version = ${NEXT_VERSION}
      WHERE id = $1 AND user_id = $2 AND ${NO_LIVE_CLAIM}
      RETURNING ${ROW_COLUMNS}`,
    [id, userId],
  )
  if (rows.length > 0) {
    try {
      return rowToConversation(rows[0])
    } catch (err) {
      // An unreadable row (a wrong key) must not stay claimed for a lease.
      await releaseConversationClaim(id, userId, rows[0].version).catch(() => {})
      throw err
    }
  }
  // The claim's age, by the database's clock like the lease itself, so the
  // refusal can tell a live holder from one that stopped renewing.
  const { rows: existing } = await query<{ claim_age: number | null }>(
    `SELECT EXTRACT(EPOCH FROM NOW() - turn_claimed_at)::float8 AS claim_age
       FROM conversations WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  if (existing.length > 0) throw new ConversationBusyError(existing[0].claim_age)
  return null
}

export interface SaveConversationInput {
  id: string
  userId: string
  agentId: string
  /** Sticky — fills a row that has none, never overwrites one. */
  title: string | null
  /** Full serializeContext() output. Stored as JSONB. */
  serializedContext: string
  /** Lifted copy of the context status, so the sidebar can filter and badge
   *  without deserializing the blob. */
  status: ConversationStatus
  /**
   * The tier this turn ran on, RECORDED rather than set: written only when the
   * row has none yet (`COALESCE`, the stickiness `title` has), so it never
   * overwrites a mid-conversation flip. A row reaches here without one when
   * `seedActionRow` created it before any tier was resolved, or the backfill
   * left a legacy row alone; one turn under a tier is what makes that tier
   * this conversation's. {@link setConversationInferenceTier} is the only
   * mutator.
   */
  inferenceTier?: string
  /** The version the turn's claim holds — {@link claimConversation} or
   *  {@link createConversation}. */
  version: string
  /** Omit on resume to preserve the paused run's origin. */
  memoryRunOrigin?: MemoryRunOrigin | null
}

/**
 * The end-of-turn save, by the turn that holds the claim: writes the turn's
 * context **only if the row is still at the version the claim holds**,
 * releases the claim in the same statement, and returns the version it wrote.
 *
 * Throws {@link ConversationConflictError} when nothing was written — the
 * claim lapsed and was taken over, or the row was deleted mid-turn. Either way
 * the turn's result has nowhere safe to go, and the caller ends the turn
 * visibly instead of writing over the newer row. (The upsert this replaces
 * also resurrected a conversation the user had deleted mid-turn.)
 *
 * `kind` and `source` are not in the SET: they are fixed at creation, which is
 * what lets an action row survive its background run's save.
 */
export async function saveConversation(input: SaveConversationInput): Promise<string> {
  const { rows } = await query<{ version: string }>(
    `UPDATE conversations SET
       agent_id        = $3,
       title           = COALESCE(title, $4),
       context         = $5::jsonb,
       status          = $6,
       inference_tier  = COALESCE(inference_tier, $7),
       updated_at      = NOW(),
       context_version = ${NEXT_VERSION},
       turn_claimed_at = NULL,
       hitl_ended_at   = NULL,
       memory_run_origin = COALESCE($9, memory_run_origin)
     WHERE id = $1 AND user_id = $2 AND context_version = $8
     RETURNING context_version::text AS version`,
    [
      input.id,
      input.userId,
      input.agentId,
      encryptFieldOrNull(input.title),
      encryptJsonb(input.serializedContext),
      input.status,
      input.inferenceTier ?? null,
      input.version,
      input.memoryRunOrigin ?? null,
    ],
  )
  if (rows.length > 0) return rows[0].version
  console.error(
    `[db] saving conversation ${input.id} at version ${input.version} wrote no rows: another ` +
      'writer moved the row on (its claim lapsed and was taken), or the row is gone.',
  )
  throw new ConversationConflictError()
}

/**
 * Keep a claim alive — the turn holding it calls this every
 * {@link TURN_CLAIM_RENEW_MS}. `false` means the claim is no longer this
 * turn's: it lapsed and was taken, or the turn already saved.
 */
export async function renewConversationClaim(
  id: string,
  userId: string,
  version: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE conversations SET turn_claimed_at = NOW()
      WHERE id = $1 AND user_id = $2 AND context_version = $3 AND turn_claimed_at IS NOT NULL`,
    [id, userId, version],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Release a claim without saving — the turn ended before its save. With
 * `failed`, it also records the turn as failed (`status='error'`), which is
 * what keeps a row whose run threw from spinning on `running` (sf-M2/sf-M3).
 *
 * Fenced by the version the claim holds, like every write here: a turn whose
 * claim was taken over releases nothing and flips nothing, so it can neither
 * free the new holder's conversation nor mark its run failed. A no-op after
 * the turn's own save, which already released it.
 */
export async function releaseConversationClaim(
  id: string,
  userId: string,
  version: string,
  {
    failed = false,
    paused = false,
    hitlTerminal = false,
  }: { failed?: boolean; paused?: boolean; hitlTerminal?: boolean } = {},
): Promise<boolean> {
  // `paused` restores the lifted status to 'paused' while releasing (#433 S7,
  // A4/C1): a resume refused for anything but `chain-changed` must leave the
  // row saying what the blob still says — the person can answer again — so a
  // `tier-changed` refusal or a pre-run failure RESTORES 'paused' rather than
  // merely not touching it. Like `failed`, fenced by the claim's version: a
  // turn that lost the row restores nothing that is another turn's, and the
  // caller passes `paused: true` only when the row it CLAIMED said 'paused'
  // (the amendment to A4: the restore applies only to a row that was paused).
  //
  // `hitlTerminal` is the `chain-changed` half of the same release (owner
  // item 1 on review 6004200697, coordinator decision pending owner read): it
  // stamps `hitl_ended_at` beside the `error` flip, so the row's terminal
  // state is DURABLE — the m3 load-restore exempts a row whose pause ended
  // this way, instead of resurrecting `paused` from a blob that still says
  // `paused` on every load. Only the resume path may pass it, and only with
  // `failed`: a plain run failure leaves no pause to end.
  const failedSql = hitlTerminal
    ? `UPDATE conversations SET turn_claimed_at = NULL, status = 'error', updated_at = NOW(),
                                 hitl_ended_at = NOW()
         WHERE id = $1 AND user_id = $2 AND context_version = $3`
    : `UPDATE conversations SET turn_claimed_at = NULL, status = 'error', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND context_version = $3`
  const { rowCount } = await query(
    failed
      ? failedSql
      : paused
        ? `UPDATE conversations SET turn_claimed_at = NULL, status = 'paused', updated_at = NOW()
            WHERE id = $1 AND user_id = $2 AND context_version = $3`
        : `UPDATE conversations SET turn_claimed_at = NULL
            WHERE id = $1 AND user_id = $2 AND context_version = $3`,
    [id, userId, version],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Restore the lifted `status` to 'paused' when the blob says 'paused' and the
 * column has drifted off it (#433 S7, m3 as amended by #433 comment
 * 6004211643). The row is left at a status its blob does not say — `error`
 * today: a superseding MESSAGE whose run failed on a paused conversation
 * (the catch releases `failed: true` while nothing saved, so the blob still
 * says `paused`); under #470's claim a resume that dies between claim and
 * save no longer drifts the row at all, and a future status rule that does
 * is covered by the same repair. The host repairs it ON LOAD, at the version
 * the load read, and never while a turn holds the row — a live claim means a
 * turn is writing the truth right now, and this write must neither race it
 * nor refuse its save.
 *
 * Status only, never the blob: the blob IS the source of this fact. `false`
 * covers moved-on, turn-in-flight, unknown id and wrong owner alike — a
 * repair that did not land costs a wrong sidebar badge until the next load,
 * never a lost decision.
 *
 * THE ONE EXEMPTION IS THE CALLER'S (owner item 1 on review 6004200697): a
 * row whose `hitl_ended_at` is set — a `chain-changed` refusal ended its
 * pause terminally — is never repaired; `restorePausedFromBlob` reads the
 * marker off the row it loaded and declines to call this. The blob still
 * says `paused` in that case too, so the SQL alone could not tell the two
 * `error`s apart.
 *
 * One of the context writes that name the version they read (#470, F1): an
 * unconditional version of this would race the turn that just took the row.
 */
export async function restoreConversationPaused(
  id: string,
  userId: string,
  version: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE conversations SET status = 'paused', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND context_version = $3 AND ${NO_LIVE_CLAIM}`,
    [id, userId, version],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Replace a conversation's context blob **only if the row is still at the
 * version the caller read and no turn holds it**, reporting whether it wrote.
 *
 * For the writers that are not a turn and do read-modify-write on the whole
 * blob: `/api/stash` flipping `hidden`/`archived` on one event, and the turn's
 * detached summary pass. Unguarded, whichever write is second wins outright —
 * the flag silently vanishes, or a turn's whole event set is replaced by the
 * blob this caller loaded before it.
 *
 * Refused while a turn's claim is live, because that turn is about to write
 * the blob it loaded when it STARTED: a write landing now would either be
 * overwritten by it or, since it moves the version, refuse that turn's save.
 * The turn wins; this caller is told it did not write.
 *
 * Context only: `title`, `status`, `agent_id` and `inference_tier` are left
 * alone, because the blob such a caller holds may be a turn behind and
 * restamping them from it would undo what the turn just recorded.
 *
 * `false` covers moved-on, turn-in-flight, unknown id and wrong owner alike —
 * all four mean "your write did not land", which is what the caller must
 * report.
 */
export async function updateConversationContextIfUnchanged(
  id: string,
  userId: string,
  serializedContext: string,
  version: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE conversations
        SET context = $1::jsonb, updated_at = NOW(), context_version = ${NEXT_VERSION}
      WHERE id = $2 AND user_id = $3 AND context_version = $4 AND ${NO_LIVE_CLAIM}`,
    [encryptJsonb(serializedContext), id, userId, version],
  )
  return (rowCount ?? 0) > 0
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
 * the row already carries. The scope is per turn (the run frame), so
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
 * Calls a single-loop chain around its loop: router, compactIntent, planner,
 * compactExecution — plus one spare, because the count is a property of
 * whichever agent is registered and a new one must not silently invalidate the
 * arithmetic.
 */
export const CHAIN_OVERHEAD_CALLS = 5

/**
 * The most LLM calls one loop can make, on the longest chain a BROWSER can ask
 * for. `SETTINGS_BOUNDS.maxToolTurns[1]` is the tool loop's ceiling (one
 * controller call per round) and `actorCritic` is bounded by
 * `SETTINGS_BOUNDS.maxRetries[1]` at one actor call plus one critic call per
 * attempt. Both come from the exported bounds, so widening a slider lengthens
 * the backstop with no edit here. Unlike the actor, the critic has no parse
 * retry.
 */
export const ATTEMPTS_PER_CONTROLLER_CALL = 2

/**
 * One REQUEST is what the per-call timeout bounds, and a logical controller,
 * actor or planner call can make two: `createLoopControllerAdapter`,
 * `createActorControllerAdapter` and `createPlannerAdapter` each re-ask ONCE
 * when a completion is truncated at its output cap or empty
 * (`planParseRetry`, `packages/harness-baml/baml-adapters.server.ts`). On the
 * private tier a full-cap first attempt (~158 s) still fits inside the 180 s
 * `request_timeout_ms`, so the retry is reachable and the worst call is two
 * timeouts' worth, not one (#597 review finding 1).
 */
const WORST_LOOP_REQUESTS = Math.max(
  SETTINGS_BOUNDS.maxToolTurns[1] * ATTEMPTS_PER_CONTROLLER_CALL,
  SETTINGS_BOUNDS.maxRetries[1] * (ATTEMPTS_PER_CONTROLLER_CALL + 1),
)

/**
 * `decisionLoop`'s iteration default (N5 on #507, `maxIterations: 6`). A MIRROR
 * of the ruling, held against the design doc's N5 line and by a tripwire that
 * goes red the day core exports `decisionLoop` (`stuck-run-reaper.test.ts`):
 * import its default then, instead of this copy.
 */
export const DECISION_LOOP_MAX_ITERATIONS = 6

/**
 * The wall-clock cap of one tool call: the MCP SDK's
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` (60 000 ms), which covers `client.callTool` in
 * `mcp-client.server.ts` and the sandbox backend. Pinned against the SDK's own
 * export. (The sandbox's `defaultTimeoutSec` is NOT this cap: it is written into
 * the runtime config and never read by a backend.)
 */
export const TOOL_CALL_TIMEOUT_MINUTES = 1

/**
 * The longest a turn is parked on the private tier's wake before its first call:
 * the larger of `DEFAULT_VERDA_WAKE_TIMEOUT_MS` (600 s) and
 * `DEFAULT_SMALL_LLM_WAKE_TIMEOUT_MS` (720 s). The two boxes wake in PARALLEL, so
 * it is the max and not the sum. A mirror — `lib/inference/wake.server.ts` pulls
 * in the whole transport stack, which this module must not — pinned against both
 * defaults in `stuck-run-reaper.test.ts`. A host that raises either env override
 * by more than the margin has to raise the backstop with it (`.env.example`).
 */
export const WAKE_ALLOWANCE_MINUTES = 12

/**
 * The LLM requests the `decisionLoop` agent (#507) makes in its worst
 * legitimate turn on the private tier, and the arithmetic behind
 * {@link HUNG_TURN_BACKSTOP_MINUTES}:
 *
 *     per iteration  = 1 decision + the worst child loop
 *                    = 1 + max(15 rounds × 2 attempts, 10 attempts × (2 actor + 1 critic))
 *                    = 1 + 30 = 31 requests
 *     turn           = 6 iterations × 31 + 1 synthesis + (5 chain overhead + 1 planner retry)
 *                    = 193 requests
 *
 * The `decide` call is a single request (a systemone client with no parse
 * retry) and is counted at the same 3-minute budget, which is conservative.
 *
 * **That is not the 97 in the design doc, and the difference is stated rather
 * than hidden.** The doc's P2 counts LOGICAL calls with a child as the 15-round
 * `simpleLoop` and no chain overhead: 6 × 15 + 6 decisions + 1 synthesis =
 * **97 calls**. This counts requests, in the worse child shape (`actorCritic`),
 * with the chain-overhead calls the bound it replaces already carried. Both
 * computations stand: 97 is pinned as a FLOOR the backstop must exceed, 193 is
 * the value used.
 */
export const DECISION_LOOP_WORST_REQUESTS =
  DECISION_LOOP_MAX_ITERATIONS * (1 + WORST_LOOP_REQUESTS) + 1 + (CHAIN_OVERHEAD_CALLS + 1)

/**
 * How long a row may sit at `status='running'` **while its turn lease is still
 * being renewed** before the sweep below calls it hung. It is a BACKSTOP and
 * not the reaper's liveness test: a dead process is caught in
 * {@link TURN_CLAIM_TTL_SECONDS} by the lease, so no composition's arithmetic
 * decides whether an ordinary dead turn is reaped. What this bounds is the one
 * case the lease cannot see — a process that is alive, renewing, and never
 * finishing — and for that a live long turn should not be reaped before it could
 * legitimately end, so the number is a bound on the longest legitimate turn.
 *
 * **Derived, not chosen** (G12 A1 on #507), for the PRIVATE tier:
 *
 *     LLM time     = DECISION_LOOP_WORST_REQUESTS × PER_CALL_TIMEOUT_MINUTES
 *                  = 193 requests × 3 min                       = 579 min
 *     tool time    = 6 iterations × 15 rounds × 1 min tool cap  =  90 min
 *     wake         = WAKE_ALLOWANCE_MINUTES                     =  12 min
 *     worst turn                                                = 681 min
 *     backstop     = ceil(worst × MARGIN 1.2)                   = 818 min
 *
 * **It is a bound on the private tier only.** The Anthropic tier declares no
 * `request_timeout_ms` on any leaf, and Haiku carries `retry_policy Constant`
 * (3 retries), so no per-call ceiling exists there to multiply.
 *
 * **Not every term is a hard ceiling the app enforces**, and the arithmetic does
 * not pretend so. Uncounted, because nothing bounds them: a `'sequential'` tool
 * batch runs k calls per round (the 4-call cap is in the prompt only); app-side
 * Graph tools `fetch` with no signal; `SandboxScheduler.allocate` waits with no
 * timeout; and a read-only gateway reconnect re-runs a call once. The cost of
 * the backstop reaping a turn that outlives it anyway is bounded and
 * self-healing: the reap writes only `status` (and logs it, on its own line),
 * and the turn's own save overwrites it.
 *
 * **The clock is `updated_at`**, which other writes also bump
 * (`updateConversationTitle`, `promoteConversation`), so this measures time since
 * the row's last write, not strictly time at `running`.
 *
 * It tightens when a term does — the per-call ceiling, a slider bound, the
 * iteration default — with no edit here, and `stuck-run-reaper.test.ts` holds
 * each mirrored term against its declaration.
 */
const STUCK_RUN_MARGIN = 1.2
export const HUNG_TURN_BACKSTOP_MINUTES = Math.ceil(
  (DECISION_LOOP_WORST_REQUESTS * PER_CALL_TIMEOUT_MINUTES +
    DECISION_LOOP_MAX_ITERATIONS * SETTINGS_BOUNDS.maxToolTurns[1] * TOOL_CALL_TIMEOUT_MINUTES +
    WAKE_ALLOWANCE_MINUTES) *
    STUCK_RUN_MARGIN,
)

/**
 * One row the reap changed. `leaseDead: false` means the BACKSTOP fired on a
 * lease that was still being renewed — the only reap a running process will
 * later overwrite, and an anomaly (a turn alive for hours), so the caller logs
 * it apart from the ordinary dead-lease reap.
 */
export interface ReapedRun {
  id: string
  leaseDead: boolean
}

/**
 * Reconcile abandoned runs: every row at `status='running'` that either holds
 * **no live turn lease** or has sat at `running` past
 * {@link HUNG_TURN_BACKSTOP_MINUTES} becomes `'error'`. Returns the rows it
 * changed, each with which branch fired (for the caller's log and for tests).
 *
 * The rows this exists for are the ones no code path will ever finish: the
 * process died mid-turn, so the `catch` in `turn.server.ts#runAndSave` that
 * normally flips a failed row out of `running` (sf-M2/sf-M3) never ran. Such a
 * row claims to be working and is not, which is the same dishonesty the
 * app-path e2e suite exists to forbid — just at rest rather than in a turn.
 *
 * **The lease is the liveness test (#507 P2, G12 A1).** A turn renews
 * `turn_claimed_at` every {@link TURN_CLAIM_RENEW_MS} for as long as it lives;
 * {@link NO_LIVE_CLAIM} — the predicate `claimConversation` itself uses to take
 * a row over — is therefore "no turn is holding this". Reusing it means the
 * reaper and a taking-over turn cannot disagree about "dead", and no write to
 * `updated_at` (which {@link countActiveUsers} reads as activity) is needed. A
 * live long turn keeps its renewed lease and is not reaped at any age short of
 * the backstop; a dead one is reaped within one lease plus one sweep tick.
 * Both seeders of a `running` row (`createConversation`, behind the interactive
 * pre-seed and `seedActionRow`) take the claim in the INSERT, so a running row
 * with no live lease is never a turn between seed and claim. A NULL claim
 * counts as dead: that is a row seeded before the lease existed, or one whose
 * turn threw and released before any save.
 *
 * **What it is NOT is "a spinner nothing can clear"** — an earlier version of
 * this docstring said that and it was wrong (F4 on #278). A live run's spinner
 * is `session-registry`'s client-side `isProcessing` signal, per browser tab; it
 * is never seeded from the persisted status and a reload clears it whatever the
 * row says. What the reap actually buys is honest data AT REST — a
 * `kind='action'` row's badge, the row's own status wherever it is read, and a
 * conversation that no longer reports itself as running to anything that asks.
 *
 * **Multi-instance safe, and it has to be, because nothing elects a leader.**
 * Every input is in the database:
 *
 *   - both freshness tests are against the DATABASE's `NOW()`, so two app
 *     instances agree on the deadline even with skewed host clocks, and an
 *     instance that just booted judges another instance's rows correctly — it
 *     holds no memory of which turns are live, and must not;
 *   - `status = 'running'` in the WHERE clause is the claim. Postgres takes a
 *     row lock per UPDATE and re-evaluates the WHERE after the lock, so two
 *     concurrent sweeps serialize (the second no longer matches), and a turn
 *     that claims the row between the sweep's read and write makes the lease
 *     live again and is left alone — `RETURNING` reports each reaped row to
 *     exactly one sweeper and the sweep is idempotent rather than repeatable.
 *
 * **The one interleaving left** is a process that is alive but stalled past the
 * lease (a blocked event loop): it is reaped, then renews and later saves its
 * own outcome over the reap. The reap writes only `status` — never `context`,
 * `context_version` or the claim — so nothing is lost: the save lands at the
 * version the turn holds and states the truth, and a turn that was in fact
 * taken over is refused by the version as before.
 *
 * Cross-user by design (no `user_id` scope): this is a process-wide sweep, not
 * a request, and an abandoned row is abandoned whoever owns it. It reads and
 * writes only plaintext columns — `status`, `turn_claimed_at`, `updated_at`,
 * and `id` for the report — so no key is needed and no `context` blob is
 * touched. Like {@link countActiveUsers}, it lives here because this module
 * owns SQL against `conversations` (`encryption-coverage.test.ts` pins that
 * nothing else does).
 *
 * `paused` is deliberately untouched: an approval gate waits for a person, for
 * as long as that takes, and reaping one would discard resumable work.
 *
 * **`updated_at` is left alone**, which is the one place this write differs
 * from every other write in this module: it is the app's record of "this user
 * did something" ({@link countActiveUsers}, per poll, per tab), and a sweep is
 * not something the user did. It is also what the sidebar renders as "x ago",
 * where the abandonment time is the honest answer. Nothing depends on it
 * advancing here: the idempotence above comes from `status`.
 */
export async function reapStuckConversations(): Promise<ReapedRun[]> {
  // Both intervals are constants, never caller values — inlined for the same
  // reason `countActiveUsers` inlines its window (readability over
  // `make_interval` with a bound parameter).
  const { rows } = await query<{ id: string; lease_dead: boolean }>(
    `UPDATE conversations
        SET status = 'error'
      WHERE status = 'running'
        AND (${NO_LIVE_CLAIM}
             OR updated_at < NOW() - INTERVAL '${HUNG_TURN_BACKSTOP_MINUTES} minutes')
      RETURNING id, ${NO_LIVE_CLAIM} AS lease_dead`,
  )
  return rows.map((r) => ({ id: r.id, leaseDead: r.lease_dead }))
}

/**
 * List a user's conversations: pinned rows first, then newest-created first.
 *
 * Deliberately `created_at`, not `updated_at` (#105): every turn-save bumps
 * `updated_at`, so with concurrent runs an activity-ordered list reshuffles
 * on each refetch — the thread under the cursor jumps to the top. Creation
 * order is stable for a conversation's whole lifetime. `updated_at` is still
 * returned for display ("x ago" shows activity, it just doesn't sort).
 *
 * **Pinning is a third, higher key and it does not disturb that.** The sort is
 * `(pinned_at IS NULL)` — false sorts before true, so pinned rows lead —
 * then `pinned_at DESC` so the most recently pinned sits at the very top, then
 * the existing `created_at DESC` for everything else. An unpinned list is
 * byte-identical to what this returned before pinning existed, because every
 * row shares the same leading key.
 *
 * The `LIMIT` interacts with this in the one direction that matters: pinned
 * rows sort first, so a pin can never be cut off by the ceiling — which is
 * precisely what a user pins a conversation to prevent. It is the unpinned
 * tail that loses a row per pin, which is the honest trade.
 *
 * `pinned_at` is a plaintext column like the rest of the ordering inputs; only
 * `title` comes back encrypted.
 */
export async function listConversations(userId: string): Promise<ConversationListItem[]> {
  const { rows } = await query<DbListRow>(
    `SELECT id, agent_id, title, kind, source, status, inference_tier, updated_at, pinned_at
       FROM conversations
      WHERE user_id = $1
      ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC
      LIMIT 200`,
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
    pinnedAt: r.pinned_at,
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
  await deleteConversations([id], userId)
}

/**
 * Delete a batch of conversations in one round trip, scoped to the user.
 * Ids that don't exist or belong to someone else are silently skipped —
 * same contract as {@link deleteConversation}. Returns the ids actually
 * deleted so callers can patch caches from ground truth.
 */
export async function deleteConversations(ids: string[], userId: string): Promise<string[]> {
  if (ids.length === 0) return []
  // ONE transaction with the memory erase (#531, owner decision (b)): every
  // memory that ever drew on one of these conversations dies whole, and only
  // if the conversation delete commits with it. The erase runs first — the
  // `memory_sources` FK to conversations is NO ACTION, so the order is also
  // what lets the row delete through.
  return withTransaction(async (tx) => {
    // A pending memory proposal's payload is memory text the person never
    // agreed to keep (#433 S11): it leaves with the conversation it came from.
    // FIRST, and the order matters (#579 review 3, lock order): an approval's
    // item transaction takes its proposal row `FOR SHARE` and only then touches
    // `memories`, so taking the row first here means a write that has not
    // started finds no row and stops, and one that has started finishes before
    // this proceeds — instead of the two taking the same locks in opposite
    // orders and one aborting on a deadlock.
    await deleteHitlRowsForConversations(ids, userId, tx)
    await deleteMemoriesForConversations(ids, userId, tx)
    const { rows } = await tx.query<{ id: string }>(
      'DELETE FROM conversations WHERE id = ANY($1) AND user_id = $2 RETURNING id',
      [ids, userId],
    )
    return rows.map((r) => r.id)
  })
}

/**
 * Authoritative title override. Bypasses the COALESCE-sticky rule that
 * `saveConversation` applies — used by the LLM title generator
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
 * How many conversations one user may pin at once.
 *
 * The cap is a product decision, and it is enforced HERE rather than in the UI
 * because the UI is not the only caller: `setConversationPinned` is reachable
 * as a server action, so a browser can ask for a fourth pin whatever the
 * sidebar renders. The client reads this number back off a refusal (it cannot
 * import a `.server` module) instead of hard-coding its own copy.
 */
export const CONVERSATION_PIN_LIMIT = 3

/**
 * What {@link setConversationPinned} did.
 *
 *   'pinned'      — the row is pinned (including the idempotent case: it
 *                   already was, and its original `pinned_at` is preserved so
 *                   a repeat call cannot silently reorder the pinned block).
 *   'unpinned'    — the row is no longer pinned.
 *   'cap_reached' — refused: the user already holds
 *                   {@link CONVERSATION_PIN_LIMIT} pins.
 *   'not_found'   — no such row for this user. Same wrong-user contract as
 *                   every other write here: a foreign id is indistinguishable
 *                   from an absent one, on purpose.
 */
export type PinOutcome = 'pinned' | 'unpinned' | 'cap_reached' | 'not_found'

/**
 * Pin or unpin a conversation, scoped to its owner.
 *
 * **The cap is counted and applied in one statement.** The count is a subquery
 * of the same UPDATE, so no caller can read a count and then act on it after it
 * has gone stale, and `user_id` appears in both halves — a user's pins are
 * counted against their own rows only, and a foreign id no-ops rather than
 * pinning someone else's conversation.
 *
 * **The residual race, named rather than assumed away:** two pins issued for
 * the same user close enough to overlap (two browser tabs, one click each) both
 * take their snapshot before either commits, so both can see `n = 2` and both
 * succeed — leaving four pinned rows. Closing it needs the count and the write
 * in one explicit transaction, and `query()` deliberately exposes no
 * transaction seam (it takes opaque SQL and runs it on a pooled connection);
 * adding one for a sidebar cap is a bigger change than the defect. The
 * overshoot is at most one row per race, costs nothing but a longer pinned
 * block, is visible to the user, and is undone by unpinning. It is a fail-OPEN
 * cap under concurrency and a hard one otherwise. If that trade stops being
 * acceptable, the fix is a transaction here, not a check in the UI.
 *
 * **`updated_at` is deliberately not bumped**, for the same two reasons
 * {@link reapStuckConversations} leaves it alone: it is the app's record of
 * "this user did something" ({@link countActiveUsers} reads exactly that), and
 * it is what the sidebar renders as "x ago" for the CONVERSATION. Pinning is a
 * statement about the list, not about the thread, and bumping it would report
 * every pinned conversation as freshly active. Nothing depends on it moving —
 * the list's pinned ordering reads `pinned_at`.
 */
export async function setConversationPinned(
  id: string,
  userId: string,
  pinned: boolean,
): Promise<PinOutcome> {
  if (!pinned) {
    const { rows } = await query<{ id: string }>(
      `UPDATE conversations SET pinned_at = NULL
        WHERE id = $1 AND user_id = $2 AND pinned_at IS NOT NULL
       RETURNING id`,
      [id, userId],
    )
    // Nothing matched: either the row is not this user's, or it was already
    // unpinned. The second is the caller's goal, so it is reported as success —
    // only a genuinely absent row is 'not_found'.
    if (rows.length > 0) return 'unpinned'
    return (await getOwnedConversationExists(id, userId)) ? 'unpinned' : 'not_found'
  }

  const { rows } = await query<{
    pin_count: string | number
    found: string | number
    previously_pinned_at: Date | null
    new_pinned_at: Date | null
  }>(
    `WITH pinned AS (
       SELECT COUNT(*) AS n FROM conversations
        WHERE user_id = $2 AND pinned_at IS NOT NULL
     ),
     target AS (
       SELECT pinned_at FROM conversations WHERE id = $1 AND user_id = $2
     ),
     promoted AS (
       UPDATE conversations SET pinned_at = NOW()
        WHERE id = $1 AND user_id = $2 AND pinned_at IS NULL
          AND (SELECT n FROM pinned) < $3
       RETURNING pinned_at
     )
     SELECT (SELECT n FROM pinned)               AS pin_count,
            (SELECT COUNT(*) FROM target)        AS found,
            (SELECT pinned_at FROM target)       AS previously_pinned_at,
            (SELECT pinned_at FROM promoted)     AS new_pinned_at`,
    [id, userId, CONVERSATION_PIN_LIMIT],
  )
  const row = rows[0]
  if (!row) return 'not_found'
  if (row.new_pinned_at !== null) return 'pinned'
  // Already pinned before this call — idempotent success, and it does NOT
  // rewrite `pinned_at`, so re-pinning cannot jump a row to the top of the
  // pinned block.
  if (row.previously_pinned_at !== null) return 'pinned'
  if (Number(row.found) === 0) return 'not_found'
  return 'cap_reached'
}

/** Does this id name a row this user owns? Used only to tell an already-unpinned
 *  row (success) from a foreign or absent one (`not_found`). Reads no content. */
async function getOwnedConversationExists(id: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
    [id, userId],
  )
  return rows.length > 0
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
// Share by link
// ============================================================================

/**
 * Bytes of entropy in a share token. 32 → 256 bits, base64url-encoded to 43
 * characters.
 *
 * The token is the ONLY thing standing between an anonymous request and a
 * decrypted conversation, so it is sized as an authenticator rather than as an
 * id: it must survive being pasted into a chat, a bookmark bar and a browser
 * history without becoming guessable by anyone who has seen a different one.
 * A conversation id would have been the convenient choice and is exactly the
 * wrong one — since URLs now carry ids (`?c=…`), an id that also granted access
 * would make every bookmark a share.
 */
const SHARE_TOKEN_BYTES = 32

/**
 * The shape `SHARE_TOKEN_BYTES` of base64url produces, as a whole-string match.
 *
 * Used to reject a malformed token BEFORE it reaches the index probe. Not a
 * security control — the unique index and the token's own entropy are that —
 * but it keeps arbitrary browser-supplied text out of a query, and it makes the
 * "unknown token" answer identical for garbage and for a revoked share.
 */
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** A conversation reached by share token: content, and nothing that identifies
 *  its owner. `user_id` is deliberately absent from the projection — no caller
 *  on the public path has any use for it, and a field that is never selected
 *  cannot be returned by accident. */
export interface SharedConversationRow {
  id: string
  title: string | null
  serializedContext: string
  sharedAt: Date
}

/**
 * Make a conversation public-with-link, or return the link it already has.
 *
 * Owner-scoped like every other write here: a wrong `userId` matches no row and
 * returns `null` rather than minting anything.
 *
 * **Sharing twice returns the SAME token** (`COALESCE`), which is the point of
 * the whole function being an upsert rather than an assignment. The owner
 * re-opens the dialog to copy a link they already sent; rotating on every open
 * would silently break the copy they sent yesterday. Rotation happens on the
 * one action that means it — {@link unshareConversation}, after which a fresh
 * {@link shareConversation} mints a new value and the revoked one stays dead.
 *
 * **`updated_at` is left alone**, for {@link reapStuckConversations}' reason:
 * the column is the app's record of *chat* activity — `countActiveUsers` reads
 * exactly that, and the sidebar renders it as "x ago". Sharing is not a turn,
 * and bumping it would reorder a sidebar and inflate an active-user count for
 * an action that added no content. `shared_at` records when the share began,
 * which is the thing that actually happened.
 */
export async function shareConversation(id: string, userId: string): Promise<string | null> {
  const minted = randomBytes(SHARE_TOKEN_BYTES).toString('base64url')
  const { rows } = await query<{ share_token: string }>(
    `UPDATE conversations
        SET share_token = COALESCE(share_token, $1),
            shared_at   = COALESCE(shared_at, NOW())
      WHERE id = $2 AND user_id = $3
      RETURNING share_token`,
    [minted, id, userId],
  )
  return rows.length > 0 ? rows[0].share_token : null
}

/**
 * Revoke a share. The token is cleared, so the link that carried it stops
 * resolving immediately and permanently — nothing anywhere else records it, and
 * a later re-share mints a value unrelated to the revoked one.
 *
 * Owner-scoped; a wrong `userId` silently no-ops, the same contract as
 * {@link deleteConversation}.
 */
export async function unshareConversation(id: string, userId: string): Promise<void> {
  await query(
    `UPDATE conversations SET share_token = NULL, shared_at = NULL
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
}

/**
 * The share token a conversation currently has, for its OWNER.
 *
 * `null` covers three states on purpose — not shared, not yours, not there —
 * because the only caller is the owner's own share dialog, where the last two
 * are unreachable, and conflating them costs the caller nothing while keeping
 * this from becoming a probe for whether an id exists.
 */
export async function getShareToken(id: string, userId: string): Promise<string | null> {
  const { rows } = await query<{ share_token: string | null }>(
    'SELECT share_token FROM conversations WHERE id = $1 AND user_id = $2',
    [id, userId],
  )
  return rows.length > 0 ? rows[0].share_token : null
}

/**
 * Load a conversation by share token — the ONE read in this module that is not
 * scoped to an owner, because on this path the token *is* the authorization.
 *
 * `null` for an unknown token, a revoked token and a malformed one alike: the
 * caller cannot tell "never existed" from "was shared and is not any more",
 * which is what keeps the public route's answer a 404 rather than a 403 that
 * confirms a conversation is there.
 *
 * It selects content and `shared_at`, never `user_id`, `agent_id`, `kind`,
 * `source` or `status` — see {@link SharedConversationRow}. What the *viewer*
 * gets is narrowed once more above this, in the public `'use server'` module.
 */
export async function loadSharedConversation(token: string): Promise<SharedConversationRow | null> {
  if (!SHARE_TOKEN_SHAPE.test(token)) return null
  const { rows } = await query<{
    id: string
    title: string | null
    context: unknown
    shared_at: Date
  }>('SELECT id, title, context, shared_at FROM conversations WHERE share_token = $1', [token])
  if (rows.length === 0) return null
  return {
    id: rows[0].id,
    title: decryptFieldOrNull(rows[0].title, 'conversations.title'),
    serializedContext: decryptJsonb(rows[0].context, 'conversations.context'),
    sharedAt: rows[0].shared_at,
  }
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
