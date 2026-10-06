/**
 * Round-trip and purge tests for the HITL transport tables (#433 S7): the
 * answer rows and the quarantine.
 *
 * Hits the live Postgres from docker-compose (same posture as
 * `session-claims.test.ts`) and skips when it is unreachable — the points
 * under test are first-answer-wins on a real conflict path, the payload purge
 * (F20b/A8) and the expiry sweep (F2), none of which a mock can demonstrate.
 *
 * At-rest encryption is asserted here too (A1): the answer, the payload and
 * every quarantine content column must be envelopes in the row, not
 * plaintext — the migration/boot-gate side of the same guarantee is
 * `encryption-coverage.test.ts`'s.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  recordHitlAnswer,
  loadHitlAnswerRows,
  closeHitlRows,
  putQuarantine,
  getQuarantine,
  deleteQuarantine,
  sweepExpiredHitl,
  stopHitlSweepTimer,
} from '../../../lib/db/hitl.server'
import { closePool, query } from '../../../lib/db/client.server'
import { looksEncrypted } from '../../../lib/db/crypto.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const sid = (name: string) => `test-hitl-${name}-${SUFFIX}`
const rid = (name: string) => `req-${name}-${SUFFIX}`

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[hitl.test] Postgres unreachable, skipping:', err)
  }
  // The schema init arms the expiry sweep; a 1-hour timer is unref'd, but the
  // immediate first sweep it fires is part of THIS process and races nothing —
  // stop it so its log line cannot interleave with a deliberate sweep below.
  stopHitlSweepTimer()
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM hitl_requests WHERE session_id LIKE $1', [`test-hitl-%-${SUFFIX}`])
  await query('DELETE FROM hitl_quarantine WHERE session_id LIKE $1', [`test-hitl-%-${SUFFIX}`])
  await closePool()
})

describe('answer rows', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('records an answer, reads it back decrypted, and stores it as ciphertext', async () => {
    expect(
      await recordHitlAnswer({
        requestId: rid('rt'),
        userId: 'alice',
        sessionId: sid('rt'),
        kind: 'confirm',
        runId: 'run-1',
        blocksRun: true,
        expiresAt: new Date(Date.now() + 60_000),
        answer: { choice: 'approve', flags: { verbose: true } },
      }),
    ).toBe(true)

    const rows = await loadHitlAnswerRows(sid('rt'), 'alice')
    expect(rows).toHaveLength(1)
    expect(rows[0].answer).toEqual({ choice: 'approve', flags: { verbose: true } })
    expect(rows[0].kind).toBe('confirm')
    expect(rows[0].status).toBe('answered')

    // A1's at-rest half: the answer column holds an envelope, not the choice.
    const { rows: raw } = await query<{ answer: string | null }>(
      'SELECT answer FROM hitl_requests WHERE request_id = $1',
      [rid('rt')],
    )
    expect(raw[0].answer).not.toBeNull()
    expect(looksEncrypted(raw[0].answer)).toBe(true)
    expect(raw[0].answer).not.toContain('approve')
  })

  it('first answer wins: a second answer changes nothing and reports it', async () => {
    const base = {
      userId: 'alice',
      sessionId: sid('first'),
      kind: 'confirm',
      runId: 'run-1',
      blocksRun: true,
      expiresAt: null,
    }
    expect(await recordHitlAnswer({ ...base, requestId: rid('first'), answer: 'approve' })).toBe(
      true,
    )
    // A double submit, a replayed form — same request, a second answer.
    expect(await recordHitlAnswer({ ...base, requestId: rid('first'), answer: 'reject' })).toBe(
      false,
    )
    expect((await loadHitlAnswerRows(sid('first'), 'alice'))[0].answer).toEqual({
      choice: 'approve',
    })
  })

  it('never updates a pending row the caller does not own: the conflict is fenced', async () => {
    // A proposal row (S11's shape): pending, belonging to alice and HER session.
    await query(
      `INSERT INTO hitl_requests (request_id, user_id, session_id, kind, status)
       VALUES ($1, 'alice', $2, 'memory.confirm', 'pending')`,
      [rid('fenced'), sid('owned')],
    )
    // Another user names the same request id on their own session: the
    // conflict matches, the fence does not — nothing is written, so one
    // user's answer can never decide another user's request.
    expect(
      await recordHitlAnswer({
        requestId: rid('fenced'),
        userId: 'mallory',
        sessionId: sid('mallory-session'),
        kind: 'memory.confirm',
        runId: 'run-1',
        blocksRun: false,
        expiresAt: null,
        answer: 'save',
      }),
    ).toBe(false)
    // The owner's answer is the one that lands.
    expect(
      await recordHitlAnswer({
        requestId: rid('fenced'),
        userId: 'alice',
        sessionId: sid('owned'),
        kind: 'memory.confirm',
        runId: 'run-1',
        blocksRun: false,
        expiresAt: null,
        answer: 'save',
      }),
    ).toBe(true)
    const { rows } = await query<{ user_id: string; status: string }>(
      'SELECT user_id, status FROM hitl_requests WHERE request_id = $1',
      [rid('fenced')],
    )
    expect(rows[0]).toEqual({ user_id: 'alice', status: 'answered' })
  })

  it('is owner-scoped: another user reads none of it', async () => {
    await recordHitlAnswer({
      requestId: rid('scope'),
      userId: 'alice',
      sessionId: sid('scope'),
      kind: 'confirm',
      runId: 'run-1',
      blocksRun: true,
      expiresAt: null,
      answer: 'approve',
    })
    expect(await loadHitlAnswerRows(sid('scope'), 'mallory')).toHaveLength(0)
  })

  it('closing rows flips the status and deletes the payload (A8)', async () => {
    await recordHitlAnswer({
      requestId: rid('purge'),
      userId: 'alice',
      sessionId: sid('purge'),
      kind: 'provenance',
      runId: 'run-1',
      blocksRun: true,
      expiresAt: new Date(Date.now() + 60_000),
      answer: { choice: 'remove', flags: { markInjected: true } },
    })
    // The proposal payload the request carried, in transit with the answer.
    // Written via SQL directly — the purge is what is under test, not the
    // write path — and plainly, so the assertion can see the column emptied.
    await query('UPDATE hitl_requests SET payload = $1 WHERE request_id = $2', [
      'plain-payload-for-the-purge-test',
      rid('purge'),
    ])

    expect(await closeHitlRows([rid('purge')], 'alice', 'applied')).toBe(1)

    const { rows } = await query<{ status: string; payload: string | null; answer: string | null }>(
      'SELECT status, payload, answer FROM hitl_requests WHERE request_id = $1',
      [rid('purge')],
    )
    // The payload — the personal data the request carried — is gone; the
    // answered choice stays as the audit skeleton.
    expect(rows[0].payload).toBeNull()
    expect(rows[0].status).toBe('applied')
    expect(looksEncrypted(rows[0].answer)).toBe(true)
    // And a closed row is no longer an answer in transit.
    expect(await loadHitlAnswerRows(sid('purge'), 'alice')).toHaveLength(0)
  })
})

describe('the quarantine (F2)', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('round-trips the held content and stores every column as ciphertext', async () => {
    await putQuarantine({
      requestId: rid('q'),
      userId: 'alice',
      sessionId: sid('q'),
      expiresAt: new Date(Date.now() + 60_000),
      rawFile: 'UEsDBAAAAAAA', // "raw bytes", base64
      tier0Copy: '# The sanitized copy\n\nwith **no** disclaimer',
      findings: { findings: [{ rule: 'hidden-sheet', count: 1 }] },
      senderAddress: 'jane@fabrikam.example',
    })

    const row = await getQuarantine(rid('q'), 'alice')
    expect(row).not.toBeNull()
    expect(row!.rawFile).toBe('UEsDBAAAAAAA')
    expect(row!.tier0Copy).toContain('sanitized copy')
    expect(row!.findings).toEqual({ findings: [{ rule: 'hidden-sheet', count: 1 }] })
    expect(row!.senderAddress).toBe('jane@fabrikam.example')

    // At rest, none of it is plaintext (A1) — the address above all, which is
    // the one column C2 keeps out of the conversation entirely.
    const { rows } = await query<Record<string, string | null>>(
      'SELECT raw_file, tier0_copy, findings, sender_address FROM hitl_quarantine WHERE request_id = $1',
      [rid('q')],
    )
    for (const [column, value] of Object.entries(rows[0])) {
      expect(looksEncrypted(value), column).toBe(true)
    }
    expect(JSON.stringify(rows[0])).not.toContain('fabrikam')
  })

  it('is owner-scoped: another user reads nothing, and their delete is a no-op', async () => {
    await putQuarantine({
      requestId: rid('own'),
      userId: 'alice',
      sessionId: sid('own'),
      expiresAt: new Date(Date.now() + 60_000),
      senderAddress: 'a@b.example',
    })
    expect(await getQuarantine(rid('own'), 'mallory')).toBeNull()
    await deleteQuarantine(rid('own'), 'mallory')
    expect(await getQuarantine(rid('own'), 'alice')).not.toBeNull()
  })

  it('deleteQuarantine drops the row, and a second drop is a no-op (Δ4)', async () => {
    await putQuarantine({
      requestId: rid('del'),
      userId: 'alice',
      sessionId: sid('del'),
      expiresAt: new Date(Date.now() + 60_000),
      rawFile: 'x',
    })
    await deleteQuarantine(rid('del'), 'alice')
    await deleteQuarantine(rid('del'), 'alice')
    expect(await getQuarantine(rid('del'), 'alice')).toBeNull()
  })
})

describe('the expiry sweep', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('deletes expired quarantine rows whole, and purges expired request payloads', async () => {
    await putQuarantine({
      requestId: rid('swept'),
      userId: 'alice',
      sessionId: sid('swept'),
      expiresAt: new Date(Date.now() - 1_000),
      rawFile: 'x',
      senderAddress: 'gone@fabrikam.example',
    })
    await putQuarantine({
      requestId: rid('kept'),
      userId: 'alice',
      sessionId: sid('kept'),
      expiresAt: new Date(Date.now() + 60_000),
      rawFile: 'y',
    })
    await recordHitlAnswer({
      requestId: rid('due'),
      userId: 'alice',
      sessionId: sid('swept'),
      kind: 'memory.confirm',
      runId: 'run-1',
      blocksRun: false,
      expiresAt: new Date(Date.now() - 1_000),
      answer: { choice: 'save' },
    })
    await query(`UPDATE hitl_requests SET payload = $1 WHERE request_id = $2`, [
      'plain-expiring-payload',
      rid('due'),
    ])
    await recordHitlAnswer({
      requestId: rid('live'),
      userId: 'alice',
      sessionId: sid('swept'),
      kind: 'confirm',
      runId: 'run-1',
      blocksRun: true,
      expiresAt: new Date(Date.now() + 60_000),
      answer: { choice: 'approve' },
    })

    const swept = await sweepExpiredHitl()

    expect(swept.quarantine).toBe(1)
    expect(swept.payloads).toBe(1)
    expect(await getQuarantine(rid('swept'), 'alice')).toBeNull()
    expect(await getQuarantine(rid('kept'), 'alice')).not.toBeNull()
    const { rows } = await query<{ request_id: string; status: string; payload: string | null }>(
      'SELECT request_id, status, payload FROM hitl_requests WHERE session_id = $1',
      [sid('swept')],
    )
    const byId = new Map(rows.map((r) => [r.request_id, r]))
    expect(byId.get(rid('due'))!.status).toBe('expired')
    expect(byId.get(rid('due'))!.payload).toBeNull()
    // Not yet due: untouched, still the answer in transit.
    expect(byId.get(rid('live'))!.status).toBe('answered')
  })
})
