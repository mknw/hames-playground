/**
 * Data Stash routes — per-user session scoping.
 *
 * Every stash route names a `sessionId`, and each one answers 404 unless that
 * session belongs to the caller. Ownership comes from two records, both mocked
 * here at the repository level so the real resolver
 * (`lib/stash/ownership.server.ts`) is what these cases exercise:
 *
 *   - `session_claims` — written at first touch, which is what covers an upload
 *     that arrives before the session has any conversation row.
 *   - `conversations.user_id` — the long-lived record, and what the
 *     agent-trigger path (`seedActionRow`) writes for a triggered run.
 *
 * The storage layer is a plain in-memory map: these cases are about who gets
 * an answer, not about what Redis stores.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// ── Auth ────────────────────────────────────────────────────────────────────
let currentUser: string | null = 'alice'
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: async () => {
    if (!currentUser) throw new Error('Authentication required')
    return { id: currentUser, email: `${currentUser}@example.test` }
  },
}))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => false,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

// ── Ownership records ───────────────────────────────────────────────────────
const conversationOwners = new Map<string, string>()
vi.mock('../../../lib/db/conversations.server', () => ({
  getConversationOwner: async (id: string) => conversationOwners.get(id) ?? null,
}))

/** First toucher wins, matching the SQL upsert in `session-claims.server.ts`. */
const claims = new Map<string, string>()
const claimSession = vi.fn(async (sessionId: string, userId: string, _ttlSeconds: number) => {
  void _ttlSeconds
  const held = claims.get(sessionId)
  if (held) return held
  claims.set(sessionId, userId)
  return userId
})
vi.mock('../../../lib/db/session-claims.server', () => ({
  getSessionClaimOwner: async (sessionId: string) => claims.get(sessionId) ?? null,
  claimSession: (sessionId: string, userId: string, ttl: number) =>
    claimSession(sessionId, userId, ttl),
}))

// ── Storage (in-memory stand-in for the Redis document store) ───────────────
interface Doc {
  id: string
  sessionId: string
  filename: string
  mimeType: string
  size: number
  uploadedAt: number
  content: string
  encoding?: 'utf8' | 'base64'
  hidden?: boolean
  archived?: boolean
}
const docs = new Map<string, Doc>()
const docKey = (sessionId: string, id: string) => `${sessionId}:${id}`
let nextDocId = 1

const storeDocument = vi.fn(
  async (input: {
    sessionId: string
    filename: string
    mimeType: string
    content: string
    encoding?: 'utf8' | 'base64'
  }) => {
    const doc: Doc = {
      id: `doc-${nextDocId++}`,
      sessionId: input.sessionId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.content.length,
      uploadedAt: 1,
      content: input.content,
      ...(input.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
    }
    docs.set(docKey(doc.sessionId, doc.id), doc)
    return doc
  },
)
const getDocument = vi.fn(
  async (sessionId: string, id: string) => docs.get(docKey(sessionId, id)) ?? null,
)
const listDocuments = vi.fn(async (sessionId: string) =>
  [...docs.values()]
    .filter((d) => d.sessionId === sessionId)
    .map(({ content: _c, ...meta }) => meta),
)
const deleteDocument = vi.fn(async (sessionId: string, id: string) => {
  docs.delete(docKey(sessionId, id))
})
const setDocumentFlags = vi.fn(
  async (sessionId: string, id: string, patch: { hidden?: boolean; archived?: boolean }) => {
    const doc = docs.get(docKey(sessionId, id))
    if (!doc) return null
    Object.assign(doc, patch)
    return doc
  },
)
vi.mock('../../../lib/document-store.server', () => ({
  DEFAULT_TTL_SECONDS: 7 * 24 * 60 * 60,
  storeDocument: (...args: unknown[]) => storeDocument(...(args as [never])),
  getDocument: (...args: unknown[]) => getDocument(...(args as [never, never])),
  listDocuments: (...args: unknown[]) => listDocuments(...(args as [never])),
  deleteDocument: (...args: unknown[]) => deleteDocument(...(args as [never, never])),
  setDocumentFlags: (...args: unknown[]) => setDocumentFlags(...(args as [never, never, never])),
  stripContent: (doc: Doc) => {
    const { content: _c, ...meta } = doc
    return meta
  },
}))

// ── Ingest / search ─────────────────────────────────────────────────────────
const ingestDocument = vi.fn(async () => ({ chunks: 3 }))
const searchDocuments = vi.fn(async () => [{ docId: 'doc-1', score: 0.9 }])
const ingestStashDocument = vi.fn(async () => {})
vi.mock('../../../lib/document-ingest.server', () => ({
  ingestDocument: () => ingestDocument(),
  searchDocuments: () => searchDocuments(),
  ingestStashDocument: () => ingestStashDocument(),
}))

// ── Upload-route collaborators (auto-ingest gate) ───────────────────────────
vi.mock('../../../lib/harness-client/registry.server', () => ({
  agentUsesRedisRetriever: async () => false,
}))
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession: async () => null,
}))
vi.mock('../../../lib/doc-convert.server', () => ({
  conversionEnabled: () => false,
  isConvertible: () => false,
}))

const { POST: uploadPost, GET: uploadGet } = await import('../../../routes/api/stash/upload')
const {
  GET: documentGet,
  DELETE: documentDelete,
  PATCH: documentPatch,
} = await import('../../../routes/api/stash/document/[id]')
const { GET: searchGet } = await import('../../../routes/api/stash/search')
const { POST: ingestPost } = await import('../../../routes/api/stash/ingest')

// Minimal APIEvent shim — the routes only touch `params` + `request`.
function evt(request: Request, params: Record<string, string> = {}) {
  return { params, request } as never
}

function jsonRequest(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Upload a text document as `user`, returning the stored document id. */
async function uploadAs(user: string, sessionId: string, filename = 'notes.txt') {
  currentUser = user
  const res = await uploadPost(
    evt(
      jsonRequest('http://x/api/stash/upload', {
        sessionId,
        filename,
        content: 'hello world',
      }),
    ),
  )
  const body = (await res.json()) as { document?: { id: string }; error?: string }
  return { status: res.status, id: body.document?.id, body }
}

beforeEach(() => {
  vi.clearAllMocks()
  conversationOwners.clear()
  claims.clear()
  docs.clear()
  nextDocId = 1
  currentUser = 'alice'
})

describe('stash routes — session ownership', () => {
  it('401s an unauthenticated caller before touching ownership', async () => {
    currentUser = null
    const res = await uploadGet(evt(new Request('http://x/api/stash/upload?sessionId=s1')))
    expect(res.status).toBe(401)
    expect(listDocuments).not.toHaveBeenCalled()
  })

  it('lets the owner read a document back and refuses everyone else', async () => {
    conversationOwners.set('s1', 'alice')
    const { id } = await uploadAs('alice', 's1')
    expect(id).toBeTruthy()

    currentUser = 'alice'
    const mine = await documentGet(
      evt(new Request(`http://x/api/stash/document/${id}?sessionId=s1`), { id: id! }),
    )
    expect(mine.status).toBe(200)
    expect((await mine.json()).document.content).toBe('hello world')

    currentUser = 'mallory'
    const theirs = await documentGet(
      evt(new Request(`http://x/api/stash/document/${id}?sessionId=s1`), { id: id! }),
    )
    expect(theirs.status).toBe(404)
    expect(await theirs.json()).toEqual({ error: 'Session not found' })
  })

  it('refuses a raw ?download by a non-owner', async () => {
    conversationOwners.set('s1', 'alice')
    const { id } = await uploadAs('alice', 's1')

    currentUser = 'mallory'
    const res = await documentGet(
      evt(new Request(`http://x/api/stash/document/${id}?sessionId=s1&download`), { id: id! }),
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Disposition')).toBeNull()
  })

  it('scopes the document list to the owner', async () => {
    conversationOwners.set('s1', 'alice')
    await uploadAs('alice', 's1')

    currentUser = 'alice'
    const mine = await uploadGet(evt(new Request('http://x/api/stash/upload?sessionId=s1')))
    expect(mine.status).toBe(200)
    expect((await mine.json()).documents).toHaveLength(1)

    currentUser = 'mallory'
    const theirs = await uploadGet(evt(new Request('http://x/api/stash/upload?sessionId=s1')))
    expect(theirs.status).toBe(404)
    expect(listDocuments).toHaveBeenCalledTimes(1)
  })

  it('lists an unclaimed session as empty (a fresh chat has no documents yet)', async () => {
    const res = await uploadGet(evt(new Request('http://x/api/stash/upload?sessionId=brand-new')))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ documents: [] })
    expect(listDocuments).not.toHaveBeenCalled()
  })

  it('refuses a delete or a flag edit from a non-owner', async () => {
    conversationOwners.set('s1', 'alice')
    const { id } = await uploadAs('alice', 's1')

    currentUser = 'mallory'
    const del = await documentDelete(
      evt(new Request(`http://x/api/stash/document/${id}?sessionId=s1`, { method: 'DELETE' }), {
        id: id!,
      }),
    )
    expect(del.status).toBe(404)
    expect(deleteDocument).not.toHaveBeenCalled()

    const patch = await documentPatch(
      evt(
        jsonRequest(
          `http://x/api/stash/document/${id}`,
          { sessionId: 's1', hidden: true },
          'PATCH',
        ),
        { id: id! },
      ),
    )
    expect(patch.status).toBe(404)
    expect(setDocumentFlags).not.toHaveBeenCalled()
    expect(docs.get(`s1:${id}`)!.hidden).toBeUndefined()

    // ...while the owner's own flag edit goes through.
    currentUser = 'alice'
    const mine = await documentPatch(
      evt(
        jsonRequest(
          `http://x/api/stash/document/${id}`,
          { sessionId: 's1', hidden: true },
          'PATCH',
        ),
        { id: id! },
      ),
    )
    expect(mine.status).toBe(200)
    expect(docs.get(`s1:${id}`)!.hidden).toBe(true)
  })

  it('scopes search to the owner', async () => {
    conversationOwners.set('s1', 'alice')

    currentUser = 'alice'
    const mine = await searchGet(evt(new Request('http://x/api/stash/search?sessionId=s1&q=hello')))
    expect(mine.status).toBe(200)
    expect((await mine.json()).hits).toHaveLength(1)

    currentUser = 'mallory'
    const theirs = await searchGet(
      evt(new Request('http://x/api/stash/search?sessionId=s1&q=hello')),
    )
    expect(theirs.status).toBe(404)
    expect(searchDocuments).toHaveBeenCalledTimes(1)
  })

  it('scopes ingest to the owner', async () => {
    conversationOwners.set('s1', 'alice')
    const { id } = await uploadAs('alice', 's1')

    currentUser = 'mallory'
    const theirs = await ingestPost(
      evt(jsonRequest('http://x/api/stash/ingest', { sessionId: 's1', docId: id })),
    )
    expect(theirs.status).toBe(404)
    expect(ingestDocument).not.toHaveBeenCalled()

    currentUser = 'alice'
    const mine = await ingestPost(
      evt(jsonRequest('http://x/api/stash/ingest', { sessionId: 's1', docId: id })),
    )
    expect(mine.status).toBe(200)
    expect(ingestDocument).toHaveBeenCalledTimes(1)
  })
})

describe('stash routes — uploads that precede the conversation row', () => {
  it('records the uploader as the owner, and serves the document back to them', async () => {
    // No conversation row: the file was dropped before the first chat message.
    const { status, id } = await uploadAs('alice', 'pre-1')
    expect(status).toBe(201)
    expect(claims.get('pre-1')).toBe('alice')

    currentUser = 'alice'
    const res = await documentGet(
      evt(new Request(`http://x/api/stash/document/${id}?sessionId=pre-1`), { id: id! }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).document.content).toBe('hello world')
  })

  it('refuses a read of that session by anyone else', async () => {
    const { id } = await uploadAs('alice', 'pre-2')

    currentUser = 'mallory'
    const doc = await documentGet(
      evt(new Request(`http://x/api/stash/document/${id}?sessionId=pre-2`), { id: id! }),
    )
    expect(doc.status).toBe(404)

    const list = await uploadGet(evt(new Request('http://x/api/stash/upload?sessionId=pre-2')))
    expect(list.status).toBe(404)
  })

  it('refuses a second uploader on a session someone already claimed', async () => {
    await uploadAs('alice', 'pre-3')
    storeDocument.mockClear()

    const { status, body } = await uploadAs('mallory', 'pre-3', 'theirs.txt')
    expect(status).toBe(404)
    expect(body.error).toBe('Session not found')
    expect(storeDocument).not.toHaveBeenCalled()
    expect(claims.get('pre-3')).toBe('alice')
  })

  it('keeps the first claim when the conversation row is later written by someone else', async () => {
    await uploadAs('alice', 'pre-4')
    // A conversation row appearing under a different user does not transfer the
    // stash: the earlier claim is the first touch and stays authoritative.
    conversationOwners.set('pre-4', 'mallory')

    currentUser = 'mallory'
    const list = await uploadGet(evt(new Request('http://x/api/stash/upload?sessionId=pre-4')))
    expect(list.status).toBe(404)

    currentUser = 'alice'
    const mine = await uploadGet(evt(new Request('http://x/api/stash/upload?sessionId=pre-4')))
    expect(mine.status).toBe(200)
    expect((await mine.json()).documents).toHaveLength(1)
  })

  it('refuses an upload to a session that is already another user’s conversation', async () => {
    conversationOwners.set('theirs', 'alice')
    const { status } = await uploadAs('mallory', 'theirs')
    expect(status).toBe(404)
    expect(storeDocument).not.toHaveBeenCalled()
  })
})

describe('stash routes — agent-trigger recording playback', () => {
  /**
   * `POST /api/agents/:id` resolves a bearer token to a userId, stores the
   * recording under the run id, and seeds the conversation row for that same
   * user inside the one request — so the row is the ownership record for the
   * run's stash, and playback from the UI reads through it.
   */
  it('serves the recording to the token’s user and refuses others', async () => {
    const runId = 'run-1'
    const doc = await storeDocument({
      sessionId: runId,
      filename: 'memo.m4a',
      mimeType: 'audio/mp4',
      content: Buffer.from('BYTES').toString('base64'),
      encoding: 'base64',
    })
    conversationOwners.set(runId, 'alice') // what seedActionRow writes

    currentUser = 'alice'
    const playback = await documentGet(
      evt(new Request(`http://x/api/stash/document/${doc.id}?sessionId=${runId}&download`), {
        id: doc.id,
      }),
    )
    expect(playback.status).toBe(200)
    expect(playback.headers.get('Content-Type')).toBe('audio/mp4')
    expect(await playback.text()).toBe('BYTES')

    currentUser = 'mallory'
    const denied = await documentGet(
      evt(new Request(`http://x/api/stash/document/${doc.id}?sessionId=${runId}&download`), {
        id: doc.id,
      }),
    )
    expect(denied.status).toBe(404)
  })

  it('lists the run’s documents for the triggering user with no claim row present', async () => {
    const runId = 'run-2'
    await storeDocument({
      sessionId: runId,
      filename: 'memo.m4a',
      mimeType: 'audio/mp4',
      content: 'QQ==',
      encoding: 'base64',
    })
    conversationOwners.set(runId, 'alice')
    expect(claims.has(runId)).toBe(false)

    currentUser = 'alice'
    const res = await uploadGet(evt(new Request(`http://x/api/stash/upload?sessionId=${runId}`)))
    expect(res.status).toBe(200)
    expect((await res.json()).documents).toHaveLength(1)
  })
})
