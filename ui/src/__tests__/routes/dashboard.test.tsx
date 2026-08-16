/**
 * Metrics dashboard page render (#132).
 *
 * The fold is covered exhaustively in `lib/metrics/aggregate.test.ts`; this
 * mounts the route over a stubbed server action to check the numbers actually
 * reach the DOM — global cards, both aggregate tables, the unmetered notice,
 * and the empty state when nothing has been run yet.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildDashboard, type ConversationEvents } from '~/lib/metrics/aggregate'
import type { ContextEvent } from '~/lib/harness-patterns/types'

const getMetricsDashboard = vi.fn()

// Stub the "use server" module — importing it for real would pull in pg.
vi.mock('~/lib/metrics/dashboard.server', () => ({
  getMetricsDashboard: (...args: unknown[]) => getMetricsDashboard(...args),
}))

const { render } = await import('@solidjs/testing-library')
const { default: Dashboard } = await import('~/routes/dashboard')

const tick = () => new Promise((r) => setTimeout(r, 20))

function metered(patternId: string, costUsd: number): ContextEvent {
  return {
    type: 'controller_action',
    ts: 1,
    patternId,
    data: {},
    llmCall: { functionName: 'LoopController', variables: {} },
    metrics: {
      inputUncachedTokens: 2000,
      inputCacheReadTokens: 6000,
      inputCacheWriteTokens: 2000,
      outputTokens: 1500,
      attempts: 1,
      costUsd,
      noCacheUsd: costUsd * 2,
    },
  } as ContextEvent
}

function unmetered(patternId: string): ContextEvent {
  return {
    type: 'controller_action',
    ts: 2,
    patternId,
    data: {},
    llmCall: { functionName: 'LoopController', variables: {} },
  } as ContextEvent
}

function conversation(id: string, events: ContextEvent[]): ConversationEvents {
  return { id, title: `Thread ${id}`, agentId: 'default', updatedAt: 1_700_000_000_000, events }
}

describe('Dashboard route', () => {
  it('renders totals, both aggregates and the unmetered notice', async () => {
    getMetricsDashboard.mockResolvedValue({
      ...buildDashboard([
        conversation('alpha', [metered('neo4j-query', 0.4), unmetered('neo4j-query')]),
        conversation('beta', [metered('web-search', 0.1)]),
      ]),
      generatedAt: 1_700_000_000_000,
      conversationScanLimit: 200,
    })

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    // Global cards: cost, savings (half the bill is cache-free baseline), hit-rate.
    expect(text).toContain('$0.50')
    expect(text).toContain('Cache hit-rate')
    expect(text).toContain('60%') // 12k cache-read of 20k input tokens
    expect(text).toContain('Saved by caching')

    // Aggregates, ranked by cost.
    expect(text).toContain('neo4j-query')
    expect(text).toContain('web-search')
    expect(text).toContain('Thread alpha')
    expect(text).toContain('Thread beta')

    // Legacy events are surfaced, not silently absorbed.
    expect(text).toContain('unmetered')

    // Under the ceiling, the header states the real count.
    expect(text).toContain('2 conversations')

    const rows = container.querySelectorAll('tbody tr')
    expect(rows.length).toBe(4) // 2 patterns + 2 conversations
  })

  it('says "most recent N" when the load hit its row ceiling', async () => {
    getMetricsDashboard.mockResolvedValue({
      ...buildDashboard([
        conversation('alpha', [metered('neo4j-query', 0.4)]),
        conversation('beta', [metered('web-search', 0.1)]),
      ]),
      generatedAt: 1_700_000_000_000,
      conversationScanLimit: 2,
    })

    const { container } = render(() => <Dashboard />)
    await tick()

    expect(container.textContent).toContain('most recent 2 conversations')
  })

  it('shows an empty state when nothing has been run', async () => {
    getMetricsDashboard.mockResolvedValue({
      ...buildDashboard([conversation('quiet', [])]),
      generatedAt: 1_700_000_000_000,
      conversationScanLimit: 200,
    })

    const { container } = render(() => <Dashboard />)
    await tick()

    expect(container.textContent).toContain('No LLM activity recorded yet.')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0)
  })
})
