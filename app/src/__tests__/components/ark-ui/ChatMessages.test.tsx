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
import { fireEvent, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { ChatMessages, type Message } from '~/components/ark-ui/ChatMessages'
import type { RetrievalReference } from '@hames-ai/harness-patterns'
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
    expect(plain.container.querySelector('.i-material-symbols-lightbulb-outline')).toBeNull()
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

  it('renders the tool call outside the assistant bubble', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[msg({ id: 'm1', role: 'assistant', content: 'May I write?', toolCall })]}
      />
    ))
    // The tool row is a sibling of the bubble, not nested inside it.
    const bubble = container.querySelector<HTMLElement>('[data-role="assistant"]')!
    const trigger = container.querySelector<HTMLElement>('[data-part="trigger"]')!
    expect(bubble.contains(trigger)).toBe(false)
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

describe('ChatMessages — link review (#901 slice 2)', () => {
  const linkMessage = (over: Partial<Message> = {}): Message =>
    msg({ role: 'assistant', content: 'See [the docs](https://external.example/guide).', ...over })

  /** The dialog is not open. */
  const noDialog = () =>
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeNull()

  // MUTATION: drop the intercept branch from handleClick → the click
  // navigates and no dialog opens → red.
  it('opens the review dialog instead of navigating when an unverified link is clicked', async () => {
    const { container } = render(() => <ChatMessages messages={[linkMessage()]} />)
    noDialog()
    const anchor = container.querySelector<HTMLAnchorElement>('a[data-link-review="unverified"]')!
    expect(anchor).toBeTruthy()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    await tick()
    // Navigation is intercepted, the dialog opens on the RESOLVED address, and
    // nothing was decided: the anchor is still there, still live.
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="link-review-address"]')!.textContent).toBe(
      'https://external.example/guide',
    )
    expect(container.querySelector('a[data-link-review="unverified"]')).toBe(anchor)
    // The dialog closes without deciding, and the link is untouched.
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-cancel"]')!,
    )
    await tick()
    noDialog()
    expect(container.querySelector('a[data-link-review="unverified"]')).toBe(anchor)
  })

  // MUTATION: drop the `on:auxclick` handler → a middle-click navigates with
  // no review → red (approved Q8: auxiliary activation is intercepted where
  // the platform permits).
  it('intercepts auxiliary (middle-button) activation too', async () => {
    const { container } = render(() => <ChatMessages messages={[linkMessage()]} />)
    const anchor = container.querySelector('a[data-link-review="unverified"]')!
    const event = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    await tick()
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeTruthy()
  })

  // MUTATION: make the defang persistent (store the raw; strip matching
  // anchors when a message re-renders) → the link stays inert after a
  // re-render derived from message.content → red. Ruling Q5: the defang is
  // the CURRENT rendering only.
  it('"Cancel and defang" makes the chosen link inert text — and a re-render derived from message.content presents it again', async () => {
    const [messages, setMessages] = createSignal<Message[]>([linkMessage()])
    const { container } = render(() => <ChatMessages messages={messages()} />)
    const anchor = container.querySelector('a[data-link-review="unverified"]')!
    fireEvent.click(anchor)
    await tick()
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-defang"]')!,
    )
    await tick()
    // The chosen link became inert text: no anchor left in this rendering, its
    // words kept, the dialog closed.
    expect(container.querySelector('a[data-link-review]')).toBeNull()
    expect(container.textContent).toContain('the docs')
    noDialog()
    // ...and the next rendering derived from message.content presents the link
    // again: nothing was stored, so a streaming update or a reload shows the
    // link as it was rendered.
    setMessages([linkMessage()])
    await tick()
    expect(container.querySelector('a[data-link-review="unverified"]')).toBeTruthy()
  })

  // The defang keys on `data-link-raw`: every anchor in the CHOSEN message
  // carrying that raw spelling goes inert together.
  it('defangs every anchor with the chosen link’s raw spelling in the same message', async () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          linkMessage({
            content:
              'See [one](https://external.example/guide) and [two](https://external.example/guide).',
          }),
        ]}
      />
    ))
    const anchors = container.querySelectorAll('a[data-link-review="unverified"]')
    expect(anchors.length).toBe(2)
    fireEvent.click(anchors[0])
    await tick()
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-defang"]')!,
    )
    await tick()
    expect(container.querySelector('a[data-link-review]')).toBeNull()
    expect(container.textContent).toContain('one')
    expect(container.textContent).toContain('two')
  })

  // MUTATION: scope the defang to the whole transcript (drop the
  // `.prose-chat` container) → the same address in another message is defanged
  // too → red. "Only the chosen link in this message" (the merged design).
  it('defangs only the chosen link in its own message, not the same address elsewhere', async () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          linkMessage(),
          linkMessage({ content: 'Also [see this](https://external.example/guide) here.' }),
        ]}
      />
    ))
    const anchors = container.querySelectorAll('a[data-link-review="unverified"]')
    expect(anchors.length).toBe(2)
    fireEvent.click(anchors[1])
    await tick()
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-defang"]')!,
    )
    await tick()
    // The second message's link is inert; the first message's link is untouched.
    expect(anchors[0].isConnected).toBe(true)
    expect(anchors[0].getAttribute('data-link-raw')).toBe('https://external.example/guide')
    expect(container.querySelectorAll('a[data-link-review="unverified"]').length).toBe(1)
  })

  // Slice 1's fail-closed stamps only what it cannot prove recognised; the
  // recognised link navigates as before — no dialog, no interception.
  it('leaves a recognised link to navigate normally', async () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          linkMessage({
            content: 'See [docs](https://docs.example/guide).',
            recognisedLinkHosts: ['docs.example'],
          }),
        ]}
      />
    ))
    expect(container.querySelector('a[data-link-review]')).toBeNull()
    const plain = container.querySelector<HTMLAnchorElement>('a[href]')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    plain.dispatchEvent(event)
    await tick()
    expect(event.defaultPrevented).toBe(false)
    noDialog()
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
