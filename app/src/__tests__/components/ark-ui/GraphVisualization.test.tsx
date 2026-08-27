/**
 * GraphVisualization — the toolbar, the editing surface, and the Cytoscape
 * bridge.
 *
 * Cytoscape needs a canvas, so `cytoscape` is replaced with a recording double.
 * That double is not the thing under test: what is asserted is the traffic
 * across it (which elements get added, which layout is run, which Cypher is
 * handed to `onCypherWrite`) plus everything the component renders on its own —
 * the empty state, the query panel, the properties panel and relation mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSignal } from 'solid-js'
import type { ElementDefinition } from 'cytoscape'

// ---------------------------------------------------------------------------
// Cytoscape double
// ---------------------------------------------------------------------------

interface Handler {
  event: string
  selector?: string
  fn: (evt: { target: unknown }) => void
}

interface FakeCollection {
  length: number
  ids: string[]
  map: <T>(fn: (el: { id: () => string }) => T) => T[]
  nonempty: () => boolean
  empty: () => boolean
  union: (other: FakeCollection) => FakeCollection
  remove: () => void
  removeClass: () => void
  addClass: (cls: string) => void
  layout: (opts: { name: string }) => { run: () => void }
  position: unknown
}

const added: unknown[] = []
const layoutsRun: string[] = []
/** Every `layout(opts)` the component runs, with the options object it handed
 *  over — `fit` lives in there, not on `cy.fit`, so the re-framing behaviour of
 *  an incremental add is only visible here. */
const layoutRuns: { scope: 'core' | 'elements'; opts: Record<string, unknown> }[] = []
const styleUpdates: Record<string, unknown>[] = []
const destroyed = vi.fn()
const fit = vi.fn()
const dataWrites: [string, string, unknown][] = []

let handlers: Handler[] = []
let nodeIds: string[] = []
let edgeIds: string[] = []
let zoomLevel = 1
let cyInstance: FakeCore | undefined
let highlighted: string[] = []

/** Ids `add` should refuse, so the per-element retry path can be exercised. */
let rejectIds: string[] = []

const collection = (ids: string[]): FakeCollection => ({
  length: ids.length,
  ids,
  map: <T,>(fn: (el: { id: () => string }) => T) => ids.map((id) => fn({ id: () => id })),
  nonempty: () => ids.length > 0,
  empty: () => ids.length === 0,
  union: (other: FakeCollection) => collection([...ids, ...other.ids]),
  remove: () => {
    nodeIds = []
    edgeIds = []
  },
  removeClass: () => {
    highlighted = []
  },
  addClass: (cls: string) => {
    if (cls === 'highlighted') highlighted.push(...ids)
  },
  layout: (opts: { name: string }) => ({
    run: () => {
      layoutsRun.push(opts.name)
      layoutRuns.push({ scope: 'elements', opts: opts as Record<string, unknown> })
    },
  }),
  position: vi.fn(),
})

class FakeCore {
  on(event: string, selectorOrFn: string | Handler['fn'], maybeFn?: Handler['fn']) {
    handlers.push(
      typeof selectorOrFn === 'string'
        ? { event, selector: selectorOrFn, fn: maybeFn! }
        : { event, fn: selectorOrFn },
    )
  }
  add(els: ElementDefinition | ElementDefinition[]) {
    const list = Array.isArray(els) ? els : [els]
    for (const el of list) {
      const id = el.data?.id as string
      // Real Cytoscape aborts the whole batch on a malformed element.
      if (rejectIds.includes(id)) throw new Error(`bad element: ${id}`)
      added.push(el)
      if (el.data?.source) edgeIds.push(id)
      else nodeIds.push(id)
    }
    return collection(list.map((el) => el.data?.id as string))
  }
  collection() {
    return collection([])
  }
  elements() {
    return collection([...nodeIds, ...edgeIds])
  }
  nodes() {
    return collection(nodeIds)
  }
  edges() {
    return collection(edgeIds)
  }
  $id(id: string) {
    return collection(nodeIds.includes(id) || edgeIds.includes(id) ? [id] : [])
  }
  getElementById(id: string) {
    return {
      data: (key: string, value: unknown) => dataWrites.push([id, key, value]),
      nonempty: () => nodeIds.includes(id) || edgeIds.includes(id),
      empty: () => !nodeIds.includes(id) && !edgeIds.includes(id),
    }
  }
  layout(opts: { name: string }) {
    return {
      run: () => {
        layoutsRun.push(opts.name)
        layoutRuns.push({ scope: 'core', opts: opts as Record<string, unknown> })
      },
    }
  }
  style(sheet?: unknown) {
    if (sheet !== undefined) return undefined
    const chain = {
      selector: () => chain,
      style: (s: Record<string, unknown>) => {
        styleUpdates.push(s)
        return chain
      },
      update: () => chain,
    }
    return chain
  }
  fit = fit
  resize = vi.fn()
  zoom(next?: number) {
    if (next === undefined) return zoomLevel
    zoomLevel = next
    return zoomLevel
  }
  extent() {
    return { x1: 0, y1: 0, x2: 200, y2: 200 }
  }
  animate = vi.fn()
  destroy = destroyed
}

vi.mock('cytoscape', () => ({
  default: () => {
    cyInstance = new FakeCore()
    return cyInstance
  },
}))

const runManualCypher = vi.fn()
const getNodeProperties = vi.fn()
vi.mock('~/lib/neo4j/queries', () => ({
  runManualCypher: (...a: unknown[]) => runManualCypher(...a),
  getNodeProperties: (...a: unknown[]) => getNodeProperties(...a),
}))

// Intent-shaped graph edit RPCs (#226 C2) — the component calls these
// directly instead of shipping raw Cypher through an onCypherWrite prop.
const createGraphNode = vi.fn(async (..._a: unknown[]) => {})
const linkGraphNodes = vi.fn(async (..._a: unknown[]) => {})
const setGraphNodeProperty = vi.fn(async (..._a: unknown[]) => {})
vi.mock('~/lib/neo4j/graph-edit.server', () => ({
  createGraphNode: (...a: unknown[]) => createGraphNode(...a),
  linkGraphNodes: (...a: unknown[]) => linkGraphNodes(...a),
  setGraphNodeProperty: (...a: unknown[]) => setGraphNodeProperty(...a),
}))

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

let resizeCb: ((entries: { contentRect: { width: number; height: number } }[]) => void) | undefined

const { render } = await import('@solidjs/testing-library')
const { GraphVisualization } = await import('../../../components/ark-ui/GraphVisualization')

const tick = () => new Promise((r) => setTimeout(r, 20))

/** Make the container "visible" — the element effect is gated on a non-zero size. */
const becomeVisible = async () => {
  resizeCb?.([{ contentRect: { width: 800, height: 600 } }])
  await tick()
}

const fire = (event: string, selector: string | undefined, target: unknown) => {
  const h = handlers.find((x) => x.event === event && x.selector === selector)!
  h.fn({ target })
}

const fakeNode = (id: string, data: Record<string, unknown>) => ({
  id: () => id,
  data: () => ({ id, ...data }),
  renderedPosition: () => ({ x: 100, y: 120 }),
})

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!

const nodes = (ids: string[]): ElementDefinition[] =>
  ids.map((id) => ({ data: { id, label: id.toUpperCase() } }))

beforeEach(() => {
  added.length = 0
  layoutsRun.length = 0
  layoutRuns.length = 0
  styleUpdates.length = 0
  dataWrites.length = 0
  handlers = []
  nodeIds = []
  edgeIds = []
  rejectIds = []
  highlighted = []
  zoomLevel = 1
  cyInstance = undefined
  resizeCb = undefined
  vi.clearAllMocks()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: typeof resizeCb) {
        resizeCb = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

describe('GraphVisualization — mounting and elements', () => {
  it('shows the empty state and no counts before anything is loaded', async () => {
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await tick()

    expect(container.textContent).toContain('No Graph Data')
    expect(container.textContent).toContain('0 nodes')
    expect(container.textContent).toContain('0 edges')
  })

  // #237 follow-up: the panel is now mounted with an empty graph, so the empty
  // state carries the caller's per-tab copy and points at the manual Cypher box
  // — which is the only thing a user can do before any chat turn.
  it('renders the caller-supplied empty copy and points at the manual query box', async () => {
    const { container } = render(() => (
      <GraphVisualization
        elements={[]}
        emptyIconClass="i-material-symbols-database-outline"
        emptyMessage="No Neo4j graph data yet. Query your knowledge base to see results."
      />
    ))
    await tick()

    expect(container.textContent).toContain('No Neo4j graph data yet')
    // The glyph is an icon utility class, not a character in the text — an
    // emoji here was what #294's follow-up swept out of the chrome.
    expect(container.querySelector('.i-material-symbols-database-outline')).toBeTruthy()
    expect(container.textContent).toContain('Manual Cypher Query')
  })

  it('falls back to the default empty copy when the caller supplies none', async () => {
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await tick()

    expect(container.textContent).toContain('Ask a question to visualize the knowledge graph')
  })

  it('holds off loading elements until the container has a size', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a', 'b'])} />)
    await tick()
    expect(added).toHaveLength(0)

    await becomeVisible()

    expect(added).toHaveLength(2)
    expect(container.textContent).toContain('2 nodes')
    expect(container.textContent).not.toContain('No Graph Data')
    expect(layoutsRun).toContain('cose')
    expect(fit).toHaveBeenCalled()
    // First load frames the whole graph: the layout is run over the core and
    // is not opted out of fitting.
    expect(layoutRuns).toEqual([{ scope: 'core', opts: expect.objectContaining({ name: 'cose' }) }])
    expect(layoutRuns[0].opts.fit).not.toBe(false)
  })

  // SA-H9. `cy.add()` throws on a malformed element, and it was called bare
  // inside a createEffect — so one bad row from one Cypher query took the whole
  // canvas down rather than costing itself.
  it('renders the rest of the batch when Cytoscape rejects one element', async () => {
    rejectIds = ['bad']
    const { container } = render(() => (
      <GraphVisualization elements={[...nodes(['a']), ...nodes(['bad']), ...nodes(['c'])]} />
    ))
    await becomeVisible()

    expect(added.map((e) => (e as ElementDefinition).data.id)).toEqual(['a', 'c'])
    expect(container.textContent).toContain('2 nodes')
    // Counted and named, not swallowed.
    expect(container.textContent).toContain('1 skipped')
    expect(container.textContent).not.toContain('No Graph Data')
  })

  it('says nothing about skipped elements when the batch is clean', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a', 'b'])} />)
    await becomeVisible()
    expect(container.textContent).not.toContain('skipped')
  })

  it('keeps rendering an incremental batch that contains a bad element', async () => {
    const [elements, setElements] = createSignal(nodes(['a']))
    const { container } = render(() => <GraphVisualization elements={elements()} />)
    await becomeVisible()
    added.length = 0

    rejectIds = ['bad']
    setElements([...nodes(['a']), ...nodes(['bad']), ...nodes(['c'])])
    await tick()

    expect(added.map((e) => (e as ElementDefinition).data.id)).toEqual(['c'])
    expect(container.textContent).toContain('2 nodes')
    expect(container.textContent).toContain('1 skipped')
  })

  it('adds only the new elements on an incremental update', async () => {
    const [elements, setElements] = createSignal(nodes(['a']))
    render(() => <GraphVisualization elements={elements()} />)
    await becomeVisible()
    added.length = 0
    layoutRuns.length = 0
    fit.mockClear()

    setElements(nodes(['a', 'b', 'c']))
    await tick()

    expect(added.map((e) => (e as ElementDefinition).data.id)).toEqual(['b', 'c'])
    expect(fit, 'an incremental add must not re-frame the whole graph').not.toHaveBeenCalled()
    // `cy.fit` is only half of it: the re-framing an incremental add has to
    // avoid comes from the layout's own `fit` option, which Cytoscape defaults
    // to true. Assert the option the component actually hands over.
    expect(layoutRuns).toEqual([
      { scope: 'elements', opts: expect.objectContaining({ name: 'cose', fit: false }) },
    ])
  })

  it('clears the canvas when the elements go away', async () => {
    const [elements, setElements] = createSignal(nodes(['a', 'b']))
    const { container } = render(() => <GraphVisualization elements={elements()} />)
    await becomeVisible()
    expect(container.textContent).toContain('2 nodes')

    setElements([])
    await tick()

    expect(container.textContent).toContain('0 nodes')
    expect(container.textContent).toContain('No Graph Data')
  })

  it('highlights the ids it is handed and drops the previous ones', async () => {
    const [ids, setIds] = createSignal<string[]>([])
    render(() => <GraphVisualization elements={nodes(['a', 'b'])} highlightedIds={ids()} />)
    await becomeVisible()

    setIds(['a'])
    await tick()
    expect(highlighted).toEqual(['a'])

    setIds(['b'])
    await tick()
    expect(highlighted).toEqual(['b'])
  })

  it('destroys the Cytoscape instance on unmount', async () => {
    const { unmount } = render(() => <GraphVisualization elements={nodes(['a'])} />)
    await becomeVisible()

    unmount()
    expect(destroyed).toHaveBeenCalled()
  })
})

describe('GraphVisualization — toolbar', () => {
  it('re-runs the layout the user picks', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a'])} />)
    await becomeVisible()
    layoutsRun.length = 0

    const select = container.querySelector('select')!
    select.value = 'grid'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    expect(layoutsRun).toEqual(['grid'])
  })

  it('honours the initial layout prop', async () => {
    render(() => <GraphVisualization elements={nodes(['a'])} layout="breadthfirst" />)
    await becomeVisible()

    expect(layoutsRun).toContain('breadthfirst')
  })

  it('fits and zooms from the toolbar', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a'])} />)
    await becomeVisible()
    fit.mockClear()

    button(container, 'Fit View').click()
    expect(fit).toHaveBeenCalled()

    button(container, '+').click()
    expect(zoomLevel).toBeCloseTo(1.2)
    button(container, '−').click()
    expect(zoomLevel).toBeCloseTo(0.96)
  })

  it('pushes the display controls into the stylesheet', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a'])} />)
    await becomeVisible()
    styleUpdates.length = 0

    const sizeSlider = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[0]
    sizeSlider.value = '80'
    sizeSlider.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    expect(styleUpdates.some((s) => s.width === 80 && s.height === 80)).toBe(true)
  })

  it('drops edge labels when the checkbox is cleared', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a'])} />)
    await becomeVisible()
    styleUpdates.length = 0

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    checkbox.checked = false
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    expect(styleUpdates.some((s) => s.label === '')).toBe(true)
  })
})

describe('GraphVisualization — manual Cypher', () => {
  it('runs a query, forwards the result and remembers it', async () => {
    const graphUpdate = nodes(['x'])
    runManualCypher.mockResolvedValue({ success: true, graphUpdate })
    const onElementsChange = vi.fn()
    const { container } = render(() => (
      <GraphVisualization elements={[]} onElementsChange={onElementsChange} />
    ))
    await becomeVisible()

    const box = container.querySelector('textarea')!
    box.value = 'MATCH (n) RETURN n'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Run Query').click()
    await tick()

    expect(runManualCypher).toHaveBeenCalledWith('MATCH (n) RETURN n')
    expect(onElementsChange).toHaveBeenCalledWith(graphUpdate)
    expect(box.value, 'the box clears after a successful run').toBe('')
    expect(container.textContent).toContain('1 recent')
  })

  // #237 follow-up: `onElementsChange` has no caller in the app, so forwarding
  // the result was the *only* thing a successful query did — the canvas stayed
  // empty and the run looked like a no-op. The result is rendered here now.
  it('renders the result onto the canvas, not only through the callback', async () => {
    runManualCypher.mockResolvedValue({ success: true, graphUpdate: nodes(['x', 'y']) })
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()
    expect(added).toHaveLength(0)

    const box = container.querySelector('textarea')!
    box.value = 'MATCH (n) RETURN n'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Run Query').click()
    await tick()

    expect(added.map((el) => (el as ElementDefinition).data!.id)).toEqual(['x', 'y'])
    expect(container.textContent).toContain('2 nodes')
    // First content on an empty canvas: lay everything out and frame it.
    expect(layoutRuns.at(-1)).toMatchObject({ scope: 'core' })
    expect(fit).toHaveBeenCalled()
  })

  it('adds a second query onto the graph without re-framing what is already there', async () => {
    runManualCypher.mockResolvedValue({ success: true, graphUpdate: nodes(['x']) })
    const { container } = render(() => <GraphVisualization elements={nodes(['seed'])} />)
    await becomeVisible()
    fit.mockClear()

    const box = container.querySelector('textarea')!
    box.value = 'MATCH (n) RETURN n'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Run Query').click()
    await tick()

    expect(container.textContent).toContain('2 nodes')
    expect(layoutRuns.at(-1)).toMatchObject({ scope: 'elements', opts: { fit: false } })
    expect(fit).not.toHaveBeenCalled()
  })

  it('skips ids the graph already holds', async () => {
    runManualCypher.mockResolvedValue({ success: true, graphUpdate: nodes(['seed', 'x']) })
    const { container } = render(() => <GraphVisualization elements={nodes(['seed'])} />)
    await becomeVisible()
    added.length = 0

    const box = container.querySelector('textarea')!
    box.value = 'MATCH (n) RETURN n'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Run Query').click()
    await tick()

    expect(added.map((el) => (el as ElementDefinition).data!.id)).toEqual(['x'])
    expect(container.textContent).toContain('2 nodes')
  })

  it('replays a query from the history', async () => {
    runManualCypher.mockResolvedValue({ success: true, graphUpdate: [] })
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()

    const box = container.querySelector('textarea')!
    box.value = 'MATCH (n) RETURN n'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Run Query').click()
    await tick()

    const recent = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('title') === 'MATCH (n) RETURN n',
    )!
    recent.click()
    await tick()
    expect(box.value).toBe('MATCH (n) RETURN n')
  })

  it('runs on Cmd+Enter', async () => {
    runManualCypher.mockResolvedValue({ success: true, graphUpdate: [] })
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()

    const box = container.querySelector('textarea')!
    box.value = 'MATCH (n) RETURN n'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    box.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await tick()

    expect(runManualCypher).toHaveBeenCalled()
  })

  it('shows the driver error and keeps the query', async () => {
    runManualCypher.mockResolvedValue({ success: false, error: 'Write operations are rejected' })
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()

    const box = container.querySelector('textarea')!
    box.value = 'CREATE (n)'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Run Query').click()
    await tick()

    expect(container.textContent).toContain('Query Error')
    expect(container.textContent).toContain('Write operations are rejected')
    expect(box.value).toBe('CREATE (n)')
  })

  it('shows a thrown error too', async () => {
    runManualCypher.mockRejectedValue(new Error('neo4j unreachable'))
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()

    const box = container.querySelector('textarea')!
    box.value = 'MATCH (n) RETURN n'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Run Query').click()
    await tick()

    expect(container.textContent).toContain('neo4j unreachable')
  })
})

describe('GraphVisualization — node creation and editing', () => {
  it('creates a node locally and persists it', async () => {
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()

    button(container, '+ Node').click()
    await tick()
    const [name, , description] = container.querySelectorAll<HTMLInputElement>(
      'input:not([type="range"]):not([type="checkbox"])',
    )
    name.value = 'GraphQL'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    description.value = 'A query language'
    description.dispatchEvent(new Event('input', { bubbles: true }))

    button(container, 'Create').click()
    await tick()

    expect(added.at(-1)).toMatchObject({
      data: { id: 'GraphQL', label: 'GraphQL', type: 'Concept', description: 'A query language' },
    })
    expect(createGraphNode).toHaveBeenCalledWith('Concept', 'GraphQL', 'A query language')
    expect(container.textContent, 'the form closes again').not.toContain('Create Node')
  })

  it('omits the description when none was given', async () => {
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()

    button(container, '+ Node').click()
    await tick()
    const name = container.querySelector<HTMLInputElement>(
      'input:not([type="range"]):not([type="checkbox"])',
    )!
    name.value = 'REST'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    button(container, 'Create').click()
    await tick()

    expect(createGraphNode).toHaveBeenCalledWith('Concept', 'REST', undefined)
  })

  it('closes the create form without touching the graph', async () => {
    const { container } = render(() => <GraphVisualization elements={[]} />)
    await becomeVisible()

    button(container, '+ Node').click()
    await tick()
    button(container, 'Cancel').click()
    await tick()

    expect(container.textContent).not.toContain('Create Node')
    expect(added).toHaveLength(0)
  })
})

describe('GraphVisualization — node properties panel', () => {
  const openPanel = async (elements = nodes(['a'])) => {
    const onNodeClick = vi.fn()
    const rendered = render(() => (
      <GraphVisualization elements={elements} onNodeClick={onNodeClick} />
    ))
    await becomeVisible()
    return { ...rendered, onNodeClick }
  }

  it('opens on a node tap with the node data merged in', async () => {
    const { container, onNodeClick } = await openPanel()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha', labels: ['Concept'], weight: 3 }))
    await tick()

    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('Concept')
    expect(container.textContent).toContain('weight')
    expect(onNodeClick).toHaveBeenCalledWith('a', expect.objectContaining({ label: 'Alpha' }))
  })

  it('offers to load properties when the node carries none', async () => {
    getNodeProperties.mockResolvedValue({ success: true, properties: { summary: 'from neo4j' } })
    const { container } = await openPanel()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha' }))
    await tick()
    expect(container.textContent).toContain('No properties loaded')

    button(container, 'Load Properties').click()
    await tick()

    expect(getNodeProperties).toHaveBeenCalledWith('a')
    expect(container.textContent).toContain('from neo4j')
    expect(dataWrites).toContainEqual(['a', 'properties', { summary: 'from neo4j' }])
  })

  it('survives a failed property load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    getNodeProperties.mockRejectedValue(new Error('neo4j down'))
    const { container } = await openPanel()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha' }))
    await tick()
    button(container, 'Load Properties').click()
    await tick()

    expect(container.textContent).toContain('Load Properties')
    consoleError.mockRestore()
  })

  it('edits a string property and writes it back to Neo4j', async () => {
    const rendered = render(() => <GraphVisualization elements={nodes(['a'])} />)
    await becomeVisible()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha', properties: { summary: 'old' } }))
    await tick()

    rendered.container.querySelector<HTMLElement>('button[title="Edit field"]')!.click()
    await tick()
    // [0] is the manual-Cypher box; [1] is the field editor in the panel.
    const box = rendered.container.querySelectorAll('textarea')[1]
    box.value = 'new summary'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    button(rendered.container, 'Save').click()
    await tick()

    expect(setGraphNodeProperty).toHaveBeenCalledWith('Alpha', 'summary', 'new summary')
    expect(dataWrites).toContainEqual(['a', 'summary', 'new summary'])
    expect(rendered.container.textContent).toContain('new summary')
  })

  it('survives a rejected property write instead of crashing the panel', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    setGraphNodeProperty.mockRejectedValueOnce(new Error('neo4j down'))
    const rendered = render(() => <GraphVisualization elements={nodes(['a'])} />)
    await becomeVisible()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha', properties: { summary: 'old' } }))
    await tick()
    rendered.container.querySelector<HTMLElement>('button[title="Edit field"]')!.click()
    await tick()
    button(rendered.container, 'Save').click()
    await tick()

    expect(setGraphNodeProperty).toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith('Cypher write failed:', expect.any(Error))
    consoleError.mockRestore()
  })

  it('closes on a background tap', async () => {
    const { container } = await openPanel()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha' }))
    await tick()
    expect(container.textContent).toContain('Alpha')

    fire('tap', undefined, cyInstance)
    await tick()
    expect(container.textContent).not.toContain('No properties loaded')
  })

  it('centres the view on a double tap', async () => {
    await openPanel()

    fire('dbltap', 'node', fakeNode('a', { label: 'Alpha' }))
    expect(cyInstance!.animate).toHaveBeenCalledWith(
      expect.objectContaining({ zoom: 1.5 }),
      expect.objectContaining({ duration: 500 }),
    )
  })

  it('reports an edge tap', async () => {
    const onEdgeClick = vi.fn()
    render(() => <GraphVisualization elements={nodes(['a'])} onEdgeClick={onEdgeClick} />)
    await becomeVisible()

    fire('tap', 'edge', { id: () => 'e1', data: () => ({ label: 'RELATES_TO' }) })
    expect(onEdgeClick).toHaveBeenCalledWith('e1', { label: 'RELATES_TO' })
  })
})

describe('GraphVisualization — relation mode', () => {
  it('draws and persists a relation between two tapped nodes', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a', 'b'])} />)
    await becomeVisible()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha' }))
    await tick()
    button(container, 'Create Relation').click()
    await tick()
    expect(container.textContent).toContain('Select target node for relation from')

    const relType = container.querySelector<HTMLInputElement>('input[placeholder="REL_TYPE"]')!
    relType.value = 'DEPENDS_ON'
    relType.dispatchEvent(new Event('input', { bubbles: true }))

    fire('tap', 'node', fakeNode('b', { label: 'Beta' }))
    await tick()

    expect(added.at(-1)).toMatchObject({
      data: { id: 'a-DEPENDS_ON-b', source: 'a', target: 'b', label: 'DEPENDS_ON' },
    })
    expect(linkGraphNodes).toHaveBeenCalledWith('Alpha', 'Beta', 'DEPENDS_ON')
    expect(container.textContent, 'the banner clears once the relation lands').not.toContain(
      'Select target node',
    )
  })

  it('can be abandoned from the banner', async () => {
    const { container } = render(() => <GraphVisualization elements={nodes(['a', 'b'])} />)
    await becomeVisible()

    fire('tap', 'node', fakeNode('a', { label: 'Alpha' }))
    await tick()
    button(container, 'Create Relation').click()
    await tick()

    button(container, 'Cancel').click()
    await tick()
    expect(container.textContent).not.toContain('Select target node')
  })
})
