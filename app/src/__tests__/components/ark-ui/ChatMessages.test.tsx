/**
 * ChatMessages — the rendered transcript.
 *
 * `renderAssistantMarkdown` (the markdown → sanitize → annotate pipeline) is
 * covered separately in chat-markdown.test.ts; this file is about what the
 * *component* puts on screen: which bubble shape each role gets, the
 * `<think>` split, the retriever Sources footer, the tool-call slot, and the
 * event-delegated entity/citation interactions that turn a rendered span back
 * into a callback.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { ChatMessages, type Message } from '~/components/ark-ui/ChatMessages'
import type { RetrievalReference } from '~/lib/harness-patterns'
import { installDomObservers } from '../../mocks/dom-observers'

beforeAll(() => {
  installDomObservers()
  // The auto-scroll sentinel calls it; jsdom implements no scrolling.
  Element.prototype.scrollIntoView = vi.fn()
})

const tick = () => new Promise((r) => setTimeout(r, 20))

const msg = (over: Partial<Message> & Pick<Message, 'role' | 'content'>): Message => ({
  id: over.id ?? `m-${over.role}-${over.content.slice(0, 8)}`,
  timestamp: new Date('2026-05-10T09:30:00Z'),
  ...over,
})

const reference = (source: string, docId: string): RetrievalReference => ({
  source,
  docId,
  chunkIndex: 0,
  startOffset: 0,
  endOffset: 10,
})

/** The bubble wrapper carries `data-role` — the role-specific styling anchor. */
const bubbles = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-role]')]

describe('ChatMessages — transcript shape', () => {
  it('shows the empty state when there are no messages, and drops it once one lands', async () => {
    const [messages, setMessages] = createSignal<Message[]>([])
    const { container } = render(() => <ChatMessages messages={messages()} />)

    expect(container.textContent).toContain('Start a conversation')

    setMessages([msg({ role: 'user', content: 'hi' })])
    await tick()

    expect(container.textContent).not.toContain('Start a conversation')
    expect(container.textContent).toContain('hi')
  })

  it('tags every bubble with its role so user turns can flip side', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({ role: 'user', content: 'question' }),
          msg({ role: 'assistant', content: 'answer' }),
        ]}
      />
    ))
    expect(bubbles(container).map((b) => b.dataset.role)).toEqual(['user', 'assistant'])
    // The user turn is the reversed row; the assistant turn is not.
    expect(bubbles(container)[0].className).toContain('flex-row-reverse')
    expect(bubbles(container)[1].className).not.toContain('flex-row-reverse')
  })

  it('initials the avatar by role — U for the user, ! for problems, AI otherwise', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({ role: 'user', content: 'u' }),
          msg({ role: 'assistant', content: 'a' }),
          msg({ role: 'error', content: 'e' }),
          msg({ role: 'warning', content: 'w' }),
          msg({ role: 'system', content: 's' }),
        ]}
      />
    ))
    const initials = bubbles(container).map((b) => b.firstElementChild!.textContent)
    expect(initials).toEqual(['U', 'AI', '!', '!', 'AI'])
  })

  it('renders a plain-text bubble for user and system turns, not markdown', () => {
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'user', content: '**not bold**' })]} />
    ))
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toContain('**not bold**')
  })

  it('renders assistant markdown as HTML', () => {
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'assistant', content: '**bold**' })]} />
    ))
    expect(container.querySelector('strong')?.textContent).toBe('bold')
  })

  it('stamps each bubble with its local time', () => {
    const at = new Date('2026-05-10T09:30:00Z')
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'user', content: 'x', timestamp: at })]} />
    ))
    const expected = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(container.textContent).toContain(expected)
  })
})

// SA-L10: the <think> extraction is gone. It was a local-GLM leftover; the
// Anthropic chains this app routes through never expose a reasoning trace, so
// the only strings that pattern could still match were answers that genuinely
// begin with those characters — which it silently hid.
describe('ChatMessages — no think-block extraction', () => {
  it('renders an answer that opens with a think tag in full, with no affordance', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({
            role: 'assistant',
            content: '<think>weighing the options</think>The answer is 42.',
          }),
        ]}
      />
    ))
    expect(container.querySelector('.think-root')).toBeNull()
    expect(container.querySelector('.think-preview')).toBeNull()
    const body = container.querySelector('.prose-chat')!
    expect(body.textContent).toContain('The answer is 42.')
    // Nothing was peeled off and thrown behind a collapsible.
    expect(container.textContent).toContain('weighing the options')
  })

  it('renders no think affordance for an ordinary answer', () => {
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'assistant', content: 'Just the answer.' })]} />
    ))
    expect(container.querySelector('.think-root')).toBeNull()
    expect(container.textContent).toContain('Just the answer.')
  })

  it('leaves a non-leading think tag in the answer body', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[msg({ role: 'assistant', content: 'Note: <think>x</think> is a tag.' })]}
      />
    ))
    expect(container.querySelector('.think-root')).toBeNull()
    expect(container.textContent).toContain('is a tag.')
  })
})

describe('ChatMessages — error and warning bubbles', () => {
  it('titles an error bubble and attributes it to its pattern and turn', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({
            role: 'error',
            content: 'Server error: 500',
            patternId: 'neo4j-query',
            turnInfo: '(turn 3, attempt 2)',
          }),
        ]}
      />
    ))
    expect(container.textContent).toContain('Error in neo4j-query (turn 3, attempt 2)')
    expect(container.textContent).toContain('Server error: 500')
  })

  it('titles a warning bubble as a warning', () => {
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'warning', content: 'result truncated' })]} />
    ))
    expect(container.textContent).toContain('Warning')
    expect(container.textContent).not.toContain('Error')
  })

  it('shows the recovery hint only when the message carries one', () => {
    const withHint = render(() => (
      <ChatMessages
        messages={[msg({ role: 'error', content: 'boom', hint: 'Check the gateway is up.' })]}
      />
    ))
    expect(withHint.container.textContent).toContain('Check the gateway is up.')
    withHint.unmount()

    const plain = render(() => (
      <ChatMessages messages={[msg({ role: 'error', content: 'boom' })]} />
    ))
    expect(plain.container.querySelector('.i-mdi-lightbulb-outline')).toBeNull()
  })

  it('omits the pattern attribution when the error has no pattern', () => {
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'error', content: 'boom' })]} />
    ))
    expect(container.textContent).toContain('Error')
    expect(container.textContent).not.toContain('Error in')
  })
})

describe('ChatMessages — tool calls', () => {
  const toolCall = {
    type: 'neo4j' as const,
    status: 'pending' as const,
    tool: 'write_neo4j_cypher',
  }

  it('renders the tool call outside the assistant bubble and wires approve/reject', async () => {
    const onApproveWrite = vi.fn()
    const onRejectWrite = vi.fn()
    const { container } = render(() => (
      <ChatMessages
        messages={[msg({ id: 'm1', role: 'assistant', content: 'May I write?', toolCall })]}
        onApproveWrite={onApproveWrite}
        onRejectWrite={onRejectWrite}
      />
    ))

    // The tool row is a sibling of the bubble, not nested inside it.
    const bubble = container.querySelector<HTMLElement>('[data-role="assistant"]')!
    const trigger = container.querySelector<HTMLElement>('[data-part="trigger"]')!
    expect(bubble.contains(trigger)).toBe(false)

    trigger.click()
    await tick()
    const approve = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Approve'),
    )!
    approve.click()

    // The message id is what the interface needs to patch the right bubble.
    expect(onApproveWrite).toHaveBeenCalledWith('m1')
    expect(onRejectWrite).not.toHaveBeenCalled()
  })

  // A tool call attached to a user turn is not the agent asking permission —
  // rendering an Approve button there would be a spoofable prompt.
  it('never renders a tool call attached to a non-assistant message', () => {
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'user', content: 'do it', toolCall })]} />
    ))
    expect(container.querySelector('[data-part="trigger"]')).toBeNull()
  })
})

describe('ChatMessages — retriever citations', () => {
  const refs = [
    reference('report.pdf', 'doc-1'),
    reference('report.pdf', 'doc-1'), // same doc, second chunk
    reference('notes.md', 'doc-2'),
  ]

  it('lists one Sources chip per cited document, not per chunk', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[msg({ role: 'assistant', content: 'See the files.', references: refs })]}
      />
    ))
    const chips = [...container.querySelectorAll('.doc-ref-chip')]
    expect(chips.map((c) => c.textContent)).toEqual(['report.pdf', 'notes.md'])
  })

  it('renders no Sources footer for an uncited answer', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[msg({ role: 'assistant', content: 'From memory.', references: [] })]}
      />
    ))
    expect(container.querySelector('.doc-ref-footer')).toBeNull()
  })

  it('opens the cited document when its footer chip is clicked', () => {
    const onOpenReference = vi.fn()
    const { container } = render(() => (
      <ChatMessages
        messages={[msg({ role: 'assistant', content: 'See the files.', references: refs })]}
        onOpenReference={onOpenReference}
      />
    ))
    container.querySelectorAll<HTMLElement>('.doc-ref-chip')[1].click()
    expect(onOpenReference).toHaveBeenCalledWith({ docId: 'doc-2' })
    expect(onOpenReference).toHaveBeenCalledTimes(1)
  })

  it('opens the document when an inline filename citation is clicked', () => {
    const onOpenReference = vi.fn()
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({
            role: 'assistant',
            content: 'The figure in report.pdf shows the trend.',
            references: [reference('report.pdf', 'doc-1')],
          }),
        ]}
        onOpenReference={onOpenReference}
      />
    ))
    const inline = container.querySelector<HTMLElement>('.doc-ref')!
    expect(inline.textContent).toContain('report.pdf')
    inline.click()
    expect(onOpenReference).toHaveBeenCalledWith({ docId: 'doc-1' })
  })

  // SA-M10. A model that writes citation markup into its answer must not get a
  // working citation out of it: the sanitizer strips `class` and `data-*`, and
  // only the annotators — running on typed reference data afterwards — put them
  // back. Nothing here is escaped away, so the prose still reads normally.
  it('ignores citation markup written by the model itself', () => {
    const onOpenReference = vi.fn()
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({
            role: 'assistant',
            content:
              'Confirmed in <span class="doc-ref" data-doc-id="attacker-doc">payroll.xlsx</span>.',
            references: [],
          }),
        ]}
        onOpenReference={onOpenReference}
      />
    ))
    expect(container.querySelector('.doc-ref')).toBeNull()
    expect(container.querySelector('[data-doc-id]')).toBeNull()
    expect(container.textContent).toContain('payroll.xlsx')

    // Nothing clickable was produced, so nothing can open.
    container.querySelector<HTMLElement>('.prose-chat')!.click()
    expect(onOpenReference).not.toHaveBeenCalled()
  })

  it('still annotates a genuine citation for the same filename', () => {
    const onOpenReference = vi.fn()
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({
            role: 'assistant',
            content:
              'Confirmed in <span class="doc-ref" data-doc-id="attacker-doc">payroll.xlsx</span>.',
            references: [reference('payroll.xlsx', 'doc-real')],
          }),
        ]}
        onOpenReference={onOpenReference}
      />
    ))
    const inline = container.querySelector<HTMLElement>('.doc-ref')!
    inline.click()
    // The annotator's docId, never the one the model wrote.
    expect(onOpenReference).toHaveBeenCalledWith({ docId: 'doc-real' })
  })
})

describe('ChatMessages — graph entity interaction', () => {
  const graphEntityNames = new Map([
    ['Ada Lovelace', ['n1', 'n2']],
    ['Babbage', ['n3']],
  ])

  const renderWithEntities = (onHighlightEntities?: (ids: string[]) => void) =>
    render(() => (
      <ChatMessages
        messages={[msg({ role: 'assistant', content: 'Ada Lovelace worked with Babbage.' })]}
        graphEntityNames={graphEntityNames}
        onHighlightEntities={onHighlightEntities}
      />
    ))

  const entity = (root: HTMLElement, name: string) =>
    root.querySelector<HTMLElement>(`.graph-entity[data-entity-name="${name}"]`)!

  it("highlights an entity's graph ids on hover and clears them on exit", () => {
    const onHighlight = vi.fn()
    const { container, unmount } = renderWithEntities(onHighlight)

    entity(container, 'Ada Lovelace').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(onHighlight).toHaveBeenLastCalledWith(['n1', 'n2'])

    entity(container, 'Ada Lovelace').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    expect(onHighlight).toHaveBeenLastCalledWith([])

    unmount()
  })

  it('pins an entity on click so the highlight survives mouse-out', () => {
    const onHighlight = vi.fn()
    const { container, unmount } = renderWithEntities(onHighlight)
    const ada = entity(container, 'Ada Lovelace')

    ada.click()
    expect(ada.classList.contains('toggled')).toBe(true)
    expect(onHighlight).toHaveBeenLastCalledWith(['n1', 'n2'])

    // Hovering a *different* entity now shows both, not just the hovered one.
    entity(container, 'Babbage').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(onHighlight).toHaveBeenLastCalledWith(['n3', 'n1', 'n2'])

    // Mouse-out falls back to the pinned set rather than clearing.
    entity(container, 'Babbage').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    expect(onHighlight).toHaveBeenLastCalledWith(['n1', 'n2'])

    // Click again to unpin — leaves module state clean for the next test.
    ada.click()
    expect(ada.classList.contains('toggled')).toBe(false)
    expect(onHighlight).toHaveBeenLastCalledWith([])

    unmount()
  })

  it('ignores clicks and hovers that land outside an entity span', () => {
    const onHighlight = vi.fn()
    const { container, unmount } = renderWithEntities(onHighlight)

    const plain = container.querySelector<HTMLElement>('.prose-chat')!
    plain.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    plain.click()

    expect(onHighlight).not.toHaveBeenCalled()
    unmount()
  })

  it('renders and interacts without an onHighlightEntities handler', () => {
    const { container, unmount } = renderWithEntities(undefined)
    const ada = entity(container, 'Ada Lovelace')
    expect(() => {
      ada.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      ada.click()
      ada.click()
    }).not.toThrow()
    unmount()
  })
})

describe('ChatMessages — trailing slot', () => {
  it('renders the trailing slot after the last message', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[msg({ role: 'user', content: 'hi' })]}
        trailing={() => <div data-testid="progress">bar</div>}
      />
    ))
    const slot = container.querySelector('[data-testid="progress"]')!
    const bubble = container.querySelector('[data-role="user"]')!
    // Slot follows the transcript in document order.
    expect(bubble.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders nothing extra when no trailing slot is supplied', () => {
    const { container } = render(() => (
      <ChatMessages messages={[msg({ role: 'user', content: 'hi' })]} />
    ))
    expect(container.querySelector('[data-testid="progress"]')).toBeNull()
  })
})

describe('ChatMessages — auto-scroll', () => {
  // The scroll is deferred by 50ms so the new bubble has laid out first —
  // settle past that (and past any timer left by an earlier mount) before
  // reading the spy.
  const settle = () => new Promise((r) => setTimeout(r, 120))

  it('scrolls to the bottom when a new message arrives, but not on a content edit', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const first = msg({ id: 'a', role: 'user', content: 'hi' })
    const [messages, setMessages] = createSignal<Message[]>([first])
    const { unmount } = render(() => <ChatMessages messages={messages()} />)
    await settle()
    scrollIntoView.mockClear()

    // Streaming edit of the same message — count unchanged, no scroll: the
    // user must not be yanked to the bottom while reading back an answer
    // that is still being appended to.
    setMessages([{ ...first, content: 'hi there' }])
    await settle()
    expect(scrollIntoView).not.toHaveBeenCalled()

    // A genuinely new message does scroll.
    setMessages((prev) => [...prev, msg({ id: 'b', role: 'assistant', content: 'hello' })])
    await settle()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' })

    unmount()
  })
})
