/**
 * HITL transport — Server Only.
 *
 * SQL for the two tables a human-in-the-loop decision needs beside the
 * conversation blob (#433 S7): `hitl_requests` (the answer in transit, the
 * proposal payloads, the inbox index) and `hitl_quarantine` (the held file of
 * an un-decided provenance request, F2). This module is the ONE place
 * production code runs SQL against them — `encryption-coverage.test.ts` pins
 * that, and pins that both tables' content columns are encrypted here.
 *
 * NEVER AUTHORITATIVE (ADR-0009): the decision state is the blob's `hitl_*`
 * events. `readHitl(blob).pending` is what a resume validates answers
 * against; a row here whose request is not pending is closed `superseded`, and
 * nothing in this module decides a resume.
 *
 * Owner scope on every statement, like every repository here: a foreign id is
 * a no-op, never a probe for whether an id exists.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { decryptFieldOrNull, encryptFieldOrNull } from './crypto.server'
import { query, withTransaction, type TxQuery } from './client.server'

assertServerOnImport()

/** One answer as a person chose it — the only shape the client may supply
 *  (#433 F4: no principal, no resolution; those are host-stamped). */
export interface HitlAnswerValue {
  readonly choice: string
  readonly flags?: Readonly<Record<string, boolean>>
}

/** The decoded `answer` column of one row. */
export type StoredAnswer = { choice: string; flags?: Record<string, boolean> }

/** One answer row, as a resume or the inbox reads it. */
export interface HitlRequestRow {
  readonly requestId: string
  readonly sessionId: string
  readonly kind: string
  readonly status: string
  readonly blocksRun: boolean
  readonly expiresAt: Date | null
  readonly answeredAt: Date | null
  readonly answer: StoredAnswer | null
  /** Present only while the request is open (F20b: purged on close). */
  readonly payload: unknown
}

/** The quarantined content of one held request. */
export interface QuarantineRow {
  readonly requestId: string
  readonly sessionId: string
  readonly expiresAt: Date
  /** The raw file, base64. */
  readonly rawFile: string | null
  /** The tier-0 copy, without the disclaimer. */
  readonly tier0Copy: string | null
  /** The sanitize report's findings, held with the payload until the
   *  decision (F20a) — never on the event, never in a prompt (SD-3). */
  readonly findings: unknown
  /** The sender's FULL address (C2); the stored summary and the disclaimer
   *  carry the domain only. Deleted with the row. */
  readonly senderAddress: string | null
}

/** Is `value` a client-suppliable answer and nothing else? F4 in one place:
 *  a string choice, or `{ choice, flags? }` with boolean flag values and NO
 *  other property — a smuggled `principal` or `resolution` is refused here, at
 *  the trust boundary, before it is recorded anywhere. */
export function isAnswerShape(value: unknown): value is string | HitlAnswerValue {
  if (typeof value === 'string') return true
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value)
  if (keys.some((k) => k !== 'choice' && k !== 'flags')) return false
  const v = value as Record<string, unknown>
  if (typeof v.choice !== 'string') return false
  if (v.flags === undefined) return true
  if (typeof v.flags !== 'object' || v.flags === null) return false
  return Object.values(v.flags).every((f) => typeof f === 'boolean')
}

/** Normalize either form to the stored `{ choice, flags? }`. */
function toStoredAnswer(value: string | HitlAnswerValue): StoredAnswer {
  const answer: StoredAnswer =
    typeof value === 'string' ? { choice: value } : { choice: value.choice }
  if (typeof value !== 'string' && value.flags !== undefined) {
    answer.flags = { ...value.flags }
  }
  return answer
}

/** The `hitl_requests.answer` / `.payload` columns are TEXT envelopes of JSON
 *  (`payload` may hold any JSON value, `null` included). */
function encryptJson(value: unknown): string | null {
  return encryptFieldOrNull(JSON.stringify(value ?? null))
}

function decryptJson(stored: string | null, where: string): unknown {
  const plain = decryptFieldOrNull(stored, where)
  if (plain === null) return null
  try {
    return JSON.parse(plain)
  } catch {
    // An answer column that will not parse is damage, not a legacy shape:
    // fail loudly rather than serve an answer nobody chose.
    throw new Error(`[hitl] the stored ${where} is not readable JSON`)
  }
}

/**
 * Record one answer (the ANSWER RPC's write, and nothing else). First answer
 * wins: an existing row is updated only while it is still `pending` (a
 * proposal awaiting its person), so a second answer to a request that already
 * has one — a double submit, a replayed form — changes nothing and returns
 * `false`. Never touches the conversation blob.
 */
export async function recordHitlAnswer(input: {
  readonly requestId: string
  readonly userId: string
  readonly sessionId: string
  readonly kind: string
  readonly runId: string | null
  readonly blocksRun: boolean
  readonly expiresAt: Date | null
  readonly answer: string | HitlAnswerValue
}): Promise<boolean> {
  const answer = toStoredAnswer(input.answer)
  const { rowCount } = await query(
    `INSERT INTO hitl_requests
       (request_id, user_id, session_id, run_id, kind, status, blocks_run,
        expires_at, answered_at, answer)
     VALUES ($1, $2, $3, $4, $5, 'answered', $6, $7, NOW(), $8)
     ON CONFLICT (request_id) DO UPDATE
       SET status = 'answered', answered_at = NOW(), answer = EXCLUDED.answer,
           updated_at = NOW()
       WHERE hitl_requests.status = 'pending'
         AND hitl_requests.user_id = EXCLUDED.user_id
         AND hitl_requests.session_id = EXCLUDED.session_id`,
    [
      input.requestId,
      input.userId,
      input.sessionId,
      input.runId,
      input.kind,
      input.blocksRun,
      input.expiresAt,
      encryptFieldOrNull(JSON.stringify(answer)),
    ],
  )
  return (rowCount ?? 0) > 0
}

/**
 * The session's answer rows still in transit — recorded, not yet consumed by
 * a resume. The inbox reads the same table; a resume filters these against
 * `readHitl(blob).pending` before using them.
 */
export async function loadHitlAnswerRows(
  sessionId: string,
  userId: string,
): Promise<HitlRequestRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT request_id, session_id, kind, status, blocks_run, expires_at,
            answered_at, answer, payload
       FROM hitl_requests
      WHERE session_id = $1 AND user_id = $2 AND status = 'answered'`,
    [sessionId, userId],
  )
  return rows.map((r) => ({
    requestId: r.request_id as string,
    sessionId: r.session_id as string,
    kind: r.kind as string,
    status: r.status as string,
    blocksRun: r.blocks_run === true,
    expiresAt: (r.expires_at as Date | null) ?? null,
    answeredAt: (r.answered_at as Date | null) ?? null,
    answer:
      (decryptJson(r.answer as string | null, 'hitl_requests.answer') as StoredAnswer | null) ??
      null,
    payload: decryptJson(r.payload as string | null, 'hitl_requests.payload'),
  }))
}

/**
 * Close answer rows: mark them and DELETE THEIR PAYLOAD (F20b). Called by the
 * resume — `applied` for answers a resume consumed, `superseded` for answers
 * whose request was superseded or expired before they landed, `expired` when
 * nobody answered in time. The answer itself stays on `applied` rows for
 * audit; on every close the payload — the personal data the request carried —
 * is gone.
 */
export async function closeHitlRows(
  requestIds: readonly string[],
  userId: string,
  status: 'applied' | 'superseded' | 'expired',
): Promise<number> {
  if (requestIds.length === 0) return 0
  const { rowCount } = await query(
    `UPDATE hitl_requests
        SET status = $3, payload = NULL, updated_at = NOW()
      WHERE user_id = $1 AND request_id = ANY($2)`,
    [userId, [...requestIds], status],
  )
  return rowCount ?? 0
}

// ============================================================================
// Proposals (#433 S11, #419 M6)
// ============================================================================
//
// A proposal's payload — the memory text a person has not yet agreed to keep —
// waits here, encrypted, under its request id. It is NEVER authoritative: the
// proposal is two events in the conversation blob (ADR-0009), and the RPC that
// lists or applies one derives that from the blob first. A row with no open
// proposal in the blob is simply never offered.

/** One open proposal's row, decoded. */
export interface HitlProposalRow {
  readonly requestId: string
  readonly sessionId: string
  readonly kind: string
  readonly expiresAt: Date | null
  /** The payload the proposing hook held; `null` once purged. Untyped here —
   *  the memory module parses it (`parseMemoryProposalPayload`). */
  readonly payload: unknown
  /** `answering`: a person's answer is BOUND (first answer wins, before any
   *  write) and its effects are not all recorded yet; only a retry of that same
   *  answer may finish it. */
  readonly status: 'pending' | 'answering'
  /** The bound answer while `answering`. */
  readonly answer: StoredAnswer | null
}

/**
 * Hold a proposal's payload under its request id, `pending`. The row's owner is
 * the caller's; an existing row of the same id is left alone (`DO NOTHING`):
 * request ids are fresh UUIDs, so a conflict is a bug or a replay, and a replay
 * must not swap the payload a person is about to approve.
 */
export async function putHitlProposal(input: {
  readonly requestId: string
  readonly userId: string
  readonly sessionId: string
  readonly kind: string
  readonly runId: string | null
  readonly expiresAt: Date
  readonly payload: unknown
}): Promise<void> {
  // Only while the user's memory switch is ON, decided by the INSERT itself: a
  // switch-off plus erase that lands between the hook's own check and this hold
  // must not leave a readable proposal behind (#579 review 1). Zero rows is a
  // refusal either way, so the hook takes its request back.
  const { rowCount } = await query(
    `INSERT INTO hitl_requests
       (request_id, user_id, session_id, run_id, kind, status, blocks_run, expires_at, payload)
     SELECT $1, $2, $3, $4, $5, 'pending', FALSE, $6, $7
      WHERE EXISTS (SELECT 1 FROM user_prefs WHERE user_id = $2 AND memory_enabled)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      input.requestId,
      input.userId,
      input.sessionId,
      input.runId,
      input.kind,
      input.expiresAt,
      encryptJson(input.payload),
    ],
  )
  if (!rowCount) {
    throw new Error(
      '[hitl] the proposal was not held: its request id is already held, or memory is off',
    )
  }
}

/**
 * One OPEN proposal of the caller's: `pending`, not past `expires_at`, with its
 * payload still held. Owner-scoped, so someone else's request id is the same
 * `null` as an unknown one.
 */
export async function getHitlProposal(
  requestId: string,
  userId: string,
): Promise<HitlProposalRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT request_id, session_id, kind, expires_at, payload, status, answer
       FROM hitl_requests
      WHERE request_id = $1 AND user_id = $2 AND status IN ('pending', 'answering')
        AND blocks_run = FALSE AND payload IS NOT NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [requestId, userId],
  )
  return rows.length === 0 ? null : toProposalRow(rows[0])
}

/** The caller's open proposals of one kind in one conversation, oldest first. */
export async function listHitlProposals(
  sessionId: string,
  userId: string,
  kind: string,
): Promise<HitlProposalRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT request_id, session_id, kind, expires_at, payload, status, answer
       FROM hitl_requests
      WHERE session_id = $1 AND user_id = $2 AND kind = $3 AND status IN ('pending', 'answering')
        AND blocks_run = FALSE AND payload IS NOT NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at, request_id`,
    [sessionId, userId, kind],
  )
  return rows.map(toProposalRow)
}

function toProposalRow(r: Record<string, unknown>): HitlProposalRow {
  return {
    requestId: r.request_id as string,
    sessionId: r.session_id as string,
    kind: r.kind as string,
    expiresAt: (r.expires_at as Date | null) ?? null,
    payload: decryptJson(r.payload as string | null, 'hitl_requests.payload'),
    status: r.status === 'answering' ? 'answering' : 'pending',
    answer:
      (decryptJson(r.answer as string | null, 'hitl_requests.answer') as StoredAnswer | null) ??
      null,
  }
}

/** Canonical form of an answer, so "the same answer" is a byte comparison:
 *  the choice, and the flags with their keys sorted. */
export function canonicalAnswer(a: StoredAnswer): string {
  return JSON.stringify({
    choice: a.choice,
    flags: Object.fromEntries(Object.entries(a.flags ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))),
  })
}

/**
 * Bind the person's answer to a proposal BEFORE anything is written (#579
 * review 2): first answer wins on the row, the primitive `recordHitlAnswer` uses
 * for blocking requests. `pending → answering` in one fenced statement.
 *
 * - `claimed: true` — this answer is now THE answer; the caller writes and saves.
 * - `claimed: false` — someone answered first. `recorded` is what they chose; the
 *   caller continues only for a byte-equal retry and refuses anything else.
 *
 * Nothing about the conversation blob here: the row decides who answered first,
 * the blob is still the record of the outcome (ADR-0009).
 */
export async function claimHitlProposalAnswer(input: {
  readonly requestId: string
  readonly userId: string
  readonly sessionId: string
  readonly kind: string
  readonly answer: StoredAnswer
}): Promise<{ claimed: true } | { claimed: false; recorded: StoredAnswer | null }> {
  const { rowCount } = await query(
    `UPDATE hitl_requests
        SET status = 'answering', answer = $5, answered_at = NOW(), updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND session_id = $3 AND kind = $4
        AND status = 'pending' AND blocks_run = FALSE`,
    [
      input.requestId,
      input.userId,
      input.sessionId,
      input.kind,
      encryptFieldOrNull(JSON.stringify(input.answer)),
    ],
  )
  if ((rowCount ?? 0) > 0) return { claimed: true }
  const { rows } = await query<{ answer: string | null }>(
    `SELECT answer FROM hitl_requests
      WHERE request_id = $1 AND user_id = $2 AND session_id = $3 AND status = 'answering'`,
    [input.requestId, input.userId, input.sessionId],
  )
  return {
    claimed: false,
    recorded:
      rows.length === 0
        ? null
        : (decryptJson(rows[0].answer, 'hitl_requests.answer') as StoredAnswer | null),
  }
}

/**
 * Give a bound answer back (`answering → pending`) ONLY when nothing is written
 * under it, so a refusal before any write (memory switched off, payload
 * unusable, a failed first write) does not turn "Don't save" into
 * `already-answered` (#579 review 2a).
 *
 * "Nothing is written" is decided HERE, by the database, never from one
 * attempt's report: an earlier attempt of the same answer (the retry after a
 * refused save), or a concurrent one, may already have written. One proposal is
 * exactly one `event_id` (the user message it was built from), and
 * `(user_id, event_id, ordinal)` is `memory_sources`' primary key, so a row for
 * that event IS a write under this proposal.
 *
 * Two statements in one transaction, on purpose. The first takes the row lock:
 * a write transaction that re-checked the binding holds it `FOR SHARE` until it
 * commits, so this waits for it. The second then runs with a FRESH statement
 * snapshot, so its `NOT EXISTS` sees what that write committed — a single
 * `UPDATE … WHERE NOT EXISTS` would keep the snapshot it started with across the
 * lock wait and could not.
 *
 * Returns whether the answer was given back.
 */
export async function releaseHitlProposalAnswer(
  requestId: string,
  userId: string,
  eventId: string,
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT 1 FROM hitl_requests
        WHERE request_id = $1 AND user_id = $2 AND status = 'answering'
          FOR UPDATE`,
      [requestId, userId],
    )
    if (rows.length === 0) return false
    const { rowCount } = await tx.query(
      `UPDATE hitl_requests
          SET status = 'pending', answer = NULL, answered_at = NULL, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND status = 'answering'
          AND NOT EXISTS (SELECT 1 FROM memory_sources WHERE user_id = $2 AND event_id = $3)`,
      [requestId, userId, eventId],
    )
    return (rowCount ?? 0) > 0
  })
}

/**
 * Inside a memory write transaction, BEFORE the item is written: the proposal is
 * still bound (`answering`), and hold the row `FOR SHARE` until the transaction
 * ends. A release (above) therefore either ran first — and this throws, so
 * nothing is written under a released answer — or waits for this write to
 * commit and then sees it (#579 review 2a, D3: two concurrent submits).
 */
export async function requireAnsweringBinding(
  tx: TxQuery,
  requestId: string,
  userId: string,
): Promise<void> {
  const { rows } = await tx.query(
    `SELECT 1 FROM hitl_requests
      WHERE request_id = $1 AND user_id = $2 AND status = 'answering'
        FOR SHARE`,
    [requestId, userId],
  )
  if (rows.length === 0) throw new Error('[hitl] the proposal answer is no longer bound')
}

/**
 * Erase every proposal row of the given conversations — the conversation
 * delete's half (it runs in that delete's transaction, so the two commit
 * together). A proposal's payload is memory text the person never agreed to
 * keep; deleting the conversation it came from must take it too.
 */
export async function deleteHitlRowsForConversations(
  conversationIds: readonly string[],
  userId: string,
  tx: TxQuery,
): Promise<void> {
  if (conversationIds.length === 0) return
  await tx.query(`DELETE FROM hitl_requests WHERE user_id = $1 AND session_id = ANY($2)`, [
    userId,
    [...conversationIds],
  ])
}

/**
 * Erase every pending proposal of one kind for a user — "forget everything"'s
 * half. Takes a `userId`, so it is NEVER a `'use server'` export (SD-13): the
 * RPC that reaches it passed its own `requireUser()` first.
 */
export async function deleteHitlProposalsForUser(userId: string, kind: string): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM hitl_requests WHERE user_id = $1 AND kind = $2 AND blocks_run = FALSE`,
    [userId, kind],
  )
  return rowCount ?? 0
}

// ============================================================================
// The quarantine (F2)
// ============================================================================

/** Hold one request's content for its decision. Replaces any row the request
 *  already holds — the row is the payload, and a re-raise re-quarantines. */
export async function putQuarantine(input: {
  readonly requestId: string
  readonly userId: string
  readonly sessionId: string
  readonly expiresAt: Date
  readonly rawFile?: string
  readonly tier0Copy?: string
  readonly findings?: unknown
  readonly senderAddress?: string
}): Promise<void> {
  await query(
    `INSERT INTO hitl_quarantine
       (request_id, user_id, session_id, expires_at, raw_file, tier0_copy,
        findings, sender_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (request_id) DO UPDATE
       SET expires_at = EXCLUDED.expires_at,
           raw_file = EXCLUDED.raw_file,
           tier0_copy = EXCLUDED.tier0_copy,
           findings = EXCLUDED.findings,
           sender_address = EXCLUDED.sender_address`,
    [
      input.requestId,
      input.userId,
      input.sessionId,
      input.expiresAt,
      encryptFieldOrNull(input.rawFile ?? null),
      encryptFieldOrNull(input.tier0Copy ?? null),
      encryptJson(input.findings ?? null),
      encryptFieldOrNull(input.senderAddress ?? null),
    ],
  )
}

/** One request's held content, or null (never held, already decided, expired
 *  and swept, or someone else's). */
export async function getQuarantine(
  requestId: string,
  userId: string,
): Promise<QuarantineRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT request_id, session_id, expires_at, raw_file, tier0_copy, findings,
            sender_address
       FROM hitl_quarantine
      WHERE request_id = $1 AND user_id = $2`,
    [requestId, userId],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    requestId: r.request_id as string,
    sessionId: r.session_id as string,
    expiresAt: r.expires_at as Date,
    rawFile: decryptFieldOrNull(r.raw_file as string | null, 'hitl_quarantine.raw_file'),
    tier0Copy: decryptFieldOrNull(r.tier0_copy as string | null, 'hitl_quarantine.tier0_copy'),
    findings: decryptJson(r.findings as string | null, 'hitl_quarantine.findings'),
    senderAddress: decryptFieldOrNull(
      r.sender_address as string | null,
      'hitl_quarantine.sender_address',
    ),
  }
}

/**
 * Drop one request's held content — the resume `resolve`'s side effect, and
 * the answer to Sanitize/Remove having taken its copy out. Idempotent (the
 * Δ4 rule): a retried resume drops an already-dropped row and nothing else.
 */
export async function deleteQuarantine(requestId: string, userId: string): Promise<void> {
  await query(`DELETE FROM hitl_quarantine WHERE request_id = $1 AND user_id = $2`, [
    requestId,
    userId,
  ])
}

// ============================================================================
// The expiry sweep
// ============================================================================

/** How often the sweep runs. A cadence, not a lifetime (the session sweep's
 *  rule): rows are due at `expires_at`; this only decides how promptly the
 *  due ones leave. */
export const HITL_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * One sweep (test entry point; the timer calls the same function):
 *
 * - the quarantine's expired rows are DELETED whole — the row is the payload,
 *   and an expired request can only resolve to "not kept";
 * - expired `hitl_requests` rows lose their payload and close `expired`
 *   (`pending` proposals and `answered`-in-transit rows alike).
 *
 * The blob's own expiry (the closing events) is `expireHitl`, lazily, by the
 * host on read — this sweep touches no conversation row.
 */
export async function sweepExpiredHitl(): Promise<{ quarantine: number; payloads: number }> {
  const gone = await query(`DELETE FROM hitl_quarantine WHERE expires_at <= NOW()`)
  const purged = await query(
    `UPDATE hitl_requests
        SET payload = NULL, status = 'expired', updated_at = NOW()
      WHERE expires_at <= NOW()
        AND (payload IS NOT NULL OR status IN ('pending', 'answering', 'answered'))`,
  )
  return { quarantine: gone.rowCount ?? 0, payloads: purged.rowCount ?? 0 }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

async function sweepOnce(): Promise<void> {
  try {
    const { quarantine, payloads } = await sweepExpiredHitl()
    if (quarantine > 0 || payloads > 0) {
      console.log(
        `[hitl] expiry sweep dropped ${quarantine} quarantined document(s) and ` +
          `purged ${payloads} expired request payload(s)`,
      )
    }
  } catch (err) {
    console.warn('[hitl] expiry sweep failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Arm the periodic expiry sweep. Idempotent (a second call is a no-op, so dev
 * HMR re-running this module can't stack timers) and `unref()`'d, so it never
 * keeps the process alive on its own — the session sweep's shape (#129). Also
 * sweeps once immediately, so a restart clears the backlog.
 *
 * Armed from the schema init, beside the encryption backfill: the tables are
 * created there, and a sweep nobody arms is a row that outlives its `expires_at`
 * — the exact SD-11 gap F20b closes.
 */
export function startHitlSweepTimer(intervalMs: number = HITL_SWEEP_INTERVAL_MS): void {
  if (sweepTimer) return
  const timer = setInterval(() => {
    void sweepOnce()
  }, intervalMs)
  timer.unref?.()
  sweepTimer = timer
  void sweepOnce()
}

/** Stop the sweep (test teardown / shutdown). Idempotent. */
export function stopHitlSweepTimer(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
