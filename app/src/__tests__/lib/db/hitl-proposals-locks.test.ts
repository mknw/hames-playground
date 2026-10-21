/**
 * The two proposal-lock races of #579 (D3: a release against a write in flight;
 * the conversation-delete lock order), in a DATABASE OF THEIR OWN.
 *
 * Both hold a transaction open across a wait, and `initSchema()` — another test
 * file's first query, run as one multi-statement transaction that takes
 * `ACCESS EXCLUSIVE` locks (`ADD COLUMN IF NOT EXISTS` takes them even when the
 * column exists) — can deadlock with it when the files share a database: CI saw
 * exactly that, with the victim in `encryption.test.ts`. So this file creates
 * and uses `hames_test_hitl_locks` on the same server, and no other file's DDL
 * can queue behind these transactions. Skips when no Postgres is reachable, like
 * `hitl-proposals.test.ts`.
 *
 * Every pin names the mutation that turns it red; each one was run.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import pg from 'pg'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  claimHitlProposalAnswer,
  getHitlProposal,
  putHitlProposal,
  releaseHitlProposalAnswer,
  requireAnsweringBinding,
  stopHitlSweepTimer,
} from '../../../lib/db/hitl.server'
import { closePool, query, withTransaction } from '../../../lib/db/client.server'
import { getMemoryEnabled } from '../../../lib/db/user-prefs.server'
import {
  closeMemoryPool,
  ensureMemoriesSchema,
  insertMemory,
  insertMemorySource,
} from '../../../lib/db/memories.server'
import { createConversation, deleteConversations } from '../../../lib/db/conversations.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const sid = (n: string) => `test-lock-${n}-${SUFFIX}`
const rid = (n: string) => `req-lock-${n}-${SUFFIX}`
const save = { choice: 'save', flags: { i0: true, i1: false } }
const DB = 'hames_test_hitl_locks'

let dbAvailable = true
beforeAll(async () => {
  try {
    const base = new URL(process.env.DATABASE_URL!)
    const admin = new URL(base)
    admin.pathname = '/postgres'
    const target = new URL(base)
    target.pathname = `/${DB}`
    const client = new pg.Client({ connectionString: admin.toString() })
    await client.connect()
    try {
      const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])
      if (rows.length === 0) await client.query(`CREATE DATABASE ${DB}`)
    } finally {
      await client.end()
    }
    // pools read the URL lazily, at their first query: point them at ours
    process.env.DATABASE_URL = target.toString()
    await query('SELECT 1')
    stopHitlSweepTimer()
    await getMemoryEnabled('schema-probe')
    await ensureMemoriesSchema()
    await query(
      `INSERT INTO user_prefs (user_id, memory_enabled) VALUES ('alice', TRUE)
       ON CONFLICT (user_id) DO UPDATE SET memory_enabled = TRUE`,
    )
  } catch (err) {
    dbAvailable = false
    console.warn('[hitl-proposals-locks] Postgres unreachable, skipping:', err)
  }
})
afterAll(async () => {
  if (!dbAvailable) return
  await closeMemoryPool().catch(() => undefined)
  await closePool()
})

const put = (n: string) =>
  putHitlProposal({
    requestId: rid(n),
    userId: 'alice',
    sessionId: sid(n),
    kind: 'memory.confirm',
    runId: 'ev-1',
    expiresAt: new Date(Date.now() + 60_000),
    payload: { v: 1, items: [] },
  })
const claim = (n: string, answer = save) =>
  claimHitlProposalAnswer({
    requestId: rid(n),
    userId: 'alice',
    sessionId: sid(n),
    kind: 'memory.confirm',
    answer,
  })

describe('proposal locks', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  // MUTATION: drop `FOR UPDATE` from the release, or `FOR SHARE` from the
  // binding check → the release does not wait for a write in flight, and
  // (single-snapshot or not) gives the answer back over it → red.
  it('a release waits for a write transaction that re-checked the binding, then sees its rows (D3)', async () => {
    await ensureMemoriesSchema()
    await put('c7')
    await claim('c7')
    const event = `ev-race-${SUFFIX}`
    await createConversation({
      id: sid('c7'),
      userId: 'alice',
      agentId: 'search',
      title: null,
      serializedContext: '{}',
    } as never)
    await insertMemory({
      id: `mem-prop-c7-${SUFFIX}`,
      userId: 'alice',
      kind: 'preference',
      tier: 'self_deployed',
      content: 'x',
      evidence: 'x',
      embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
      embedSpace: 'synthetic',
    })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let bound!: () => void
    const bindingHeld = new Promise<void>((r) => (bound = r))
    // attempt B: re-checks the binding, then writes its source row, slowly
    const writer = withTransaction(async (tx) => {
      await requireAnsweringBinding(tx, rid('c7'), 'alice', save)
      bound()
      await gate
      await tx.query(
        `INSERT INTO memory_sources (user_id, event_id, ordinal, memory_id, conversation_id)
         VALUES ('alice', $1, 0, $2, $3)`,
        [event, `mem-prop-c7-${SUFFIX}`, sid('c7')],
      )
    })
    await bindingHeld
    // attempt A: failed before writing, releases while B is mid-write
    let released: boolean | undefined
    const releaser = releaseHitlProposalAnswer(rid('c7'), 'alice', event, save).then(
      (r) => (released = r),
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(released).toBeUndefined() // it is WAITING on B's lock
    release()
    await writer
    await releaser
    expect(released).toBe(false) // and then it SAW B's committed row
    expect(await getHitlProposal(rid('c7'), 'alice')).toMatchObject({ status: 'answering' })
  })

  // #579 delta review 2, LOW: lock order. An approval's write takes its proposal
  // row FOR SHARE and then touches `memories`; a conversation delete must take the
  // same locks in the same order. MUTATION: delete the memories BEFORE the
  // proposal rows (the old order) → the two deadlock and one aborts → red.
  it('a conversation delete racing an approval write takes the proposal row first: no deadlock, nothing half-done', async () => {
    await put('c12')
    await claim('c12')
    await createConversation({
      id: sid('c12'),
      userId: 'alice',
      agentId: 'search',
      title: null,
      serializedContext: '{}',
    } as never)
    const mem = `mem-prop-c12-${SUFFIX}`
    await insertMemory({
      id: mem,
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
      eventId: `ev-c12-${SUFFIX}`,
      ordinal: 0,
      memoryId: mem,
      conversationId: sid('c12'),
    })
    let go!: () => void
    const gate = new Promise<void>((r) => (go = r))
    let held!: () => void
    const bound = new Promise<void>((r) => (held = r))
    // the approval's item transaction: binding row first, then the memory
    const approval = withTransaction(async (tx) => {
      await requireAnsweringBinding(tx, rid('c12'), 'alice', save)
      held()
      await gate
      await tx.query('UPDATE memories SET evidence_count = evidence_count + 1 WHERE id = $1', [mem])
    })
    await bound
    let deleted = false
    const del = deleteConversations([sid('c12')], 'alice').then(() => (deleted = true))
    await new Promise((r) => setTimeout(r, 400))
    expect(deleted).toBe(false) // waiting on the proposal row, holding nothing the write needs
    go()
    await approval
    await del
    expect(deleted).toBe(true)
    const { rows } = await query('SELECT 1 FROM memories WHERE id = $1', [mem])
    expect(rows).toEqual([])
    expect(await getHitlProposal(rid('c12'), 'alice')).toBeNull()
  })
})
