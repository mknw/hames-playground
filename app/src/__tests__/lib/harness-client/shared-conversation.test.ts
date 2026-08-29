/**
 * What a stranger holding a share link actually gets back.
 *
 * The repository test (`lib/db/conversation-sharing.test.ts`) proves the token
 * resolves to the right ROW; this proves the row is narrowed before it leaves
 * the server. The two failures it exists to catch are opposite in shape and
 * both silent: the projection widening (a spread carrying a field nobody meant
 * to publish) and the projection emptying (a transcript that renders as a blank
 * page because the filter is wrong).
 *
 * The conversation blob here is deliberately a realistic one — a tool call, a
 * tool result carrying something that looks like fetched mail, a router's
 * non-final status line, an error naming an endpoint — because every one of
 * those is in the owner's own transcript and none of them may be in this one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const loadSharedRow = vi.fn()

vi.mock('../../../lib/db/conversations.server', () => ({
  loadSharedConversation: (token: string) => loadSharedRow(token) as unknown,
}))

/**
 * A seam over `replayMessages`, unused unless a test sets `impl`.
 *
 * It exists for ONE assertion — that the projection copies four named fields
 * rather than spreading whatever it was handed. Asserting that against the real
 * replay is vacuous today: `ReplayedMessage`'s extra fields (`hint`,
 * `patternId`, `turnInfo`) only ever appear on error bubbles, which this
 * projection drops anyway, so a spread and a field-by-field copy produce
 * identical output and the test would pass whichever the code did. Verified by
 * mutation — that is how this seam came to exist. Feeding a deliberately
 * fattened message is what makes the assertion able to fail.
 */
const replay = vi.hoisted(() => ({
  impl: null as null | ((serialized: string) => unknown[]),
}))

vi.mock('../../../lib/harness-client/replay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/harness-client/replay')>()
  return {
    ...actual,
    replayMessages: (serialized: string) =>
      replay.impl ? replay.impl(serialized) : actual.replayMessages(serialized),
  }
})

const { loadSharedConversation } =
  await import('../../../lib/harness-client/shared-conversation.server')

const SHARED_AT = new Date('2026-08-27T09:00:00.000Z')

/** A conversation with one of everything the event stream can hold. */
const FULL_CONTEXT = JSON.stringify({
  sessionId: 'conv-1',
  createdAt: 1,
  events: [
    { id: 'e1', type: 'user_message', ts: 10, data: { content: 'what did finance send?' } },
    // A router status line — not `final`, so not a bubble even for the owner.
    { id: 'e2', type: 'assistant_message', ts: 11, data: { content: 'Let me look into that…' } },
    { id: 'e3', type: 'tool_call', ts: 12, data: { tool: 'outlook_email_search' } },
    {
      id: 'e4',
      type: 'tool_result',
      ts: 13,
      data: { result: 'From: cfo@example.com\nSubject: Q3 numbers\n…' },
    },
    {
      id: 'e5',
      type: 'error',
      ts: 14,
      patternId: 'simple-loop',
      data: { error: 'VerdaQwen did not wake', turn: 2, iteration: 1, hint: 'retry' },
    },
    {
      id: 'e6',
      type: 'assistant_message',
      ts: 15,
      data: { content: 'The CFO sent Q3.', final: true },
    },
  ],
})

beforeEach(() => {
  replay.impl = null
  loadSharedRow.mockReset()
  loadSharedRow.mockResolvedValue({
    id: 'conv-1',
    title: 'Finance mail',
    serializedContext: FULL_CONTEXT,
    sharedAt: SHARED_AT,
  })
})

describe('loadSharedConversation', () => {
  it('returns the title and the two conversational turns, in order', async () => {
    const view = await loadSharedConversation('t'.repeat(43))
    expect(view).not.toBeNull()
    expect(view!.id).toBe('conv-1')
    expect(view!.title).toBe('Finance mail')
    expect(view!.sharedAt).toBe(SHARED_AT.getTime())
    expect(view!.messages).toEqual([
      { id: 'e1', role: 'user', content: 'what did finance send?', timestamp: 10 },
      { id: 'e6', role: 'assistant', content: 'The CFO sent Q3.', timestamp: 15 },
    ])
  })

  it('publishes no field beyond the four the view type declares', async () => {
    const view = await loadSharedConversation('t'.repeat(43))
    expect(Object.keys(view!).sort()).toEqual(['id', 'messages', 'sharedAt', 'title'])
  })

  it('copies four named fields off a message rather than spreading it', async () => {
    // A replay that grew a field — the future this guards against, staged now
    // rather than waited for. A `{ ...m }` projection publishes `hint` and
    // `internalNote` here; a field-by-field one drops them.
    replay.impl = () => [
      {
        id: 'x1',
        role: 'assistant',
        content: 'visible',
        timestamp: 20,
        hint: 'internal hint',
        patternId: 'simple-loop',
        internalNote: 'never meant to be published',
      },
    ]
    const view = await loadSharedConversation('t'.repeat(43))
    expect(view!.messages).toEqual([
      { id: 'x1', role: 'assistant', content: 'visible', timestamp: 20 },
    ])
    expect(JSON.stringify(view)).not.toContain('internalNote')
    expect(JSON.stringify(view)).not.toContain('internal hint')
  })

  it('withholds the tool result, the raw blob and the diagnostics', async () => {
    const view = await loadSharedConversation('t'.repeat(43))
    const published = JSON.stringify(view)
    // The tool result is the SD-10 payload — verbatim, and since per-user Graph
    // access it can be somebody's mail.
    expect(published).not.toContain('cfo@example.com')
    expect(published).not.toContain('outlook_email_search')
    // Diagnostics name infrastructure the viewer has no business knowing about.
    expect(published).not.toContain('VerdaQwen')
    expect(published).not.toContain('simple-loop')
    // And the intermediate router line is not an answer.
    expect(published).not.toContain('Let me look into that')
  })

  it('answers null when the token resolves to nothing', async () => {
    loadSharedRow.mockResolvedValue(null)
    expect(await loadSharedConversation('t'.repeat(43))).toBeNull()
  })

  it('answers null for an argument that is not a string', async () => {
    // This is an RPC: the browser chooses the argument, and the type signature
    // is not present at runtime.
    expect(await loadSharedConversation(undefined as unknown as string)).toBeNull()
    expect(await loadSharedConversation({ toString: () => 'x' } as unknown as string)).toBeNull()
    expect(loadSharedRow).not.toHaveBeenCalled()
  })

  it('answers an empty transcript rather than throwing on an unparseable blob', async () => {
    loadSharedRow.mockResolvedValue({
      id: 'conv-1',
      title: null,
      serializedContext: 'not json',
      sharedAt: SHARED_AT,
    })
    const view = await loadSharedConversation('t'.repeat(43))
    expect(view!.messages).toEqual([])
  })
})
