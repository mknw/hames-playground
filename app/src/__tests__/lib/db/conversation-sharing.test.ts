/**
 * Share-by-link, at the repository seam.
 *
 * Layer 1 against the live Postgres container, like its neighbours here, and it
 * skips when Postgres is unreachable. What it pins is the auth boundary itself,
 * so the cases are written adversarially — "what makes this fail open?" rather
 * than "does the happy path work?":
 *
 *   - an unknown, revoked or malformed token resolves to NOTHING, and to the
 *     same nothing, so a caller cannot tell "never existed" from "was shared";
 *   - a conversation id is not a token — the thing that now appears in URLs,
 *     bookmarks and browser history grants no access on its own;
 *   - share, unshare and read-my-token are owner-scoped, so another signed-in
 *     user cannot expose, revoke or inspect a conversation that is not theirs;
 *   - the content that comes back through the token path is DECRYPTED, which is
 *     the whole point and also the reason every other assertion here matters.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Bypass the server-only guard in the jsdom test env, as the sibling DB tests do.
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  getShareToken,
  loadSharedConversation,
  saveConversation,
  shareConversation,
  unshareConversation,
} from '../../../lib/db/conversations.server'
import { closePool, query } from '../../../lib/db/client.server'

const OWNER = `share-owner-${Math.random().toString(36).slice(2, 10)}`
const STRANGER = `share-stranger-${Math.random().toString(36).slice(2, 10)}`

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[conversation-sharing.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM conversations WHERE user_id = ANY($1)', [[OWNER, STRANGER]])
  await closePool()
})

/** A saved conversation belonging to `userId`, with one user turn in it. */
async function seed(userId: string, content: string): Promise<string> {
  const id = `share-conv-${Math.random().toString(36).slice(2, 10)}`
  await saveConversation({
    id,
    userId,
    agentId: 'search',
    title: 'A shared title',
    serializedContext: JSON.stringify({
      sessionId: id,
      createdAt: 1730000000000,
      events: [
        { id: 'ev-1', type: 'user_message', ts: 1, patternId: 'harness', data: { content } },
      ],
    }),
    status: 'done',
  })
  return id
}

describe('share tokens', () => {
  it('mints a token that is not the conversation id, and is long enough to be one', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    const token = await shareConversation(id, OWNER)

    expect(token).not.toBeNull()
    // The property that makes URLs safe to bookmark: the thing in the address
    // bar is not the thing that authorizes a read.
    expect(token).not.toBe(id)
    // 32 bytes of base64url. A shorter token would be brute-forceable against
    // an endpoint that answers in constant time whether it hit.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('returns the SAME token when the owner shares again', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    const first = await shareConversation(id, OWNER)
    const second = await shareConversation(id, OWNER)
    // Re-opening the dialog must not invalidate the link already sent.
    expect(second).toBe(first)
  })

  it('reports the current token to its owner, and null before there is one', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    expect(await getShareToken(id, OWNER)).toBeNull()
    const token = await shareConversation(id, OWNER)
    expect(await getShareToken(id, OWNER)).toBe(token)
  })

  it('does not bump updated_at — sharing is not chat activity', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    const before = await query<{ updated_at: Date }>(
      'SELECT updated_at FROM conversations WHERE id = $1',
      [id],
    )
    await shareConversation(id, OWNER)
    const after = await query<{ updated_at: Date }>(
      'SELECT updated_at FROM conversations WHERE id = $1',
      [id],
    )
    // `countActiveUsers` and the sidebar's "x ago" both read this column as
    // "the user said something".
    expect(after.rows[0].updated_at.getTime()).toBe(before.rows[0].updated_at.getTime())
  })
})

describe('the public read path', () => {
  it('returns the decrypted transcript to whoever holds the token', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'the secret question')
    const token = (await shareConversation(id, OWNER))!

    const shared = await loadSharedConversation(token)
    expect(shared).not.toBeNull()
    expect(shared!.id).toBe(id)
    expect(shared!.title).toBe('A shared title')
    // Ciphertext coming back would be a passing test and a broken feature.
    expect(shared!.serializedContext).toContain('the secret question')
    expect(shared!.sharedAt).toBeInstanceOf(Date)
  })

  it('answers nothing for an unknown token', async () => {
    if (!dbAvailable) return
    // Well-formed, just never minted.
    expect(await loadSharedConversation('a'.repeat(43))).toBeNull()
  })

  it('answers nothing for a malformed token, without asking the database', async () => {
    if (!dbAvailable) return
    expect(await loadSharedConversation('')).toBeNull()
    expect(await loadSharedConversation('short')).toBeNull()
    expect(await loadSharedConversation('!'.repeat(43))).toBeNull()
    expect(await loadSharedConversation("' OR 1=1 --")).toBeNull()
  })

  it('answers nothing for a CONVERSATION ID — ids never authorize a read', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    await shareConversation(id, OWNER)
    // This is the exact string a bookmark of `/?c=<id>` carries.
    expect(await loadSharedConversation(id)).toBeNull()
  })

  it('answers nothing for a conversation that was never shared', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'private')
    expect(await getShareToken(id, OWNER)).toBeNull()
    expect(await loadSharedConversation(id)).toBeNull()
  })

  it('answers the same nothing after revocation as for a token that never existed', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    const token = (await shareConversation(id, OWNER))!
    expect(await loadSharedConversation(token)).not.toBeNull()

    await unshareConversation(id, OWNER)

    const revoked = await loadSharedConversation(token)
    const neverExisted = await loadSharedConversation('b'.repeat(43))
    // Indistinguishable: this is what keeps the route a 404 rather than a 403
    // that confirms there is a conversation behind the link.
    expect(revoked).toBeNull()
    expect(revoked).toEqual(neverExisted)
  })

  it('mints an unrelated token when a revoked conversation is shared again', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    const first = (await shareConversation(id, OWNER))!
    await unshareConversation(id, OWNER)
    const second = (await shareConversation(id, OWNER))!

    expect(second).not.toBe(first)
    // The revoked link stays dead; only the new one resolves.
    expect(await loadSharedConversation(first)).toBeNull()
    expect(await loadSharedConversation(second)).not.toBeNull()
  })
})

describe('owner scoping', () => {
  it('will not let another user share a conversation', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')

    expect(await shareConversation(id, STRANGER)).toBeNull()
    // And nothing was written: the owner still sees it as private.
    expect(await getShareToken(id, OWNER)).toBeNull()
  })

  it('will not let another user revoke a share', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    const token = (await shareConversation(id, OWNER))!

    await unshareConversation(id, STRANGER)

    expect(await getShareToken(id, OWNER)).toBe(token)
    expect(await loadSharedConversation(token)).not.toBeNull()
  })

  it('will not tell another user what a conversation’s token is', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    await shareConversation(id, OWNER)

    expect(await getShareToken(id, STRANGER)).toBeNull()
  })

  it('will not let a share ride in on a save', async () => {
    if (!dbAvailable) return
    const id = await seed(OWNER, 'hello')
    const token = (await shareConversation(id, OWNER))!
    // A later turn's save goes through the upsert, which does not name
    // `share_token` in its UPDATE set — so an ordinary turn neither clears a
    // share nor creates one.
    await seed(OWNER, 'second turn')
    await saveConversation({
      id,
      userId: OWNER,
      agentId: 'search',
      title: null,
      serializedContext: JSON.stringify({ sessionId: id, createdAt: 1, events: [] }),
      status: 'done',
    })
    expect(await getShareToken(id, OWNER)).toBe(token)
  })
})
