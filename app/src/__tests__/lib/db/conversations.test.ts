/**
 * Round-trip test for conversations CRUD.
 *
 * Hits the live Postgres container from docker-compose. Skips gracefully
 * when Postgres isn't reachable so this works on machines without docker.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

// Bypass server-only guard in jsdom test env
import { vi } from 'vitest'
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  loadConversation,
  saveConversation,
  listConversations,
  deleteConversation,
  deleteConversations,
  deriveTitle,
  getConversationOwner,
  promoteConversation,
  setConversationStatus,
  reapStuckConversations,
  STUCK_RUN_TIMEOUT_MINUTES,
} from '../../../lib/db/conversations.server'
import { closePool, query } from '../../../lib/db/client.server'

const TEST_USER = `test-user-${Math.random().toString(36).slice(2, 10)}`

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[conversations.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  // Clean up everything we wrote under the test user
  await query('DELETE FROM conversations WHERE user_id = $1', [TEST_USER])
  await closePool()
})

describe('deriveTitle', () => {
  it('returns null for empty input', () => {
    expect(deriveTitle('')).toBeNull()
    expect(deriveTitle('   \n  ')).toBeNull()
  })

  it('collapses whitespace and trims', () => {
    expect(deriveTitle('  hello   world  ')).toBe('hello world')
  })

  it('truncates with ellipsis past 60 chars', () => {
    const long = 'x'.repeat(80)
    const out = deriveTitle(long)!
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(61) // 60 chars + ellipsis
  })
})

describe('conversations CRUD', () => {
  it('round-trips a serialized context unchanged', async () => {
    if (!dbAvailable) return
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    const ctx = {
      sessionId: id,
      createdAt: 1730000000000,
      events: [
        { id: 'ev-1', type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'hi' } },
        {
          id: 'ev-2',
          type: 'tool_result',
          ts: 2,
          patternId: 'neo4j-query',
          data: { tool: 'read_neo4j_cypher', result: { rows: [] }, success: true },
        },
      ],
      status: 'done',
      data: { intent: 'neo4j' },
      input: 'hi',
    }
    const serialized = JSON.stringify(ctx)

    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'hi',
      serializedContext: serialized,
    })

    const loaded = await loadConversation(id, TEST_USER)
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(id)
    expect(loaded!.userId).toBe(TEST_USER)
    expect(loaded!.agentId).toBe('search')
    expect(loaded!.title).toBe('hi')
    expect(JSON.parse(loaded!.serializedContext)).toEqual(ctx)
  })

  it('upserts (second save overwrites context, preserves title)', async () => {
    if (!dbAvailable) return
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`

    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'first title',
      serializedContext: JSON.stringify({ events: [] }),
    })

    // Second write: try to change the title — should be ignored (sticky)
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'attempted rename',
      serializedContext: JSON.stringify({ events: [{ id: 'a' }] }),
    })

    const loaded = await loadConversation(id, TEST_USER)
    expect(loaded!.title).toBe('first title')
    expect(JSON.parse(loaded!.serializedContext)).toEqual({ events: [{ id: 'a' }] })
  })

  it("a save against another user's conversation id mutates nothing", async () => {
    if (!dbAvailable) return
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'victim title',
      serializedContext: JSON.stringify({ events: [{ id: 'victim' }] }),
      status: 'done',
    })

    // The attacker's runTurn sees no row (loadSession is user-scoped), so it
    // blind-INSERTs — which conflicts. The owner-scoped upsert must no-op.
    const attacker = `attacker-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: attacker,
      agentId: 'evil-agent',
      title: 'clobbered',
      serializedContext: JSON.stringify({ events: [] }),
      status: 'running',
    })

    const row = await loadConversation(id, TEST_USER)
    expect(row).not.toBeNull()
    expect(row!.userId).toBe(TEST_USER)
    expect(row!.agentId).toBe('search')
    expect(row!.title).toBe('victim title')
    expect(row!.status).toBe('done')
    expect(JSON.parse(row!.serializedContext)).toEqual({ events: [{ id: 'victim' }] })
    // And nothing became visible to the attacker either.
    expect(await loadConversation(id, attacker)).toBeNull()
  })

  it('only returns rows for the requesting user', async () => {
    if (!dbAvailable) return
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
    })
    const otherUser = `other-${Math.random().toString(36).slice(2, 10)}`
    const stolen = await loadConversation(id, otherUser)
    expect(stolen).toBeNull()
  })

  it('getConversationOwner answers who a row belongs to, and null for an unknown id', async () => {
    if (!dbAvailable) return
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
    })
    expect(await getConversationOwner(id)).toBe(TEST_USER)
    expect(await getConversationOwner(`missing-${id}`)).toBeNull()
  })

  it('lists newest-created first, scoped to user', async () => {
    if (!dbAvailable) return
    // Serialize inserts so created_at ordering is deterministic (#105 sorts
    // by creation, not update). Promise.all would race them, and Postgres
    // NOW() can return identical values for sub-millisecond inserts.
    const ids: string[] = []
    for (const n of [1, 2, 3]) {
      const id = `conv-list-${n}-${Math.random().toString(36).slice(2, 8)}`
      await saveConversation({
        id,
        userId: TEST_USER,
        agentId: 'search',
        title: `t${n}`,
        serializedContext: '{}',
      })
      await new Promise((r) => setTimeout(r, 15))
      ids.push(id)
    }
    const list = await listConversations(TEST_USER)
    const seen = list.map((r) => r.id).filter((id) => ids.includes(id))
    // Most recent insert appears first
    expect(seen[0]).toBe(ids[2])
    expect(seen[2]).toBe(ids[0])
  })

  // #105: sort by creation, not activity. A turn-save bumps updated_at; that
  // must NOT reshuffle the sidebar (the exact churn users saw with several
  // concurrent runs saving turns).
  it('an updated_at bump does not reorder the list', async () => {
    if (!dbAvailable) return
    const older = `conv-order-a-${Math.random().toString(36).slice(2, 8)}`
    const newer = `conv-order-b-${Math.random().toString(36).slice(2, 8)}`
    for (const id of [older, newer]) {
      await saveConversation({
        id,
        userId: TEST_USER,
        agentId: 'search',
        title: 't',
        serializedContext: '{}',
      })
      await new Promise((r) => setTimeout(r, 15))
    }
    // Re-save the OLDER one — upsert path sets updated_at = NOW().
    await saveConversation({
      id: older,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{"turn":2}',
    })
    const seen = (await listConversations(TEST_USER))
      .map((r) => r.id)
      .filter((id) => id === older || id === newer)
    expect(seen).toEqual([newer, older])
  })

  it('deleteConversation only deletes when user matches', async () => {
    if (!dbAvailable) return
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
    })

    await deleteConversation(id, 'wrong-user')
    expect(await loadConversation(id, TEST_USER)).not.toBeNull()

    await deleteConversation(id, TEST_USER)
    expect(await loadConversation(id, TEST_USER)).toBeNull()
  })

  // #71 bulk delete: one round trip, user-scoped, returns ground truth.
  it("deleteConversations removes only the caller's own rows and reports them", async () => {
    if (!dbAvailable) return
    const mk = () => `conv-bulk-${Math.random().toString(36).slice(2, 10)}`
    const own1 = mk()
    const own2 = mk()
    const foreignId = mk()
    const foreignUser = `other-${Math.random().toString(36).slice(2, 10)}`
    for (const [id, userId] of [
      [own1, TEST_USER],
      [own2, TEST_USER],
      [foreignId, foreignUser],
    ] as const) {
      await saveConversation({
        id,
        userId,
        agentId: 'search',
        title: 't',
        serializedContext: '{}',
      })
    }
    try {
      const deleted = await deleteConversations([own1, own2, foreignId, 'missing-id'], TEST_USER)
      // Own rows deleted and reported; foreign + unknown ids silently skipped.
      expect([...deleted].sort()).toEqual([own1, own2].sort())
      expect(await loadConversation(own1, TEST_USER)).toBeNull()
      expect(await loadConversation(own2, TEST_USER)).toBeNull()
      expect(await loadConversation(foreignId, foreignUser)).not.toBeNull()
    } finally {
      // afterAll only sweeps TEST_USER rows — clean the foreign seed here.
      await query('DELETE FROM conversations WHERE user_id = $1', [foreignUser])
    }
  })

  it('deleteConversations no-ops on an empty id list', async () => {
    if (!dbAvailable) return
    expect(await deleteConversations([], TEST_USER)).toEqual([])
  })
})

describe('action kind/source/status (agent trigger endpoint)', () => {
  it('defaults to conversation/chat for the normal save path', async () => {
    if (!dbAvailable) return
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
    })
    const loaded = await loadConversation(id, TEST_USER)
    expect(loaded!.kind).toBe('conversation')
    expect(loaded!.source).toBe('chat')
  })

  it('inserts an action with source=post and refreshes status, keeping kind/source immutable on update', async () => {
    if (!dbAvailable) return
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    // Route's seed insert.
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'Voice action',
      serializedContext: JSON.stringify({ events: [], status: 'running' }),
      kind: 'action',
      source: 'post',
      status: 'running',
    })
    let loaded = await loadConversation(id, TEST_USER)
    expect(loaded!.kind).toBe('action')
    expect(loaded!.source).toBe('post')
    expect(loaded!.status).toBe('running')

    // Background run's completion save — passes default kind/source but the
    // UPDATE must preserve the action's provenance while refreshing status.
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'derived-from-command', // sticky → ignored
      serializedContext: JSON.stringify({ events: [{ id: 'a' }], status: 'done' }),
      status: 'done',
    })
    loaded = await loadConversation(id, TEST_USER)
    expect(loaded!.kind).toBe('action') // NOT demoted
    expect(loaded!.source).toBe('post')
    expect(loaded!.status).toBe('done') // refreshed
    expect(loaded!.title).toBe('Voice action') // sticky
  })

  it('promoteConversation flips action → conversation, scoped to user + idempotent', async () => {
    if (!dbAvailable) return
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
      kind: 'action',
      source: 'post',
      status: 'done',
    })

    // Wrong user → no-op.
    await promoteConversation(id, 'someone-else')
    expect((await loadConversation(id, TEST_USER))!.kind).toBe('action')

    // Correct user → promoted.
    await promoteConversation(id, TEST_USER)
    expect((await loadConversation(id, TEST_USER))!.kind).toBe('conversation')

    // Idempotent re-promote stays a conversation.
    await promoteConversation(id, TEST_USER)
    expect((await loadConversation(id, TEST_USER))!.kind).toBe('conversation')
  })

  it('setConversationStatus updates status without touching context (scoped to user)', async () => {
    if (!dbAvailable) return
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    const ctx = JSON.stringify({ events: [], status: 'running' })
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: ctx,
      kind: 'action',
      source: 'post',
      status: 'running',
    })

    await setConversationStatus(id, 'wrong-user', 'error')
    expect((await loadConversation(id, TEST_USER))!.status).toBe('running')

    await setConversationStatus(id, TEST_USER, 'error')
    const loaded = await loadConversation(id, TEST_USER)
    expect(loaded!.status).toBe('error')
    // Context blob untouched.
    expect(loaded!.serializedContext).toBe(ctx)
  })

  it('listConversations surfaces kind/source/status', async () => {
    if (!dbAvailable) return
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
      kind: 'action',
      source: 'post',
      status: 'running',
    })
    const row = (await listConversations(TEST_USER)).find((r) => r.id === id)
    expect(row).toBeDefined()
    expect(row!.kind).toBe('action')
    expect(row!.source).toBe('post')
    expect(row!.status).toBe('running')
  })
})

/**
 * The stuck-run reaper's round trip (#273 D-a). The statement itself is pinned
 * hermetically in `stuck-run-reaper.test.ts`; what only a real database can
 * answer is here — whose clock decides staleness, and what two concurrent
 * sweepers see.
 *
 * Every row is seeded under `TEST_USER` and then backdated, because
 * `saveConversation` stamps `updated_at = NOW()` and the reaper's whole input is
 * that timestamp. The reap is CROSS-USER by design, so these assertions are
 * about specific ids rather than about the size of the returned list — another
 * suite's abandoned row may legitimately ride along.
 */
describe('reapStuckConversations', () => {
  /** Seed one row, then age its `updated_at` by `ageMinutes`. */
  async function seed(id: string, status: 'running' | 'paused' | 'done', age: number) {
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: null,
      serializedContext: '{}',
      status,
    })
    await query(
      `UPDATE conversations SET updated_at = NOW() - INTERVAL '${age} minutes'
        WHERE id = $1 AND user_id = $2`,
      [id, TEST_USER],
    )
  }

  async function statusOf(id: string): Promise<string | null> {
    const { rows } = await query<{ status: string }>(
      'SELECT status FROM conversations WHERE id = $1',
      [id],
    )
    return rows[0]?.status ?? null
  }

  const past = STUCK_RUN_TIMEOUT_MINUTES + 5

  it('reaps an abandoned run and leaves every other row alone', async () => {
    if (!dbAvailable) return
    const tag = Math.random().toString(36).slice(2, 8)
    const stale = `reap-stale-${tag}`
    const fresh = `reap-fresh-${tag}`
    const paused = `reap-paused-${tag}`
    const finished = `reap-done-${tag}`
    await seed(stale, 'running', past)
    await seed(fresh, 'running', 1)
    await seed(paused, 'paused', past)
    await seed(finished, 'done', past)

    const reaped = await reapStuckConversations()

    expect(reaped).toContain(stale)
    expect(await statusOf(stale)).toBe('error')
    // A turn that is merely slow keeps its spinner — that is the threshold
    // doing its job, and the reason it is measured in tens of minutes.
    expect(reaped).not.toContain(fresh)
    expect(await statusOf(fresh)).toBe('running')
    // An approval gate waits for a person for as long as that takes.
    expect(reaped).not.toContain(paused)
    expect(await statusOf(paused)).toBe('paused')
    expect(await statusOf(finished)).toBe('done')
  })

  it('is idempotent — a second sweep finds nothing to do', async () => {
    if (!dbAvailable) return
    const id = `reap-twice-${Math.random().toString(36).slice(2, 8)}`
    await seed(id, 'running', past)

    expect(await reapStuckConversations()).toContain(id)
    expect(await reapStuckConversations()).not.toContain(id)
  })

  it('reports a row to exactly one of two concurrent sweepers', async () => {
    if (!dbAvailable) return
    const id = `reap-race-${Math.random().toString(36).slice(2, 8)}`
    await seed(id, 'running', past)

    // Two app instances, no leader election, the same 30s tick. Postgres takes
    // a row lock per UPDATE, so once the first sweeper has flipped the status
    // the second one's WHERE no longer matches it — which is what makes
    // `status` the claim, and this sweep safe to arm on every instance.
    const [a, b] = await Promise.all([reapStuckConversations(), reapStuckConversations()])
    expect([...a, ...b].filter((reaped) => reaped === id)).toHaveLength(1)
  })

  it('does not make a reaped row look like recent user activity', async () => {
    if (!dbAvailable) return
    const id = `reap-activity-${Math.random().toString(36).slice(2, 8)}`
    await seed(id, 'running', past)

    await reapStuckConversations()

    const { rows } = await query<{ stale: boolean }>(
      `SELECT updated_at < NOW() - INTERVAL '${STUCK_RUN_TIMEOUT_MINUTES} minutes' AS stale
         FROM conversations WHERE id = $1`,
      [id],
    )
    // `countActiveUsers` counts owners of rows touched in the last 15 minutes.
    // Had the reap bumped `updated_at`, every reaped conversation's owner would
    // appear in the preview header's "active" figure.
    expect(rows[0].stale).toBe(true)
  })
})
