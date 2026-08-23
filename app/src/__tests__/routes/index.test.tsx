/**
 * The chat route's own job, after #226 B1: it *composes*. Per-session state
 * lives in `SessionRegistry` (its own tests cover the eight slots, the prune
 * rule and disposal); the conversation list lives in `ThreadListStore`. What
 * is left here — and what this file covers — is the wiring: which session is
 * on screen, what the panels are therefore shown, and which store call each
 * navigation makes.
 *
 * The three children (sidebar, chat view, support panel) are stubbed to prop
 * recorders. The chat stub also captures the registry the route provides
 * through context, so a case can drive the writes the real `ChatInterface`
 * would make and then check what the *other* children are handed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import type { JSX } from 'solid-js'
import { useSessionRegistry } from '~/lib/session-registry-context'
import type { SessionRegistry } from '~/lib/session-registry'

// ── Child stubs ─────────────────────────────────────────────────────────────
// Solid props are getters, so holding the props object keeps reading live values.
let sidebar: any
let chat: any
let support: any
/** The registry the route provides — captured from context by the chat stub. */
let registry: SessionRegistry

vi.mock('~/components/ark-ui/ChatSidebar', async () => {
  const actual = await vi.importActual<typeof import('~/components/ark-ui/ChatSidebar')>(
    '~/components/ark-ui/ChatSidebar',
  )
  return {
    mergeThreadsWithPlaceholder: actual.mergeThreadsWithPlaceholder,
    ChatSidebar: (props: any): JSX.Element => {
      sidebar = props
      return <div data-testid="sidebar" />
    },
  }
})

vi.mock('~/components/ark-ui/ChatInterface', () => ({
  ChatInterface: (props: any): JSX.Element => {
    chat = props
    // The real ChatInterface reads the registry from context; capturing it here
    // is how these cases drive the writes it would make.
    registry = useSessionRegistry()
    return <div data-testid="chat" />
  },
}))

vi.mock('~/components/ark-ui/SupportPanel', () => ({
  SupportPanel: (props: any): JSX.Element => {
    support = props
    return <div data-testid="support" />
  },
}))

// ── Server actions ──────────────────────────────────────────────────────────
type Thread = {
  id: string
  title: string | null
  updatedAt: string
  kind: 'conversation' | 'action'
  status: string
}
const listConversations = vi.fn<() => Promise<Thread[]>>(async () => [])
const deleteConversationsBulk = vi.fn<(ids: string[]) => Promise<{ deleted: string[] }>>()
vi.mock('~/lib/harness-client', () => ({
  listConversations: () => listConversations(),
  deleteConversationsBulk: (ids: string[]) => deleteConversationsBulk(ids),
}))

let nextId = 0
vi.mock('~/lib/session-id', () => ({ newSessionId: () => `new-${++nextId}` }))

const { default: Home } = await import('~/routes/index')

// ── Helpers ─────────────────────────────────────────────────────────────────
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id,
  title: `Thread ${id}`,
  updatedAt: '2026-08-16T12:00:00.000Z',
  kind: 'conversation',
  status: 'done',
  ...over,
})

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** Mount the route and wait for the initial thread load. */
async function mount() {
  const result = render(() => <Home />)
  await tick(10)
  return result
}

const threadIds = () => sidebar.threads.map((t: Thread) => t.id)

beforeEach(() => {
  vi.clearAllMocks()
  nextId = 0
  sidebar = chat = support = undefined
  listConversations.mockResolvedValue([])
  deleteConversationsBulk.mockResolvedValue({ deleted: [] })
  fetchMock.mockResolvedValue(jsonResponse({ documents: [] }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('chat route — session selection', () => {
  it('opens on a fresh session and hands the same id to both panels', async () => {
    await mount()
    expect(chat.sessionId).toBe('new-1')
    expect(sidebar.selectedId).toBe('new-1')
    expect(support.sessionId).toBe('new-1')
  })

  it('shows a "+ New Chat" row optimistically until the persisted one lands', async () => {
    listConversations.mockResolvedValue([thread('t1')])
    await mount()
    expect(threadIds()).toEqual(['t1'])

    const focusBefore = chat.focusInputToken
    sidebar.onNewChat()
    await tick()

    expect(chat.sessionId).toBe('new-2')
    // The optimistic row sits on top so the new chat is visible before its row exists.
    expect(threadIds()).toEqual(['new-2', 't1'])
    expect(sidebar.threads[0].isPlaceholder).toBe(true)
    // ...and the composer is focused so the user can just type.
    expect(chat.focusInputToken).toBe(focusBefore + 1)

    // Once the real row arrives, the placeholder is dropped rather than doubled.
    listConversations.mockResolvedValue([thread('new-2'), thread('t1')])
    chat.onRunStarted('new-2')
    await tick(10)
    expect(threadIds()).toEqual(['new-2', 't1'])
    expect(sidebar.threads[0].isPlaceholder).toBeUndefined()
  })

  it('drops the placeholder when the user picks an existing thread instead', async () => {
    listConversations.mockResolvedValue([thread('t1')])
    await mount()
    sidebar.onNewChat()
    await tick()
    expect(threadIds()).toContain('new-2')

    sidebar.onSelectThread('t1')
    await tick()
    expect(chat.sessionId).toBe('t1')
    expect(threadIds()).toEqual(['t1'])
  })

  it('ignores a re-select of the thread already open', async () => {
    listConversations.mockResolvedValue([thread('t1')])
    await mount()
    sidebar.onSelectThread('t1')
    await tick()

    registry.mergeGraph('t1', [{ data: { id: 'n1', label: 'Node' } }])
    await tick()
    expect(support.graphElements).toHaveLength(1)

    sidebar.onSelectThread('t1')
    await tick()
    // A no-op: the graph would have been wiped had the switch gone through.
    expect(support.graphElements).toHaveLength(1)
  })

  it('shows the newly-opened thread its own (empty) panels, not the previous one’s', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2')])
    await mount()
    registry.mergeGraph('new-1', [{ data: { id: 'n1', label: 'Node' } }])
    registry.appendEvents('new-1', [{ type: 'tool_call', ts: 1 } as never])
    await tick()
    expect(support.graphElements).toHaveLength(1)
    expect(support.contextEvents).toHaveLength(1)

    sidebar.onSelectThread('t2')
    await tick()
    expect(support.graphElements).toEqual([])
    expect(support.contextEvents).toEqual([])
  })

  // ── SA-H8 ────────────────────────────────────────────────────────────────
  // Panel state used to be three route-level singletons. Combined with the
  // hydration effect's deliberate early-return for a still-running session
  // (#105 — it must not wipe a live buffer), that meant re-entering a running
  // thread never cleared the panels, and the running thread's own events then
  // appended onto the OTHER thread's graph and timeline.
  it('keeps a backgrounded run’s events in its own thread, out of the visible one', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2')])
    await mount()

    // t1 is running and has produced a node.
    sidebar.onSelectThread('t1')
    await tick()
    registry.updateRunState('t1', { isProcessing: true })
    registry.mergeGraph('t1', [{ data: { id: 't1-node', label: 'From t1' } }])
    registry.appendEvents('t1', [{ type: 'tool_call', ts: 1 } as never])
    await tick()
    expect(support.graphElements).toHaveLength(1)

    // Switch to t2. t1 keeps streaming into its OWN buffers while t2 is shown.
    sidebar.onSelectThread('t2')
    await tick()
    registry.mergeGraph('t1', [{ data: { id: 't1-node-2', label: 'Also from t1' } }])
    registry.appendEvents('t1', [{ type: 'tool_result', ts: 2 } as never])
    await tick()
    expect(support.graphElements).toEqual([])
    expect(support.contextEvents).toEqual([])

    // Back to t1: both of its own elements are there, and nothing of t2's.
    sidebar.onSelectThread('t1')
    await tick()
    expect(support.graphElements.map((e: { data: { id: string } }) => e.data.id)).toEqual([
      't1-node',
      't1-node-2',
    ])
    expect(support.contextEvents).toHaveLength(2)
  })

  it('keeps a running thread’s panel buffers when the user browses elsewhere', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2'), thread('t3')])
    await mount()
    sidebar.onSelectThread('t1')
    await tick()
    registry.updateRunState('t1', { isProcessing: true })
    registry.appendEvents('t1', [{ type: 'tool_call', ts: 1 } as never])
    await tick()

    // Two hops away — pruning drops idle sessions' buffers but never a
    // running one's, which is the only live copy of the in-flight turn.
    sidebar.onSelectThread('t2')
    await tick()
    sidebar.onSelectThread('t3')
    await tick()
    sidebar.onSelectThread('t1')
    await tick()
    expect(support.contextEvents).toHaveLength(1)
  })

  it('resets only the session being hydrated', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2')])
    await mount()
    registry.appendEvents('t1', [{ type: 'tool_call', ts: 1 } as never])
    registry.appendEvents('t2', [{ type: 'tool_call', ts: 2 } as never])
    await tick()

    // ChatInterface calls this before it repopulates a thread from history.
    registry.clearPanels('t2')
    await tick()
    sidebar.onSelectThread('t1')
    await tick()
    expect(support.contextEvents).toHaveLength(1)
    sidebar.onSelectThread('t2')
    await tick()
    expect(support.contextEvents).toEqual([])
  })

  it('drops a deleted thread’s panel buffers', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2')])
    await mount()
    registry.appendEvents('t1', [{ type: 'tool_call', ts: 1 } as never])
    await tick()
    deleteConversationsBulk.mockResolvedValue({ deleted: ['t1'] })
    await sidebar.onDeleteThreads(['t1'])
    await tick()

    registry.appendEvents('t1', [] as never)
    await tick()
    sidebar.onSelectThread('t1')
    await tick()
    expect(support.contextEvents).toEqual([])
  })
})

describe('chat route — the thread list', () => {
  it('patches a single row’s title from the SSE title event, without refetching', async () => {
    listConversations.mockResolvedValue([thread('t1', { title: null }), thread('t2')])
    await mount()
    listConversations.mockClear()

    chat.onTitleUpdated('t1', 'Quarterly numbers')
    await tick()

    expect(sidebar.threads.map((t: Thread) => t.title)).toEqual(['Quarterly numbers', 'Thread t2'])
    expect(listConversations).not.toHaveBeenCalled()
  })

  it('flips a promoted action row to a conversation in place', async () => {
    listConversations.mockResolvedValue([thread('t1', { kind: 'action' })])
    await mount()

    chat.onPromoted('t1')
    await tick()
    expect(sidebar.threads[0].kind).toBe('conversation')
  })

  it('refetches while an action is still running, and stops once it lands', async () => {
    vi.useFakeTimers()
    try {
      listConversations.mockResolvedValue([thread('t1', { kind: 'action', status: 'running' })])
      render(() => <Home />)
      await vi.advanceTimersByTimeAsync(10)
      listConversations.mockClear()

      await vi.advanceTimersByTimeAsync(5000)
      expect(listConversations).toHaveBeenCalledTimes(1)

      listConversations.mockResolvedValue([thread('t1', { kind: 'action', status: 'done' })])
      await vi.advanceTimersByTimeAsync(5000)
      listConversations.mockClear()

      await vi.advanceTimersByTimeAsync(20_000)
      expect(listConversations).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes the server-confirmed rows only', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2'), thread('t3')])
    await mount()

    // The server is ground truth: t3 was not deleted, so its row stays.
    deleteConversationsBulk.mockResolvedValue({ deleted: ['t1'] })
    await sidebar.onDeleteThreads(['t1', 't3'])
    await tick()

    expect(threadIds()).toEqual(['t2', 't3'])
  })

  it('leaves the list alone when nothing was deleted', async () => {
    listConversations.mockResolvedValue([thread('t1')])
    await mount()

    deleteConversationsBulk.mockResolvedValue({ deleted: [] })
    await sidebar.onDeleteThreads(['t1'])
    await tick()
    expect(threadIds()).toEqual(['t1'])
  })

  it('lands on the newest remaining thread when the open one is deleted', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2')])
    await mount()
    sidebar.onSelectThread('t1')
    await tick()

    deleteConversationsBulk.mockResolvedValue({ deleted: ['t1'] })
    await sidebar.onDeleteThreads(['t1'])
    await tick()

    expect(chat.sessionId).toBe('t2')
  })

  it('opens a fresh chat when the last thread is deleted', async () => {
    listConversations.mockResolvedValue([thread('t1')])
    await mount()
    sidebar.onSelectThread('t1')
    await tick()

    deleteConversationsBulk.mockResolvedValue({ deleted: ['t1'] })
    await sidebar.onDeleteThreads(['t1'])
    await tick()

    expect(chat.sessionId).toBe('new-2')
    expect(threadIds()).toEqual(['new-2']) // the optimistic row for it
  })
})

// The registry's own contract — the eight slots, the prune rule, disposal —
// is covered by `lib/session-registry.test.ts`. What is left here is the
// route's *policy* over it: which run gets marked, and when a stream is torn
// down.
describe('chat route — run state across threads', () => {
  it('prunes an idle session’s message buffer on a switch, but never a running one’s', async () => {
    listConversations.mockResolvedValue([thread('t1'), thread('t2'), thread('t3')])
    await mount()

    registry.setMessages('t1', [{ id: 'm1', role: 'user', content: 'still streaming' } as never])
    registry.setMessages('t3', [{ id: 'm2', role: 'user', content: 'finished' } as never])
    registry.updateRunState('t1', { isProcessing: true })
    await tick()

    sidebar.onSelectThread('t2')
    await tick()

    expect(registry.messages('t1')).toHaveLength(1)
    // t3 is idle — Postgres is authoritative for it, so its buffer is disposable.
    expect(registry.messages('t3')).toEqual([])
  })

  it('marks a run that landed in a thread the user was not watching', async () => {
    vi.useFakeTimers()
    try {
      listConversations.mockResolvedValue([thread('t1'), thread('t2')])
      render(() => <Home />)
      await vi.advanceTimersByTimeAsync(10)
      sidebar.onSelectThread('t2')
      await vi.advanceTimersByTimeAsync(1)

      chat.onRunSettled('t1', 'done')
      await vi.advanceTimersByTimeAsync(1)
      expect(registry.completion('t1')).toEqual({ outcome: 'done', flashing: true })

      // The flash is one-shot; the mark itself survives until the thread is opened.
      await vi.advanceTimersByTimeAsync(2400)
      expect(registry.completion('t1')).toEqual({ outcome: 'done', flashing: false })

      sidebar.onSelectThread('t1')
      await vi.advanceTimersByTimeAsync(1)
      expect(registry.completion('t1')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mark a run the user watched land', async () => {
    listConversations.mockResolvedValue([thread('t1')])
    await mount()
    sidebar.onSelectThread('t1')
    await tick()

    chat.onRunSettled('t1', 'done')
    await tick()
    expect(registry.completion('t1')).toBeUndefined()
  })

  it('refetches the thread list when a run settles in any thread', async () => {
    listConversations.mockResolvedValue([thread('t1')])
    await mount()
    listConversations.mockClear()

    chat.onRunSettled('t1', 'error')
    await tick(10)
    expect(listConversations).toHaveBeenCalledTimes(1)
  })

  it('aborts every in-flight stream on page unload', async () => {
    await mount()
    const a = new AbortController()
    const b = new AbortController()
    registry.registerAbort('t1', a)
    registry.registerAbort('t2', b)
    registry.unregisterAbort('t2')

    window.dispatchEvent(new Event('beforeunload'))
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
  })
})

describe('chat route — support panel wiring', () => {
  it('shows the displayed session’s accumulated graph, and clears it on request', async () => {
    await mount()
    registry.mergeGraph('new-1', [{ data: { id: 'n1', label: 'Alice' } }])
    await tick()
    registry.mergeGraph('new-1', [{ data: { id: 'n2', label: 'Acme' } }])
    // The chat view reports which ids just landed (it alone knows whether the
    // batch belongs to the thread on screen).
    chat.onHighlightEntities(['n2'])
    await tick()

    expect(support.graphElements.map((e: { data: { id: string } }) => e.data.id)).toEqual([
      'n1',
      'n2',
    ])
    expect(support.highlightedIds).toEqual(['n2'])

    support.onClearGraph()
    await tick()
    expect(support.graphElements).toEqual([])
    expect(support.highlightedIds).toEqual([])
  })

  it('indexes node and edge labels so chat can highlight known entities', async () => {
    await mount()
    registry.mergeGraph('new-1', [
      { data: { id: 'n1', label: 'Alice', kind: 'node' } },
      { data: { id: 'n2', label: 'Alice', kind: 'node' } },
      { data: { id: 'e1', label: 'WORKS_AT', source: 'n1', target: 'n2', kind: 'edge' } },
      { data: { label: 'no id — skipped', kind: 'node' } },
    ])
    await tick()

    const names: Map<string, string[]> = chat.graphEntityNames
    expect(names.get('Alice')).toEqual(['n1', 'n2'])
    expect(names.get('WORKS_AT')).toEqual(['e1'])
    expect(names.has('no id — skipped')).toBe(false)
  })

  it('clears the observability buffers on request', async () => {
    await mount()
    registry.appendEvents('new-1', [{ type: 'tool_call', ts: 1 } as never])
    chat.onContextUpdate('new-1', { id: 'ctx' } as never)
    await tick()
    expect(support.unifiedContext).toEqual({ id: 'ctx' })

    support.onClearEvents()
    await tick()
    expect(support.contextEvents).toEqual([])
    expect(support.unifiedContext).toBeUndefined()
  })

  it('refreshes the sidebar when the turn’s context is saved', async () => {
    await mount()
    listConversations.mockClear()
    chat.onContextUpdate('new-1', { id: 'ctx' } as never)
    await tick(10)
    expect(listConversations).toHaveBeenCalledTimes(1)
  })

  it('applies a stash action optimistically and persists it', async () => {
    await mount()
    registry.appendEvents('new-1', [
      { id: 'e1', type: 'tool_result', ts: 1, data: { output: 'x' } } as never,
      { id: 'e2', type: 'tool_result', ts: 2, data: { output: 'y' } } as never,
    ])
    await tick()

    await support.onStashAction('e1', 'archive')
    await tick()

    // Archiving un-hides, and only the named event is touched.
    expect(support.contextEvents[0].data).toMatchObject({ archived: true, hidden: false })
    expect(support.contextEvents[1].data).toEqual({ output: 'y' })

    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(url).toBe('/api/stash')
    expect(JSON.parse(init!.body as string)).toEqual({
      sessionId: 'new-1',
      eventId: 'e1',
      action: 'archive',
    })
  })

  it('maps each stash action to its flags', async () => {
    await mount()
    registry.appendEvents('new-1', [{ id: 'e1', type: 'tool_result', ts: 1, data: {} } as never])
    await tick()

    for (const [action, expected] of [
      ['hide', { hidden: true }],
      ['unhide', { hidden: false }],
      ['unarchive', { archived: false }],
    ] as const) {
      await support.onStashAction('e1', action)
      await tick()
      expect(support.contextEvents[0].data).toMatchObject(expected)
    }
  })

  it('tracks the agent the chat view reports, for the agent-aware panels', async () => {
    await mount()
    expect(support.agentId).toBe('search')
    chat.onSelectedAgentChange('sandbox')
    await tick()
    expect(support.agentId).toBe('sandbox')
  })

  it('routes a clicked citation to the panel', async () => {
    await mount()
    expect(support.pendingReference).toBeNull()
    chat.onOpenReference({ docId: 'doc-1', chunkIndex: 2 })
    await tick()
    expect(support.pendingReference).toEqual({ docId: 'doc-1', chunkIndex: 2 })
  })
})

describe('chat route — the embedding guard', () => {
  it('blocks the composer while an uploaded source is still embedding, and releases it when done', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(jsonResponse({ documents: [{ ingestStatus: 'pending' }] }))
      render(() => <Home />)
      await vi.advanceTimersByTimeAsync(10)
      expect(chat.embeddingSources).toBe(true)

      // The poll keeps watching until the ingest finishes.
      fetchMock.mockResolvedValue(jsonResponse({ documents: [{ ingestStatus: 'done' }] }))
      await vi.advanceTimersByTimeAsync(3000)
      expect(chat.embeddingSources).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms the poll after an upload', async () => {
    await mount()
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(jsonResponse({ documents: [{ ingestStatus: 'pending' }] }))

    support.onUploaded()
    await tick(10)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/stash/upload?sessionId=new-1')
    expect(chat.embeddingSources).toBe(true)
  })

  it('does not block the composer when the status poll fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    await mount()
    expect(chat.embeddingSources).toBe(false)
  })

  it('does not block the composer on a non-OK status response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    await mount()
    expect(chat.embeddingSources).toBe(false)
  })
})
