/**
 * SupportPanelRail — the collapsed support panel's icons-only strip (#933).
 *
 * Covered here: one named button per tab (reachable, labelled), clicking one
 * expands the panel on that tab, the Sandbox icon obeys the same
 * definite-false grey-out rule as the tab, and a new event lands for a tab
 * while collapsed → that tab's icon carries the blink class (and its
 * reduced-motion dot) until SUPPORT_BLINK_MS runs out.
 *
 * `SupportPanel` is mocked to a constant so the rail's one import from it
 * cannot drag Cytoscape and the server-backed panels into jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { batch, createSignal } from 'solid-js'
import type { ContextEvent } from '@hames-ai/harness-patterns'

vi.mock('../../../components/ark-ui/SupportPanel', () => ({
  SANDBOX_UNAVAILABLE_REASON:
    'This agent has no sandbox. Choose the Sandbox agent to use this tab.',
}))

const { SupportPanelRail } = await import('../../../components/ark-ui/SupportPanelRail')
const { SUPPORT_BLINK_MS, SUPPORT_RAIL_TABS } = await import('~/lib/support-rail')

const event = (over: Partial<ContextEvent>): ContextEvent => ({
  type: 'tool_result',
  ts: 0,
  patternId: 'p',
  data: {},
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Render the rail against live signals, so a case can land events after mount. */
function mountRail(initial?: {
  events?: ContextEvent[]
  graphElements?: unknown[]
  sandboxAvailable?: boolean
}) {
  const [events, setEvents] = createSignal<ContextEvent[]>(initial?.events ?? [])
  const [elements, setElements] = createSignal<unknown[]>(initial?.graphElements ?? [])
  const onExpand = vi.fn()
  render(() => (
    <SupportPanelRail
      sessionId="s1"
      contextEvents={events()}
      graphElements={elements() as never[]}
      sandboxAvailable={initial?.sandboxAvailable}
      onExpand={onExpand}
    />
  ))
  return { onExpand, setEvents, setElements }
}

describe('the rail', () => {
  it('offers one labelled button per tab, plus the expand toggle', () => {
    const { onExpand } = mountRail()
    for (const tab of SUPPORT_RAIL_TABS) {
      const button = document.querySelector(`[data-testid="support-rail-${tab.id}"]`)
      expect(button, tab.id).not.toBeNull()
      expect(button?.getAttribute('aria-label')).toBe(`Open ${tab.label} panel`)
    }
    const expand = document.querySelector('[data-testid="support-rail-expand"]')
    expect(expand?.getAttribute('aria-label')).toBe('Expand panel')
    // The toggle expands without naming a tab — the panel keeps its own.
    fireEvent.click(expand!)
    expect(onExpand).toHaveBeenCalledWith()
  })

  it('expands onto the tab its icon names', () => {
    const { onExpand } = mountRail()
    fireEvent.click(document.querySelector('[data-testid="support-rail-neo4j-graph"]')!)
    expect(onExpand).toHaveBeenCalledWith('neo4j-graph')
  })

  it('greys the Sandbox icon out on a definite false, and clicking it does nothing', () => {
    const { onExpand } = mountRail({ sandboxAvailable: false })
    const button = document.querySelector('[data-testid="support-rail-sandbox"]')!
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('title')).toContain('no sandbox')
    fireEvent.click(button)
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('keeps the Sandbox icon usable when sandbox availability is merely unknown', () => {
    const { onExpand } = mountRail({ sandboxAvailable: undefined })
    const button = document.querySelector('[data-testid="support-rail-sandbox"]')!
    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    expect(onExpand).toHaveBeenCalledWith('sandbox')
  })

  it('blinks a tab when an event lands for it while collapsed, then stops', () => {
    const { setEvents } = mountRail()
    const icon = () => document.querySelector('[data-testid="support-rail-data"] span')!
    // The backlog did not blink: mounted with an empty buffer, nothing carried
    // the class before anything arrived.
    expect(icon().className).not.toContain('support-rail-blink')

    setEvents([event({ type: 'tool_result' })])
    expect(icon().className).toContain('support-rail-blink')
    // And the reduced-motion fallback's dot is present in the DOM — the CSS
    // decides whether it shows.
    expect(document.querySelector('.support-rail-blink-dot')).not.toBeNull()

    vi.advanceTimersByTime(SUPPORT_BLINK_MS)
    expect(icon().className).not.toContain('support-rail-blink')
    expect(document.querySelector('.support-rail-blink-dot')).toBeNull()
  })

  it('blinks Neo4j for new graph elements while collapsed', () => {
    const { setElements } = mountRail()
    setElements([{ data: { id: 'n1' } }])
    expect(
      document.querySelector('[data-testid="support-rail-neo4j-graph"] span')!.className,
    ).toContain('support-rail-blink')
  })

  it('does not blink for a different session backlog', () => {
    // A rail is per-collapse, so a session switch mid-collapse shows up as the
    // sessionId prop changing under the same mounted rail (the route re-renders
    // it). The counters re-snapshot instead of announcing the other session's
    // history. Rendered through parent signals to reproduce that path — and
    // batched, the way the route's one synchronous propagation applies both.
    const [sid, setSid] = createSignal('s1')
    const [events, setEvents] = createSignal<ContextEvent[]>([])
    render(() => (
      <SupportPanelRail
        sessionId={sid()}
        contextEvents={events()}
        graphElements={[]}
        onExpand={() => {}}
      />
    ))
    // A whole other conversation's worth of events arrives under the NEW id.
    batch(() => {
      setSid('s2')
      setEvents([event({ type: 'tool_result' }), event({ type: 'tool_result' })])
    })
    expect(
      document.querySelector('[data-testid="support-rail-data"] span')!.className,
    ).not.toContain('support-rail-blink')
    // But the next event AFTER the snapshot still blinks.
    setEvents([event({ type: 'tool_result' }), event({ type: 'tool_result' }), event({})])
    expect(document.querySelector('[data-testid="support-rail-data"] span')!.className).toContain(
      'support-rail-blink',
    )
  })
})
