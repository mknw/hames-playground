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
  claimToolSend,
  finishToolSend,
  stopHitlSweepTimer,
  sweepExpiredHitl,
} from '../../../lib/db/hitl.server'
import { closePool, query } from '../../../lib/db/client.server'
import { looksEncrypted } from '../../../lib/db/crypto.server'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  createHitlPayloadStore,
  purgeClosedPayloads,
  resolveHitlAnswer,
} from '../../../lib/hitl/payloads.server'
import { INGRESS_FLAG_KIND, INGRESS_TEXTS } from '@hames-ai/harness-patterns'

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

describe('N8 durable tool sends', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  // N8-03/08. MUTATION: remove the unique claim or digest comparison → the
  // second attempt becomes new, or a changed payload reuses a prior claim.
  it('commits a started claim before transport and never reclaims it', async () => {
    const key = { userId: 'alice', sessionId: sid('claim'), runId: 'run-1', callKey: 'call-1' }
    expect(await claimToolSend({ ...key, digest: 'digest-a' })).toEqual({ status: 'new' })
    expect(await claimToolSend({ ...key, digest: 'digest-a' })).toEqual({ status: 'unknown' })
    expect(await claimToolSend({ ...key, digest: 'digest-b' })).toEqual({ status: 'mismatch' })
    const { rows } = await query<{ digest: string; result: string | null }>(
      'SELECT digest, result FROM tool_send_claims WHERE session_id = $1',
      [key.sessionId],
    )
    expect(looksEncrypted(rows[0].digest)).toBe(true)
    expect(rows[0].result).toBeNull()
  })

  // N8-03. MUTATION: omit the finished result read → a replay sees unknown.
  it('returns an encrypted finished result without a second send claim', async () => {
    const key = {
      userId: 'alice',
      sessionId: sid('finished'),
      runId: 'run-1',
      callKey: 'call-1',
      digest: 'digest-a',
    }
    await claimToolSend(key)
    const result = { success: true, data: { synthetic: 'private-result' } }
    await finishToolSend({ ...key, result })
    expect(await claimToolSend(key)).toEqual({ status: 'finished', result })
    const { rows } = await query<{ result: string }>(
      'SELECT result FROM tool_send_claims WHERE session_id = $1',
      [key.sessionId],
    )
    expect(looksEncrypted(rows[0].result)).toBe(true)
    expect(rows[0].result).not.toContain('private-result')
  })

  // N8-03. MUTATION: keep the started claim in process memory instead of the
  // database → a second Node process reports new and could send twice.
  it('a fresh process sees the committed started claim as outcome unknown', async () => {
    const key = {
      userId: 'alice',
      sessionId: sid('fresh-process'),
      runId: 'run-1',
      callKey: 'call-1',
      digest: 'digest-a',
    }
    expect(await claimToolSend(key)).toEqual({ status: 'new' })
    const probe = `import { claimToolSend, stopHitlSweepTimer } from './src/lib/db/hitl.server.ts';
      import { closePool } from './src/lib/db/client.server.ts';
      (async () => { const result = await claimToolSend(JSON.parse(process.env.N8_CLAIM_KEY!));
        process.stdout.write('N8_PROBE:' + JSON.stringify(result) + '\\n'); stopHitlSweepTimer(); await closePool(); })().catch((e) => {
          process.stderr.write(String(e)); process.exitCode = 1; });`
    const modules = path.resolve(process.cwd(), '../node_modules/.pnpm')
    const tsx = readdirSync(modules).find((name) => name.startsWith('tsx@'))!
    const cli = path.join(modules, tsx, 'node_modules/tsx/dist/cli.mjs')
    const output = execFileSync(process.execPath, [cli, '-e', probe], {
      cwd: process.cwd(),
      env: { ...process.env, N8_CLAIM_KEY: JSON.stringify(key) },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(JSON.parse(output.split('N8_PROBE:')[1].split('\n')[0])).toEqual({ status: 'unknown' })
  }, 30_000)
})

describe('N8 owner-scoped batch plans', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  // N8-08. MUTATION: omit either owner or session from the store read → a
  // different user or conversation can consume another checklist's payload.
  it('loads the encrypted plan only for its owner and conversation', async () => {
    const sessionId = sid('batch-owner')
    const payload = { v: 1, rows: [{ index: 0, args: { query: 'synthetic-private' } }] }
    const held = await holdHitlPayload({
      userId: 'alice',
      sessionId,
      callKey: 'batch-key',
      kind: 'egress-batch-release',
      expiresAt: soon(),
      payload,
    })
    const ref = (held as { payloadRef: string }).payloadRef
    expect(await createHitlPayloadStore('alice', sessionId).load!(ref)).toEqual({
      kind: 'egress-batch-release',
      payload,
    })
    expect(await createHitlPayloadStore('mallory', sessionId).load!(ref)).toBeNull()
    expect(await createHitlPayloadStore('alice', sid('other-session')).load!(ref)).toBeNull()
  })
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM hitl_payloads WHERE session_id LIKE $1', [`test-held-%-${SUFFIX}`])
  await query('DELETE FROM tool_send_claims WHERE session_id LIKE $1', [`test-held-%-${SUFFIX}`])
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
    const rows = await rowsOf(sid('bind'))
    expect(rows).toHaveLength(1)
    const held = await getHitlPayload(rows[0].payload_ref, 'alice')
    expect(held?.payload).toEqual({ n: 1, url: 'https://a.example' })
    // At rest: an envelope, not the address.
    expect(looksEncrypted(rows[0].payload)).toBe(true)
    expect(rows[0].payload).not.toContain('a.example')
  })

  // #801 review B2. MUTATION: bind on (owner, conversation, call) alone (drop
  // `kind` from the unique key, the conflict target and the re-read) → the
  // released call's flagged result is `rebound` → red.
  it('another kind under one call is its own row; another payload of the same kind is still rebound', async () => {
    const base = {
      userId: 'alice',
      sessionId: sid('kinds'),
      callKey: 'call-k',
      expiresAt: soon(),
    }
    const egress = await holdHitlPayload({ ...base, kind: 'egress-release', payload: { url: 'u' } })
    const ingress = await holdHitlPayload({ ...base, kind: 'ingress-flag', payload: 'raw text' })
    expect(egress).toMatchObject({ inserted: true })
    expect(ingress).toMatchObject({ inserted: true })
    expect((ingress as { payloadRef: string }).payloadRef).not.toBe(
      (egress as { payloadRef: string }).payloadRef,
    )
    expect(await holdHitlPayload({ ...base, kind: 'ingress-flag', payload: 'other' })).toEqual({
      rebound: true,
    })
    expect(await rowsOf(sid('kinds'))).toHaveLength(2)
  })

  // N2. MUTATION: drop the conversation from the store's delete → a store bound
  // to one conversation drops another's row → red.
  it("a conversation's store drops only its own rows", async () => {
    const other = (await holdHitlPayload({
      userId: 'alice',
      sessionId: sid('other'),
      callKey: 'call-x',
      kind: 'egress-release',
      expiresAt: soon(),
      payload: { q: 'theirs' },
    })) as { payloadRef: string }
    await createHitlPayloadStore('alice', sid('mine')).drop(other.payloadRef)
    expect(await getHitlPayload(other.payloadRef, 'alice')).not.toBeNull()
    await createHitlPayloadStore('alice', sid('other')).drop(other.payloadRef)
    expect(await getHitlPayload(other.payloadRef, 'alice')).toBeNull()
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

describe('the table is insert-only, and the resolve is chosen by kind', () => {
  // N1. MUTATION: add an `UPDATE hitl_payloads` statement to the repository →
  // red. (The barrier is the module, which is the only SQL against the table:
  // encryption-coverage.test.ts pins that.)
  it('no statement in the repository updates a held payload', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/lib/db/hitl.server.ts'), 'utf8')
    expect(source).not.toMatch(/UPDATE\s+hitl_payloads/i)
  })

  // N3. MUTATION: look the resolver up on a plain object → a kind named like
  // an Object.prototype member resolves to that member (and returns its
  // string) instead of the default → red.
  it('a kind named like an Object.prototype member takes the default resolver', async (ctx) => {
    skipWithoutDatabase(ctx, dbAvailable)
    const resolve = resolveHitlAnswer('alice')
    const request = { requestId: 'req-proto', kind: 'toString' } as never
    expect(await resolve(request, { choice: 'x', flags: {} })).toBeUndefined()
  })

  // Boundary guards slice 10. MUTATION: drop the `ingress-flag` resolver →
  // the default one runs, and the person's choice never becomes the result →
  // red.
  it('a flagged result becomes what the person chose, read from its own row, by its owner only', async (ctx) => {
    skipWithoutDatabase(ctx, dbAvailable)
    const sessionId = sid('flag')
    const held = await holdHitlPayload({
      userId: 'alice',
      sessionId,
      callKey: 'k-flag',
      kind: INGRESS_FLAG_KIND,
      payload: {
        namespace: 'web',
        tool: 'fetch',
        content: 'the page, flagged passage kept',
        screened: 'the page, [flagged]',
        spans: ['flagged passage'],
      },
      expiresAt: soon(),
    })
    const ref = (held as { payloadRef: string }).payloadRef
    const request = {
      requestId: 'req-flag',
      kind: INGRESS_FLAG_KIND,
      payloadRef: ref,
      summary: { namespace: 'web', tool: 'fetch' },
    } as never
    const answer = (choice: string) => ({ choice, flags: {} })
    expect(await resolveHitlAnswer('alice')(request, answer('use-unchanged'))).toBe(
      'the page, flagged passage kept',
    )
    expect(await resolveHitlAnswer('alice')(request, answer('use-sanitized'))).toBe(
      'the page, [flagged]',
    )
    expect(await resolveHitlAnswer('alice')(request, answer('leave-out'))).toBe(
      INGRESS_TEXTS.leftOut('fetch'),
    )
    // Another owner's read finds no row: the result is left out, never shown.
    expect(await resolveHitlAnswer('mallory')(request, answer('use-unchanged'))).toBe(
      INGRESS_TEXTS.leftOut('fetch'),
    )
    // A row of another kind is never released as a result. MUTATION: drop the
    // kind check → the write's held statement becomes the result → red.
    const other = await holdHitlPayload({
      userId: 'alice',
      sessionId,
      callKey: 'k-write',
      kind: 'graph-write',
      payload: { content: 'MATCH (n) DETACH DELETE n' },
      expiresAt: soon(),
    })
    const misbound = {
      ...(request as object),
      payloadRef: (other as { payloadRef: string }).payloadRef,
    }
    expect(await resolveHitlAnswer('alice')(misbound as never, answer('use-unchanged'))).toBe(
      INGRESS_TEXTS.leftOut('fetch'),
    )
  })

  it('an egress release has no side effect in the host', async (ctx) => {
    skipWithoutDatabase(ctx, dbAvailable)
    const request = { requestId: 'req-egress', kind: 'egress-release' } as never
    expect(await resolveHitlAnswer('alice')(request, { choice: 'accept', flags: {} })).toBe(
      undefined,
    )
  })
})
