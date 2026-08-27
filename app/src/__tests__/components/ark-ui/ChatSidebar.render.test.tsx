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
import { createSignal, type JSX } from 'solid-js'
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
type PinResult = import('~/lib/harness-client').PinResult
const setConversationPinned = vi.fn(async (_id: string, _pinned: boolean): Promise<PinResult> => ({
  outcome: 'pinned',
  limit: 3,
}))
vi.mock('~/lib/harness-client', () => ({ regenerateConversationTitle, setConversationPinned }))

const { ChatSidebar } = await import('~/components/ark-ui/ChatSidebar')
const { SessionRegistryContext } = await import('~/lib/session-registry-context')
type ChatThreadSummary = import('~/components/ark-ui/ChatSidebar').ChatThreadSummary
type SessionRegistry = import('~/lib/session-registry').SessionRegistry

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

const idle: SessionRunState = { isProcessing: false, runningTool: null, warming: null }
const busy: SessionRunState = {
  isProcessing: true,
  runningTool: 'read_neo4j_cypher',
  warming: null,
}

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

/**
 * The sidebar reads run state, progress and completion marks from the session
 * registry in context (#226 B1). Only those three reads matter here, so the
 * stub implements them and leaves the rest of the interface unpopulated —
 * touching any other member is a test failure by design.
 */
const stubRegistry = (over: Partial<SessionRegistry> = {}): SessionRegistry =>
  ({
    runState: () => idle,
    progress: progressFor(snapshot()),
    completion: () => undefined,
    ...over,
  }) as SessionRegistry

/** Mount under a registry, the way `routes/index.tsx` does. */
const mount = (node: () => JSX.Element, registry: SessionRegistry = stubRegistry()) =>
  render(() => (
    <SessionRegistryContext.Provider value={registry}>{node()}</SessionRegistryContext.Provider>
  ))

beforeEach(() => {
  regenerateConversationTitle.mockClear()
  regenerateConversationTitle.mockResolvedValue('Fresh title')
  setConversationPinned.mockClear()
  setConversationPinned.mockResolvedValue({ outcome: 'pinned', limit: 3 })
})

describe('ChatSidebar — expanded list', () => {
  it('lists every thread by title and reports which one was clicked', () => {
    const onSelectThread = vi.fn()
    const { container } = mount(() => (
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
    const { container } = mount(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'u', title: null }), thread({ id: 'p', isPlaceholder: true })]}
      />
    ))
    expect(rows(container)[0].textContent).toContain('(untitled)')
    expect(rows(container)[1].textContent).toContain('new chat')
  })

  it('offers an empty-state line worded for the active filter', () => {
    const { container } = mount(() => <ChatSidebar {...baseProps()} threads={[]} />)
    expect(container.textContent).toContain('No conversations yet. Send a message to start.')

    byText(container, 'Actions')!.click()
    expect(container.textContent).toContain('Trigger one via POST /api/agents/:id.')
  })

  it('filters the list by kind and keeps the active segment pressed', () => {
    const { container } = mount(() => <ChatSidebar {...baseProps()} threads={[...chats, action]} />)
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
    const { container } = mount(() => (
      <ChatSidebar {...baseProps()} threads={[thread({ id: 'a', status: 'running' }), action]} />
    ))
    const labels = rows(container).map(
      (r) => r.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null,
    )
    expect(labels).toEqual([null, 'Running'])
  })

  // SA-L7. `i-mdi-*` is not a registered icon collection in `uno.config.ts`, so
  // these classes emitted no CSS at all — every state rendered as the same
  // empty box and a failed action was indistinguishable from a completed one.
  // The status glyph is the load-bearing case for the icon-set rule.
  it('draws every status glyph from the registered icon set, each with a label', () => {
    const cases: { status: string; icon: string; label: string }[] = [
      { status: 'running', icon: 'i-material-symbols-progress-activity', label: 'Running' },
      { status: 'error', icon: 'i-material-symbols-error-outline', label: 'Failed' },
      {
        status: 'paused',
        icon: 'i-material-symbols-pause-circle-outline',
        label: 'Awaiting approval',
      },
      { status: 'done', icon: 'i-material-symbols-bolt-outline', label: 'Action, completed' },
    ]

    for (const c of cases) {
      const { container, unmount } = mount(() => (
        <ChatSidebar
          {...baseProps()}
          threads={[thread({ id: 'x', kind: 'action', status: c.status as never })]}
        />
      ))
      const glyph = container.querySelector('[aria-label]')!
      expect(glyph.className, c.status).toContain(c.icon)
      expect(glyph.className, c.status).not.toContain('i-mdi-')
      expect(glyph.getAttribute('aria-label')).toBe(c.label)
      // A text alternative as well as the hue — the row has no room for a
      // caption, so `title` carries it (`color-not-only`).
      expect(glyph.getAttribute('title')).toBeTruthy()
      unmount()
    }
  })

  it('marks the selected row with aria-current-style accent state', () => {
    const { container } = mount(() => <ChatSidebar {...baseProps()} selectedId="b" />)
    // Selection is carried by the attributify border, which the extractor only
    // emits for the literal value — assert the literal, not a computed style.
    expect(rows(container)[1].getAttribute('border')).toContain('ui-accent/40')
    expect(rows(container)[0].getAttribute('border')).toContain('transparent')
  })

  it('starts a new chat from the footer button', () => {
    const onNewChat = vi.fn()
    const { container } = mount(() => <ChatSidebar {...baseProps()} onNewChat={onNewChat} />)
    byText(container, '+ New Chat')!.click()
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })
})

describe('ChatSidebar — the tier glyph', () => {
  const tiered = [
    thread({ id: 'a', title: 'Graph audit', inferenceTier: 'verda' }),
    thread({ id: 'b', title: 'Ontology sweep', inferenceTier: 'anthropic' }),
  ]

  it('shows each row’s OWN tier, not one setting repeated', () => {
    // The whole point of the switch moving: two conversations, two answers, in
    // the same list at the same time.
    const { container } = mount(() => <ChatSidebar {...baseProps()} threads={tiered} />)

    const glyphs = rows(container).map((r) => r.querySelector('[role="img"][data-tier]'))
    expect(glyphs.map((g) => g?.getAttribute('data-tier'))).toEqual(['verda', 'anthropic'])
    expect(glyphs[0]!.className).not.toBe(glyphs[1]!.className)
  })

  it('is visible without hovering, unlike the row actions above it', () => {
    // Delete and retitle are things you can DO to a row and are hover-revealed
    // (`opacity-0 group-hover:opacity-100`). Where a conversation runs is
    // something true of it, and a setting only visible on hover is one a user
    // has to go looking for to check.
    const { container } = mount(() => <ChatSidebar {...baseProps()} threads={tiered} />)

    const glyph = rows(container)[0].querySelector('[role="img"][data-tier]')!
    expect(glyph.className).not.toContain('opacity-0')
    expect(glyph.className).not.toContain('group-hover')
  })

  it('names itself, since it is the only place the row says this', () => {
    const { container } = mount(() => <ChatSidebar {...baseProps()} threads={tiered} />)

    const glyph = rows(container)[0].querySelector('[role="img"][data-tier]')!
    // A sentence rather than a label: it is read out of context, in a list.
    expect(glyph.getAttribute('aria-label')).toBe('Runs on Private (Verda)')
    expect(glyph.getAttribute('title')).toBe('Runs on Private (Verda)')
    // And it therefore reaches the row button's accessible name.
    expect(rows(container)[0].textContent).toContain('Graph audit')
  })

  it('shows nothing for the optimistic placeholder, which has no conversation yet', () => {
    const { container } = mount(() => (
      <ChatSidebar
        {...baseProps()}
        threads={[thread({ id: 'new', title: null, isPlaceholder: true })]}
      />
    ))

    expect(rows(container)[0].querySelector('[role="img"][data-tier]')).toBeNull()
  })
})

describe('ChatSidebar — live run readout (#105)', () => {
  it('replaces the timestamp with the live status line while a run streams', () => {
    const { container } = mount(
      () => <ChatSidebar {...baseProps()} threads={[thread({ id: 'a', title: 'Graph audit' })]} />,
      stubRegistry({
        runState: () => busy,
        progress: progressFor(
          snapshot({
            status: 'Querying Neo4j',
            currentTurn: 2,
            pathProjection: 8,
            maxProjection: 8,
          }),
        ),
      }),
    )
    expect(container.textContent).toContain('Querying Neo4j')
    expect(container.textContent).not.toContain('just now')
  })

  it('falls back to "Starting…" before the first status arrives', () => {
    const { container } = mount(
      () => <ChatSidebar {...baseProps()} threads={[thread({ id: 'a' })]} />,
      stubRegistry({ runState: () => busy }),
    )
    expect(container.textContent).toContain('Starting…')
    // No denominator yet → the indeterminate shimmer, not a 0%-wide fill. The
    // class was `.thread-progress-indeterminate` until #295 folded this strip
    // onto the shared `ProgressBar`, which is also where the sweep now comes
    // from; the row asks for it by passing `percent: null`.
    expect(container.querySelector('.progress-indeterminate')).toBeTruthy()
    expect(container.querySelector('[data-part="root"]')?.getAttribute('data-state')).toBe(
      'indeterminate',
    )
  })

  it('shows the relative timestamp for an idle row', () => {
    const { container } = mount(() => (
      <ChatSidebar {...baseProps()} threads={[thread({ id: 'a' })]} />
    ))
    expect(container.textContent).toContain('just now')
  })

  it('accents a row whose run finished while the user was elsewhere', () => {
    const completion: CompletionMark = { outcome: 'error', flashing: true }
    const { container } = mount(
      () => <ChatSidebar {...baseProps()} threads={[thread({ id: 'a' })]} />,
      stubRegistry({ completion: () => completion }),
    )
    const row = rows(container)[0]
    expect(row.dataset.completed).toBe('error')
    expect(row.className).toContain('thread-flash-error')
    expect(row.title).toBe('Finished with an error while you were away')
  })
})

describe('ChatSidebar — collapsed rail (#60)', () => {
  it('renders one labelled icon button per thread, ignoring the kind filter', () => {
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(
      () => (
        <ChatSidebar
          {...baseProps()}
          collapsed
          threads={[thread({ id: 'a', title: 'Graph audit' })]}
        />
      ),
      stubRegistry({ runState: () => busy }),
    )
    const dot = container.querySelector<HTMLElement>(
      'button[aria-label="Graph audit"] span.animate-pulse',
    )
    expect(dot).toBeTruthy()
  })

  it('toggles the sidebar from the chevron', () => {
    const onToggle = vi.fn()
    const { container } = mount(() => (
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
    const { container } = mount(() => (
      <ChatSidebar {...baseProps()} onTitleRegenerated={onTitleRegenerated} />
    ))

    regenSpan(container).click()
    await tick()

    expect(regenerateConversationTitle).toHaveBeenCalledWith('a')
    expect(onTitleRegenerated).toHaveBeenCalledWith('a', 'Fresh title')
  })

  it('does not also select the thread when the ↻ is clicked', () => {
    const onSelectThread = vi.fn()
    const { container } = mount(() => (
      <ChatSidebar {...baseProps()} onSelectThread={onSelectThread} />
    ))
    regenSpan(container).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onSelectThread).not.toHaveBeenCalled()
  })

  it('ignores a second click while the first regeneration is still in flight', async () => {
    let release: (v: string) => void = () => {}
    regenerateConversationTitle.mockReturnValueOnce(new Promise<string>((r) => (release = r)))
    const { container } = mount(() => <ChatSidebar {...baseProps()} />)

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
    const { container } = mount(() => (
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
    const { container } = mount(() => (
      <ChatSidebar {...baseProps()} onTitleRegenerated={onTitleRegenerated} />
    ))
    regenSpan(container).click()
    await tick()
    expect(onTitleRegenerated).not.toHaveBeenCalled()
  })

  it('offers no ↻ on a placeholder row — there is nothing persisted to retitle', () => {
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(
      () => (
        <ChatSidebar
          {...baseProps()}
          threads={[thread({ id: 'p', isPlaceholder: true }), thread({ id: 'r' })]}
          onDeleteThreads={vi.fn(async () => {})}
        />
      ),
      stubRegistry({ runState: (id) => (id === 'r' ? busy : idle) }),
    )
    expect(container.querySelectorAll('span[title="Delete conversation"]')).toHaveLength(0)
  })

  it('does not select the thread when the delete affordance is clicked', async () => {
    const onSelectThread = vi.fn()
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(
      () => (
        <ChatSidebar
          {...baseProps()}
          threads={[...chats, thread({ id: 'r', title: 'Running one' })]}
          onDeleteThreads={vi.fn(async () => {})}
        />
      ),
      stubRegistry({ runState: (id) => (id === 'r' ? busy : idle) }),
    )
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
    const { container } = mount(
      () => (
        <ChatSidebar
          {...baseProps()}
          threads={[...chats, thread({ id: 'r', title: 'Running one' })]}
          onDeleteThreads={vi.fn(async () => {})}
        />
      ),
      stubRegistry({ runState: (id) => (id === 'r' ? busy : idle) }),
    )
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
    const { container } = mount(() => (
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
    const { container } = mount(
      () => (
        <ChatSidebar
          {...baseProps()}
          threads={[chats[0]]}
          onDeleteThreads={vi.fn(async () => {})}
        />
      ),
      stubRegistry({ runState: () => (running() ? busy : idle) }),
    )
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
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(() => (
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
    const { container } = mount(
      () => (
        <ChatSidebar
          {...baseProps()}
          threads={[thread({ id: 'r', title: 'Running one' })]}
          onDeleteThreads={vi.fn(async () => {})}
        />
      ),
      stubRegistry({ runState: () => busy }),
    )
    enterSelectMode(container)
    await tick()

    expect(checkboxes(container)[0].getAttribute('aria-disabled')).toBe('true')
    rows(container)[0].click()
    await tick()
    expect(checkboxes(container)[0].getAttribute('aria-checked')).toBe('false')
  })
})

/**
 * Pinning.
 *
 * The ordering itself is the server's — `listConversations` returns pinned
 * rows first — so what is asserted here is everything the sidebar is actually
 * responsible for: the control's pressed state, that a pinned row is legible
 * WITHOUT hover, the refusal hint, and that a change asks the route to refetch
 * rather than re-sorting a second copy of the ordering rule.
 */
describe('ChatSidebar — pinning', () => {
  const pinButtons = (root: HTMLElement) => [
    ...root.querySelectorAll<HTMLButtonElement>('button[data-testid="pin-toggle"]'),
  ]
  const pinned = thread({ id: 'p', title: 'Kept thread', pinnedAt: '2026-08-27T09:00:00Z' })

  it('offers one pin toggle per row, unpressed by default', () => {
    const { container } = mount(() => <ChatSidebar {...baseProps()} />)
    const pins = pinButtons(container)
    expect(pins).toHaveLength(chats.length)
    expect(pins.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    expect(pins[0].getAttribute('aria-label')).toBe('Pin conversation to top')
  })

  it('pins a row and asks the route to refetch the reordered list', async () => {
    const onPinChanged = vi.fn()
    const { container } = mount(() => <ChatSidebar {...baseProps()} onPinChanged={onPinChanged} />)
    pinButtons(container)[1].click()
    await tick()
    expect(setConversationPinned).toHaveBeenCalledWith('b', true)
    expect(onPinChanged).toHaveBeenCalledTimes(1)
  })

  it('marks a pinned row pressed, and shows its state without hover', () => {
    const { container } = mount(() => <ChatSidebar {...baseProps()} threads={[pinned, ...chats]} />)
    const pin = pinButtons(container)[0]
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    expect(pin.getAttribute('aria-label')).toBe('Unpin conversation')
    // The unpinned rows reveal on hover; the pinned one is opaque on its own,
    // which is what makes the state readable rather than discoverable.
    expect(pin.getAttribute('op')).toBe('100')
    expect(pinButtons(container)[1].getAttribute('op')).toContain('group-hover:100')
    // ...and it reveals on keyboard focus as well, which is the half
    // `A11Y-CHECKLIST.md`'s `hover-vs-tap` row demands by name for this file:
    // `op="0"` alone hides a hover-only control from a tabbing user entirely.
    // Attribute, not resolved opacity — the `[op~="focus:100"]:focus` rule is
    // in the built sheet, and what jsdom can pin is that the component still
    // asks for it. Deleting `focus:100` from the `op` list turns this red.
    expect(pinButtons(container)[1].getAttribute('op')).toContain('focus:100')
    // Filled glyph for pinned, outline for the rest.
    expect(pin.querySelector('.i-material-symbols-keep')).not.toBeNull()
    expect(
      pinButtons(container)[1].querySelector('.i-material-symbols-keep-outline'),
    ).not.toBeNull()
  })

  it('unpins a pinned row', async () => {
    setConversationPinned.mockResolvedValueOnce({ outcome: 'unpinned', limit: 3 })
    const onPinChanged = vi.fn()
    const { container } = mount(() => (
      <ChatSidebar {...baseProps()} threads={[pinned, ...chats]} onPinChanged={onPinChanged} />
    ))
    pinButtons(container)[0].click()
    await tick()
    expect(setConversationPinned).toHaveBeenCalledWith('p', false)
    expect(onPinChanged).toHaveBeenCalledTimes(1)
  })

  it('shows the cap hint instead of refetching when the server refuses', async () => {
    setConversationPinned.mockResolvedValueOnce({ outcome: 'cap_reached', limit: 3 })
    const onPinChanged = vi.fn()
    const { container } = mount(() => <ChatSidebar {...baseProps()} onPinChanged={onPinChanged} />)
    pinButtons(container)[0].click()
    await tick()
    const hint = container.querySelector<HTMLElement>('[data-testid="pin-hint"]')
    expect(hint?.textContent).toContain('Only 3 conversations can be pinned')
    expect(hint?.getAttribute('role')).toBe('status')
    // Nothing moved, so nothing to refetch — and the control is still offered
    // rather than disabled, so the user can pin after unpinning something.
    expect(onPinChanged).not.toHaveBeenCalled()
    expect(pinButtons(container)[0].disabled).toBe(false)
  })

  it('surfaces a failed pin instead of leaving a dead button', async () => {
    setConversationPinned.mockRejectedValueOnce(new Error('offline'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = mount(() => <ChatSidebar {...baseProps()} />)
    pinButtons(container)[0].click()
    await tick()
    expect(container.querySelector('[data-testid="pin-hint"]')?.textContent).toContain(
      'Could not update the pin',
    )
    spy.mockRestore()
  })

  it('ignores a second click while the first is in flight, at both gates', async () => {
    let release: (v: PinResult) => void = () => {}
    setConversationPinned.mockReturnValueOnce(new Promise<PinResult>((r) => (release = r)))
    const { container } = mount(() => <ChatSidebar {...baseProps()} />)
    pinButtons(container)[0].click()
    await tick()

    // Gate 1 — the DOM one. `disabled` is what actually stops a second click
    // here, and it is the ONLY gate a jsdom click can reach: neither
    // `HTMLElement.click()` nor Solid's delegated dispatch runs a handler on a
    // disabled node, so a click through this path never enters the component.
    expect(pinButtons(container)[0].disabled).toBe(true)
    pinButtons(container)[0].click()
    expect(setConversationPinned).toHaveBeenCalledTimes(1)

    // Gate 2 — `handleTogglePin`'s own early return, which gate 1 hides. It is
    // not redundant in a real browser: a click dispatched before the reactive
    // `disabled` update lands still arrives at the handler. jsdom cannot
    // produce that race, so the attribute is cleared by hand to put the second
    // click exactly where the browser would put it — past the DOM gate and
    // into the handler. Deleting `if (pinPending().has(thread.id)) return`
    // turns this assertion red.
    const raced = pinButtons(container)[0]
    raced.disabled = false
    raced.click()
    await tick()
    expect(setConversationPinned).toHaveBeenCalledTimes(1)

    release({ outcome: 'pinned', limit: 3 })
    await tick()
    pinButtons(container)[0].click()
    await tick()
    expect(setConversationPinned).toHaveBeenCalledTimes(2)
  })

  it('offers no pin on a placeholder row', () => {
    const { container } = mount(() => (
      <ChatSidebar {...baseProps()} threads={[thread({ id: 'new', isPlaceholder: true })]} />
    ))
    expect(pinButtons(container)).toHaveLength(0)
  })

  it('keeps the pin offered while a run is in flight, unlike delete', () => {
    const { container } = mount(
      () => <ChatSidebar {...baseProps()} threads={[chats[0]]} />,
      stubRegistry({ runState: () => busy }),
    )
    expect(pinButtons(container)).toHaveLength(1)
    expect(container.querySelectorAll('span[title="Delete conversation"]')).toHaveLength(0)
  })
})
