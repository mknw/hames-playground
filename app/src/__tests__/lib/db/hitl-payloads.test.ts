/**
 * Blocking-request payloads (decision-loop-agent slice 8, host half): the
 * `hitl_payloads` table behind core's `HitlPayloadStore`.
 *
 * Hits Postgres and skips when it is unreachable: the points under test — the
 * unique-key conflict path, two concurrent inserts, the expiry sweep, the
 * at-rest envelope — are the database's behaviour, which a mock cannot show.
 *
 * Each pin names the source mutation that turns it red; each was run.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  deleteHitlPayloads,
  getHitlPayload,
  holdHitlPayload,
  stopHitlSweepTimer,
  sweepExpiredHitl,
} from '../../../lib/db/hitl.server'
import { closePool, query } from '../../../lib/db/client.server'
import { looksEncrypted } from '../../../lib/db/crypto.server'
import { purgeClosedPayloads } from '../../../lib/hitl/payloads.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const sid = (name: string) => `test-held-${name}-${SUFFIX}`
const soon = () => new Date(Date.now() + 60_000)

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[hitl-payloads.test] Postgres unreachable, skipping:', err)
  }
  stopHitlSweepTimer()
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM hitl_payloads WHERE session_id LIKE $1', [`test-held-%-${SUFFIX}`])
  await closePool()
})

const rowsOf = async (sessionId: string) =>
  (
    await query<{ payload_ref: string; payload: string }>(
      'SELECT payload_ref, payload FROM hitl_payloads WHERE session_id = $1',
      [sessionId],
    )
  ).rows

describe('holding a payload for one logical call', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  // MUTATION: update the row on conflict (`DO UPDATE`), or skip the comparison
  // → a retry gets a second row, or a different payload replaces the first →
  // red.
  it('is insert-only: the same call reuses its row, and a different payload is refused', async () => {
    const base = {
      userId: 'alice',
      sessionId: sid('bind'),
      callKey: 'call-1',
      kind: 'egress-release',
      expiresAt: soon(),
    }
    const first = await holdHitlPayload({ ...base, payload: { url: 'https://a.example', n: 1 } })
    expect(first).toMatchObject({ inserted: true })
    // Key order is not the payload: canonical JSON.
    const retry = await holdHitlPayload({ ...base, payload: { n: 1, url: 'https://a.example' } })
    expect(retry).toEqual({
      payloadRef: (first as { payloadRef: string }).payloadRef,
      inserted: false,
    })

    expect(await holdHitlPayload({ ...base, payload: { url: 'https://b.example', n: 1 } })).toEqual(
      {
        rebound: true,
      },
    )
    expect(
      await holdHitlPayload({
        ...base,
        kind: 'ingress-flag',
        payload: { url: 'https://a.example', n: 1 },
      }),
    ).toEqual({ rebound: true })

    const rows = await rowsOf(sid('bind'))
    expect(rows).toHaveLength(1)
    const held = await getHitlPayload(rows[0].payload_ref, 'alice')
    expect(held?.payload).toEqual({ n: 1, url: 'https://a.example' })
    // At rest: an envelope, not the address.
    expect(looksEncrypted(rows[0].payload)).toBe(true)
    expect(rows[0].payload).not.toContain('a.example')
  })

  // MUTATION: drop the unique key from the table → two rows → red.
  it('two concurrent holds of one call leave one row, and both get its ref', async () => {
    const input = {
      userId: 'alice',
      sessionId: sid('race'),
      callKey: 'call-race',
      kind: 'egress-release',
      expiresAt: soon(),
      payload: { q: 'same' },
    }
    const [a, b] = await Promise.all([holdHitlPayload(input), holdHitlPayload(input)])
    const refs = [a, b].map((r) => (r as { payloadRef: string }).payloadRef)
    expect(refs[0]).toBe(refs[1])
    expect([a, b].filter((r) => (r as { inserted: boolean }).inserted)).toHaveLength(1)
    expect(await rowsOf(sid('race'))).toHaveLength(1)
  })

  // MUTATION: drop `user_id` from the read's WHERE → another user reads it → red.
  it('is read by its owner only, and not past its expiry', async () => {
    const held = (await holdHitlPayload({
      userId: 'alice',
      sessionId: sid('owner'),
      callKey: 'call-o',
      kind: 'egress-release',
      expiresAt: soon(),
      payload: { q: 'mine' },
    })) as { payloadRef: string }
    expect(await getHitlPayload(held.payloadRef, 'mallory')).toBeNull()
    expect((await getHitlPayload(held.payloadRef, 'alice'))?.payload).toEqual({ q: 'mine' })

    const due = (await holdHitlPayload({
      userId: 'alice',
      sessionId: sid('owner'),
      callKey: 'call-due',
      kind: 'egress-release',
      expiresAt: new Date(Date.now() - 1_000),
      payload: { q: 'late' },
    })) as { payloadRef: string }
    expect(await getHitlPayload(due.payloadRef, 'alice')).toBeNull()
  })

  // MUTATION: drop the hitl_payloads DELETE from the sweep → the due row
  // survives → red.
  it('the expiry sweep deletes a held payload whose request never closed', async () => {
    const due = (await holdHitlPayload({
      userId: 'alice',
      sessionId: sid('sweep'),
      callKey: 'call-s',
      kind: 'egress-release',
      expiresAt: new Date(Date.now() - 1_000),
      payload: { q: 'gone' },
    })) as { payloadRef: string }
    await holdHitlPayload({
      userId: 'alice',
      sessionId: sid('sweep'),
      callKey: 'call-k',
      kind: 'egress-release',
      expiresAt: soon(),
      payload: { q: 'kept' },
    })
    const swept = await sweepExpiredHitl()
    expect(swept.held).toBeGreaterThanOrEqual(1)
    const left = await rowsOf(sid('sweep'))
    expect(left.map((r) => r.payload_ref)).not.toContain(due.payloadRef)
    expect(left).toHaveLength(1)
  })

  // MUTATION: purge every request's payload (ignore `pending`) → the waiting
  // request's payload is gone before its person answered → red.
  it("after a save, a closed request's payload goes and a waiting one's stays", async () => {
    const hold = (callKey: string) =>
      holdHitlPayload({
        userId: 'alice',
        sessionId: sid('purge'),
        callKey,
        kind: 'egress-release',
        expiresAt: soon(),
        payload: { callKey },
      }) as Promise<{ payloadRef: string }>
    const closed = await hold('call-closed')
    const waiting = await hold('call-waiting')
    const request = (requestId: string, payloadRef: string) => ({
      id: `ev-${requestId}`,
      type: 'hitl_request' as const,
      ts: 1,
      patternId: 'p',
      data: {
        v: 1,
        requestId,
        runId: 'u1',
        key: `egress-release:${requestId}`,
        kind: 'egress-release',
        question: 'q',
        options: [],
        defaultOption: 'refuse',
        unattended: 'apply-default',
        summary: {},
        blocking: true,
        payloadRef,
      },
    })
    const ctx = {
      events: [
        {
          id: 'u1',
          type: 'user_message' as const,
          ts: 0,
          patternId: 'harness',
          data: { content: 'x' },
        },
        request('00000000-0000-4000-8000-000000000001', closed.payloadRef),
        {
          id: 'r1',
          type: 'hitl_response' as const,
          ts: 2,
          patternId: 'p',
          data: {
            v: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            key: 'egress-release:00000000-0000-4000-8000-000000000001',
            kind: 'egress-release',
            choice: 'refuse',
            by: 'person',
          },
        },
        request('00000000-0000-4000-8000-000000000002', waiting.payloadRef),
      ],
    }
    expect(await purgeClosedPayloads(ctx as never, 'alice')).toBe(1)
    expect(await getHitlPayload(closed.payloadRef, 'alice')).toBeNull()
    expect(await getHitlPayload(waiting.payloadRef, 'alice')).not.toBeNull()
    expect(await deleteHitlPayloads([waiting.payloadRef], 'mallory')).toBe(0)
  })
})
