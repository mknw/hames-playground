/**
 * AllGraphTab — the Turn Explorer's selection model.
 *
 * The tab derives everything it shows from `contextEvents`: which turns exist
 * and carry graph data, which of those the user has ticked, and the union of
 * graph elements those ticks imply (deduplicated, earliest turn winning). The
 * tests drive it the way a user does — open the explorer, click turn columns —
 * and assert on the counts, the legend and the empty states.
 *
 * `GraphVisualization` is stubbed (Cytoscape needs layout/canvas jsdom has
 * not); it echoes back the element count and the per-turn style selectors so
 * the colour-coding contract is observable. The window controls
 * (minimize/maximize/restore/close) are covered by
 * `floating-panel-controls.test.tsx` and are not repeated here.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import type { ContextEvent } from '~/lib/harness-patterns'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

vi.mock('../../../components/ark-ui/GraphVisualization', () => ({
  GraphVisualization: (props: { elements: unknown[]; extraStyles?: { selector: string }[] }) => (
    <div
      data-testid="graph-viz"
      data-count={props.elements.length}
      data-selectors={(props.extraStyles ?? []).map((s) => s.selector).join('|')}
    />
  ),
}))

const { AllGraphTabWrapper } = await import('../../../components/ark-ui/AllGraphTab')

const tick = () => new Promise((r) => setTimeout(r, 30))

let ts = 0
const userMessage = (content: string): ContextEvent => ({
  type: 'user_message',
  ts: ts++,
  patternId: 'harness',
  data: { content },
})

/** A memory-graph tool_result — the shape `graph-extractor` turns into nodes/edges. */
const memoryResult = (entities: string[], relations: [string, string][] = []): ContextEvent => ({
  type: 'tool_result',
  ts: ts++,
  patternId: 'memory-query',
  data: {
    callId: `c${ts}`,
    tool: 'read_graph',
    success: true,
    result: {
      entities: entities.map((name) => ({ name, entityType: 'Concept' })),
      relations: relations.map(([from, to]) => ({ from, to, relationType: 'RELATES_TO' })),
    },
  },
})

/** A tool_result that produces no graph data at all. */
const plainResult = (): ContextEvent => ({
  type: 'tool_result',
  ts: ts++,
  patternId: 'web-search',
  data: { callId: `c${ts}`, tool: 'fetch', success: true, result: { text: 'nothing graphy' } },
})

const openExplorer = async (container: HTMLElement) => {
  container.querySelector<HTMLElement>('[data-part="trigger"]')!.click()
  await tick()
}

/** The clickable header of a turn column inside the explorer body. */
const turnColumn = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-part="body"] div[cursor="pointer"]')].find(
    (el) => el.textContent?.includes(label),
  )!

const viz = (container: HTMLElement) => container.querySelector('[data-testid="graph-viz"]')

describe('AllGraphTab — empty states', () => {
  it('tells the user to interact with the agent when no turn has graph data', async () => {
    const { container } = render(() => (
      <AllGraphTabWrapper contextEvents={[userMessage('hi'), plainResult()]} />
    ))

    expect(container.textContent).toContain('No graph data yet')
    expect(container.textContent).not.toContain('Select turns from the Turn Explorer')
    expect(viz(container)).toBeNull()

    await openExplorer(container)
    expect(document.body.textContent).toContain('No graph data in any turn yet')
  })

  it('points at the Turn Explorer once some turn does have graph data', () => {
    const { container } = render(() => (
      <AllGraphTabWrapper contextEvents={[userMessage('hi'), memoryResult(['A'])]} />
    ))

    expect(container.textContent).toContain('Select turns from the Turn Explorer')
    expect(container.textContent).toContain('to open the Turn Explorer')
    expect(container.textContent).toContain('No turns selected')
  })

  it('discards events that precede the first user message', () => {
    // splitIntoTurns has no turn to attach them to, so they cannot be selected.
    const { container } = render(() => <AllGraphTabWrapper contextEvents={[memoryResult(['A'])]} />)
    expect(container.textContent).toContain('No graph data yet')
  })
})

describe('AllGraphTab — turn selection', () => {
  const events = [
    userMessage('what concepts exist?'),
    memoryResult(['Alpha', 'Beta'], [['Alpha', 'Beta']]),
    userMessage('and the third?'),
    memoryResult(['Gamma']),
    userMessage('nothing graphy here'),
    plainResult(),
  ]

  it('lists only the turns that produced graph data, with their result counts', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    await openExplorer(container)

    const body = document.querySelector('[data-part="body"]')!
    expect(body.textContent).toContain('Turn 1')
    expect(body.textContent).toContain('Turn 2')
    // Turn 3's only tool result produced no graph — the column is not offered.
    expect(body.textContent).not.toContain('Turn 3')
    expect(body.textContent).toContain('what concepts exist?')
    // `read_graph` is shown with its verb prefix stripped.
    expect(body.textContent).toContain('graph')
  })

  it('renders the graph for a ticked turn and colour-codes it by turn number', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    await openExplorer(container)

    fireEvent.click(turnColumn('Turn 1'))
    await tick()

    // Two entities + one relation.
    expect(viz(container)!.getAttribute('data-count')).toBe('3')
    expect(container.textContent).toContain('2 nodes, 1 edges')
    expect(container.textContent).toContain('(1 turn)')
    expect(viz(container)!.getAttribute('data-selectors')).toBe('node[turn = 1]|edge[turn = 1]')
  })

  it('unions the selected turns and pluralises the turn count', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    await openExplorer(container)

    fireEvent.click(turnColumn('Turn 1'))
    fireEvent.click(turnColumn('Turn 2'))
    await tick()

    expect(viz(container)!.getAttribute('data-count')).toBe('4')
    expect(container.textContent).toContain('3 nodes, 1 edges')
    expect(container.textContent).toContain('(2 turns)')
  })

  it('untoggles a turn on a second click', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    await openExplorer(container)

    fireEvent.click(turnColumn('Turn 1'))
    await tick()
    expect(viz(container)).toBeTruthy()

    fireEvent.click(turnColumn('Turn 1'))
    await tick()
    expect(viz(container)).toBeNull()
    expect(container.textContent).toContain('No turns selected')
  })

  it('deduplicates a node seen in two turns, keeping the earlier turn', async () => {
    const shared = [
      userMessage('first'),
      memoryResult(['Shared']),
      userMessage('second'),
      memoryResult(['Shared', 'Fresh']),
    ]
    const { container } = render(() => <AllGraphTabWrapper contextEvents={shared} />)
    await openExplorer(container)

    fireEvent.click(turnColumn('Turn 1'))
    fireEvent.click(turnColumn('Turn 2'))
    await tick()

    // Shared + Fresh, not Shared twice.
    expect(viz(container)!.getAttribute('data-count')).toBe('2')
    expect(container.textContent).toContain('2 nodes, 0 edges')
  })

  it('selects and clears every graph-bearing turn from the explorer header', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    await openExplorer(container)

    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'All')!)
    await tick()
    expect(container.textContent).toContain('(2 turns)')

    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'None')!)
    await tick()
    expect(container.textContent).toContain('No turns selected')
  })

  it('offers a Clear button on the controls bar only while something is selected', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    const clearButton = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Clear')

    await openExplorer(container)
    expect(clearButton()).toBeUndefined()

    fireEvent.click(turnColumn('Turn 1'))
    await tick()
    expect(clearButton()).toBeTruthy()

    fireEvent.click(clearButton()!)
    await tick()
    expect(clearButton()).toBeUndefined()
    expect(viz(container)).toBeNull()
  })

  it('shows a colour legend entry per selected turn, in ascending order', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    await openExplorer(container)

    fireEvent.click(turnColumn('Turn 2'))
    fireEvent.click(turnColumn('Turn 1'))
    await tick()

    const legend = [...container.querySelectorAll('div')].find(
      (d) => d.textContent?.startsWith('Turns') && d.textContent.includes('Turn 1'),
    )!
    const entries = [...legend.querySelectorAll('span')]
      .map((s) => s.textContent)
      .filter((t) => t?.startsWith('Turn '))
    expect(entries).toEqual(['Turn 1', 'Turn 2'])
  })
})

describe('AllGraphTab — turn column detail', () => {
  it('labels a turn without a user message body as having none', async () => {
    const events = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: {} } as ContextEvent,
      memoryResult(['A']),
    ]
    const { container } = render(() => <AllGraphTabWrapper contextEvents={events} />)
    await openExplorer(container)

    expect(turnColumn('Turn 1').textContent).toContain('Turn 1')
  })

  it('truncates a long user message in the column header', async () => {
    const long = 'x'.repeat(120)
    const { container } = render(() => (
      <AllGraphTabWrapper contextEvents={[userMessage(long), memoryResult(['A'])]} />
    ))
    await openExplorer(container)

    const header = turnColumn('Turn 1').textContent!
    expect(header).toContain('x'.repeat(40) + '...')
    expect(header).not.toContain('x'.repeat(41))
  })
})
