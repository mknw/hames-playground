/**
 * Metrics dashboard server action (`metrics/dashboard.server.ts`) — the fold
 * itself is covered by `aggregate.test.ts`; what matters here is the wiring.
 *
 * Two things must hold: every read is scoped to the *caller's* user id (there
 * is no cross-user view by design), and a conversation row whose JSONB blob
 * has no `events` array must fold to zero rather than crash the page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getAuthenticatedUser = vi.fn()
const isBypassEnabled = vi.fn(() => false)
const listConversationEvents = vi.fn()

vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => isBypassEnabled(),
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))
vi.mock('../../../lib/db/conversations.server', () => ({
  listConversationEvents: (userId: string) => listConversationEvents(userId),
  CONVERSATION_EVENTS_SCAN_LIMIT: 200,
}))

import { getMetricsDashboard } from '../../../lib/metrics/dashboard.server'
import type { ContextEvent } from '../../../lib/harness-patterns/types'

function llmEvent(costUsd: number): ContextEvent {
  return {
    id: `e-${costUsd}`,
    type: 'assistant_message',
    timestamp: 1,
    patternId: 'simple-loop',
    data: { content: 'hi' },
    metrics: {
      attempts: 1,
      inputUncachedTokens: 10,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 5,
      costUsd,
      noCacheUsd: costUsd,
      priced: true,
    },
  } as unknown as ContextEvent
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conv-1',
    title: 'A chat',
    agentId: 'neo4j',
    updatedAt: new Date(1_000),
    events: [llmEvent(0.5)],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  isBypassEnabled.mockReturnValue(false)
  getAuthenticatedUser.mockResolvedValue({ id: 'oid-1', email: 'ann@corp.com' })
  listConversationEvents.mockResolvedValue([row()])
})

describe('getMetricsDashboard', () => {
  it('folds only the authenticated caller’s conversations', async () => {
    const out = await getMetricsDashboard()

    expect(listConversationEvents).toHaveBeenCalledWith('oid-1')
    expect(out.totals.costUsd).toBeCloseTo(0.5)
    expect(out.byConversation.map((c) => c.id)).toEqual(['conv-1'])
  })

  it('scopes to the bypass user without an auth lookup when bypass is on', async () => {
    isBypassEnabled.mockReturnValue(true)

    await getMetricsDashboard()

    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(listConversationEvents).toHaveBeenCalledWith('dev-bypass-user')
  })

  it('refuses to load when the caller is not authenticated', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))

    await expect(getMetricsDashboard()).rejects.toThrow(/Authentication required/)
    expect(listConversationEvents).not.toHaveBeenCalled()
  })

  it('treats a row with no events array as an empty conversation', async () => {
    listConversationEvents.mockResolvedValue([row({ id: 'conv-empty', events: null })])

    const out = await getMetricsDashboard()

    expect(out.totals.meteredCalls).toBe(0)
  })

  it('reports the scan limit so the page can say the fold is partial', async () => {
    const out = await getMetricsDashboard()

    expect(out.conversationScanLimit).toBe(200)
  })

  it('stamps when the fold ran', async () => {
    const before = Date.now()

    const out = await getMetricsDashboard()

    expect(out.generatedAt).toBeGreaterThanOrEqual(before)
  })

  it('honours the requested per-conversation row cap', async () => {
    listConversationEvents.mockResolvedValue([
      row({ id: 'a', events: [llmEvent(1)] }),
      row({ id: 'b', events: [llmEvent(2)] }),
      row({ id: 'c', events: [llmEvent(3)] }),
    ])

    const out = await getMetricsDashboard(2)

    expect(out.byConversation).toHaveLength(2)
    expect(out.conversationCount).toBe(3)
    expect(out.conversationsOmitted).toBe(1)
    // Ranked by cost — the cheapest conversation is the one dropped.
    expect(out.byConversation.map((c) => c.id)).not.toContain('a')
  })
})
