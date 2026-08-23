/**
 * DataStashPanel — uploads, tool-result partitioning, and the inline viewer.
 *
 * Everything the panel does that matters crosses one of two boundaries: the
 * `/api/stash/*` routes (asserted through a stubbed `fetch`) and the props it
 * is handed (`events`, `pendingReference`, `onStashAction`). Both are exercised
 * here; the reference extractor is left real, since it is the thing that decides
 * which lines the viewer highlights.
 *
 * Note the panel keeps a module-level document cache keyed by session, so each
 * test uses its own session id.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createSignal } from 'solid-js'
import { installDomStubs } from './dom-stubs'
import type { ContextEvent } from '../../../lib/harness-patterns/types'
import type { StashDocumentMeta } from '../../../lib/document-store.server'

beforeAll(() => installDomStubs())

const { render } = await import('@solidjs/testing-library')
const { DataStashPanel } = await import('../../../components/ark-ui/DataStashPanel')

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sessionCounter = 0
/** A fresh session per test, so the panel's module-level doc cache can't leak. */
let sid = ''

function doc(over: Partial<StashDocumentMeta> = {}): StashDocumentMeta {
  return {
    id: 'doc-1',
    sessionId: 's',
    filename: 'notes.md',
    mimeType: 'text/markdown',
    size: 2048,
    uploadedAt: 1_700_000_000_000,
    ...over,
  }
}

function toolResult(
  id: string,
  tool: string,
  over: Partial<{ summary: string; success: boolean; hidden: boolean; archived: boolean }> = {},
): ContextEvent {
  return {
    id,
    type: 'tool_result',
    ts: 1,
    patternId: 'p',
    data: { tool, result: 'raw payload', success: true, ...over },
  } as ContextEvent
}

const userMessage = (): ContextEvent =>
  ({
    id: 'u1',
    type: 'user_message',
    ts: 2,
    patternId: 'p',
    data: { content: 'hi' },
  }) as ContextEvent

function retrieverEvent(docId: string, spans: [number, number][]): ContextEvent {
  return {
    id: 'r1',
    type: 'tool_result',
    ts: 3,
    patternId: 'p',
    data: {
      tool: 'retriever',
      success: true,
      result: {
        references: spans.map(([startOffset, endOffset], i) => ({
          source: 'notes.md',
          docId,
          chunkIndex: i,
          startOffset,
          endOffset,
        })),
      },
    },
  } as ContextEvent
}

// ---------------------------------------------------------------------------
// fetch routing
// ---------------------------------------------------------------------------

let listResponse: StashDocumentMeta[] = []
let documentBody: unknown = {
  document: { content: 'alpha\nbravo\ncharlie\ndelta', encoding: 'utf8' },
}
let uploadResponse: { ok: boolean; body: unknown } = { ok: true, body: {} }
const calls: { url: string; method: string; body?: unknown }[] = []

const json = (body: unknown, ok = true) =>
  Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response)

const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  calls.push({ url, method, body: init?.body })
  if (url.startsWith('/api/stash/upload') && method === 'POST') {
    return json(uploadResponse.body, uploadResponse.ok)
  }
  if (url.startsWith('/api/stash/upload')) return json({ documents: listResponse })
  if (url.startsWith('/api/stash/document/')) {
    if (method === 'GET') return json(documentBody)
    return json({ ok: true })
  }
  return json({})
})

const chips = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('div[title]')].filter((el) =>
    el.getAttribute('title')?.includes('\n'),
  )
const menuButton = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === label)

beforeEach(() => {
  sid = `sess-${++sessionCounter}`
  calls.length = 0
  fetchMock.mockClear()
  listResponse = []
  uploadResponse = { ok: true, body: {} }
  documentBody = { document: { content: 'alpha\nbravo\ncharlie\ndelta', encoding: 'utf8' } }
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

describe('DataStashPanel — tool results', () => {
  it('splits results into the current turn, previous turns and the archive', async () => {
    const events = [
      toolResult('ev-old', 'read_neo4j_cypher'),
      toolResult('ev-arch', 'web_search', { archived: true }),
      userMessage(),
      toolResult('ev-new', 'fetch_content'),
    ]
    const { container } = render(() => (
      <DataStashPanel events={events} sessionId={sid} onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    expect(container.textContent).toContain('Current Turn')
    expect(container.textContent).toContain('Previous Turns')
    expect(container.textContent).toContain('Archived')
    expect(container.textContent).toContain('3 items')
  })

  it('shows the empty state when the agent has produced nothing', async () => {
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId={sid} onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    expect(container.textContent).toContain('No tool results yet')
    expect(container.textContent).toContain('0 items')
  })

  it('labels a chip by the informative segment of its tool name', async () => {
    const { container } = render(() => (
      <DataStashPanel
        events={[toolResult('ev-fr1y8p', 'read_neo4j_cypher')]}
        sessionId={sid}
        onStashAction={vi.fn(async () => {})}
      />
    ))
    await tick()

    // `read` is a generic verb and is skipped in favour of `neo4j`.
    expect(container.textContent).toContain('neo4j:fr1y8p')
  })

  it('offers hide/archive on a live result and reports the choice', async () => {
    const onStashAction = vi.fn(async () => {})
    const { container } = render(() => (
      <DataStashPanel
        events={[toolResult('ev-1', 'web_search')]}
        sessionId={sid}
        onStashAction={onStashAction}
      />
    ))
    await tick()

    container.querySelector<HTMLElement>('[data-part="trigger"] > div')!.click()
    await tick()
    expect(menuButton('Hide')).toBeTruthy()
    expect(menuButton('Unhide')).toBeUndefined()

    menuButton('Archive')!.click()
    await tick()
    expect(onStashAction).toHaveBeenCalledWith('ev-1', 'archive')
  })

  it('offers unarchive — and only that — on an archived result', async () => {
    const onStashAction = vi.fn(async () => {})
    const { container } = render(() => (
      <DataStashPanel
        events={[toolResult('ev-2', 'web_search', { archived: true })]}
        sessionId={sid}
        onStashAction={onStashAction}
      />
    ))
    await tick()

    // The Archived section is collapsed by default.
    const archived = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Archived'),
    )!
    archived.click()
    await tick()

    container.querySelector<HTMLElement>('[data-part="trigger"] > div')!.click()
    await tick()

    expect(menuButton('Unarchive')).toBeTruthy()
    expect(menuButton('Hide')).toBeUndefined()
    menuButton('Unarchive')!.click()
    await tick()
    expect(onStashAction).toHaveBeenCalledWith('ev-2', 'unarchive')
  })

  it('offers unhide + archive on a hidden result and can be cancelled', async () => {
    const onStashAction = vi.fn(async () => {})
    const { container } = render(() => (
      <DataStashPanel
        events={[toolResult('ev-3', 'web_search', { hidden: true })]}
        sessionId={sid}
        onStashAction={onStashAction}
      />
    ))
    await tick()

    container.querySelector<HTMLElement>('[data-part="trigger"] > div')!.click()
    await tick()
    expect(menuButton('Unhide')).toBeTruthy()

    menuButton('Cancel')!.click()
    await tick()
    expect(menuButton('Unhide')).toBeUndefined()
    expect(onStashAction).not.toHaveBeenCalled()
  })

  it('collapses a section from its header', async () => {
    const { container } = render(() => (
      <DataStashPanel
        events={[toolResult('ev-4', 'web_search')]}
        sessionId={sid}
        onStashAction={vi.fn(async () => {})}
      />
    ))
    await tick()

    const header = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Agent Findings'),
    )!
    expect(container.textContent).toContain('web:4')

    header.click()
    await tick()
    expect(container.textContent).not.toContain('web:4')
  })
})

describe('DataStashPanel — uploads', () => {
  it('lists the session documents fetched on mount', async () => {
    listResponse = [doc({ id: 'd1', filename: 'report.csv', mimeType: 'text/csv' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId={sid} onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    expect(calls[0].url).toBe(`/api/stash/upload?sessionId=${sid}`)
    expect(container.textContent).toContain('report.csv')
    expect(container.textContent).toContain('1 items')
  })

  it('posts a picked file with the session and agent, then shows it immediately', async () => {
    const stored = doc({ id: 'd9', filename: 'uploaded.txt', ingestStatus: 'pending' })
    uploadResponse = { ok: true, body: { document: stored } }
    const onUploaded = vi.fn()
    const { container } = render(() => (
      <DataStashPanel
        events={[]}
        sessionId="sess-upload"
        agentId="retriever"
        onStashAction={vi.fn(async () => {})}
        onUploaded={onUploaded}
      />
    ))
    await tick()

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(['hello'], 'uploaded.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    const post = calls.find((c) => c.method === 'POST')!
    const form = post.body as FormData
    expect(form.get('sessionId')).toBe('sess-upload')
    expect(form.get('agentId')).toBe('retriever')
    expect((form.get('file') as File).name).toBe('uploaded.txt')

    expect(container.textContent).toContain('uploaded.txt')
    expect(container.textContent, 'ingest status shows straight away').toContain('embedding…')
    expect(onUploaded).toHaveBeenCalled()
  })

  it('reports the server error message when an upload is rejected', async () => {
    uploadResponse = { ok: false, body: { error: 'File too large' } }
    const { container } = render(() => (
      <DataStashPanel
        events={[]}
        sessionId="sess-badupload"
        onStashAction={vi.fn(async () => {})}
      />
    ))
    await tick()

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'big.bin')],
      configurable: true,
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    expect(container.textContent).toContain('File too large')
  })

  it('refuses to upload before a conversation exists', async () => {
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.txt')], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    expect(container.textContent).toContain('Start a conversation before uploading')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('takes files dropped on the zone', async () => {
    uploadResponse = { ok: true, body: { document: doc({ id: 'dd', filename: 'dropped.md' }) } }
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-drop" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    const zone = container.querySelector<HTMLElement>('div[border^="2 dashed"]')!
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [new File(['x'], 'dropped.md')] },
    })
    zone.dispatchEvent(drop)
    await tick()

    expect(calls.some((c) => c.method === 'POST')).toBe(true)
    expect(container.textContent).toContain('dropped.md')
  })

  it('flags a failed vector ingest on the chip', async () => {
    listResponse = [doc({ id: 'd2', filename: 'broken.md', ingestStatus: 'failed' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId={sid} onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    expect(container.textContent).toContain('index failed')
  })

  it('deletes a document optimistically and calls the route', async () => {
    listResponse = [doc({ id: 'd3', filename: 'stale.md' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-del" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    chips(container)[0].click()
    await tick()
    listResponse = []
    menuButton('Delete')!.click()
    await tick()

    expect(container.textContent).not.toContain('stale.md')
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('d3'))).toBe(true)
  })

  it('patches hide/archive state through the document route', async () => {
    listResponse = [doc({ id: 'd4', filename: 'keep.md' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-patch" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    chips(container)[0].click()
    await tick()
    menuButton('Archive')!.click()
    await tick()

    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(JSON.parse(patch.body as string)).toEqual({
      sessionId: 'sess-patch',
      archived: true,
      hidden: false,
    })
  })

  it('downloads through an anchor rather than a fetch', async () => {
    listResponse = [doc({ id: 'd5', filename: 'binary.xlsx', encoding: 'base64' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-dl" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()
    const clicks: string[] = []
    const realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      clicks.push(this.getAttribute('href')!)
    }

    chips(container)[0].click()
    await tick()
    menuButton('Download')!.click()
    await tick()

    HTMLAnchorElement.prototype.click = realClick
    expect(clicks[0]).toBe('/api/stash/document/d5?sessionId=sess-dl&download')
  })

  it('offers a player for an audio upload only', async () => {
    listResponse = [
      doc({ id: 'd6', filename: 'memo.m4a', mimeType: 'application/octet-stream' }),
      doc({ id: 'd7', filename: 'notes.md' }),
    ]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-audio" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    chips(container)[1].click()
    await tick()
    expect(menuButton('Play'), 'a markdown file gets no player').toBeUndefined()
    menuButton('Cancel') // no-op; close by re-clicking the chip
    chips(container)[1].click()
    await tick()

    chips(container)[0].click()
    await tick()
    menuButton('Play')!.click()
    await tick()

    const audio = container.querySelector('audio')!
    expect(audio.getAttribute('src')).toBe('/api/stash/document/d6?sessionId=sess-audio&download')
  })
})

describe('DataStashPanel — inline viewer', () => {
  it('opens a text document and numbers its lines', async () => {
    listResponse = [doc({ id: 'v1', filename: 'notes.md' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-view" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    container.querySelector<HTMLElement>('button[title="View file"]')!.click()
    await tick()

    expect(container.textContent).toContain('charlie')
    expect(calls.some((c) => c.url === '/api/stash/document/v1?sessionId=sess-view')).toBe(true)
  })

  it('offers no text view for an unconverted binary', async () => {
    listResponse = [doc({ id: 'v2', filename: 'sheet.xlsx', encoding: 'base64' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId={sid} onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    expect(container.querySelector('button[title="View file"]')).toBeNull()
  })

  it('offers the text view for a converted binary', async () => {
    listResponse = [doc({ id: 'v3', filename: 'brief.docx', encoding: 'base64', converted: true })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId={sid} onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    expect(container.querySelector('button[title="View file"]')).toBeTruthy()
  })

  it('surfaces a failed load instead of an empty file', async () => {
    listResponse = [doc({ id: 'v4', filename: 'gone.md' })]
    documentBody = {}
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-missing" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    container.querySelector<HTMLElement>('button[title="View file"]')!.click()
    await tick()

    expect(container.textContent).toContain('Document not found')
  })

  it('says so when the stored bytes have no text preview', async () => {
    listResponse = [doc({ id: 'v5', filename: 'img.png', encoding: 'base64', converted: true })]
    documentBody = { document: { content: 'AAAA', encoding: 'base64' } }
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-binary" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    container.querySelector<HTMLElement>('button[title="View file"]')!.click()
    await tick()

    expect(container.textContent).toContain('Binary file — no text preview')
  })

  it('opens at the cited chunk and steps through the rest', async () => {
    listResponse = [doc({ id: 'v6', filename: 'notes.md' })]
    // 'alpha\nbravo\ncharlie\ndelta' — offsets 0..5 = line 1, 12..19 = line 3.
    const events = [
      retrieverEvent('v6', [
        [0, 5],
        [12, 19],
      ]),
    ]
    const [pending, setPending] = createSignal<{
      docId: string
      startOffset?: number
      endOffset?: number
    } | null>(null)
    const { container } = render(() => (
      <DataStashPanel
        events={events}
        sessionId="sess-cite"
        onStashAction={vi.fn(async () => {})}
        pendingReference={pending()}
      />
    ))
    await tick()

    setPending({ docId: 'v6', startOffset: 12, endOffset: 19 })
    await tick()

    expect(container.textContent).toContain('L3')
    expect(container.textContent).toContain('2/2')

    const prev = container.querySelector<HTMLButtonElement>('button[title="Previous reference"]')!
    prev.click()
    await tick()
    expect(container.textContent).toContain('1/2')
    expect(prev.disabled, 'no further back to go').toBe(true)

    container.querySelector<HTMLButtonElement>('button[title="Next reference"]')!.click()
    await tick()
    expect(container.textContent).toContain('2/2')
  })

  it('ignores a citation for a document this session does not hold', async () => {
    listResponse = [doc({ id: 'v7', filename: 'notes.md' })]
    const [pending, setPending] = createSignal<{ docId: string } | null>(null)
    const { container } = render(() => (
      <DataStashPanel
        events={[]}
        sessionId="sess-foreign"
        onStashAction={vi.fn(async () => {})}
        pendingReference={pending()}
      />
    ))
    await tick()

    setPending({ docId: 'not-mine' })
    await tick()

    expect(container.querySelector('button[title="Close viewer"]')).toBeNull()
  })

  it('closes the viewer from its header', async () => {
    listResponse = [doc({ id: 'v8', filename: 'notes.md' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-close" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    container.querySelector<HTMLElement>('button[title="View file"]')!.click()
    await tick()
    expect(container.textContent).toContain('charlie')

    container.querySelector<HTMLElement>('button[title="Close viewer"]')!.click()
    await tick()
    expect(container.textContent).not.toContain('charlie')
  })

  it('closes the viewer when its document is deleted', async () => {
    listResponse = [doc({ id: 'v9', filename: 'doomed.md' })]
    const { container } = render(() => (
      <DataStashPanel events={[]} sessionId="sess-vdel" onStashAction={vi.fn(async () => {})} />
    ))
    await tick()

    container.querySelector<HTMLElement>('button[title="View file"]')!.click()
    await tick()
    expect(container.querySelector('button[title="Close viewer"]')).toBeTruthy()

    chips(container)[0].click()
    await tick()
    listResponse = []
    menuButton('Delete')!.click()
    await tick()

    expect(container.querySelector('button[title="Close viewer"]')).toBeNull()
  })
})
