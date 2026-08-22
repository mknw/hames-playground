/**
 * DataStashPanel — the uploads gallery, the tool-result partition, and the
 * inline file viewer.
 *
 * The panel joins two unrelated stores: Redis-backed uploads it fetches over
 * /api/stash/* itself, and the `tool_result` events handed to it as props. The
 * behaviours worth pinning are the seams between them — how results split into
 * Current Turn / Previous Turns / Archived, what each chip's context menu
 * offers for a given hidden/archived state, what an upload does optimistically
 * before the server confirms, and how a chat citation drives the viewer to a
 * specific char range.
 *
 * `fetch` is stubbed per-route. Every test uses a distinct sessionId because
 * the panel keeps a module-level document cache keyed by session.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import type { ContextEvent } from '~/lib/harness-patterns'
import type { OpenReferenceTarget } from '~/lib/harness-client/reference-extractor'
import type { StashDocumentMeta } from '~/lib/document-store.server'

const { DataStashPanel } = await import('../../../components/ark-ui/DataStashPanel')

// The viewer scrolls the focused highlight into view; jsdom implements no
// scrollIntoView, and the call sits in a createEffect where a throw surfaces
// as an unhandled error rather than a test failure.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

const settle = () => new Promise((r) => setTimeout(r, 30))

/** Hoisted out of JSX: an inline `async () => {}` inside a tracked scope
 *  trips solid/reactivity. */
const noopAction = async () => {}

let sessionSeq = 0
/** A fresh session id per test — the panel's doc cache is module-level. */
const newSession = () => `sess-${++sessionSeq}`

let evSeq = 0
const userMessage = (): ContextEvent => ({
  type: 'user_message',
  ts: ++evSeq,
  patternId: 'harness',
  data: { content: 'go' },
})
const toolResult = (
  tool: string,
  over: Record<string, unknown> = {},
  id = `ev-${evSeq}${tool}`,
): ContextEvent => ({
  id,
  type: 'tool_result',
  ts: ++evSeq,
  patternId: 'neo4j-query',
  data: { tool, success: true, result: { rows: [] }, ...over },
})

const doc = (over: Partial<StashDocumentMeta> = {}): StashDocumentMeta =>
  ({
    id: 'doc-1',
    filename: 'notes.md',
    mimeType: 'text/markdown',
    size: 2560,
    uploadedAt: '2026-08-01T00:00:00Z',
    ...over,
  }) as StashDocumentMeta

/** Route-aware fetch stub. Each entry is matched as a substring of the URL. */
interface FetchPlan {
  documents?: StashDocumentMeta[]
  documentBody?: unknown
  documentStatus?: number
  uploadResponse?: { ok?: boolean; body: unknown }
}
let calls: { url: string; init?: RequestInit }[] = []
const stubFetch = (plan: FetchPlan = {}) => {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const u = String(url)
    if (u.startsWith('/api/stash/upload') && init?.method === 'POST') {
      const r = plan.uploadResponse ?? { ok: true, body: {} }
      return { ok: r.ok ?? true, status: r.ok === false ? 500 : 200, json: async () => r.body }
    }
    if (u.startsWith('/api/stash/upload')) {
      return { ok: true, status: 200, json: async () => ({ documents: plan.documents ?? [] }) }
    }
    if (u.startsWith('/api/stash/document/')) {
      const status = plan.documentStatus ?? 200
      return { ok: status < 400, status, json: async () => plan.documentBody ?? {} }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

const renderPanel = async (
  props: Partial<Parameters<typeof DataStashPanel>[0]> & { sessionId?: string } = {},
) => {
  // Resolved once: the panel's doc cache and its `sid === props.sessionId`
  // guard both key off a stable id.
  const sessionId = props.sessionId ?? newSession()
  const rendered = render(() => (
    <DataStashPanel
      events={props.events ?? []}
      sessionId={sessionId}
      agentId={props.agentId}
      onStashAction={props.onStashAction ?? (async () => {})}
      pendingReference={props.pendingReference}
      onUploaded={props.onUploaded}
    />
  ))
  await settle()
  return rendered
}

/** The positioned wrapper that holds a chip, its menu and its player. */
const shell = (chip: HTMLElement) => chip.closest<HTMLElement>('div[style*="inline-block"]')!

/** Menu buttons only — the tool chips sit inside a Tooltip.Trigger button,
 *  and doc chips carry a bare-icon "View file" button. */
const menuButtons = (chip: HTMLElement) =>
  [...shell(chip).querySelectorAll('button')].filter((b) => !b.contains(chip) && !!b.textContent)

/** Open a chip's context menu by clicking the chip body; returns its labels. */
const chipMenu = (chip: HTMLElement) => {
  fireEvent.click(chip)
  return menuButtons(chip).map((b) => b.textContent)
}
const menuButton = (chip: HTMLElement, label: string) => {
  const open = menuButtons(chip)
  const found = (open.length ? open : (chipMenu(chip), menuButtons(chip))).find(
    (b) => b.textContent === label,
  )
  return found!
}

/** Tool-result chips (the ones carrying a `ref:` style label). */
const toolChips = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-part="trigger"] > div'),
]

/** Document chips (identified by their native title tooltip). */
const docChips = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('div[title]')].filter((el) =>
    el.getAttribute('title')?.includes('·'),
  )

beforeEach(() => {
  calls = []
  stubFetch()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DataStashPanel — tool result partition', () => {
  it('shows an empty findings state and a zero item count', async () => {
    const { container } = await renderPanel()

    expect(container.textContent).toContain('0 items')
    expect(container.textContent).toContain('No tool results yet')
  })

  it('splits results into the current turn and previous turns', async () => {
    const events = [
      userMessage(),
      toolResult('read_neo4j_cypher', {}, 'ev-old1'),
      userMessage(),
      toolResult('web_search', {}, 'ev-new1'),
      toolResult('read_graph', {}, 'ev-new2'),
    ]
    const { container } = await renderPanel({ events })

    expect(container.textContent).toContain('3 items')
    expect(container.textContent).toContain('Current Turn')
    expect(container.textContent).toContain('Previous Turns')
    // Labels drop the generic verb ("read_") in favour of the first
    // domain segment — `web_search` keeps `web`, `read_graph` keeps `graph`.
    expect(container.textContent).toContain('neo4j:old1')
    expect(container.textContent).toContain('web:new1')
    expect(container.textContent).toContain('graph:new2')
  })

  it('treats every result as previous when no user message has landed', async () => {
    const { container } = await renderPanel({ events: [toolResult('web_search', {}, 'ev-a')] })

    expect(container.textContent).toContain('Previous Turns')
    expect(container.textContent).not.toContain('Current Turn')
  })

  it('files archived results into their own collapsed section', async () => {
    const events = [
      userMessage(),
      toolResult('web_search', { archived: true }, 'ev-arch'),
      toolResult('read_graph', {}, 'ev-live'),
    ]
    const { container, getByText } = await renderPanel({ events })

    expect(container.textContent).toContain('Archived')
    // Closed by default — the chip is not rendered until expanded.
    expect(container.textContent).not.toContain('web:arch')

    fireEvent.click(getByText('Archived'))
    expect(container.textContent).toContain('web:arch')
  })

  it('skips tool results that carry no event id', async () => {
    const withoutId = { ...toolResult('web_search'), id: undefined }
    const { container } = await renderPanel({ events: [userMessage(), withoutId] })

    expect(container.textContent).toContain('0 items')
  })

  it('collapses and re-expands a section', async () => {
    const events = [userMessage(), toolResult('web_search', {}, 'ev-x')]
    const { container, getByText } = await renderPanel({ events })
    expect(container.textContent).toContain('web:x')

    fireEvent.click(getByText('Agent Findings'))
    expect(container.textContent).not.toContain('web:x')

    fireEvent.click(getByText('Agent Findings'))
    expect(container.textContent).toContain('web:x')
  })
})

describe('DataStashPanel — tool result chips', () => {
  it('offers hide and archive for a live result, and reports the action', async () => {
    const onStashAction = vi.fn(async () => {})
    const events = [userMessage(), toolResult('web_search', {}, 'ev-a')]
    const { container } = await renderPanel({ events, onStashAction })

    const chip = toolChips(container)[0]
    expect(chipMenu(chip)).toEqual(['Hide', 'Archive', 'Cancel'])

    fireEvent.click(menuButton(chip, 'Hide'))
    await settle()
    expect(onStashAction).toHaveBeenCalledWith('ev-a', 'hide')
  })

  it('offers unhide and archive for a hidden result', async () => {
    const events = [userMessage(), toolResult('web_search', { hidden: true }, 'ev-a')]
    const { container } = await renderPanel({ events })

    expect(chipMenu(toolChips(container)[0])).toEqual(['Unhide', 'Archive', 'Cancel'])
  })

  it('offers only unarchive for an archived result', async () => {
    const events = [userMessage(), toolResult('web_search', { archived: true }, 'ev-a')]
    const { container, getByText } = await renderPanel({ events })
    fireEvent.click(getByText('Archived'))

    expect(chipMenu(toolChips(container)[0])).toEqual(['Unarchive', 'Cancel'])
  })

  it('closes the menu on Cancel without acting', async () => {
    const onStashAction = vi.fn(async () => {})
    const events = [userMessage(), toolResult('web_search', {}, 'ev-a')]
    const { container } = await renderPanel({ events, onStashAction })

    const chip = toolChips(container)[0]
    chipMenu(chip)
    fireEvent.click(menuButton(chip, 'Cancel'))

    expect(menuButtons(chip)).toHaveLength(0)
    expect(onStashAction).not.toHaveBeenCalled()
  })

  it('shows the LLM summary in the tooltip, or a raw preview marked pending', async () => {
    const events = [
      userMessage(),
      toolResult('web_search', { summary: 'three articles about graphs' }, 'ev-sum'),
      toolResult('read_graph', { result: { entities: ['a'] } }, 'ev-raw'),
    ]
    const { container } = await renderPanel({ events })

    expect(container.textContent).toContain('three articles about graphs')
    expect(container.textContent).toContain('{"entities":["a"]}')
    // Only the summary-less chip advertises a pending summary.
    expect(container.textContent.match(/Summary pending…/g)).toHaveLength(1)
  })
})

describe('DataStashPanel — uploads', () => {
  const upload = async (container: HTMLElement, files: File[]) => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    fireEvent.change(input)
    await settle()
  }

  it('lists documents fetched for the session', async () => {
    stubFetch({ documents: [doc({ filename: 'report.csv', mimeType: 'text/csv', size: 4096 })] })
    const { container } = await renderPanel()

    expect(container.textContent).toContain('report.csv')
    expect(container.textContent).toContain('1 items')
    expect(docChips(container)[0].getAttribute('title')).toContain('4.0 KB')
  })

  it('posts each picked file and shows it before the list refreshes', async () => {
    const uploaded = doc({ id: 'doc-9', filename: 'fresh.md' })
    const fetchFn = stubFetch({ uploadResponse: { body: { document: uploaded } } })
    const onUploaded = vi.fn()
    const { container } = await renderPanel({ agentId: 'researcher', onUploaded })

    await upload(container, [new File(['hello'], 'fresh.md', { type: 'text/markdown' })])

    const post = calls.find((c) => c.init?.method === 'POST')!
    const form = post.init!.body as FormData
    expect(form.get('agentId')).toBe('researcher')
    expect((form.get('file') as File).name).toBe('fresh.md')
    expect(container.textContent).toContain('fresh.md')
    expect(onUploaded).toHaveBeenCalledOnce()
    expect(fetchFn).toHaveBeenCalled()
  })

  it('surfaces the server error message from a failed upload', async () => {
    stubFetch({ uploadResponse: { ok: false, body: { error: 'file too large' } } })
    const { container } = await renderPanel()

    await upload(container, [new File(['x'], 'big.bin')])
    expect(container.textContent).toContain('file too large')
  })

  it('refuses to upload before a conversation exists', async () => {
    const { container } = await renderPanel({ sessionId: '' })

    await upload(container, [new File(['x'], 'a.md')])
    expect(container.textContent).toContain('Start a conversation before uploading')
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
  })

  it('accepts a drag-and-drop as an upload', async () => {
    stubFetch({ uploadResponse: { body: { document: doc({ filename: 'dropped.txt' }) } } })
    const { container } = await renderPanel()

    const zone = container.querySelector<HTMLElement>('input[type="file"]')!.parentElement!
    fireEvent.dragOver(zone)
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'dropped.txt')] } })
    await settle()

    expect(container.textContent).toContain('dropped.txt')
  })

  it('ignores a drag that leaves without dropping', async () => {
    const { container } = await renderPanel()
    const zone = container.querySelector<HTMLElement>('input[type="file"]')!.parentElement!

    fireEvent.dragOver(zone)
    fireEvent.dragLeave(zone)
    fireEvent.drop(zone, { dataTransfer: { files: [] } })
    await settle()

    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
  })
})

describe('DataStashPanel — document chips', () => {
  it('flags a document still being embedded', async () => {
    stubFetch({ documents: [doc({ ingestStatus: 'pending' })] })
    const { container } = await renderPanel()

    expect(container.textContent).toContain('embedding…')
  })

  it('flags a document whose ingest failed', async () => {
    stubFetch({ documents: [doc({ ingestStatus: 'failed' })] })
    const { container } = await renderPanel()

    expect(container.textContent).toContain('index failed')
  })

  it('offers download, hide, archive and delete', async () => {
    stubFetch({ documents: [doc()] })
    const { container } = await renderPanel()

    expect(chipMenu(docChips(container)[0])).toEqual(['Download', 'Hide', 'Archive', 'Delete'])
  })

  it('swaps hide for unhide once a document is hidden', async () => {
    stubFetch({ documents: [doc({ hidden: true })] })
    const { container } = await renderPanel()

    expect(chipMenu(docChips(container)[0])).toEqual(['Download', 'Unhide', 'Archive', 'Delete'])
  })

  it('offers only unarchive for an archived document', async () => {
    stubFetch({ documents: [doc({ archived: true })] })
    const { container } = await renderPanel()

    expect(chipMenu(docChips(container)[0])).toEqual(['Download', 'Unarchive', 'Delete'])
  })

  it('patches the hidden flag through the document route', async () => {
    stubFetch({ documents: [doc()] })
    const { container } = await renderPanel({ sessionId: 'sess-patch' })

    fireEvent.click(menuButton(docChips(container)[0], 'Hide'))
    await settle()

    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    expect(JSON.parse(patch.init!.body as string)).toEqual({
      sessionId: 'sess-patch',
      hidden: true,
    })
  })

  it('archives by setting archived and clearing hidden together', async () => {
    stubFetch({ documents: [doc({ hidden: true })] })
    const { container } = await renderPanel()

    fireEvent.click(menuButton(docChips(container)[0], 'Archive'))
    await settle()

    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    expect(JSON.parse(patch.init!.body as string)).toMatchObject({
      archived: true,
      hidden: false,
    })
  })

  it('removes a deleted document optimistically and calls DELETE', async () => {
    stubFetch({ documents: [doc({ filename: 'doomed.md' })] })
    const { container } = await renderPanel()
    expect(container.textContent).toContain('doomed.md')

    fireEvent.click(menuButton(docChips(container)[0], 'Delete'))
    expect(container.textContent).not.toContain('doomed.md')

    await settle()
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true)
  })

  it('downloads through an anchor rather than a fetch', async () => {
    stubFetch({ documents: [doc({ id: 'doc-dl' })] })
    const { container } = await renderPanel({ sessionId: 'sess-dl' })

    const clicked: HTMLAnchorElement[] = []
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = create(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = () => clicked.push(el as HTMLAnchorElement)
      return el
    })

    fireEvent.click(menuButton(docChips(container)[0], 'Download'))
    await settle()

    expect(clicked).toHaveLength(1)
    expect(clicked[0].getAttribute('href')).toBe(
      '/api/stash/document/doc-dl?sessionId=sess-dl&download',
    )
    expect(calls.some((c) => c.url.includes('&download'))).toBe(false)
  })

  it('offers an inline player for an audio recording and mounts it on Play', async () => {
    stubFetch({ documents: [doc({ id: 'rec-1', filename: 'note.m4a', mimeType: 'audio/mp4' })] })
    const { container } = await renderPanel({ sessionId: 'sess-audio' })

    const chip = docChips(container)[0]
    expect(chipMenu(chip)).toContain('Play')

    fireEvent.click(menuButton(chip, 'Play'))
    const audio = container.querySelector('audio')!
    expect(audio.getAttribute('src')).toBe(
      '/api/stash/document/rec-1?sessionId=sess-audio&download',
    )
  })

  it('offers no player for a text document', async () => {
    stubFetch({ documents: [doc()] })
    const { container } = await renderPanel()

    expect(chipMenu(docChips(container)[0])).not.toContain('Play')
  })

  it('hides the view button for a raw binary upload', async () => {
    stubFetch({ documents: [doc({ filename: 'scan.pdf', encoding: 'base64' })] })
    const { container } = await renderPanel()

    expect(container.querySelector('[title="View file"]')).toBeNull()
  })

  it('keeps the view button for a converted binary', async () => {
    stubFetch({ documents: [doc({ filename: 'scan.pdf', encoding: 'base64', converted: true })] })
    const { container } = await renderPanel()

    expect(container.querySelector('[title="View file"]')).toBeTruthy()
  })
})

describe('DataStashPanel — inline file viewer', () => {
  const openViewer = async (container: HTMLElement) => {
    fireEvent.click(container.querySelector<HTMLElement>('[title="View file"]')!)
    await settle()
  }

  it('renders the file with line numbers', async () => {
    stubFetch({
      documents: [doc({ filename: 'a.md' })],
      documentBody: { document: { content: 'line one\nline two\n\nline four' } },
    })
    const { container } = await renderPanel()
    await openViewer(container)

    expect(container.textContent).toContain('line one')
    expect(container.textContent).toContain('line four')
    // Four lines, numbered — the blank third line still gets a row.
    expect(container.textContent).toContain('4')
  })

  it('reports a binary file as having no text preview', async () => {
    stubFetch({
      documents: [doc({ converted: true, encoding: 'base64' })],
      documentBody: { document: { content: 'AAA', encoding: 'base64' } },
    })
    const { container } = await renderPanel()
    await openViewer(container)

    expect(container.textContent).toContain('Binary file — no text preview')
  })

  it('reports a missing document', async () => {
    stubFetch({ documents: [doc()], documentBody: {} })
    const { container } = await renderPanel()
    await openViewer(container)

    expect(container.textContent).toContain('Document not found')
  })

  it('reports an HTTP failure', async () => {
    stubFetch({ documents: [doc()], documentStatus: 404 })
    const { container } = await renderPanel()
    await openViewer(container)

    expect(container.textContent).toContain('HTTP 404')
  })

  it('closes on the ✕ and toggles shut from the eye button', async () => {
    stubFetch({ documents: [doc()], documentBody: { document: { content: 'x' } } })
    const { container, getByText } = await renderPanel()

    await openViewer(container)
    expect(container.querySelector('[title="Close viewer"]')).toBeTruthy()

    fireEvent.click(getByText('✕'))
    expect(container.querySelector('[title="Close viewer"]')).toBeNull()

    await openViewer(container)
    await openViewer(container)
    expect(container.querySelector('[title="Close viewer"]')).toBeNull()
  })

  it('closes itself when its document is deleted', async () => {
    stubFetch({ documents: [doc()], documentBody: { document: { content: 'x' } } })
    const { container } = await renderPanel()
    await openViewer(container)
    expect(container.querySelector('[title="Close viewer"]')).toBeTruthy()

    fireEvent.click(menuButton(docChips(container)[0], 'Delete'))
    await settle()
    expect(container.querySelector('[title="Close viewer"]')).toBeNull()
  })
})

describe('DataStashPanel — chat citations', () => {
  const content = 'alpha\nbravo\ncharlie\ndelta\necho'
  /** A retriever result whose references point into `doc-1`. */
  const retrieverEvent = (): ContextEvent => ({
    id: 'ev-retr',
    type: 'tool_result',
    ts: ++evSeq,
    patternId: 'retriever',
    data: {
      tool: 'retriever',
      success: true,
      result: {
        references: [
          { docId: 'doc-1', filename: 'notes.md', startOffset: 0, endOffset: 5, chunkIndex: 0 },
          { docId: 'doc-1', filename: 'notes.md', startOffset: 12, endOffset: 19, chunkIndex: 1 },
        ],
      },
    },
  })

  it('opens the viewer at the cited range and steps between references', async () => {
    stubFetch({ documents: [doc()], documentBody: { document: { content } } })
    const events = [userMessage(), retrieverEvent()]
    // The citation arrives from the chat after the doc list has loaded — the
    // panel can only resolve `docId` against documents it already holds.
    const [ref, setRef] = createSignal<OpenReferenceTarget | null>(null)
    const { container } = render(() => (
      <DataStashPanel
        events={events}
        sessionId="sess-cite"
        onStashAction={noopAction}
        pendingReference={ref()}
      />
    ))
    await settle()

    setRef({ docId: 'doc-1', startOffset: 12, endOffset: 19 })
    await settle()

    // Second reference is focused: chars 12–19 sit on line 3.
    expect(container.textContent).toContain('L3')
    expect(container.textContent).toContain('2/2')

    fireEvent.click(container.querySelector<HTMLElement>('[title="Previous reference"]')!)
    expect(container.textContent).toContain('1/2')
    expect(container.textContent).toContain('L1')

    fireEvent.click(container.querySelector<HTMLElement>('[title="Next reference"]')!)
    expect(container.textContent).toContain('2/2')
  })

  /** One reference spanning bravo→delta: chars 6–25 of `content`. */
  const spanningEvent = (): ContextEvent => ({
    id: 'ev-retr-span',
    type: 'tool_result',
    ts: ++evSeq,
    patternId: 'retriever',
    data: {
      tool: 'retriever',
      success: true,
      result: {
        references: [
          { docId: 'doc-1', filename: 'notes.md', startOffset: 6, endOffset: 25, chunkIndex: 0 },
        ],
      },
    },
  })

  it('reports the exact line span of a multi-line chunk, not just its start', async () => {
    // 'alpha\nbravo\ncharlie\ndelta\necho' — chars 6–25 start on line 2 and
    // end on line 4. The end of the range is derived arithmetic of its own, so
    // it is asserted exactly: an off-by-one would read L2–5 and still contain
    // 'L2'.
    stubFetch({ documents: [doc()], documentBody: { document: { content } } })
    const [ref, setRef] = createSignal<OpenReferenceTarget | null>(null)
    const { container } = render(() => (
      <DataStashPanel
        events={[userMessage(), spanningEvent()]}
        sessionId="sess-span"
        onStashAction={noopAction}
        pendingReference={ref()}
      />
    ))
    await settle()

    setRef({ docId: 'doc-1', startOffset: 6, endOffset: 25 })
    await settle()

    expect(container.textContent).toContain('L2\u20134')
    expect(container.textContent).not.toContain('L2\u20135')
  })

  it('falls back to the first reference when a citation matches none of them', async () => {
    // `findIndex` returns -1 for an unmatched offset pair; the viewer must open
    // on reference 1 of 2 rather than on an out-of-range slot (which would read
    // '0/2' with no line marker at all).
    stubFetch({ documents: [doc()], documentBody: { document: { content } } })
    const [ref, setRef] = createSignal<OpenReferenceTarget | null>(null)
    const { container } = render(() => (
      <DataStashPanel
        events={[userMessage(), retrieverEvent()]}
        sessionId="sess-cite-oob"
        onStashAction={noopAction}
        pendingReference={ref()}
      />
    ))
    await settle()

    setRef({ docId: 'doc-1', startOffset: 999, endOffset: 1000 })
    await settle()

    expect(container.textContent).toContain('1/2')
    expect(container.textContent).toContain('L1')
    expect(container.textContent).not.toContain('0/2')
  })

  it('ignores a citation for a document this session never uploaded', async () => {
    stubFetch({ documents: [doc()] })
    const [ref, setRef] = createSignal<OpenReferenceTarget | null>(null)
    const { container } = render(() => (
      <DataStashPanel
        events={[]}
        sessionId="sess-cite-miss"
        onStashAction={noopAction}
        pendingReference={ref()}
      />
    ))
    await settle()

    setRef({ docId: 'not-here', startOffset: 0, endOffset: 1 })
    await settle()
    expect(container.querySelector('[title="Close viewer"]')).toBeNull()
  })

  it('shows no navigator when the doc is opened without references', async () => {
    stubFetch({ documents: [doc()], documentBody: { document: { content } } })
    const { container } = await renderPanel()

    fireEvent.click(container.querySelector<HTMLElement>('[title="View file"]')!)
    await settle()

    expect(container.querySelector('[title="Next reference"]')).toBeNull()
  })
})
