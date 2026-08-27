/**
 * SupportPanel — tab routing, the per-source graph split, and the graph
 * controls bar (sync freeze / clear).
 *
 * The panel's own logic is: which tab is showing, which `graphElements` reach
 * which tab (`source === 'memory'` vs neo4j-or-unset), and the freeze/thaw
 * behaviour of `GraphTabContent`'s Sync toggle. `Tabs.Root` runs with
 * `lazyMount` + `unmountOnExit`, so a tab's child only exists while selected —
 * the tests lean on that to prove routing rather than inspecting internals.
 *
 * Stubs: `GraphVisualization` (Cytoscape needs layout/canvas jsdom has not),
 * `DataStashPanel` (loads server-backed resources on
 * mount). Each stub echoes the props the panel is contracted to pass down.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import type { ContextEvent } from '~/lib/harness-patterns'
import type { GraphElement } from '~/lib/harness-client/types'
import type { OpenReferenceTarget } from '~/lib/harness-client/reference-extractor'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../components/ark-ui/GraphVisualization', () => ({
  GraphVisualization: (props: {
    elements: unknown[]
    emptyMessage?: string
    onClearGraph?: () => void
  }) => (
    <div
      data-testid="graph-viz"
      data-count={props.elements.length}
      data-empty-message={props.emptyMessage}
      data-has-clear={props.onClearGraph ? 'yes' : 'no'}
    >
      {/* The clear control itself lives in the real GraphVisualization (it owns
          the Cytoscape instance). What the panel is contracted to pass is the
          reset, so the stub offers a way to invoke it. */}
      <button onClick={() => props.onClearGraph?.()}>stub-clear</button>
    </div>
  ),
}))

vi.mock('../../../components/ark-ui/DataStashPanel', () => ({
  DataStashPanel: (props: { sessionId: string; agentId?: string }) => (
    <div data-testid="data-stash" data-session={props.sessionId} data-agent={props.agentId} />
  ),
}))

const { SupportPanel } = await import('../../../components/ark-ui/SupportPanel')

const node = (id: string, source?: GraphElement['source']): GraphElement => ({
  data: { id, label: id },
  ...(source ? { source } : {}),
})
const edge = (
  id: string,
  from: string,
  to: string,
  source?: GraphElement['source'],
): GraphElement => ({
  data: { id, source: from, target: to, label: 'REL' },
  ...(source ? { source } : {}),
})

const tab = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-scope="tabs"][data-part="trigger"]')].find(
    (el) => el.textContent?.includes(label),
  )!

/** zag's tabs machine settles its selection asynchronously. */
const tick = () => new Promise((r) => setTimeout(r, 30))

/** The Sync toggle is a pause/play icon + the word "Sync", so its STATE lives
 *  only in the accessible name — found by the invariant half of that name. */
const syncToggle = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('button')].find((b) =>
    b.getAttribute('aria-label')?.endsWith('graph sync'),
  )!

const clickTab = async (container: HTMLElement, label: string) => {
  fireEvent.click(tab(container, label))
  await tick()
}

describe('SupportPanel — tab routing', () => {
  it('opens on the Context manager tab, showing the observability timeline', async () => {
    const { container, getByText } = render(() => <SupportPanel graphElements={[]} />)

    expect(getByText('No events yet')).toBeTruthy()
    // lazyMount: no other tab's content has been built yet.
    expect(container.querySelector('[data-testid="graph-viz"]')).toBeNull()
    expect(container.querySelector('[data-testid="data-stash"]')).toBeNull()
  })

  it('routes the Data tab to the stash panel with the session and agent ids', async () => {
    const { container } = render(() => (
      <SupportPanel graphElements={[]} sessionId="sess-9" agentId="researcher" />
    ))

    await clickTab(container, 'Data')
    const stash = container.querySelector('[data-testid="data-stash"]')!
    expect(stash.getAttribute('data-session')).toBe('sess-9')
    expect(stash.getAttribute('data-agent')).toBe('researcher')
  })

  it('passes an empty string to the stash panel when no session exists yet', async () => {
    const { container } = render(() => <SupportPanel graphElements={[]} />)
    await clickTab(container, 'Data')
    expect(
      container.querySelector('[data-testid="data-stash"]')!.getAttribute('data-session'),
    ).toBe('')
  })

  it('routes the Terminal tab to the sandbox feed', async () => {
    const events: ContextEvent[] = [
      {
        type: 'tool_call',
        ts: 1,
        patternId: 'sandbox',
        data: { callId: 'c1', tool: 'sandbox_bash', args: { command: 'ls -la' } },
      },
    ]
    const { container } = render(() => (
      <SupportPanel graphElements={[]} contextEvents={events} sessionId="sess-9" />
    ))

    await clickTab(container, 'Terminal')
    expect(container.textContent).toContain('1 sandbox command')
    expect(container.textContent).toContain('ls -la')
  })

  // Three tabs have been deleted for the alpha preview: the two disabled
  // "coming in Phase 6/7" stops (Actions, Documents), which led to a
  // placeholder, and "All" (the Turn Explorer), which the owner found showed
  // nothing useful. This pins that they stay gone rather than being re-added as
  // clutter; git holds the panels themselves.
  it('offers no tab that leads nowhere', async () => {
    const { container } = render(() => <SupportPanel graphElements={[]} />)
    const labels = [
      ...container.querySelectorAll<HTMLElement>('[data-scope="tabs"][data-part="trigger"]'),
    ].map((el) => el.textContent?.trim())
    expect(labels).not.toContain('Actions')
    expect(labels).not.toContain('Documents')
    expect(labels).not.toContain('All')
    expect(labels.length).toBe(5)
  })

  it('jumps to the Data tab when a chat citation is clicked', async () => {
    const [ref, setRef] = createSignal<OpenReferenceTarget | null>(null)
    const { container } = render(() => (
      <SupportPanel graphElements={[]} pendingReference={ref()} sessionId="s" />
    ))
    expect(container.querySelector('[data-testid="data-stash"]')).toBeNull()

    setRef({ docId: 'doc-1' })
    await tick()
    expect(container.querySelector('[data-testid="data-stash"]')).toBeTruthy()
  })
})

describe('SupportPanel — per-source graph split', () => {
  it('sends unsourced and neo4j elements to the Neo4j tab only', async () => {
    const elements = [node('a'), node('b', 'neo4j'), node('m', 'memory')]
    const { container } = render(() => <SupportPanel graphElements={elements} />)

    await clickTab(container, 'Neo4j')
    expect(container.querySelector('[data-testid="graph-viz"]')!.getAttribute('data-count')).toBe(
      '2',
    )
  })

  it('sends only memory-sourced elements to the Memory tab', async () => {
    const elements = [node('a'), node('b', 'neo4j'), node('m', 'memory')]
    const { container } = render(() => <SupportPanel graphElements={elements} />)

    await clickTab(container, 'Memory')
    expect(container.querySelector('[data-testid="graph-viz"]')!.getAttribute('data-count')).toBe(
      '1',
    )
  })

  // #237 follow-up: the graph used to be swapped out for a plain empty-state
  // div, which took the manual Cypher box (it lives inside GraphVisualization)
  // with it — so there was no way to query before a chat turn had populated the
  // graph. It stays mounted now, and owns the empty state; the per-tab copy is
  // handed to it rather than rendered here.
  it('keeps the graph mounted with nothing in it, and passes the per-tab empty copy', async () => {
    const { container } = render(() => <SupportPanel graphElements={[node('a', 'neo4j')]} />)

    await clickTab(container, 'Memory')
    const memoryViz = container.querySelector('[data-testid="graph-viz"]')!
    expect(memoryViz.getAttribute('data-count')).toBe('0')
    expect(memoryViz.getAttribute('data-empty-message')).toContain('No memory graph data yet')

    await clickTab(container, 'Neo4j')
    const neo4jViz = container.querySelector('[data-testid="graph-viz"]')!
    expect(neo4jViz.getAttribute('data-count')).toBe('1')
    expect(neo4jViz.getAttribute('data-empty-message')).toContain('No Neo4j graph data yet')
  })
})

describe('SupportPanel — graph controls bar', () => {
  // Node vs edge comes from the extractor's explicit `data.kind` stamp
  // (SA-M12), with the legacy both-endpoints shape as the fallback for graphs
  // restored from a session persisted before `kind` existed.
  const mixed = [node('n1'), node('n2'), edge('e1', 'n1', 'n2')]

  it('counts nodes and edges for the visible source', async () => {
    const { container } = render(() => <SupportPanel graphElements={mixed} />)
    await clickTab(container, 'Neo4j')
    expect(container.textContent).toContain('2 nodes, 1 edges')
  })

  it('counts a node carrying a source property as a node', async () => {
    // `(:Chunk {source: 'report.pdf'})` — a real shape in this repo's Data
    // Stash schema, which the old `data.source` test read as an edge.
    const chunk: GraphElement = {
      data: { id: 'chunk-1', label: 'chunk-1', source: 'report.pdf', kind: 'node' },
    }
    const { container } = render(() => <SupportPanel graphElements={[chunk, node('n1')]} />)
    await clickTab(container, 'Neo4j')
    expect(container.textContent).toContain('2 nodes, 0 edges')
  })

  it('hides the controls bar entirely when the tab has no elements', async () => {
    const { container } = render(() => <SupportPanel graphElements={[]} />)
    await clickTab(container, 'Neo4j')
    expect(container.textContent).not.toContain('Sync')
  })

  it('freezes the rendered graph while sync is paused and catches up on resume', async () => {
    const [elements, setElements] = createSignal<GraphElement[]>(mixed)
    const { container } = render(() => <SupportPanel graphElements={elements()} />)
    await clickTab(container, 'Neo4j')

    const count = () =>
      container.querySelector('[data-testid="graph-viz"]')!.getAttribute('data-count')
    expect(count()).toBe('3')

    expect(syncToggle(container).getAttribute('aria-label')).toBe('Pause graph sync')
    fireEvent.click(syncToggle(container))
    expect(syncToggle(container).getAttribute('aria-label')).toBe('Resume graph sync')
    setElements([...mixed, node('n3'), node('n4')])
    // Frozen at the snapshot taken when sync was paused.
    expect(count()).toBe('3')
    expect(container.textContent).toContain('2 nodes, 1 edges')

    fireEvent.click(syncToggle(container))
    expect(count()).toBe('5')
    expect(container.textContent).toContain('4 nodes, 1 edges')
  })

  // The clear control moved onto the canvas toolbar, beside Fit View / zoom /
  // + Node: it has to be reachable when the conversation graph is empty but the
  // canvas is not (a manual Cypher query), and the old count-gated button in
  // this bar was hidden in exactly that case.
  it('hands the canvas a reset, and forwards it to the owner', async () => {
    const onClearGraph = vi.fn()
    const { container, getByText } = render(() => (
      <SupportPanel graphElements={[]} onClearGraph={onClearGraph} />
    ))
    await clickTab(container, 'Neo4j')

    expect(
      container.querySelector('[data-testid="graph-viz"]')!.getAttribute('data-has-clear'),
    ).toBe('yes')
    fireEvent.click(getByText('stub-clear'))
    expect(onClearGraph).toHaveBeenCalledTimes(1)
  })

  it('offers no clear when nothing owns the elements', async () => {
    const { container } = render(() => <SupportPanel graphElements={mixed} />)
    await clickTab(container, 'Neo4j')
    expect(
      container.querySelector('[data-testid="graph-viz"]')!.getAttribute('data-has-clear'),
    ).toBe('no')
  })

  // Clearing a PAUSED view has to drop the snapshot too. Resetting only the
  // conversation's list leaves `frozenElements` rendering, and the element
  // effect re-runs on tab visibility — so the snapshot would come back. It also
  // has to leave the freeze: this bar is hidden while the tab has nothing to
  // show, so a clear that stayed paused would take the Sync toggle with it and
  // strand the tab on an empty snapshot for good.
  it('drops the freeze snapshot and resumes sync', async () => {
    const [elements, setElements] = createSignal<GraphElement[]>(mixed)
    const { container, getByText } = render(() => (
      <SupportPanel graphElements={elements()} onClearGraph={() => setElements([])} />
    ))
    await clickTab(container, 'Neo4j')

    const count = () =>
      container.querySelector('[data-testid="graph-viz"]')!.getAttribute('data-count')

    fireEvent.click(getByText('⏸ Sync'))
    expect(count()).toBe('3')

    fireEvent.click(getByText('stub-clear'))
    expect(count(), 'the snapshot is empty, not still frozen at 3').toBe('0')

    // Live again: a later result repopulates instead of resurrecting the old
    // snapshot, and the toggle is back to prove sync resumed.
    setElements([node('n9')])
    expect(count()).toBe('1')
    expect(getByText('⏸ Sync')).toBeTruthy()
  })
})

describe('SupportPanel — Context manager tab', () => {
  it('forwards the event stream and the clear callback to the observability panel', async () => {
    const onClearEvents = vi.fn()
    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'hello there' } },
    ]
    const { getByText } = render(() => (
      <SupportPanel graphElements={[]} contextEvents={events} onClearEvents={onClearEvents} />
    ))

    expect(getByText('hello there')).toBeTruthy()
    fireEvent.click(getByText('Clear'))
    expect(onClearEvents).toHaveBeenCalledTimes(1)
  })
})
