/**
 * ChatSidebar — placeholder merge logic + row indicator precedence.
 *
 * Covers the optimistic "+ New Chat" placeholder rules from #44:
 *  - placeholder is prepended when its id is not in the persisted list
 *  - placeholder is dropped once the persisted row arrives (the real row
 *    replaces the optimistic one in-place at the top of the list)
 *  - no placeholder when `placeholderId` is null
 *
 * ...and the #105 rule that a live run outranks the persisted status badge.
 */

import { describe, it, expect, vi } from 'vitest'

// ChatSidebar.tsx now imports `regenerateConversationTitle` from the
// server-only `harness-client` module. The transitive import chain
// (`harness-patterns` → `assert.server.ts`) self-asserts at import time
// and throws under jsdom. Stub both before pulling in the SUT.
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
vi.mock('../../../lib/harness-client', () => ({
  regenerateConversationTitle: vi.fn(async () => null),
}))

const { mergeThreadsWithPlaceholder, rowIndicator } = await import('../../../components/ark-ui/ChatSidebar')
type ChatThreadSummary = import('../../../components/ark-ui/ChatSidebar').ChatThreadSummary

const persisted: ChatThreadSummary[] = [
  { id: 'a', title: 'Alpha', updatedAt: '2026-05-10T00:00:00Z', kind: 'conversation', status: 'done' },
  { id: 'b', title: 'Beta', updatedAt: '2026-05-09T00:00:00Z', kind: 'conversation', status: 'done' },
]

describe('mergeThreadsWithPlaceholder', () => {
  it('returns persisted list unchanged when no placeholder is set', () => {
    expect(mergeThreadsWithPlaceholder(persisted, null)).toBe(persisted)
  })

  it('prepends an optimistic placeholder when its id is not yet persisted', () => {
    const merged = mergeThreadsWithPlaceholder(
      persisted,
      'new-id',
      () => '2026-05-10T12:00:00Z',
    )
    expect(merged).toHaveLength(3)
    expect(merged[0]).toEqual({
      id: 'new-id',
      title: null,
      updatedAt: '2026-05-10T12:00:00Z',
      kind: 'conversation',
      status: 'done',
      isPlaceholder: true,
    })
    expect(merged[1].id).toBe('a')
    expect(merged[2].id).toBe('b')
  })

  it('drops the placeholder once a persisted row with the same id arrives', () => {
    const withRow: ChatThreadSummary[] = [
      { id: 'new-id', title: 'First message…', updatedAt: '2026-05-10T12:00:00Z', kind: 'conversation', status: 'done' },
      ...persisted,
    ]
    const merged = mergeThreadsWithPlaceholder(withRow, 'new-id')
    expect(merged).toBe(withRow)
    expect(merged.some((t) => t.isPlaceholder)).toBe(false)
  })

  it('never produces duplicate ids', () => {
    const merged = mergeThreadsWithPlaceholder(persisted, 'new-id')
    const ids = merged.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Regression for #52: when the placeholder is a UUID (post-fix) and the
  // persisted list contains legacy `cl-{n}` ids, the placeholder must be kept
  // — under the old `createUniqueId()` scheme the counter could mint a value
  // that collided with one of these rows and the placeholder would silently
  // vanish.
  it('keeps a UUID placeholder when threads contain legacy cl-{n} ids', () => {
    const legacy: ChatThreadSummary[] = Array.from({ length: 20 }, (_, i) => ({
      id: `cl-${i}`,
      title: `Conversation ${i}`,
      updatedAt: '2026-05-10T00:00:00Z',
      kind: 'conversation' as const,
      status: 'done' as const,
    }))
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const merged = mergeThreadsWithPlaceholder(
      legacy,
      uuid,
      () => '2026-05-10T12:00:00Z',
    )
    expect(merged).toHaveLength(legacy.length + 1)
    expect(merged[0].id).toBe(uuid)
    expect(merged[0].isPlaceholder).toBe(true)
    // Legacy rows still flow through unchanged, in order.
    expect(merged.slice(1).map((t) => t.id)).toEqual(legacy.map((t) => t.id))
  })
})

describe('rowIndicator', () => {
  // The #105 core: a chat with a stream open in this tab spins, even though
  // its persisted status is still whatever the last list refetch saw.
  it('spins a live conversation regardless of persisted status', () => {
    expect(
      rowIndicator({ kind: 'conversation', status: 'done', live: true }),
    ).toBe('running')
  })

  it('shows nothing for a conversation at rest', () => {
    expect(
      rowIndicator({ kind: 'conversation', status: 'done', live: false }),
    ).toBe('none')
  })

  // Live state is fresher than the row's persisted status, so it wins even
  // when the two disagree (row says errored, but a retry is in flight).
  it('lets a live run outrank a persisted error on an action row', () => {
    expect(rowIndicator({ kind: 'action', status: 'error', live: true })).toBe(
      'running',
    )
  })

  it('falls back to the persisted action badges when nothing is live', () => {
    expect(rowIndicator({ kind: 'action', status: 'running', live: false })).toBe('running')
    expect(rowIndicator({ kind: 'action', status: 'error', live: false })).toBe('action-error')
    expect(rowIndicator({ kind: 'action', status: 'paused', live: false })).toBe('action-paused')
    expect(rowIndicator({ kind: 'action', status: 'done', live: false })).toBe('action-done')
  })

  // A conversation must never pick up the action-only badges, which would
  // brand an ordinary chat as POST-triggered.
  it('never returns an action badge for a conversation', () => {
    for (const status of ['running', 'paused', 'done', 'error'] as const) {
      const got = rowIndicator({ kind: 'conversation', status, live: false })
      expect(got).toBe('none')
    }
  })
})
