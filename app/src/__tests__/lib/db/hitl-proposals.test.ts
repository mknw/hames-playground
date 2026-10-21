/**
 * The proposal rows of `hitl_requests` (#433 S11, #419 M6) against real
 * Postgres: held encrypted, offered only while open and unexpired and only to
 * their owner, purged on close, and erased with their conversation. Skips when
 * the database is unreachable (the `hitl.test.ts` posture).
 *
 * Every pin names the mutation that turns it red; each one was run.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  canonicalAnswer,
  claimHitlProposalAnswer,
  releaseHitlProposalAnswer,
  requireAnsweringBinding,
  closeHitlRows,
  deleteHitlProposalsForUser,
  deleteHitlRowsForConversations,
  getHitlProposal,
  listHitlProposals,
  listProposalSessionIds,
  putHitlProposal,
  stopHitlSweepTimer,
  sweepExpiredHitl,
} from '../../../lib/db/hitl.server'
import { closePool, query, withTransaction } from '../../../lib/db/client.server'
import { getMemoryEnabled } from '../../../lib/db/user-prefs.server'
import {
  insertMemory,
  insertMemorySource,
  ensureMemoriesSchema,
} from '../../../lib/db/memories.server'
import { createConversation } from '../../../lib/db/conversations.server'
import { looksEncrypted } from '../../../lib/db/crypto.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const sid = (n: string) => `test-prop-${n}-${SUFFIX}`
const rid = (n: string) => `req-prop-${n}-${SUFFIX}`
const SECRET = 'zebra-pangolin-SENTINEL'

let dbAvailable = true
beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch {
    dbAvailable = false
  }
  stopHitlSweepTimer()
  // `user_prefs` is created lazily by its own module; ask it to.
  if (dbAvailable) await getMemoryEnabled('schema-probe')
  // the release guard reads `memory_sources`, which its own module creates lazily
  if (dbAvailable) await ensureMemoriesSchema()
  if (dbAvailable) for (const u of ['alice', 'bob', 'carol', 'dave']) await setSwitch(u, true)
})
afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM memories WHERE id LIKE $1', [`mem-prop-%-${SUFFIX}`])
  await query('DELETE FROM conversations WHERE id LIKE $1', [`test-prop-%-${SUFFIX}`])
  await query('DELETE FROM hitl_requests WHERE session_id LIKE $1', [`test-prop-%-${SUFFIX}`])
  await closePool()
})

const setSwitch = (user: string, on: boolean) =>
  query(
    `INSERT INTO user_prefs (user_id, memory_enabled) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET memory_enabled = EXCLUDED.memory_enabled`,
    [user, on],
  )

const put = (n: string, over: Partial<Parameters<typeof putHitlProposal>[0]> = {}) =>
  putHitlProposal({
    requestId: rid(n),
    userId: 'alice',
    sessionId: sid(n),
    kind: 'memory.confirm',
    runId: 'ev-1',
    expiresAt: new Date(Date.now() + 60_000),
    payload: { v: 1, items: [{ content: SECRET }] },
    ...over,
  })

describe('proposal rows', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  // MUTATION: store the payload with JSON.stringify instead of encryptJson → red.
  it('holds the payload as ciphertext and reads it back decrypted', async () => {
    await put('rt')
    const { rows } = await query<{ payload: string; status: string; blocks_run: boolean }>(
      'SELECT payload, status, blocks_run FROM hitl_requests WHERE request_id = $1',
      [rid('rt')],
    )
    expect(looksEncrypted(rows[0].payload)).toBe(true)
    expect(rows[0].payload).not.toContain(SECRET)
    expect(rows[0]).toMatchObject({ status: 'pending', blocks_run: false })
    const row = await getHitlProposal(rid('rt'), 'alice')
    expect(row).toMatchObject({
      requestId: rid('rt'),
      sessionId: sid('rt'),
      kind: 'memory.confirm',
    })
    expect(row!.payload).toEqual({ v: 1, items: [{ content: SECRET }] })
  })

  // MUTATION: drop `AND user_id = $2` from either read → red.
  it('is owner-scoped: someone else gets nothing, not an error', async () => {
    await put('own')
    expect(await getHitlProposal(rid('own'), 'mallory')).toBeNull()
    expect(await listHitlProposals(sid('own'), 'mallory', 'memory.confirm')).toEqual([])
    expect(await listHitlProposals(sid('own'), 'alice', 'memory.confirm')).toHaveLength(1)
  })

  // MUTATION: drop the `expires_at > NOW()` clause → an expired payload is offered → red.
  it('does not offer an expired proposal', async () => {
    await put('exp', { expiresAt: new Date(Date.now() - 1_000) })
    expect(await getHitlProposal(rid('exp'), 'alice')).toBeNull()
    expect(await listHitlProposals(sid('exp'), 'alice', 'memory.confirm')).toEqual([])
  })

  // MUTATION: drop `blocks_run = FALSE` → a blocking request's row is offered as a proposal → red.
  it('never offers a blocking request, nor another kind', async () => {
    // A blocking row that DOES hold a payload: only `blocks_run` excludes it.
    await put('blk')
    await query('UPDATE hitl_requests SET blocks_run = TRUE WHERE request_id = $1', [rid('blk')])
    await put('kind', { kind: 'provenance', sessionId: sid('blk') })
    expect(await getHitlProposal(rid('blk'), 'alice')).toBeNull()
    expect(await listHitlProposals(sid('blk'), 'alice', 'memory.confirm')).toEqual([])
  })

  // MUTATION: drop `user_id = $1` → another user's conversations are listed → red.
  // MUTATION: drop the expiry / blocks_run / kind clauses → each of the rows below leaks → red.
  it('lists the caller’s conversations with an open proposal, ids only, and nothing else', async () => {
    await put('ib1')
    await put('ib2', { userId: 'bob' })
    await put('ib3', { expiresAt: new Date(Date.now() - 1_000) })
    await put('ib4', { kind: 'provenance' })
    await put('ib5')
    await query('UPDATE hitl_requests SET blocks_run = TRUE WHERE request_id = $1', [rid('ib5')])
    await closeHitlRows([rid('ib1')], 'alice', 'applied')
    await put('ib6')
    const mine = await listProposalSessionIds('alice', 'memory.confirm', 500)
    expect(mine).toContain(sid('ib6'))
    for (const n of ['ib1', 'ib2', 'ib3', 'ib4', 'ib5']) expect(mine).not.toContain(sid(n))
    expect(await listProposalSessionIds('bob', 'memory.confirm', 500)).toContain(sid('ib2'))
    expect(await listProposalSessionIds('mallory', 'memory.confirm', 500)).toEqual([])
  })

  // MUTATION: `DO UPDATE` instead of `DO NOTHING` → a replay swaps the payload a person is about to approve → red.
  it('a replay of a request id does not swap the held payload', async () => {
    await put('swap')
    await expect(put('swap', { payload: { v: 1, items: [{ content: 'EVIL' }] } })).rejects.toThrow(
      /already held/,
    )
    expect((await getHitlProposal(rid('swap'), 'alice'))!.payload).toEqual({
      v: 1,
      items: [{ content: SECRET }],
    })
  })

  // MUTATION: closeHitlRows stops purging the payload → red (A8).
  it('a closed proposal is no longer offered and holds no payload', async () => {
    await put('close')
    await closeHitlRows([rid('close')], 'alice', 'applied')
    expect(await getHitlProposal(rid('close'), 'alice')).toBeNull()
    const { rows } = await query<{ payload: string | null }>(
      'SELECT payload FROM hitl_requests WHERE request_id = $1',
      [rid('close')],
    )
    expect(rows[0].payload).toBeNull()
  })

  it('the expiry sweep purges an expired proposal payload', async () => {
    await put('sweep', { expiresAt: new Date(Date.now() - 5_000) })
    await sweepExpiredHitl()
    const { rows } = await query<{ payload: string | null; status: string }>(
      'SELECT payload, status FROM hitl_requests WHERE request_id = $1',
      [rid('sweep')],
    )
    expect(rows[0]).toEqual({ payload: null, status: 'expired' })
  })

  // MUTATION: omit the `session_id = ANY` delete → a deleted conversation's
  // proposal text outlives it → red.
  it('is erased with its conversation, in the caller transaction, and only the owner’s', async () => {
    await put('del')
    await put('keep', { sessionId: sid('del'), requestId: rid('theirs'), userId: 'bob' })
    await withTransaction((tx) => deleteHitlRowsForConversations([sid('del')], 'alice', tx))
    expect(await getHitlProposal(rid('del'), 'alice')).toBeNull()
    expect(await getHitlProposal(rid('theirs'), 'bob')).not.toBeNull()
  })

  // MUTATION: drop `user_id` or `kind` from the delete → red.
  it('forget-everything erases one user’s proposals of that kind and nobody else’s', async () => {
    await put('f1', { userId: 'carol' })
    await put('f2', { userId: 'carol', kind: 'provenance' })
    await put('f3', { userId: 'dave' })
    expect(await deleteHitlProposalsForUser('carol', 'memory.confirm')).toBe(1)
    expect(await getHitlProposal(rid('f1'), 'carol')).toBeNull()
    const { rows } = await query('SELECT 1 FROM hitl_requests WHERE request_id = ANY($1)', [
      [rid('f2'), rid('f3')],
    ])
    expect(rows).toHaveLength(2)
  })

  // #579 review 1. MUTATION: drop the `WHERE EXISTS (… memory_enabled)` → a hold
  // that lands after switch-off + erase leaves a readable proposal → red.
  it('a hold while memory is OFF inserts nothing and throws, so the hook takes the proposal back', async () => {
    await setSwitch('erin', false)
    await expect(put('off', { userId: 'erin' })).rejects.toThrow(/memory is off/)
    expect(await getHitlProposal(rid('off'), 'erin')).toBeNull()
    const { rows } = await query('SELECT 1 FROM hitl_requests WHERE request_id = $1', [rid('off')])
    expect(rows).toEqual([])
    await setSwitch('erin', true)
    await put('off', { userId: 'erin' })
    expect(await getHitlProposal(rid('off'), 'erin')).not.toBeNull()
  })

  it('a user with no preferences row at all is OFF', async () => {
    await expect(put('norow', { userId: 'nobody-' + SUFFIX })).rejects.toThrow(/memory is off/)
  })
})

describe('the bound answer (#579 review 2)', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))
  const save = { choice: 'save', flags: { i0: true, i1: false } }
  const EVENT = `ev-nothing-written-${SUFFIX}`
  const claim = (
    n: string,
    answer: { choice: string; flags?: Record<string, boolean> } = save,
    user = 'alice',
  ) =>
    claimHitlProposalAnswer({
      requestId: rid(n),
      userId: user,
      sessionId: sid(n),
      kind: 'memory.confirm',
      answer,
    })

  // MUTATION: drop `AND status = 'pending'` from the claim → a second answer
  // overwrites the first → red.
  it('the first answer wins: a second claim is refused and reads back the first', async () => {
    await put('c1')
    expect(await claim('c1')).toEqual({ claimed: true })
    expect(await claim('c1', { choice: 'discard' })).toEqual({ claimed: false, recorded: save })
    expect(await claim('c1')).toEqual({ claimed: false, recorded: save })
  })

  // MUTATION: drop the owner / session fence from the claim → red.
  it('is owner- and session-fenced: another user, or another conversation, binds nothing', async () => {
    await put('c2')
    expect(await claim('c2', save, 'bob')).toEqual({ claimed: false, recorded: null })
    expect(
      await claimHitlProposalAnswer({
        requestId: rid('c2'),
        userId: 'alice',
        sessionId: 'another-session',
        kind: 'memory.confirm',
        answer: save,
      }),
    ).toEqual({ claimed: false, recorded: null })
    expect(await claim('c2')).toEqual({ claimed: true })
  })

  // MUTATION: store the answer in plaintext → red.
  it('holds the answer as ciphertext, and the answering row is still readable for the retry', async () => {
    await put('c3')
    await claim('c3')
    const { rows } = await query<{ answer: string; status: string }>(
      'SELECT answer, status FROM hitl_requests WHERE request_id = $1',
      [rid('c3')],
    )
    expect(rows[0].status).toBe('answering')
    expect(looksEncrypted(rows[0].answer)).toBe(true)
    expect(rows[0].answer).not.toContain('save')
    const row = await getHitlProposal(rid('c3'), 'alice')
    expect(row).toMatchObject({ status: 'answering', answer: save })
    expect((await listHitlProposals(sid('c3'), 'alice', 'memory.confirm'))[0].status).toBe(
      'answering',
    )
  })

  // MUTATION: release without the `status = 'answering'` fence → red.
  it('a release gives a bound answer back, and only to its owner', async () => {
    await put('c4')
    await claim('c4')
    expect(await releaseHitlProposalAnswer(rid('c4'), 'bob', EVENT, save)).toBe(false)
    expect((await getHitlProposal(rid('c4'), 'alice'))!.status).toBe('answering')
    expect(await releaseHitlProposalAnswer(rid('c4'), 'alice', EVENT, save)).toBe(true)
    expect(await getHitlProposal(rid('c4'), 'alice')).toMatchObject({
      status: 'pending',
      answer: null,
    })
    expect(await claim('c4', { choice: 'discard' })).toEqual({ claimed: true })
  })

  // #579 review 2a. MUTATION: drop the `NOT EXISTS (… memory_sources …)` → a
  // release after an earlier attempt WROTE gives the answer back, and "Don't
  // save" is then recorded over the written memories → red.
  it('a release with a memory_sources row for the proposal changes nothing', async () => {
    await ensureMemoriesSchema()
    await put('c6')
    await claim('c6')
    const event = `ev-written-${SUFFIX}`
    await createConversation({
      id: sid('c6'),
      userId: 'alice',
      agentId: 'search',
      title: null,
      serializedContext: '{}',
    } as never)
    await insertMemory({
      id: `mem-prop-c6-${SUFFIX}`,
      userId: 'alice',
      kind: 'preference',
      tier: 'self_deployed',
      content: 'x',
      evidence: 'x',
      embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
      embedSpace: 'synthetic',
    })
    await insertMemorySource({
      userId: 'alice',
      eventId: event,
      ordinal: 0,
      memoryId: `mem-prop-c6-${SUFFIX}`,
      conversationId: sid('c6'),
    })
    expect(await releaseHitlProposalAnswer(rid('c6'), 'alice', event, save)).toBe(false)
    expect(await getHitlProposal(rid('c6'), 'alice')).toMatchObject({
      status: 'answering',
      answer: save,
    })
    // another event's sources do not block it, and another user's source for
    // the same event id does not either (the guard is owner-scoped)
    expect(await releaseHitlProposalAnswer(rid('c6'), 'alice', `${event}-other`, save)).toBe(true)
  })

  // MUTATION: drop `user_id = $2` from the NOT EXISTS → another user's source row
  // for the same event id blocks (or is read as) this owner's release → red.
  it("the release guard is owner-scoped: another user's source for the same event id does not count", async () => {
    await put('c9')
    await claim('c9')
    const event = `ev-shared-${SUFFIX}`
    await createConversation({
      id: sid('c9'),
      userId: 'bob',
      agentId: 'search',
      title: null,
      serializedContext: '{}',
    } as never)
    await insertMemory({
      id: `mem-prop-c9-${SUFFIX}`,
      userId: 'bob',
      kind: 'preference',
      tier: 'self_deployed',
      content: 'x',
      evidence: 'x',
      embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
      embedSpace: 'synthetic',
    })
    await insertMemorySource({
      userId: 'bob',
      eventId: event,
      ordinal: 0,
      memoryId: `mem-prop-c9-${SUFFIX}`,
      conversationId: sid('c9'),
    })
    expect(await releaseHitlProposalAnswer(rid('c9'), 'alice', event, save)).toBe(true)
  })

  // MUTATION: drop the status clause of the binding check → a write proceeds
  // under an answer that was released → red.
  it('the binding check refuses a proposal that is not (or no longer) answering', async () => {
    await put('c8')
    await expect(
      withTransaction((tx) => requireAnsweringBinding(tx, rid('c8'), 'alice', save)),
    ).rejects.toThrow(/no longer bound/)
    await claim('c8')
    await expect(
      withTransaction((tx) => requireAnsweringBinding(tx, rid('c8'), 'alice', save)),
    ).resolves.toBeUndefined()
    await expect(
      withTransaction((tx) => requireAnsweringBinding(tx, rid('c8'), 'bob', save)),
    ).rejects.toThrow(/no longer bound/)
  })

  // D4 (#579 delta review 2). MUTATION: drop the answer comparison (check the
  // status only) → after a release and a re-claim as "Don't save", an in-flight
  // save still passes the check and writes under the discard binding → red.
  it('D4 · the binding check is for THIS answer: after a release and a re-claim as discard, a save is refused', async () => {
    await put('c10')
    await claim('c10') // attempt A: save, bound
    await expect(
      withTransaction((tx) => requireAnsweringBinding(tx, rid('c10'), 'alice', save)),
    ).resolves.toBeUndefined()
    // a sibling releases (nothing written yet), and "Don't save" claims the row
    expect(await releaseHitlProposalAnswer(rid('c10'), 'alice', EVENT, save)).toBe(true)
    expect(await claim('c10', { choice: 'discard' })).toEqual({ claimed: true })
    // the row is `answering` again — with discard bound
    expect((await getHitlProposal(rid('c10'), 'alice'))!.status).toBe('answering')
    await expect(
      withTransaction((tx) => requireAnsweringBinding(tx, rid('c10'), 'alice', save)),
    ).rejects.toThrow(/no longer bound/)
    // and the stale attempt cannot undo the discard's claim by releasing it
    // MUTATION: release without the answer comparison → red
    expect(await releaseHitlProposalAnswer(rid('c10'), 'alice', EVENT, save)).toBe(false)
    expect((await getHitlProposal(rid('c10'), 'alice'))!.answer).toEqual({ choice: 'discard' })
    // the same answer in another flag order, and the discard itself, still pass
    await expect(
      withTransaction((tx) =>
        requireAnsweringBinding(tx, rid('c10'), 'alice', { choice: 'discard' }),
      ),
    ).resolves.toBeUndefined()
  })

  it('the binding check compares flags too: a save of one item is not a save of both', async () => {
    await put('c11')
    await claim('c11', { choice: 'save', flags: { i0: true, i1: false } })
    await expect(
      withTransaction((tx) =>
        requireAnsweringBinding(tx, rid('c11'), 'alice', {
          choice: 'save',
          flags: { i0: true, i1: true },
        }),
      ),
    ).rejects.toThrow(/no longer bound/)
    await expect(
      withTransaction((tx) =>
        requireAnsweringBinding(tx, rid('c11'), 'alice', {
          choice: 'save',
          flags: { i1: false, i0: true },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  // MUTATION: drop the status clause from the binding check → a CLOSED proposal
  // (answer kept for audit, payload gone) still passes for the same answer → red.
  it('the binding check refuses a closed proposal even for the answer it recorded', async () => {
    await put('c13')
    await claim('c13')
    await closeHitlRows([rid('c13')], 'alice', 'applied')
    const { rows } = await query<{ answer: string | null; status: string }>(
      'SELECT answer, status FROM hitl_requests WHERE request_id = $1',
      [rid('c13')],
    )
    expect(rows[0].status).toBe('applied')
    expect(rows[0].answer).not.toBeNull() // kept for audit
    await expect(
      withTransaction((tx) => requireAnsweringBinding(tx, rid('c13'), 'alice', save)),
    ).rejects.toThrow(/no longer bound/)
  })

  // MUTATION: leave 'answering' out of the sweep → an expired bound answer keeps its payload → red.
  it('the expiry sweep purges an answering row like a pending one', async () => {
    await put('c5', { expiresAt: new Date(Date.now() - 5_000) })
    // payload already gone: only the STATUS clause of the sweep can pick it up
    await query(
      `UPDATE hitl_requests SET status = 'answering', payload = NULL WHERE request_id = $1`,
      [rid('c5')],
    )
    await sweepExpiredHitl()
    const { rows } = await query<{ payload: string | null; status: string }>(
      'SELECT payload, status FROM hitl_requests WHERE request_id = $1',
      [rid('c5')],
    )
    expect(rows[0]).toEqual({ payload: null, status: 'expired' })
  })

  // MUTATION: sort nothing → the same answer in another key order reads as different → red.
  it('"the same answer" is a byte comparison of a canonical form', () => {
    expect(canonicalAnswer({ choice: 'save', flags: { i1: false, i0: true } })).toBe(
      canonicalAnswer({ choice: 'save', flags: { i0: true, i1: false } }),
    )
    expect(canonicalAnswer({ choice: 'save', flags: { i0: true } })).not.toBe(
      canonicalAnswer({ choice: 'save', flags: { i0: false } }),
    )
    expect(canonicalAnswer({ choice: 'discard' })).toBe(
      canonicalAnswer({ choice: 'discard', flags: {} }),
    )
  })
})
