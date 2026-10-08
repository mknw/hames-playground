/**
 * Round-trip test for conversations CRUD.
 *
 * Hits the live Postgres container from docker-compose. Skips gracefully
 * when Postgres isn't reachable so this works on machines without docker.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

// Bypass server-only guard in jsdom test env
import { vi } from 'vitest'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  claimConversation,
  createConversation,
  loadConversation,
  releaseConversationClaim,
  renewConversationClaim,
  saveConversation,
  ConversationBusyError,
  ConversationConflictError,
  TURN_CLAIM_TTL_SECONDS,
  updateConversationTitle,
  shareConversation,
  type ConversationStatus,
  type CreateConversationInput,
  type SaveConversationInput,
  listConversations,
  deleteConversation,
  deleteConversations,
  deriveTitle,
  getConversationOwner,
  promoteConversation,
  updateConversationContextIfUnchanged,
  setConversationInferenceTier,
  getConversationInferenceTier,
  backfillConversationInferenceTier,
  setConversationPinned,
  reapStuckConversations,
  CONVERSATION_PIN_LIMIT,
  STUCK_RUN_TIMEOUT_MINUTES,
} from '../../../lib/db/conversations.server'
import { closePool, query } from '../../../lib/db/client.server'
import { setStoredInferenceTier } from '../../../lib/db/user-prefs.server'

const TEST_USER = `test-user-${Math.random().toString(36).slice(2, 10)}`

/**
 * A row the way a finished turn leaves it: created, claimed, by the turn it is
 * created for, then saved at that claim, which releases it. Returns the
 * version the row ends at.
 */
async function seedRow(input: CreateConversationInput): Promise<string> {
  const held = await createConversation(input)
  return saveConversation({ ...input, status: input.status ?? 'done', version: held })
}

/** One more turn on an existing row: claim it, then save at that claim. */
async function saveTurn(
  input: Omit<SaveConversationInput, 'version' | 'status'> & { status?: ConversationStatus },
): Promise<string> {
  const claimed = await claimConversation(input.id, input.userId)
  if (!claimed) throw new Error(`no row ${input.id} for ${input.userId}`)
  return saveConversation({ ...input, status: input.status ?? 'done', version: claimed.version })
}

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
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('round-trips a serialized context unchanged', async () => {
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

    await seedRow({
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

  it("a later turn's save replaces the context and keeps the title", async () => {
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`

    await seedRow({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'first title',
      serializedContext: JSON.stringify({ events: [] }),
    })

    // Second write: try to change the title — should be ignored (sticky)
    await saveTurn({
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
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'victim title',
      serializedContext: JSON.stringify({ events: [{ id: 'victim' }] }),
      status: 'done',
    })

    // The attacker's runTurn sees no row (loadSession is user-scoped), so it
    // blind-INSERTs — which conflicts. The owner-scoped upsert must write no
    // rows, and must SAY SO: the write is the last step of a turn that has
    // already run, answered and been billed, so swallowing the 0-row upsert
    // loses that turn silently (`event: done`, an assistant bubble, and no
    // conversation on reload). Reachable from the URL — `/?c=<someone else's
    // id>` is enough.
    const attacker = `attacker-${Math.random().toString(36).slice(2, 10)}`
    const saving = createConversation({
      id,
      userId: attacker,
      agentId: 'evil-agent',
      title: 'clobbered',
      serializedContext: JSON.stringify({ events: [] }),
      status: 'running',
    })
    await expect(saving).rejects.toThrow(/could not be saved/)
    // And pins the ABSENCE of the ownership fact, not just the presence of the
    // new wording: this message is rendered verbatim in the browser
    // (turn.server.ts:267 -> events.ts:131 -> an error bubble), so "belongs to
    // another user" belongs in the log and nowhere else.
    await expect(saving).rejects.not.toThrow(/another user/i)

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
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
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

  // `/api/stash` loads the whole blob, flips a flag on one event and writes the
  // blob back. Its competing writer is the turn's own `compactAndSave`, which
  // fires just after the answer lands — so the window opens exactly when a user
  // acts on a tool result. Unguarded, whichever write is second wins outright:
  // the flag vanishes, or the turn's whole event set is replaced by the blob
  // this route loaded before it.
  describe('updateConversationContextIfUnchanged', () => {
    it('writes at the version it read, and refuses once the row has moved on', async () => {
      const id = `conv-cas-${Math.random().toString(36).slice(2, 10)}`
      await seedRow({
        id,
        userId: TEST_USER,
        agentId: 'search',
        title: 't',
        serializedContext: JSON.stringify({ events: ['turn-1'] }),
      })

      const read = (await loadConversation(id, TEST_USER))!
      expect(
        await updateConversationContextIfUnchanged(
          id,
          TEST_USER,
          JSON.stringify({ events: ['turn-1', 'hidden'] }),
          read.version,
        ),
      ).toBe(true)

      // Same version again: the row now carries the one that write produced.
      expect(
        await updateConversationContextIfUnchanged(
          id,
          TEST_USER,
          JSON.stringify({ events: ['stale'] }),
          read.version,
        ),
      ).toBe(false)

      const after = (await loadConversation(id, TEST_USER))!
      expect(JSON.parse(after.serializedContext)).toEqual({ events: ['turn-1', 'hidden'] })
      expect(after.version).not.toBe(read.version)
    })

    it('refuses a stale write after a concurrent turn, leaving the turn intact', async () => {
      const id = `conv-cas-${Math.random().toString(36).slice(2, 10)}`
      await seedRow({
        id,
        userId: TEST_USER,
        agentId: 'search',
        title: 't',
        serializedContext: JSON.stringify({ events: ['turn-1'] }),
      })

      const read = (await loadConversation(id, TEST_USER))!
      // The turn's own save lands in between.
      await saveTurn({
        id,
        userId: TEST_USER,
        agentId: 'search',
        title: 't',
        serializedContext: JSON.stringify({ events: ['turn-1', 'turn-2'] }),
      })

      expect(
        await updateConversationContextIfUnchanged(
          id,
          TEST_USER,
          JSON.stringify({ events: ['turn-1', 'hidden'] }),
          read.version,
        ),
      ).toBe(false)

      const after = (await loadConversation(id, TEST_USER))!
      expect(JSON.parse(after.serializedContext)).toEqual({ events: ['turn-1', 'turn-2'] })
    })

    it('refuses a write from someone who is not the owner', async () => {
      const id = `conv-cas-${Math.random().toString(36).slice(2, 10)}`
      await seedRow({
        id,
        userId: TEST_USER,
        agentId: 'search',
        title: 't',
        serializedContext: JSON.stringify({ events: ['mine'] }),
      })
      const read = (await loadConversation(id, TEST_USER))!

      const attacker = `attacker-${Math.random().toString(36).slice(2, 10)}`
      expect(
        await updateConversationContextIfUnchanged(
          id,
          attacker,
          JSON.stringify({ events: [] }),
          read.version,
        ),
      ).toBe(false)

      const after = (await loadConversation(id, TEST_USER))!
      expect(JSON.parse(after.serializedContext)).toEqual({ events: ['mine'] })
    })
  })

  it('getConversationOwner answers who a row belongs to, and null for an unknown id', async () => {
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
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
    // Serialize inserts so created_at ordering is deterministic (#105 sorts
    // by creation, not update). Promise.all would race them, and Postgres
    // NOW() can return identical values for sub-millisecond inserts.
    const ids: string[] = []
    for (const n of [1, 2, 3]) {
      const id = `conv-list-${n}-${Math.random().toString(36).slice(2, 8)}`
      await seedRow({
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
    const older = `conv-order-a-${Math.random().toString(36).slice(2, 8)}`
    const newer = `conv-order-b-${Math.random().toString(36).slice(2, 8)}`
    for (const id of [older, newer]) {
      await seedRow({
        id,
        userId: TEST_USER,
        agentId: 'search',
        title: 't',
        serializedContext: '{}',
      })
      await new Promise((r) => setTimeout(r, 15))
    }
    // Re-save the OLDER one — upsert path sets updated_at = NOW().
    await saveTurn({
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
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
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
      await seedRow({
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
    expect(await deleteConversations([], TEST_USER)).toEqual([])
  })
})

/**
 * One turn at a time, and every save at the version it read (#458). The turn
 * runner's use of these is pinned with mocks in `turn.test.ts` and end to end
 * in `context-row-lost-updates.test.ts`; what only a real database can answer
 * is here — that the statements themselves refuse.
 */
describe('the turn claim and the versioned save', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  const mkId = () => `claim-${Math.random().toString(36).slice(2, 10)}`
  const row = (id: string, serializedContext = '{"turn":1}') => ({
    id,
    userId: TEST_USER,
    agentId: 'search',
    title: 't',
    serializedContext,
  })
  /** Age a live claim past the lease, as a holder that died would leave it. */
  const lapse = (id: string) =>
    query(
      `UPDATE conversations SET turn_claimed_at = NOW() - INTERVAL '${TURN_CLAIM_TTL_SECONDS + 5} seconds'
        WHERE id = $1`,
      [id],
    )

  // MUTATION: drop `${NO_LIVE_CLAIM}` from claimConversation → the second
  // claim succeeds and the busy assertion reddens.
  it('is exclusive: a second claim is refused until the first is released', async () => {
    const id = mkId()
    const seeded = await seedRow(row(id))

    const first = (await claimConversation(id, TEST_USER))!
    // Claim and read are one statement, at a version the claim moved on.
    expect(JSON.parse(first.serializedContext)).toEqual({ turn: 1 })
    expect(first.version).not.toBe(seeded)

    await expect(claimConversation(id, TEST_USER)).rejects.toBeInstanceOf(ConversationBusyError)
    await expect(claimConversation(id, TEST_USER)).rejects.toThrow(
      /turn is still running in this conversation/,
    )

    expect(await releaseConversationClaim(id, TEST_USER, first.version)).toBe(true)
    expect(await claimConversation(id, TEST_USER)).not.toBeNull()
  })

  it('answers null for an unknown id and for someone else’s, claiming nothing', async () => {
    const id = mkId()
    await seedRow(row(id))
    expect(await claimConversation(`missing-${id}`, TEST_USER)).toBeNull()
    expect(await claimConversation(id, `${TEST_USER}-other`)).toBeNull()
    // The owner's row was not claimed by either.
    expect(await claimConversation(id, TEST_USER)).not.toBeNull()
  })

  // MUTATION: drop `AND context_version = $8` from saveConversation → the
  // stale save lands and both assertions on it redden.
  it('saves only at the version the claim holds, and the save releases the claim', async () => {
    const id = mkId()
    await seedRow(row(id))
    const held = (await claimConversation(id, TEST_USER))!

    const stale = String(Number(held.version) - 1)
    await expect(
      saveConversation({ ...row(id, '{"stale":true}'), status: 'done', version: stale }),
    ).rejects.toBeInstanceOf(ConversationConflictError)
    expect(JSON.parse((await loadConversation(id, TEST_USER))!.serializedContext)).toEqual({
      turn: 1,
    })

    const written = await saveConversation({
      ...row(id, '{"turn":2}'),
      status: 'done',
      version: held.version,
    })
    expect(written).not.toBe(held.version)
    const after = (await loadConversation(id, TEST_USER))!
    expect(JSON.parse(after.serializedContext)).toEqual({ turn: 2 })
    expect(after.version).toBe(written)
    // MUTATION: drop `turn_claimed_at = NULL` from the save → this claim is
    // refused as busy.
    expect(await claimConversation(id, TEST_USER)).not.toBeNull()
  })

  // Why the version is `context_version` and not `xmin`: every one of these is
  // an UPDATE of the row, each may happen while a turn runs, and none of them
  // touches `context`. On `xmin` each would have failed the turn's save.
  it('lets a pin, a share, a tier flip and a title land mid-turn without failing the turn', async () => {
    const id = mkId()
    await seedRow(row(id))
    const held = (await claimConversation(id, TEST_USER))!

    await setConversationPinned(id, TEST_USER, true)
    await shareConversation(id, TEST_USER)
    await setConversationInferenceTier(id, TEST_USER, 'verda')
    await updateConversationTitle(id, TEST_USER, 'A better title')

    await expect(
      saveConversation({ ...row(id, '{"turn":2}'), status: 'done', version: held.version }),
    ).resolves.toBeTypeOf('string')
    const after = (await loadConversation(id, TEST_USER))!
    expect(JSON.parse(after.serializedContext)).toEqual({ turn: 2 })
    expect(after.title).toBe('A better title')
  })

  // A turn whose process died must not lock its conversation for good.
  // MUTATION: drop the `turn_claimed_at < NOW() - INTERVAL …` arm of
  // NO_LIVE_CLAIM → the takeover claim is refused as busy.
  it('treats a claim not renewed within the lease as dead, and refuses the old holder’s save', async () => {
    const id = mkId()
    await seedRow(row(id))
    const dead = (await claimConversation(id, TEST_USER))!
    await lapse(id)

    const next = (await claimConversation(id, TEST_USER))!
    expect(next).not.toBeNull()

    // The old holder was only slow after all: its save must not land over the
    // turn that took the row.
    await expect(
      saveConversation({ ...row(id, '{"late":true}'), status: 'done', version: dead.version }),
    ).rejects.toBeInstanceOf(ConversationConflictError)
    // Nor may its failure path free the new holder's row or mark it failed.
    expect(await releaseConversationClaim(id, TEST_USER, dead.version, { failed: true })).toBe(
      false,
    )
    await expect(claimConversation(id, TEST_USER)).rejects.toBeInstanceOf(ConversationBusyError)

    await saveConversation({ ...row(id, '{"turn":2}'), status: 'done', version: next.version })
    const after = (await loadConversation(id, TEST_USER))!
    expect(JSON.parse(after.serializedContext)).toEqual({ turn: 2 })
    expect(after.status).toBe('done')
  })

  // MUTATION: make renewConversationClaim a no-op → the lapsed claim is taken.
  it('keeps a renewed claim live past the lease, and renews only the holder’s', async () => {
    const id = mkId()
    await seedRow(row(id))
    const held = (await claimConversation(id, TEST_USER))!
    await lapse(id)

    expect(await renewConversationClaim(id, TEST_USER, String(Number(held.version) + 1))).toBe(
      false,
    )
    expect(await renewConversationClaim(id, TEST_USER, held.version)).toBe(true)
    await expect(claimConversation(id, TEST_USER)).rejects.toBeInstanceOf(ConversationBusyError)
  })

  it('creates a row claimed, and refuses a second create of the same new chat', async () => {
    const id = mkId()
    const held = await createConversation(row(id))
    // Two first messages on one new chat: the second is a second turn.
    await expect(createConversation(row(id, '{"second":true}'))).rejects.toBeInstanceOf(
      ConversationBusyError,
    )
    await expect(claimConversation(id, TEST_USER)).rejects.toBeInstanceOf(ConversationBusyError)
    expect(JSON.parse((await loadConversation(id, TEST_USER))!.serializedContext)).toEqual({
      turn: 1,
    })
    await saveConversation({ ...row(id, '{"turn":1,"done":true}'), status: 'done', version: held })
  })

  // MUTATION: drop `${NO_LIVE_CLAIM}` from updateConversationContextIfUnchanged
  // → the flip lands at the version it read, under a live turn.
  it('refuses a flag flip or a summary pass while a turn holds the row', async () => {
    const id = mkId()
    await seedRow(row(id))
    const held = (await claimConversation(id, TEST_USER))!
    // Read AFTER the claim, so the version is current and only the claim stands
    // in the way.
    const read = (await loadConversation(id, TEST_USER))!
    expect(read.version).toBe(held.version)

    expect(
      await updateConversationContextIfUnchanged(id, TEST_USER, '{"flag":true}', read.version),
    ).toBe(false)

    expect(await releaseConversationClaim(id, TEST_USER, held.version)).toBe(true)
    expect(
      await updateConversationContextIfUnchanged(id, TEST_USER, '{"flag":true}', read.version),
    ).toBe(true)
    expect(JSON.parse((await loadConversation(id, TEST_USER))!.serializedContext)).toEqual({
      flag: true,
    })
  })

  // SD-11. A first turn still running when its chat is deleted holds the
  // deleted row's version; a second tab on `?c=<id>` then recreates the id.
  // On a per-row count both rows start at the same number, and the old turn's
  // save lands in the new row — resurrecting the deleted conversation and
  // releasing the new turn's claim.
  // MUTATION: the column's insert default back to 0 (a per-row count) → the
  // old save lands and this reddens.
  it('never repeats a version, so a turn on a deleted conversation cannot save into its recreation', async () => {
    const id = mkId()
    const deleted = await createConversation(row(id, '{"deleted":true}'))
    await deleteConversation(id, TEST_USER)
    const recreated = await createConversation(row(id, '{"recreated":true}'))
    expect(recreated).not.toBe(deleted)

    await expect(
      saveConversation({ ...row(id, '{"resurrected":true}'), status: 'done', version: deleted }),
    ).rejects.toBeInstanceOf(ConversationConflictError)
    expect(JSON.parse((await loadConversation(id, TEST_USER))!.serializedContext)).toEqual({
      recreated: true,
    })
    // Still the new turn's: its claim was not released by the old save.
    await expect(claimConversation(id, TEST_USER)).rejects.toBeInstanceOf(ConversationBusyError)
    await saveConversation({ ...row(id), status: 'done', version: recreated })
  })

  // The other half of "never repeats": a claim, a save and a flag write each
  // draw a NEW number, never `+ 1` on the row's own. Another row's create in
  // between is what tells the two apart — the sequence has moved past it, a
  // per-row `+ 1` has not.
  // MUTATION: `context_version + 1` in place of the sequence in the three
  // UPDATEs → the first assertion reddens. Each later one would too: on a
  // per-row count the row's k-th write is its first number + k, and the k-th
  // number drawn by `past()` is at least that.
  it('draws every new version past any number already handed out', async () => {
    const id = mkId()
    // Created and released, not seeded through a save: the row's number must
    // be one the sequence handed out, for the comparison below to mean anything.
    const created = await createConversation(row(id))
    await releaseConversationClaim(id, TEST_USER, created)
    const past = async () => Number(await createConversation(row(mkId())))

    let floor = await past()
    const held = (await claimConversation(id, TEST_USER))!
    expect(Number(held.version)).toBeGreaterThan(floor)

    floor = await past()
    const saved = await saveConversation({ ...row(id), status: 'done', version: held.version })
    expect(Number(saved)).toBeGreaterThan(floor)

    floor = await past()
    expect(await updateConversationContextIfUnchanged(id, TEST_USER, '{"flag":1}', saved)).toBe(
      true,
    )
    expect(Number((await loadConversation(id, TEST_USER))!.version)).toBeGreaterThan(floor)
  })

  // A release never moves the version, so without `turn_claimed_at IS NOT
  // NULL` a renewal landing after a failure release (or a stale-approval
  // release) would claim the row again for a whole lease, and the user's
  // retry would be refused as busy.
  // MUTATION: drop `AND turn_claimed_at IS NOT NULL` from
  // renewConversationClaim → the renewal succeeds and the claim is refused.
  it('does not let a late renewal re-claim a released conversation', async () => {
    const id = mkId()
    const held = await createConversation(row(id))
    expect(await releaseConversationClaim(id, TEST_USER, held, { failed: true })).toBe(true)

    expect(await renewConversationClaim(id, TEST_USER, held)).toBe(false)
    expect(await claimConversation(id, TEST_USER)).not.toBeNull()
  })
  // Owner item 1 on review 6004200697 (coordinator decision, pending owner
  // read): a `chain-changed` refusal ends the pause TERMINALLY, and the m3
  // load-restore must be able to tell that `error` apart from a failed
  // superseding message's — BOTH leave the blob `paused`, so the marker is
  // the only difference. Pinned here: the terminal release stamps it, a
  // plain failure neither stamps nor clears it, and the conversation's next
  // successful save — the turn that moved it on — clears it.
  // MUTATION: drop `hitl_ended_at = NOW()` from the terminal release → the
  // first assertion reddens. Stamp it on every failed release → the second
  // row's assertion reddens. Drop `hitl_ended_at = NULL` from
  // saveConversation → the last assertion reddens.
  it('a chain-changed release ends the pause terminally; a plain failure does not, and the next save clears it', async () => {
    const id = mkId()
    const paused = JSON.stringify({ events: [], status: 'paused' })
    const held = await createConversation({ ...row(id, paused), status: 'paused' })

    // The terminal refusal: error, and marked, so the m3 load-restore
    // exempts this row instead of resurrecting the pause.
    expect(
      await releaseConversationClaim(id, TEST_USER, held, { failed: true, hitlTerminal: true }),
    ).toBe(true)
    const refused = (await loadConversation(id, TEST_USER))!
    expect(refused.status).toBe('error')
    expect(refused.hitlEndedAt).not.toBeNull()

    // A LATER plain failure on the same conversation is not an un-termaling:
    // the chain-changed verdict stands, and the marker must outlive it.
    const again = (await claimConversation(id, TEST_USER))!
    expect(await releaseConversationClaim(id, TEST_USER, again.version, { failed: true })).toBe(
      true,
    )
    expect((await loadConversation(id, TEST_USER))!.hitlEndedAt).not.toBeNull()

    // The next successful save is the turn that moved the conversation on:
    // the marker goes, so a later pause's drift is repairable again.
    const third = (await claimConversation(id, TEST_USER))!
    await saveConversation({
      ...row(id, JSON.stringify({ events: [], status: 'done' })),
      status: 'done',
      version: third.version,
    })
    expect((await loadConversation(id, TEST_USER))!.hitlEndedAt).toBeNull()

    // And a plain failure ALONE sets no marker — that row's `error` is the
    // drift the m3 repair exists for (a failed superseding message).
    const other = mkId()
    const otherHeld = await createConversation({ ...row(other, paused), status: 'paused' })
    expect(await releaseConversationClaim(other, TEST_USER, otherHeld, { failed: true })).toBe(true)
    const plain = (await loadConversation(other, TEST_USER))!
    expect(plain.status).toBe('error')
    expect(plain.hitlEndedAt).toBeNull()
  })

  // A row that cannot be read (a wrong key, a corrupt blob) must not stay
  // claimed for a lease after the claim that read it threw.
  // MUTATION: drop the release in claimConversation's decrypt catch → the
  // second claim is refused as busy.
  it('lets go of a claim whose row cannot be decrypted', async () => {
    const id = mkId()
    await seedRow(row(id))
    // A JSONB string that is not an envelope: `decryptJsonb` refuses it.
    await query(`UPDATE conversations SET context = '"not an envelope"'::jsonb WHERE id = $1`, [id])
    try {
      await expect(claimConversation(id, TEST_USER)).rejects.toThrow()
      const again = claimConversation(id, TEST_USER)
      await expect(again).rejects.toThrow()
      await expect(again).rejects.not.toBeInstanceOf(ConversationBusyError)
    } finally {
      await deleteConversation(id, TEST_USER)
    }
  })

  // After a deploy or a crash the holder is gone, and "still running… wait for
  // it to finish" asks the user to wait for a turn that will never finish.
  // MUTATION: always use the "still running" text → this reddens.
  it('says the last turn was interrupted, and when to resend, once the holder stops renewing', async () => {
    const id = mkId()
    await seedRow(row(id))
    await claimConversation(id, TEST_USER)
    await query(
      `UPDATE conversations SET turn_claimed_at = NOW() - INTERVAL '60 seconds' WHERE id = $1`,
      [id],
    )

    await expect(claimConversation(id, TEST_USER)).rejects.toThrow(
      /^The last turn in this conversation was interrupted\. You can send again in about (5[89]|60) seconds\.$/,
    )
  })
})

describe('action kind/source/status (agent trigger endpoint)', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('defaults to conversation/chat for the normal save path', async () => {
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
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
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    // Route's seed insert — created claimed for the background run.
    const held = await createConversation({
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

    // Background run's completion save, at the seed's claim — the UPDATE must
    // preserve the action's provenance while refreshing status.
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'derived-from-command', // sticky → ignored
      serializedContext: JSON.stringify({ events: [{ id: 'a' }], status: 'done' }),
      status: 'done',
      version: held,
    })
    loaded = await loadConversation(id, TEST_USER)
    expect(loaded!.kind).toBe('action') // NOT demoted
    expect(loaded!.source).toBe('post')
    expect(loaded!.status).toBe('done') // refreshed
    expect(loaded!.title).toBe('Voice action') // sticky
  })

  it('promoteConversation flips action → conversation, scoped to user + idempotent', async () => {
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
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

  // The run's failure path (sf-M2/sf-M3): a row whose run threw must not keep
  // showing as running. Fenced by the claim, so neither a wrong owner nor a
  // version the claim does not hold flips anything.
  it('a failed release flips status to error without touching context, fenced by the claim', async () => {
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    const ctx = JSON.stringify({ events: [], status: 'running' })
    const held = await createConversation({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: ctx,
      kind: 'action',
      source: 'post',
      status: 'running',
    })

    expect(await releaseConversationClaim(id, 'wrong-user', held, { failed: true })).toBe(false)
    const notHeld = String(Number(held) + 7)
    expect(await releaseConversationClaim(id, TEST_USER, notHeld, { failed: true })).toBe(false)
    expect((await loadConversation(id, TEST_USER))!.status).toBe('running')

    expect(await releaseConversationClaim(id, TEST_USER, held, { failed: true })).toBe(true)
    const loaded = await loadConversation(id, TEST_USER)
    expect(loaded!.status).toBe('error')
    // Context blob untouched.
    expect(loaded!.serializedContext).toBe(ctx)
    // And the conversation is free for the next turn.
    expect(await claimConversation(id, TEST_USER)).not.toBeNull()
  })

  it('listConversations surfaces kind/source/status', async () => {
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
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
describe('inference_tier (the per-conversation switch)', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('is absent until something records one — NULL is not a tier', async () => {
    const id = `tier-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
    })
    // A row with no tier of its own. The resolver reads this as "fall through
    // to the seed", which is what a legacy row has to do — a NOT NULL DEFAULT
    // would have claimed every one of them ran on whichever literal was picked.
    expect(await getConversationInferenceTier(id, TEST_USER)).toBeNull()
    expect((await loadConversation(id, TEST_USER))!.inferenceTier).toBeNull()
  })

  it('is recorded by the save that creates the row, and STICKS across later saves', async () => {
    const id = `tier-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{"turn":1}',
      inferenceTier: 'verda',
    })
    // The user flips mid-conversation…
    await setConversationInferenceTier(id, TEST_USER, 'anthropic')
    // …and the NEXT turn saves under the tier it started on. If that save
    // refreshed the column instead of COALESCing it, the flip would be undone
    // by the very turn that was still finishing when it was made.
    await saveTurn({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{"turn":2}',
      inferenceTier: 'verda',
    })
    expect(await getConversationInferenceTier(id, TEST_USER)).toBe('anthropic')
  })

  it('is FILLED by a later save when the row was created without one', async () => {
    // The action-row shape: `seedActionRow` writes the row before any tier is
    // resolved, so the run's own save is what records where it ran.
    const id = `act-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'triggered',
      serializedContext: '{}',
      kind: 'action',
      source: 'post',
    })
    expect(await getConversationInferenceTier(id, TEST_USER)).toBeNull()

    await saveTurn({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 'triggered',
      serializedContext: '{"done":true}',
      inferenceTier: 'verda',
    })
    expect(await getConversationInferenceTier(id, TEST_USER)).toBe('verda')
  })

  it('setConversationInferenceTier is scoped to the owner and reads back on the list', async () => {
    const id = `tier-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
      inferenceTier: 'anthropic',
    })

    // Someone else's write must change nothing — a wrong userId re-routing a
    // conversation is the failure this scoping exists to prevent.
    await setConversationInferenceTier(id, `${TEST_USER}-other`, 'verda')
    expect(await getConversationInferenceTier(id, TEST_USER)).toBe('anthropic')
    // …and it must not leak the row to the wrong reader either.
    expect(await getConversationInferenceTier(id, `${TEST_USER}-other`)).toBeNull()

    await setConversationInferenceTier(id, TEST_USER, 'verda')
    const listed = (await listConversations(TEST_USER)).find((r) => r.id === id)
    expect(listed!.inferenceTier).toBe('verda')
  })

  it('does NOT bump updated_at — choosing a tier is not chat activity', async () => {
    // `updated_at` is what the sidebar renders as "x ago" and what
    // `countActiveUsers` reads as "this user did something". A flip is neither.
    const id = `tier-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
      id,
      userId: TEST_USER,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
    })
    const before = (await loadConversation(id, TEST_USER))!.updatedAt
    await setConversationInferenceTier(id, TEST_USER, 'verda')
    expect((await loadConversation(id, TEST_USER))!.updatedAt).toEqual(before)
  })
})

describe('backfillConversationInferenceTier', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('copies a RECORDED preference onto that user’s untiered rows, and nothing else', async () => {
    const withPref = `${TEST_USER}-pref`
    const noPref = `${TEST_USER}-nopref`
    const untiered = `bf-${Math.random().toString(36).slice(2, 10)}`
    const alreadyTiered = `bf-${Math.random().toString(36).slice(2, 10)}`
    const foreign = `bf-${Math.random().toString(36).slice(2, 10)}`
    const base = { agentId: 'search', title: 't', serializedContext: '{}' }

    await seedRow({ id: untiered, userId: withPref, ...base })
    await seedRow({ id: alreadyTiered, userId: withPref, ...base, inferenceTier: 'verda' })
    await seedRow({ id: foreign, userId: noPref, ...base })
    // Through the repository that owns the table, so this does not depend on
    // `user_prefs` already existing — it bootstraps its own schema, exactly as
    // it does on a deployment where nobody has flipped the switch yet. (That
    // case is also why the backfill is guarded by `to_regclass`: on a fresh
    // database `initSchema` runs it BEFORE anything creates that table.)
    await setStoredInferenceTier(withPref, 'anthropic')

    try {
      const run = (text: string, params?: unknown[]) => query(text, params)
      await backfillConversationInferenceTier(run)

      // A recorded choice is a FACT about the runs that already happened.
      expect(await getConversationInferenceTier(untiered, withPref)).toBe('anthropic')
      // An existing tier is never overwritten…
      expect(await getConversationInferenceTier(alreadyTiered, withPref)).toBe('verda')
      // …and a user who never chose gets nothing written: their turns ran on
      // `defaultInferenceTier()`, which is host state read per turn, so
      // materialising today's answer would claim a routing nobody observed.
      expect(await getConversationInferenceTier(foreign, noPref)).toBeNull()

      // Idempotent: running it again changes nothing.
      await backfillConversationInferenceTier(run)
      expect(await getConversationInferenceTier(untiered, withPref)).toBe('anthropic')
      expect(await getConversationInferenceTier(alreadyTiered, withPref)).toBe('verda')
    } finally {
      await query('DELETE FROM conversations WHERE user_id = ANY($1)', [[withPref, noPref]])
      await query('DELETE FROM user_prefs WHERE user_id = $1', [withPref])
    }
  })

  it('copies nothing from a stored value this build does not recognise', async () => {
    // The backfill's own rule is "copy a recorded fact, never a guess", and a
    // `user_prefs` value outside the union is not a fact about anything — it is
    // a row written by a build that knew a tier this one does not, or by hand.
    // Copying it would put a value on `conversations.inference_tier` that
    // `resolveTier` narrows straight back out, so the row would read as pinned
    // and resolve as unpinned: worse than the NULL it replaced, because the
    // sidebar glyph renders the column.
    //
    // The column is deliberately un-CONSTRAINED plaintext (a lifted enum, like
    // `kind`/`source`/`status`), so nothing below this statement rejects such a
    // value — which is why the `IN ('verda','anthropic')` filter is the control
    // and why it needs a test of its own.
    const unknownPref = `${TEST_USER}-unknown-pref`
    const untiered = `bf-${Math.random().toString(36).slice(2, 10)}`
    await seedRow({
      id: untiered,
      userId: unknownPref,
      agentId: 'search',
      title: 't',
      serializedContext: '{}',
    })
    // Through the repository first, so `user_prefs` exists and this test does
    // not depend on the bootstrap order; then straight to SQL, because the
    // setter's own type is the union and the row under test is outside it.
    await setStoredInferenceTier(unknownPref, 'anthropic')
    await query('UPDATE user_prefs SET inference_tier = $1 WHERE user_id = $2', [
      'some-future-tier',
      unknownPref,
    ])

    try {
      await backfillConversationInferenceTier((text: string, params?: unknown[]) =>
        query(text, params),
      )

      expect(await getConversationInferenceTier(untiered, unknownPref)).toBeNull()
    } finally {
      await query('DELETE FROM conversations WHERE user_id = $1', [unknownPref])
      await query('DELETE FROM user_prefs WHERE user_id = $1', [unknownPref])
    }
  })
})

describe('reapStuckConversations', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  /** Seed one row, then age its `updated_at` by `ageMinutes`. */
  async function seed(id: string, status: 'running' | 'paused' | 'done', age: number) {
    await seedRow({
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

  it('reaps one minute over the threshold and not one minute under', async () => {
    // The boundary itself, driven rather than argued — the derivation is only
    // worth what the statement does at its edges. Re-driven at the post-#279
    // threshold of 90 minutes (it was 300 when these cases were first run).
    const tag = Math.random().toString(36).slice(2, 8)
    const under = `reap-under-${tag}`
    const over = `reap-over-${tag}`
    // The base review's case: a live 21-minute turn WAS reaped out from under
    // itself under the old 20-minute threshold, which is what made the number
    // derived rather than chosen (#278 F3). It must still survive, and it is the
    // one row here whose age is a fact about the past rather than a fraction of
    // the current constant — so it stays honest if the threshold moves again.
    const live21 = `reap-live21-${tag}`
    await seed(under, 'running', STUCK_RUN_TIMEOUT_MINUTES - 1)
    await seed(over, 'running', STUCK_RUN_TIMEOUT_MINUTES + 1)
    await seed(live21, 'running', 21)

    const reaped = await reapStuckConversations()

    expect(reaped).toContain(over)
    expect(await statusOf(over)).toBe('error')
    expect(reaped).not.toContain(under)
    expect(await statusOf(under)).toBe('running')
    expect(reaped).not.toContain(live21)
    expect(await statusOf(live21)).toBe('running')
  })

  it('is idempotent — a second sweep finds nothing to do', async () => {
    const id = `reap-twice-${Math.random().toString(36).slice(2, 8)}`
    await seed(id, 'running', past)

    expect(await reapStuckConversations()).toContain(id)
    expect(await reapStuckConversations()).not.toContain(id)
  })

  it('reports a row to exactly one of two concurrent sweepers', async () => {
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

// Every test in 'conversation pinning' reads the cap off the constant, so they
// all pass at any value — mutation-checked, and this is what that check bought.
// Three is the owner's product decision (2026-08-27), not a derived number. Its
// own block because it needs no database, so that block's skip must not take it.
describe('conversation pinning: the cap', () => {
  it('caps pinning at three conversations', () => {
    expect(CONVERSATION_PIN_LIMIT).toBe(3)
  })
})

/**
 * Pinned conversations.
 *
 * Every test here gets its OWN user id rather than the file's shared
 * `TEST_USER`: the cap is a per-owner COUNT, so two tests sharing an owner
 * would leak pins into each other's arithmetic and the first failure would
 * name the wrong rule.
 */
describe('conversation pinning', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  const users: string[] = []
  /** A fresh owner, registered for cleanup in this block's afterAll. */
  const freshUser = () => {
    const u = `pin-user-${Math.random().toString(36).slice(2, 10)}`
    users.push(u)
    return u
  }
  const mkId = () => `conv-${Math.random().toString(36).slice(2, 10)}`

  /** Seed a conversation with an explicit `created_at`, so the fallback
   *  ordering under test is a fact rather than a race between two NOW()s. */
  const seed = async (userId: string, createdAt: string) => {
    const id = mkId()
    await seedRow({
      id,
      userId,
      agentId: 'search',
      title: id,
      serializedContext: '{}',
    })
    await query('UPDATE conversations SET created_at = $1 WHERE id = $2', [createdAt, id])
    return id
  }

  const idsInOrder = async (userId: string) => (await listConversations(userId)).map((r) => r.id)

  afterAll(async () => {
    if (!dbAvailable) return
    for (const u of users) await query('DELETE FROM conversations WHERE user_id = $1', [u])
  })

  it('puts a pinned conversation above newer unpinned ones', async () => {
    const user = freshUser()
    const oldest = await seed(user, '2020-01-01T00:00:00Z')
    const middle = await seed(user, '2021-01-01T00:00:00Z')
    const newest = await seed(user, '2022-01-01T00:00:00Z')

    // Baseline: creation order, newest first — unchanged by this feature.
    expect(await idsInOrder(user)).toEqual([newest, middle, oldest])

    expect(await setConversationPinned(oldest, user, true)).toBe('pinned')
    expect(await idsInOrder(user)).toEqual([oldest, newest, middle])
  })

  it('orders several pins by most recently pinned', async () => {
    const user = freshUser()
    const a = await seed(user, '2020-01-01T00:00:00Z')
    const b = await seed(user, '2021-01-01T00:00:00Z')
    const c = await seed(user, '2022-01-01T00:00:00Z')

    expect(await setConversationPinned(a, user, true)).toBe('pinned')
    expect(await setConversationPinned(b, user, true)).toBe('pinned')
    // Most recently pinned leads the pinned block; c is unpinned and trails
    // despite being the newest row.
    expect(await idsInOrder(user)).toEqual([b, a, c])
  })

  it(`refuses the pin past ${CONVERSATION_PIN_LIMIT} and leaves that row unpinned`, async () => {
    const user = freshUser()
    const ids: string[] = []
    for (let i = 0; i <= CONVERSATION_PIN_LIMIT; i++) {
      ids.push(await seed(user, `202${i}-01-01T00:00:00Z`))
    }
    for (let i = 0; i < CONVERSATION_PIN_LIMIT; i++) {
      expect(await setConversationPinned(ids[i], user, true)).toBe('pinned')
    }
    const overflow = ids[CONVERSATION_PIN_LIMIT]
    expect(await setConversationPinned(overflow, user, true)).toBe('cap_reached')

    const list = await listConversations(user)
    expect(list.filter((r) => r.pinnedAt !== null)).toHaveLength(CONVERSATION_PIN_LIMIT)
    expect(list.find((r) => r.id === overflow)!.pinnedAt).toBeNull()
  })

  it('frees a slot on unpin, so the refused row can then be pinned', async () => {
    const user = freshUser()
    const ids: string[] = []
    for (let i = 0; i <= CONVERSATION_PIN_LIMIT; i++) {
      ids.push(await seed(user, `202${i}-01-01T00:00:00Z`))
    }
    for (let i = 0; i < CONVERSATION_PIN_LIMIT; i++) {
      await setConversationPinned(ids[i], user, true)
    }
    const overflow = ids[CONVERSATION_PIN_LIMIT]
    expect(await setConversationPinned(overflow, user, true)).toBe('cap_reached')

    expect(await setConversationPinned(ids[0], user, false)).toBe('unpinned')
    expect(await setConversationPinned(overflow, user, true)).toBe('pinned')

    const list = await listConversations(user)
    expect(list.filter((r) => r.pinnedAt !== null)).toHaveLength(CONVERSATION_PIN_LIMIT)
    // The freshly unpinned row is back in the creation-ordered tail.
    expect(list.find((r) => r.id === ids[0])!.pinnedAt).toBeNull()
  })

  it('counts the cap per owner, not globally', async () => {
    const owner = freshUser()
    const other = freshUser()
    for (let i = 0; i < CONVERSATION_PIN_LIMIT; i++) {
      const id = await seed(other, `201${i}-01-01T00:00:00Z`)
      expect(await setConversationPinned(id, other, true)).toBe('pinned')
    }
    // Another user holding a full set of pins must not consume this user's.
    const mine = await seed(owner, '2020-01-01T00:00:00Z')
    expect(await setConversationPinned(mine, owner, true)).toBe('pinned')
  })

  it("will not pin someone else's conversation", async () => {
    const owner = freshUser()
    const stranger = freshUser()
    const theirs = await seed(owner, '2020-01-01T00:00:00Z')

    expect(await setConversationPinned(theirs, stranger, true)).toBe('not_found')
    // Untouched: still the owner's, still unpinned.
    const list = await listConversations(owner)
    expect(list.find((r) => r.id === theirs)!.pinnedAt).toBeNull()
    expect(await listConversations(stranger)).toEqual([])
  })

  it("will not unpin someone else's conversation", async () => {
    const owner = freshUser()
    const stranger = freshUser()
    const theirs = await seed(owner, '2020-01-01T00:00:00Z')
    await setConversationPinned(theirs, owner, true)

    expect(await setConversationPinned(theirs, stranger, false)).toBe('not_found')
    expect((await listConversations(owner)).find((r) => r.id === theirs)!.pinnedAt).not.toBeNull()
  })

  it('reports an unknown id as not_found for both directions', async () => {
    const user = freshUser()
    expect(await setConversationPinned('no-such-conversation', user, true)).toBe('not_found')
    expect(await setConversationPinned('no-such-conversation', user, false)).toBe('not_found')
  })

  it('is idempotent, and a repeat pin does not reorder the pinned block', async () => {
    const user = freshUser()
    const a = await seed(user, '2020-01-01T00:00:00Z')
    const b = await seed(user, '2021-01-01T00:00:00Z')
    await setConversationPinned(a, user, true)
    await setConversationPinned(b, user, true)
    expect(await idsInOrder(user)).toEqual([b, a])

    const before = (await listConversations(user)).find((r) => r.id === a)!.pinnedAt
    // Re-pinning the older pin must not promote it over b.
    expect(await setConversationPinned(a, user, true)).toBe('pinned')
    const after = (await listConversations(user)).find((r) => r.id === a)!.pinnedAt
    expect(after).toEqual(before)
    expect(await idsInOrder(user)).toEqual([b, a])

    // Unpinning twice is likewise a success, not an error.
    expect(await setConversationPinned(a, user, false)).toBe('unpinned')
    expect(await setConversationPinned(a, user, false)).toBe('unpinned')
  })

  it('does not bump updated_at — a pin is not conversation activity', async () => {
    const user = freshUser()
    const id = await seed(user, '2020-01-01T00:00:00Z')
    await query("UPDATE conversations SET updated_at = '2020-06-01T00:00:00Z' WHERE id = $1", [id])
    const before = (await loadConversation(id, user))!.updatedAt

    await setConversationPinned(id, user, true)
    expect((await loadConversation(id, user))!.updatedAt).toEqual(before)

    await setConversationPinned(id, user, false)
    expect((await loadConversation(id, user))!.updatedAt).toEqual(before)
  })

  it('survives a turn-save: the save does not clear a pin', async () => {
    const user = freshUser()
    const id = await seed(user, '2020-01-01T00:00:00Z')
    await setConversationPinned(id, user, true)

    // A later turn writes the row again through the normal persistence path.
    await saveTurn({
      id,
      userId: user,
      agentId: 'search',
      title: 'ignored',
      serializedContext: JSON.stringify({ events: [{ id: 'ev' }] }),
      status: 'done',
    })
    expect((await listConversations(user)).find((r) => r.id === id)!.pinnedAt).not.toBeNull()
  })
})

describe('M5c lifted memory run origin', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))
  it('is nullable, changes with a new interactive run, and survives a resume save', async () => {
    const input = {
      id: `origin-${TEST_USER}`,
      userId: TEST_USER,
      agentId: 'search',
      title: null,
      serializedContext: '{"events":[]}',
    }
    await seedRow(input)
    expect((await loadConversation(input.id, TEST_USER))!.memoryRunOrigin).toBeNull()
    await saveTurn({ ...input, memoryRunOrigin: 'triggered' })
    expect((await loadConversation(input.id, TEST_USER))!.memoryRunOrigin).toBe('triggered')
    await saveTurn(input) // a resume supplies no new origin
    expect((await loadConversation(input.id, TEST_USER))!.memoryRunOrigin).toBe('triggered')
    await saveTurn({ ...input, memoryRunOrigin: 'interactive' })
    expect((await loadConversation(input.id, TEST_USER))!.memoryRunOrigin).toBe('interactive')
    await saveTurn(input)
    expect((await loadConversation(input.id, TEST_USER))!.memoryRunOrigin).toBe('interactive')
    await expect(
      saveConversation({ ...input, status: 'done', version: '0', memoryRunOrigin: 'triggered' }),
    ).rejects.toBeInstanceOf(ConversationConflictError)
    expect((await loadConversation(input.id, TEST_USER))!.memoryRunOrigin).toBe('interactive')
  })
})
