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
import { query } from './client.server'

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
        AND (payload IS NOT NULL OR status IN ('pending', 'answered'))`,
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
