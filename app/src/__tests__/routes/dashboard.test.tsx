/**
 * Metrics dashboard page render (#132).
 *
 * The fold is covered exhaustively in `packages/harness-patterns/__tests__/metrics/aggregate.test.ts`; this
 * mounts the route over a stubbed server action to check the numbers actually
 * reach the DOM — global cards, both aggregate tables, the unmetered notice,
 * and the empty state when nothing has been run yet.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildDashboard,
  type ConversationEvents,
} from '@hames-ai/harness-patterns/metrics/aggregate'
import type { ContextEvent } from '@hames-ai/harness-patterns/types'

const getMetricsDashboard = vi.fn()

// Stub the "use server" module — importing it for real would pull in pg.
vi.mock('~/lib/metrics/dashboard.server', () => ({
  getMetricsDashboard: (...args: unknown[]) => getMetricsDashboard(...args),
}))

const { render } = await import('@solidjs/testing-library')
const { default: Dashboard } = await import('~/routes/dashboard')

const tick = () => new Promise((r) => setTimeout(r, 20))

function conversation(id: string, events: ContextEvent[]): ConversationEvents {
  return { id, title: `Thread ${id}`, agentId: 'search', updatedAt: 1_700_000_000_000, events }
}

/** Process-local self-deployed figures the route does not derive from events.
 *  Shape mirrors `MetricsDashboard['inference']`. */
const inference = {
  large: { samples: 3, medianMs: 31_300, slowestMs: 62_200, basis: 'measured' },
  small: { samples: 0, medianMs: null, slowestMs: null, basis: 'default' },
  selfDeployedCall: { p50Ms: 4_100, samples: 12 },
} as const

const dashboardPayload = (conversations: ConversationEvents[]) => ({
  ...buildDashboard(conversations),
  generatedAt: 1_700_000_000_000,
  conversationScanLimit: 200,
  inference,
})
function metered(
  patternId: string,
  costEur: number,
  basis: 'tokens' | 'time' = 'tokens',
  over: Partial<import('@hames-ai/harness-patterns/types').EventMetrics> = {},
): ContextEvent {
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
      costEur,
      noCacheEur: basis === 'time' ? costEur : costEur * 2,
      basis,
      ...over,
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

describe('Dashboard route', () => {
  it('renders totals, both aggregates and the unmetered notice', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([
        conversation('alpha', [metered('neo4j-query', 0.4), unmetered('neo4j-query')]),
        conversation('beta', [metered('web-search', 0.1)]),
      ]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    // Global cards: cost with the caching saving merged into it as the
    // secondary line (owner feedback), plus hit-rate.
    expect(text).toContain('€0.50')
    expect(text).toContain('Cache hit-rate')
    expect(text).toContain('60%') // 12k cache-read of 20k input tokens
    expect(text).toContain('saved €0.50 by caching')

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

    // All token-priced: nothing is a floor, and the wall-clock footnote stays off.
    expect(text).not.toContain('≥')
    expect(text).not.toContain('LARGE_LLM_EUR_PER_HOUR')
  })

  it('marks every cost figure a floor, and explains why, once a step was time-billed', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([
        conversation('alpha', [metered('neo4j-query', 0.4, 'time')]),
        conversation('beta', [metered('web-search', 0.1)]),
      ]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    // The card, and the pattern/conversation row whose own steps were time-billed.
    expect(text).toContain('≥ €0.50')
    expect(text).toContain('≥ €0.40')
    // The marker is per-summary, so the all-token row keeps its exact figure:
    // four markers in total — the card, the two `alpha`-side rows, and the one
    // the footnote quotes when it explains what the symbol means.
    expect(text).toContain('€0.10')
    expect(text.match(/≥/g)).toHaveLength(4)
    // The caveat is stated on the page, not only in a tooltip.
    expect(text).toContain('LARGE_LLM_EUR_PER_HOUR')
    expect(text).toContain('SMALL_LLM_EUR_PER_HOUR')
    expect(text).toContain('LARGE_LLM_EUR_PER_HOUR, and SMALL_LLM_EUR_PER_HOUR')
    // #848: the footnote names the small box's rate basis — the GPU actually
    // served, per-GPU overrides for the fallback types, and the highest-known
    // floor when that could not be read.
    expect(text).toMatch(/highest known rate/)
    expect(text).toMatch(/cold start/)
    expect(text).toMatch(/floors on the bill/)
  })

  it('says "most recent N" when the load hit its row ceiling', async () => {
    getMetricsDashboard.mockResolvedValue({
      ...dashboardPayload([
        conversation('alpha', [metered('neo4j-query', 0.4)]),
        conversation('beta', [metered('web-search', 0.1)]),
      ]),
      conversationScanLimit: 2,
    })

    const { container } = render(() => <Dashboard />)
    await tick()

    expect(container.textContent).toContain('most recent 2 conversations')
  })

  it('shows an empty state when nothing has been run', async () => {
    getMetricsDashboard.mockResolvedValue(dashboardPayload([conversation('quiet', [])]))

    const { container } = render(() => <Dashboard />)
    await tick()

    expect(container.textContent).toContain('No LLM activity recorded yet.')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0)
  })
})

describe('Dashboard route — cache visibility', () => {
  it('hides the cache cards and dashes the cached cells on a purely time-billed account', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([conversation('alpha', [metered('neo4j-query', 0.4, 'time')])]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    // Caching saves nothing on wall-clock-billed steps: no card, no percentage,
    // no cache segment — a dash, never a fabricated 0.
    expect(text).not.toContain('Saved by caching')
    expect(text).not.toContain('by caching')
    expect(text).not.toContain('Cache hit-rate')
    expect(text).not.toContain('cache read')
    // The freed fourth slot is the GPU compute-time tile. These steps carry no
    // measured duration stamp, so the value is absent — never 0s.
    expect(text).toContain('GPU compute time')
    expect(text).toContain('—')
    // The tool-call card and the self-deployed section take the space.
    expect(text).toContain('Tool calls')
    expect(text).toContain('Self-deployed inference')
  })

  it('keeps the cache cards once a token-priced step exists', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([conversation('alpha', [metered('neo4j-query', 0.4)])]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    expect(container.textContent).toContain('saved €0.40 by caching')
    expect(container.textContent).toContain('Cache hit-rate')
    // A scope with a token-priced step renders four tiles already; its compute
    // seconds are part of the >= cost figure, not a fifth tile.
    expect(container.textContent).not.toContain('GPU compute time')
  })
})

describe('Dashboard route — self-deployed inference', () => {
  it("renders each box's wake-wait window and the cold/warm contrast", async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([conversation('a', [metered('p', 0.1)])]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    // Boot-up per box: median / slowest, count, and the measured basis.
    expect(text).toContain('27B wake-ups')
    expect(text).toContain('4B wake-ups')
    expect(text).toContain('31s / 1m 02s')
    expect(text).toContain('median / slowest of 3 wake(s) · measured')
    // The 4B box has no reading here — a dash, not its fallback constant.
    expect(text).toContain('no wake measured by this process yet')
    // Cold vs warm, labelled as what each actually measures.
    expect(text).toContain('Cold: first answer after a wake (27B)')
    expect(text).toContain('Warm: recent call duration (self-hosted tier)')
    expect(text).toContain('4.1s')
  })

  it('hides the section when no wake was measured and no step was time-billed', async () => {
    getMetricsDashboard.mockResolvedValue({
      ...dashboardPayload([conversation('a', [metered('p', 0.1)])]),
      inference: {
        large: { samples: 0, medianMs: null, slowestMs: null, basis: 'default' },
        small: { samples: 0, medianMs: null, slowestMs: null, basis: 'default' },
        selfDeployedCall: { p50Ms: null, samples: 0 },
      },
    })

    const { container } = render(() => <Dashboard />)
    await tick()
    expect(container.textContent).not.toContain('Self-deployed inference')
  })
})

describe('Dashboard route — tool calls', () => {
  it('counts tool calls and failures on the totals card and per conversation', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([
        conversation('alpha', [
          metered('loop', 0.1),
          { type: 'tool_call', ts: 3, patternId: 'loop', data: { tool: 't' } } as ContextEvent,
          { type: 'tool_call', ts: 4, patternId: 'loop', data: { tool: 't' } } as ContextEvent,
          {
            type: 'tool_result',
            ts: 5,
            patternId: 'loop',
            data: { tool: 't', result: 'ok', success: false },
          } as ContextEvent,
        ]),
      ]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    expect(text).toContain('Tool calls')
    expect(text).toContain('1 failed')
    // The conversation row: 2 calls, 1 failure in parentheses.
    expect(text).toContain('2 (1)')
  })
})

describe('Dashboard route — GPU compute time tile', () => {
  it('fills the fourth slot with the summed compute seconds when they were stamped', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([
        conversation('alpha', [
          metered('neo4j-query', 0.4, 'time', {
            timeRate: { eurPerHour: 4.59898, durationMs: 45_000 },
          }),
          metered('neo4j-query', 0.3, 'time', {
            timeRate: { eurPerHour: 4.59898, durationMs: 75_000 },
          }),
        ]),
      ]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    expect(text).toContain('GPU compute time')
    expect(text).toContain('≥ 2m 00s')
  })

  it('shows nothing — never 0s — when a time-priced step carried no duration stamp', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([conversation('alpha', [metered('neo4j-query', 0.4, 'time')])]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    const text = container.textContent ?? ''

    expect(text).toContain('GPU compute time')
    expect(text).not.toContain('0s')
  })

  it('is absent on a MIXED scope — its compute seconds are part of the ≥ cost figure', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([
        conversation('alpha', [
          metered('p', 0.4, 'time', { timeRate: { eurPerHour: 4.6, durationMs: 30_000 } }),
          metered('p', 0.1),
        ]),
      ]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    expect(container.textContent).not.toContain('GPU compute time')
  })

  it('is absent on a scope with no time-priced step', async () => {
    getMetricsDashboard.mockResolvedValue(
      dashboardPayload([conversation('alpha', [metered('p', 0.1)])]),
    )

    const { container } = render(() => <Dashboard />)
    await tick()
    expect(container.textContent).not.toContain('GPU compute time')
  })
})
