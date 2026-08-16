/**
 * ChatSidebar — the rendered thread list.
 *
 * The pure policy helpers (merge/filter/indicator/select-mode maths) are
 * covered in ChatSidebar.test.ts; this file mounts the component and asserts
 * what those rules actually produce on screen: the two layouts (collapsed
 * rail vs expanded list), the kind filter, the hover row actions, select mode
 * with its keyboard shortcuts, and the delete-confirm dialog's open/retry/
 * close behaviour.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { installDomObservers } from '../../mocks/dom-observers'
import type { CompletionMark, SessionRunState } from '~/lib/run-registry'
import type { ChainProgressSnapshot } from '~/components/ark-ui/useChainProgress'

beforeAll(installDomObservers)

// `regenerateConversationTitle` comes from the server-only harness-client
// barrel, whose transitive `assert.server` throws under jsdom.
vi.mock('~/lib/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const regenerateConversationTitle = vi.fn(
  async (_id: string): Promise<string | null> => 'Fresh title',
)
vi.mock('~/lib/harness-client', () => ({ regenerateConversationTitle }))

const { ChatSidebar } = await import('~/components/ark-ui/ChatSidebar')
type ChatThreadSummary = import('~/components/ark-ui/ChatSidebar').ChatThreadSummary

const tick = () => new Promise((r) => setTimeout(r, 20))

const thread = (
  over: Partial<ChatThreadSummary> & Pick<ChatThreadSummary, 'id'>,
): ChatThreadSummary => ({
  title: `Thread ${over.id}`,
  updatedAt: new Date().toISOString(),
  kind: 'conversation',
  status: 'done',
  ...over,
})

const chats = [
  thread({ id: 'a', title: 'Graph audit' }),
  thread({ id: 'b', title: 'Ontology sweep' }),
]
const action = thread({ id: 'act', title: 'Nightly sync', kind: 'action', status: 'running' })

/** The thread rows. `.group` is the hover-scope class every row carries — a
 *  looser selector also catches the SettingsPanel buttons in the footer. */
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('button.group')]

const byText = (root: ParentNode, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

/** The delete-confirm dialog. Scoped by data-scope: the SettingsPanel in the
 *  sidebar footer is a floating-panel and also owns a `content` part. */
const confirmDialog = () =>
  document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="content"]')

const idle: SessionRunState = { isProcessing: false, runningTool: null }
const busy: SessionRunState = { isProcessing: true, runningTool: 'read_neo4j_cypher' }

const snapshot = (over: Partial<ChainProgressSnapshot> = {}): ChainProgressSnapshot => ({
  currentTurn: 0,
  maxProjection: 0,
  pathProjection: 0,
  status: null,
  done: false,
  ...over,
})

const progressFor = (snap: ChainProgressSnapshot) => () => ({
  snapshot: () => snap,
  ingest: vi.fn(),
  finish: vi.fn(),
  reset: vi.fn(),
})

/** Minimal props — every optional callback left off unless a test needs it. */
const baseProps = () => ({
  collapsed: false,
  onToggle: vi.fn(),
  threads: chats,
  selectedId: null,
  onSelectThread: vi.fn(),
  onNewChat: vi.fn(),
})

beforeEach(() => {
  regenerateConversationTitle.mockClear()
  regenerateConversationTitle.mockResolvedValue('Fresh title')
})

describe('ChatSidebar — expanded list', () => {
  it('lists every thread by title and reports which one was clicked', () => {
    const onSelectThread = vi.fn()
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onSelectThread={onSelectThread} />
    ))

    expect(rows(container).map((r) => r.textContent)).toEqual([
      expect.stringContaining('Graph audit'),
      expect.stringContaining('Ontology sweep'),
    ])

    rows(container)[1].click()
    expect(onSelectThread).toHaveBeenCalledWith('b')
  })

  it('names an untitled row and italicises the optimistic placeholder', () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'u', title: null }), thread({ id: 'p', isPlaceholder: true })]}
      />
    ))
    expect(rows(container)[0].textContent).toContain('(untitled)')
    expect(rows(container)[1].textContent).toContain('new chat')
  })

  it('offers an empty-state line worded for the active filter', () => {
    const { container } = render(() => <ChatSidebar {...baseProps()} threads={[]} />)
    expect(container.textContent).toContain('No conversations yet. Send a message to start.')

    byText(container, 'Actions')!.click()
    expect(container.textContent).toContain('Trigger one via POST /api/agents/:id.')
  })

  it('filters the list by kind and keeps the active segment pressed', () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} threads={[...chats, action]} />
    ))
    expect(rows(container)).toHaveLength(3)

    byText(container, 'Actions')!.click()
    expect(rows(container).map((r) => r.textContent)).toEqual([
      expect.stringContaining('Nightly sync'),
    ])
    expect(byText(container, 'Actions')!.getAttribute('aria-pressed')).toBe('true')
    expect(byText(container, 'All')!.getAttribute('aria-pressed')).toBe('false')

    byText(container, 'Chats')!.click()
    expect(rows(container)).toHaveLength(2)
  })

  it('badges a running action but never a conversation', () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} threads={[thread({ id: 'a', status: 'running' }), action]} />
    ))
    const labels = rows(container).map(
      (r) => r.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null,
    )
    expect(labels).toEqual([null, 'running'])
  })

  it('marks the selected row with aria-current-style accent state', () => {
    const { container } = render(() => <ChatSidebar {...baseProps()} selectedId="b" />)
    // Selection is carried by the attributify border, which the extractor only
    // emits for the literal value — assert the literal, not a computed style.
    expect(rows(container)[1].getAttribute('border')).toContain('neon-cyan/40')
    expect(rows(container)[0].getAttribute('border')).toContain('transparent')
  })

  it('starts a new chat from the footer button', () => {
    const onNewChat = vi.fn()
    const { container } = render(() => <ChatSidebar {...baseProps()} onNewChat={onNewChat} />)
    byText(container, '+ New Chat')!.click()
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })
})

describe('ChatSidebar — live run readout (#105)', () => {
  it('replaces the timestamp with the live status line while a run streams', () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'a', title: 'Graph audit' })]}
        getRunState={() => busy}
        getProgress={progressFor(
          snapshot({
            status: 'Querying Neo4j',
            currentTurn: 2,
            pathProjection: 8,
            maxProjection: 8,
          }),
        )}
      />
    ))
    expect(container.textContent).toContain('Querying Neo4j')
    expect(container.textContent).not.toContain('just now')
  })

  it('falls back to "Starting…" before the first status arrives', () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'a' })]}
        getRunState={() => busy}
        getProgress={progressFor(snapshot())}
      />
    ))
    expect(container.textContent).toContain('Starting…')
    // No denominator yet → the indeterminate shimmer, not a 0%-wide fill.
    expect(container.querySelector('.thread-progress-indeterminate')).toBeTruthy()
  })

  it('shows the relative timestamp for an idle row', () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} threads={[thread({ id: 'a' })]} getRunState={() => idle} />
    ))
    expect(container.textContent).toContain('just now')
  })

  it('accents a row whose run finished while the user was elsewhere', () => {
    const completion: CompletionMark = { outcome: 'error', flashing: true }
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'a' })]}
        getCompletion={() => completion}
      />
    ))
    const row = rows(container)[0]
    expect(row.dataset.completed).toBe('error')
    expect(row.className).toContain('thread-flash-error')
    expect(row.title).toBe('Finished with an error while you were away')
  })
})

describe('ChatSidebar — collapsed rail (#60)', () => {
  it('renders one labelled icon button per thread, ignoring the kind filter', () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} collapsed threads={[...chats, action]} />
    ))
    const labels = [...container.querySelectorAll('button[aria-label]')].map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(labels).toEqual(['Graph audit', 'Ontology sweep', 'Nightly sync', 'New chat'])
    // The expanded-only affordances are gone.
    expect(byText(container, '+ New Chat')).toBeUndefined()
    expect(byText(container, 'All')).toBeUndefined()
  })

  it('selects a thread and starts a new chat from the rail', () => {
    const onSelectThread = vi.fn()
    const onNewChat = vi.fn()
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        collapsed
        onSelectThread={onSelectThread}
        onNewChat={onNewChat}
      />
    ))
    container.querySelector<HTMLElement>('button[aria-label="Graph audit"]')!.click()
    expect(onSelectThread).toHaveBeenCalledWith('a')

    container.querySelector<HTMLElement>('button[aria-label="New chat"]')!.click()
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('compresses live state into a pulsing dot on the rail button', () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        collapsed
        threads={[thread({ id: 'a', title: 'Graph audit' })]}
        getRunState={() => busy}
      />
    ))
    const dot = container.querySelector<HTMLElement>(
      'button[aria-label="Graph audit"] span.animate-pulse',
    )
    expect(dot).toBeTruthy()
  })

  it('toggles the sidebar from the chevron', () => {
    const onToggle = vi.fn()
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} collapsed onToggle={onToggle} />
    ))
    container.querySelector<HTMLElement>('button[title="Expand sidebar"]')!.click()
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('ChatSidebar — regenerate title', () => {
  const regenSpan = (root: HTMLElement, index = 0) =>
    [...root.querySelectorAll<HTMLElement>('span[title="Regenerate title"]')][index]

  it('regenerates a row title and forwards the new one to the route', async () => {
    const onTitleRegenerated = vi.fn()
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onTitleRegenerated={onTitleRegenerated} />
    ))

    regenSpan(container).click()
    await tick()

    expect(regenerateConversationTitle).toHaveBeenCalledWith('a')
    expect(onTitleRegenerated).toHaveBeenCalledWith('a', 'Fresh title')
  })

  it('does not also select the thread when the ↻ is clicked', () => {
    const onSelectThread = vi.fn()
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onSelectThread={onSelectThread} />
    ))
    regenSpan(container).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onSelectThread).not.toHaveBeenCalled()
  })

  it('ignores a second click while the first regeneration is still in flight', async () => {
    let release: (v: string) => void = () => {}
    regenerateConversationTitle.mockReturnValueOnce(new Promise<string>((r) => (release = r)))
    const { container } = render(() => <ChatSidebar {...baseProps()} />)

    regenSpan(container).click()
    await tick()
    regenSpan(container).click()
    expect(regenerateConversationTitle).toHaveBeenCalledTimes(1)

    release('done')
    await tick()
    // Once settled the row is clickable again.
    regenSpan(container).click()
    expect(regenerateConversationTitle).toHaveBeenCalledTimes(2)
  })

  it('swallows a failed regeneration without notifying the route', async () => {
    const onTitleRegenerated = vi.fn()
    regenerateConversationTitle.mockRejectedValueOnce(new Error('LLM down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onTitleRegenerated={onTitleRegenerated} />
    ))

    regenSpan(container).click()
    await tick()

    expect(onTitleRegenerated).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  // A null title means the server had nothing better to offer — leave the row alone.
  it('leaves the title alone when the server returns none', async () => {
    const onTitleRegenerated = vi.fn()
    regenerateConversationTitle.mockResolvedValueOnce(null)
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onTitleRegenerated={onTitleRegenerated} />
    ))
    regenSpan(container).click()
    await tick()
    expect(onTitleRegenerated).not.toHaveBeenCalled()
  })

  it('offers no ↻ on a placeholder row — there is nothing persisted to retitle', () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} threads={[thread({ id: 'p', isPlaceholder: true })]} />
    ))
    expect(container.querySelector('span[title="Regenerate title"]')).toBeNull()
  })
})

describe('ChatSidebar — delete (#71)', () => {
  const deleteSpan = (root: HTMLElement, index = 0) =>
    [...root.querySelectorAll<HTMLElement>('span[title="Delete conversation"]')][index]

  const dialogText = () => confirmDialog()?.textContent ?? ''

  it('confirms before deleting, naming the conversation', async () => {
    const onDeleteThreads = vi.fn(async () => {})
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onDeleteThreads={onDeleteThreads} />
    ))

    deleteSpan(container).click()
    await tick()

    expect(dialogText()).toContain('Delete "Graph audit"? This can\'t be undone.')
    expect(onDeleteThreads).not.toHaveBeenCalled()

    byText(confirmDialog()!, 'Delete')!.click()
    await tick()
    expect(onDeleteThreads).toHaveBeenCalledWith(['a'])
    expect(confirmDialog()).toBeNull()
  })

  it('cancels without deleting', async () => {
    const onDeleteThreads = vi.fn(async () => {})
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onDeleteThreads={onDeleteThreads} />
    ))
    deleteSpan(container).click()
    await tick()
    byText(confirmDialog()!, 'Cancel')!.click()
    await tick()

    expect(onDeleteThreads).not.toHaveBeenCalled()
    expect(confirmDialog()).toBeNull()
  })

  // A failed mutation must not look like a success — the row is still there,
  // so the dialog stays up for a retry.
  it('keeps the dialog open when the delete fails', async () => {
    const onDeleteThreads = vi.fn(async () => {
      throw new Error('network')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onDeleteThreads={onDeleteThreads} />
    ))
    deleteSpan(container).click()
    await tick()
    byText(confirmDialog()!, 'Delete')!.click()
    await tick()

    expect(confirmDialog()).toBeTruthy()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('hides the delete affordance for placeholder and running rows', () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'p', isPlaceholder: true }), thread({ id: 'r' })]}
        getRunState={(id) => (id === 'r' ? busy : idle)}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    expect(container.querySelectorAll('span[title="Delete conversation"]')).toHaveLength(0)
  })

  it('does not select the thread when the delete affordance is clicked', async () => {
    const onSelectThread = vi.fn()
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        onSelectThread={onSelectThread}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    deleteSpan(container).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    await tick()
    expect(onSelectThread).not.toHaveBeenCalled()
  })
})

describe('ChatSidebar — select mode (#71)', () => {
  const enterSelectMode = (root: HTMLElement) => {
    root.querySelector<HTMLElement>('button[title="Select conversations"]')!.click()
  }
  const checkboxes = (root: HTMLElement) => [
    ...root.querySelectorAll<HTMLElement>('[role="checkbox"]'),
  ]

  it('turns rows into checkboxes and swaps the row click for a toggle', async () => {
    const onSelectThread = vi.fn()
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        onSelectThread={onSelectThread}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    enterSelectMode(container)
    await tick()

    expect(checkboxes(container)).toHaveLength(2)

    rows(container)[0].click()
    await tick()
    expect(onSelectThread, 'row click selects, not navigates').not.toHaveBeenCalled()
    expect(checkboxes(container)[0].getAttribute('aria-checked')).toBe('true')
    expect(byText(container, 'Delete selected (1)')).toBeTruthy()

    // Clicking again unticks.
    rows(container)[0].click()
    await tick()
    expect(checkboxes(container)[0].getAttribute('aria-checked')).toBe('false')
  })

  it('select-all ticks only the eligible rows, then Clear drops them', async () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[...chats, thread({ id: 'r', title: 'Running one' })]}
        getRunState={(id) => (id === 'r' ? busy : idle)}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    enterSelectMode(container)
    await tick()

    byText(container, 'Select all')!.click()
    await tick()
    expect(byText(container, 'Delete selected (2)')).toBeTruthy()
    // The label flips once everything eligible is ticked.
    expect(byText(container, 'Clear')).toBeTruthy()

    byText(container, 'Clear')!.click()
    await tick()
    expect(byText(container, 'Delete selected (0)')).toBeTruthy()
  })

  it('reports the running rows it had to skip in the bulk confirm', async () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[...chats, thread({ id: 'r', title: 'Running one' })]}
        getRunState={(id) => (id === 'r' ? busy : idle)}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    enterSelectMode(container)
    await tick()
    byText(container, 'Select all')!.click()
    await tick()
    byText(container, 'Delete selected (2)')!.click()
    await tick()

    const copy = confirmDialog()!.textContent!
    expect(copy).toContain("Delete 2 conversations? This can't be undone.")
    expect(copy).toContain('1 running — skipped.')
  })

  it('leaves select mode after a successful bulk delete', async () => {
    const onDeleteThreads = vi.fn(async () => {})
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onDeleteThreads={onDeleteThreads} />
    ))
    enterSelectMode(container)
    await tick()
    byText(container, 'Select all')!.click()
    await tick()
    byText(container, 'Delete selected (2)')!.click()
    await tick()
    byText(confirmDialog()!, 'Delete')!.click()
    await tick()

    expect(onDeleteThreads).toHaveBeenCalledWith(['a', 'b'])
    expect(checkboxes(container)).toHaveLength(0)
  })

  it('refuses a bulk delete when every selected row started running', async () => {
    const [running, setRunning] = createSignal(false)
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[chats[0]]}
        getRunState={() => (running() ? busy : idle)}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    enterSelectMode(container)
    await tick()
    rows(container)[0].click()
    await tick()

    // A run starts in the ticked thread before the user confirms.
    setRunning(true)
    await tick()
    byText(container, 'Delete selected (1)')!.click()
    await tick()

    expect(confirmDialog()).toBeNull()
  })

  it('exits select mode on Escape and toggles select-all on Cmd/Ctrl-A', async () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onDeleteThreads={vi.fn(async () => {})} />
    ))
    enterSelectMode(container)
    await tick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    await tick()
    expect(byText(container, 'Delete selected (2)')).toBeTruthy()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(checkboxes(container)).toHaveLength(0)
  })

  // Cmd-A inside the composer must keep meaning "select all text".
  it('leaves the shortcut alone while a text field has focus', async () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onDeleteThreads={vi.fn(async () => {})} />
    ))
    enterSelectMode(container)
    await tick()

    const input = document.createElement('textarea')
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()

    expect(byText(container, 'Delete selected (0)')).toBeTruthy()
    input.remove()
  })

  it('cancels select mode from its own Cancel button', async () => {
    const { container } = render(() => (
      <ChatSidebar {...baseProps()} onDeleteThreads={vi.fn(async () => {})} />
    ))
    enterSelectMode(container)
    await tick()
    byText(container, 'Cancel')!.click()
    await tick()
    expect(checkboxes(container)).toHaveLength(0)
  })

  // Every select-mode control lives in the expanded layout; collapsing would
  // leave the state armed but invisible.
  it('exits select mode when the sidebar collapses', async () => {
    const [collapsed, setCollapsed] = createSignal(false)
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        collapsed={collapsed()}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    enterSelectMode(container)
    await tick()

    setCollapsed(true)
    await tick()
    setCollapsed(false)
    await tick()

    expect(checkboxes(container)).toHaveLength(0)
  })

  it('will not tick a running row', async () => {
    const { container } = render(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'r', title: 'Running one' })]}
        getRunState={() => busy}
        onDeleteThreads={vi.fn(async () => {})}
      />
    ))
    enterSelectMode(container)
    await tick()

    expect(checkboxes(container)[0].getAttribute('aria-disabled')).toBe('true')
    rows(container)[0].click()
    await tick()
    expect(checkboxes(container)[0].getAttribute('aria-checked')).toBe('false')
  })
})
