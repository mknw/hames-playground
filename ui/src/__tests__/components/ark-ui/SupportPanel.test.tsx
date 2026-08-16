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
 * `DataStashPanel` and `ToolsPanel` (both load server-backed resources on
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
  GraphVisualization: (props: { elements: unknown[] }) => (
    <div data-testid="graph-viz" data-count={props.elements.length} />
  ),
}))

vi.mock('../../../components/ark-ui/DataStashPanel', () => ({
  DataStashPanel: (props: { sessionId: string; agentId?: string }) => (
    <div data-testid="data-stash" data-session={props.sessionId} data-agent={props.agentId} />
  ),
}))

vi.mock('../../../components/ark-ui/ToolsPanel', () => ({
  ToolsPanel: (props: { sessionId?: string; agentId?: string }) => (
    <div data-testid="tools-panel" data-session={props.sessionId} data-agent={props.agentId} />
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

  it('routes the Tools tab to the tools panel', async () => {
    const { container } = render(() => (
      <SupportPanel graphElements={[]} sessionId="sess-9" agentId="code-mode" />
    ))

    await clickTab(container, 'Tools')
    const tools = container.querySelector('[data-testid="tools-panel"]')!
    expect(tools.getAttribute('data-agent')).toBe('code-mode')
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

  it('renders the coming-soon placeholders for the disabled tabs', async () => {
    const { container } = render(() => <SupportPanel graphElements={[]} />)
    expect((tab(container, 'Actions') as HTMLButtonElement).disabled).toBe(true)
    expect((tab(container, 'Documents') as HTMLButtonElement).disabled).toBe(true)
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

  it('shows the per-tab empty message when that source has nothing', async () => {
    const { container } = render(() => <SupportPanel graphElements={[node('a', 'neo4j')]} />)

    await clickTab(container, 'Memory')
    expect(container.textContent).toContain('No memory graph data yet')
    expect(container.querySelector('[data-testid="graph-viz"]')).toBeNull()

    await clickTab(container, 'Neo4j')
    expect(container.textContent).not.toContain('No Neo4j graph data yet')
  })
})

describe('SupportPanel — graph controls bar', () => {
  // A graph element is counted as an edge iff its `data.source` is set — that
  // is the node/edge discriminator Cytoscape itself uses.
  const mixed = [node('n1'), node('n2'), edge('e1', 'n1', 'n2')]

  it('counts nodes and edges for the visible source', async () => {
    const { container } = render(() => <SupportPanel graphElements={mixed} />)
    await clickTab(container, 'Neo4j')
    expect(container.textContent).toContain('2 nodes, 1 edges')
  })

  it('hides the controls bar entirely when the tab has no elements', async () => {
    const { container } = render(() => <SupportPanel graphElements={[]} />)
    await clickTab(container, 'Neo4j')
    expect(container.textContent).not.toContain('Clear Graph')
  })

  it('forwards Clear Graph to the owner', async () => {
    const onClearGraph = vi.fn()
    const { container, getByText } = render(() => (
      <SupportPanel graphElements={mixed} onClearGraph={onClearGraph} />
    ))
    await clickTab(container, 'Neo4j')

    fireEvent.click(getByText('Clear Graph'))
    expect(onClearGraph).toHaveBeenCalledTimes(1)
  })

  it('freezes the rendered graph while sync is paused and catches up on resume', async () => {
    const [elements, setElements] = createSignal<GraphElement[]>(mixed)
    const { container, getByText } = render(() => <SupportPanel graphElements={elements()} />)
    await clickTab(container, 'Neo4j')

    const count = () =>
      container.querySelector('[data-testid="graph-viz"]')!.getAttribute('data-count')
    expect(count()).toBe('3')

    fireEvent.click(getByText('⏸ Sync'))
    setElements([...mixed, node('n3'), node('n4')])
    // Frozen at the snapshot taken when sync was paused.
    expect(count()).toBe('3')
    expect(container.textContent).toContain('2 nodes, 1 edges')

    fireEvent.click(getByText('▶ Sync'))
    expect(count()).toBe('5')
    expect(container.textContent).toContain('4 nodes, 1 edges')
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
