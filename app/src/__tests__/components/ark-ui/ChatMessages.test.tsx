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
import {
  DEFAULT_LINK_REVIEW_REASON,
  IMAGE_LINK_REVIEW_REASON,
} from '~/components/ark-ui/HitlDialog'
import { createLinkAcceptanceStore } from '~/lib/link-acceptance'
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

  // SUPERSEDED PIN, re-pinned per the owner's ruling: slice 2 pinned "a
  // re-render presents the link again" (the defang rendering-only, ruling Q5
  // of the 2026-11-03 page). The owner's answers OVERRIDE that recommendation
  // (issue #901 comment 6618793027, 2026-11-04): the action is "Cancel and
  // mark unsafe" and the MARK is persisted, not rendering-only — "No session
  // state beyond the persisted mark". This pin now asserts the ruled
  // behaviour: a re-render derived from message.content keeps the marked link
  // inert, because the store re-derives the defang for every marked raw
  // spelling. The mark is client-side signal state — a fresh store (a
  // reload) starts empty, pinned in link-acceptance.test.ts and below.
  it('"Cancel and mark unsafe" makes the chosen link inert text — and a re-render derived from message.content keeps it inert', async () => {
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
    // ...and the next rendering derived from message.content keeps it inert:
    // the mark is persisted in the store, so the re-render re-derives the
    // defang — the link is not presented again, is not counted, and the
    // Accept-as-safe action has nothing to offer.
    setMessages([linkMessage()])
    await tick()
    expect(container.querySelector('a[data-link-review]')).toBeNull()
    expect(container.textContent).toContain('the docs')
    expect(container.querySelector('[data-testid="link-review-strip"]')).toBeNull()
  })

  // The mark's client-side lifetime, at the component level: the store dies
  // with its session, so a fresh ChatMessages instance — what a reload
  // creates — presents the marked link again.
  it('a fresh instance presents a marked link again (a reload starts empty)', async () => {
    const first = render(() => <ChatMessages messages={[linkMessage()]} />)
    const anchor = first.container.querySelector('a[data-link-review="unverified"]')!
    fireEvent.click(anchor)
    await tick()
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-defang"]')!,
    )
    await tick()
    expect(first.container.querySelector('a[data-link-review]')).toBeNull()

    first.unmount()
    const reloaded = render(() => <ChatMessages messages={[linkMessage()]} />)
    expect(reloaded.container.querySelector('a[data-link-review="unverified"]')).toBeTruthy()
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

describe('ChatMessages — the blocked-image placeholder’s open path (#901 override)', () => {
  // Owner ruling 2026-11-04 (issue #901 comment 6618793027): the user CAN open
  // images from trusted sources — the placeholder carries the link-review
  // dialog's open path for trusted-source images. The SAME dialog serves it;
  // nothing here adds images to the acceptance store (the ruling adds no
  // acceptance for images).

  /** An assistant answer whose only image is the trusted stash route, refused
   *  because its `download` param is missing. */
  const trustedImageMessage = (over: Partial<Message> = {}): Message =>
    msg({
      role: 'assistant',
      content: '![chart](/api/stash/document/abc?sessionId=s1)',
      ...over,
    })

  /** An assistant answer whose only image is refused and NOT trusted-shaped. */
  const attackerImageMessage = (): Message =>
    msg({ role: 'assistant', content: '![chart](https://attacker.example/p.png)' })

  const noDialog = () =>
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeNull()

  // MUTATION: drop the `interceptImageReview` call from handleClick → the
  // click opens nothing → red.
  it('opens the review dialog with the image’s resolved address when the placeholder is activated', async () => {
    const { container } = render(() => <ChatMessages messages={[trustedImageMessage()]} />)
    noDialog()
    const placeholder = container.querySelector<HTMLElement>(
      '.prose-chat .blocked-image[data-img-dest]',
    )!
    expect(placeholder).toBeTruthy()
    // The dest carries the `download` param set — the exact URL the
    // auto-load path would have allowed to load — so the reviewed open
    // retrieves the image file, not the route's JSON document record.
    expect(placeholder.getAttribute('data-img-dest')).toBe(
      `${window.location.origin}/api/stash/document/abc?sessionId=s1&download`,
    )

    placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="link-review-address"]')!.textContent).toBe(
      `${window.location.origin}/api/stash/document/abc?sessionId=s1&download`,
    )
    // The open action is the dialog's reviewed anchor, stamped exactly as the
    // sanitizer stamps every rendered link.
    const open = document.querySelector<HTMLAnchorElement>('[data-testid="link-review-open"]')!
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toBe('noopener noreferrer')

    // Dismiss decides nothing: the placeholder keeps its open path.
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-cancel"]')!,
    )
    await tick()
    noDialog()
    expect(container.querySelector('.blocked-image[data-img-dest]')).toBe(placeholder)
  })

  // The dialog is a consent mechanism and the merged design's copy rule is
  // that the reason is factual: every trusted image is own-origin by
  // construction, and own origin IS recognised in the link classification, so
  // the link default would state a falsehood about why the review exists.
  // MUTATION: drop the image `reason`/`target` pass-through in ChatMessages'
  // dialog mount → the link default reason and link title come back → red.
  it('an image review states the image reason and copy, never the link default', async () => {
    const { container } = render(() => <ChatMessages messages={[trustedImageMessage()]} />)
    const placeholder = container.querySelector<HTMLElement>('.blocked-image[data-img-dest]')!
    placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    const dialog = document.querySelector('[data-testid="link-review-dialog"]')!
    expect(dialog.textContent).toContain(IMAGE_LINK_REVIEW_REASON)
    expect(dialog.textContent).not.toContain(DEFAULT_LINK_REVIEW_REASON)
    expect(dialog.textContent).toContain('Review this image')
    expect(dialog.textContent).toContain('The complete address this image would open:')
  })

  // The link review keeps its own copy: the image branch rides props on the
  // SAME body; it does not retitle the body for every caller.
  it('a link review keeps the link copy and the default reason', async () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({ role: 'assistant', content: 'See [the docs](https://external.example/guide).' }),
        ]}
      />
    ))
    const anchor = container.querySelector<HTMLAnchorElement>('a[data-link-review="unverified"]')!
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    const dialog = document.querySelector('[data-testid="link-review-dialog"]')!
    expect(dialog.textContent).toContain(DEFAULT_LINK_REVIEW_REASON)
    expect(dialog.textContent).not.toContain(IMAGE_LINK_REVIEW_REASON)
    expect(dialog.textContent).toContain('Review this link')
  })

  // The nested case: a trusted-shape placeholder inside an unverified anchor.
  // The intercept ORDER (link before image, in handleClick) is load-bearing
  // and this pin is what protects it — swapping the order left both suites
  // green at the review, silently moving nested-placeholder clicks to the
  // image review. The click/keyboard split is principled, and the pin pins
  // BOTH halves: the CLICK gates the anchor (that click would navigate it),
  // while KEYBOARD activates the placeholder's own affordance (Enter on a
  // nested focusable does not activate the anchor around it).
  // MUTATION: swap the intercept order (image branch before link) in
  // handleClick → the click below opens the image review instead → red.
  it('a placeholder nested in an unverified anchor: click reviews the anchor, keyboard the image', async () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({
            role: 'assistant',
            content:
              '[![chart](/api/stash/document/abc?sessionId=s1)](https://external.example/page)',
          }),
        ]}
      />
    ))
    const placeholder = container.querySelector<HTMLElement>('.blocked-image[data-img-dest]')!
    expect(placeholder).toBeTruthy()
    expect(placeholder.closest('a[data-link-review="unverified"]')).toBeTruthy()

    placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    expect(document.querySelector('[data-testid="link-review-address"]')!.textContent).toBe(
      'https://external.example/page',
    )
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-cancel"]')!,
    )
    await tick()
    noDialog()

    placeholder.focus()
    fireEvent.keyDown(placeholder, { key: 'Enter' })
    await tick()
    expect(document.querySelector('[data-testid="link-review-address"]')!.textContent).toBe(
      `${window.location.origin}/api/stash/document/abc?sessionId=s1&download`,
    )
  })

  // MUTATION: widen `isTrustedImageSource` in the sanitizer to "own origin at
  // large" → the attacker placeholder is stamped here too → red.
  it('a non-trusted-source placeholder stays inert — activating it opens nothing', async () => {
    const { container } = render(() => <ChatMessages messages={[attackerImageMessage()]} />)
    const placeholder = container.querySelector('.blocked-image')!
    expect(placeholder).toBeTruthy()
    expect(placeholder.hasAttribute('data-img-dest')).toBe(false)

    placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    noDialog()
  })

  it('keyboard activation (Enter) opens the dialog exactly as the click does', async () => {
    const { container } = render(() => <ChatMessages messages={[trustedImageMessage()]} />)
    const placeholder = container.querySelector<HTMLElement>('.blocked-image[data-img-dest]')!
    placeholder.focus()
    fireEvent.keyDown(placeholder, { key: 'Enter' })
    await tick()
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeTruthy()
  })

  // The ruling adds no acceptance for images, so unlike the link defang
  // (ruling Q5: a PERSISTED mark) the image defang is current-rendering-only:
  // a re-render derived from message.content presents the placeholder again.
  it('"Cancel and mark unsafe" removes the open path from this rendering — and a re-render presents it again', async () => {
    const [messages, setMessages] = createSignal<Message[]>([trustedImageMessage()])
    const { container } = render(() => <ChatMessages messages={messages()} />)
    const placeholder = container.querySelector<HTMLElement>('.blocked-image[data-img-dest]')!
    placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-defang"]')!,
    )
    await tick()
    noDialog()
    // Inert again: no affordance left in THIS rendering, text kept.
    expect(container.querySelector('.blocked-image[data-img-dest]')).toBeNull()
    expect(container.querySelector('.blocked-image')!.hasAttribute('role')).toBe(false)
    expect(container.textContent).toContain('Image blocked:')

    setMessages([trustedImageMessage()])
    await tick()
    expect(container.querySelector('.blocked-image[data-img-dest]')).toBeTruthy()
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

describe('ChatMessages — link acceptance (#901 slice 3)', () => {
  const GUIDE = 'https://external.example/guide'
  const OTHER = 'https://external.example/other'

  const linkMsg = (over: Partial<Message> = {}): Message =>
    msg({
      id: over.id ?? 'm-accept',
      role: 'assistant',
      content: 'See [the docs](https://external.example/guide).',
      ...over,
    })

  const twoLinks = (over: Partial<Message> = {}): Message =>
    msg({
      id: over.id ?? 'm-two',
      role: 'assistant',
      content:
        'See [first](https://external.example/guide) and [second](https://external.example/other).',
      ...over,
    })

  const indicator = (root: HTMLElement) =>
    root.querySelector('[data-testid="links-unverified-indicator"]')
  const trigger = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>('[data-testid="accept-as-safe-trigger"]')
  const items = () => [...document.querySelectorAll('[data-testid="accept-as-safe-item"]')]

  /** Open the Accept-as-safe menu and return the offered items. */
  const openList = async (root: HTMLElement) => {
    fireEvent.click(trigger(root)!)
    await tick()
    return items()
  }

  /** Click an unverified anchor through the delegated handler, freshly. */
  const clickAnchor = (root: HTMLElement, index: number) => {
    const anchors = root.querySelectorAll<HTMLAnchorElement>('a[data-link-review="unverified"]')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchors[index].dispatchEvent(event)
    return event
  }

  /** Select a menu item the way a POINTER does — press, then release —
   *  because zag's menu machine selects through its own ITEM_CLICK path,
   *  which needs the pointerdown's highlight; a bare click event does not
   *  select. (`onSelect` is what fires on both pointer and keyboard.) */
  const acceptItem = (item: Element) => {
    fireEvent.pointerDown(item, { pointerType: 'mouse' })
    fireEvent.click(item)
  }

  it('shows the indicator and the Accept-as-safe action beside an assistant message with unverified links', () => {
    const { container } = render(() => <ChatMessages messages={[linkMsg()]} />)
    // Explicit accessible name (a11y pin): the label and the visible words agree.
    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links unverified: 1')
    expect(indicator(container)!.textContent).toBe('Links unverified: 1')
    expect(trigger(container)!.textContent).toBe('Accept as safe')
  })

  it('shows neither for a message with no links, nor for one whose links are all recognised', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          msg({ role: 'assistant', content: 'Plain answer, no links.' }),
          msg({
            role: 'assistant',
            content: 'See [docs](https://docs.example/guide).',
            recognisedLinkHosts: ['docs.example'],
          }),
        ]}
      />
    ))
    expect(container.querySelector('[data-testid="link-review-strip"]')).toBeNull()
  })

  // MUTATION: widen the strip's derivation past stamped anchors — include the
  // image pass's `.blocked-image` placeholders, the "let blocked images be
  // acceptable too" implementation ruling Q3 rejected → the blocked image
  // below is counted → red. The image pass keeps the last word: a placeholder
  // is inert text, never a link, never counted.
  it('never counts a link the image pass already blocked', () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          // Its only external reference is an image: blocked, placeholder text.
          msg({
            id: 'm-img',
            role: 'assistant',
            content: 'Pic: ![pic](https://external.example/pic.png).',
          }),
          // A link WRAPPING a blocked image: the image is inert, the anchor
          // still navigates — so the link is counted, the placeholder is not.
          msg({
            id: 'm-wrap',
            role: 'assistant',
            content:
              'Wrap: [![pic](https://external.example/pic.png)](https://external.example/page).',
          }),
        ]}
      />
    ))
    expect(container.querySelector('.blocked-image')).toBeTruthy()
    const strips = container.querySelectorAll('[data-testid="link-review-strip"]')
    expect(strips.length).toBe(1)
    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links unverified: 1')
  })

  it('presents this message’s unverified links for explicit selection, and accepting one accepts exactly that one', async () => {
    const { container } = render(() => <ChatMessages messages={[twoLinks()]} />)
    const listed = await openList(container)
    // The item names the resolved address it accepts — explicit selection,
    // not an unnamed "accept all".
    expect(listed.map((el) => el.textContent)).toEqual([
      `Accept as safe: ${GUIDE}`,
      `Accept as safe: ${OTHER}`,
    ])
    acceptItem(listed[0])
    await tick()

    // Exactly the first link is accepted: its anchor navigates (no dialog)…
    const eventA = clickAnchor(container, 0)
    await tick()
    expect(eventA.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeNull()
    // …slice 1's stamps are untouched on it (the store decides, not the DOM)…
    const anchorA = container.querySelectorAll<HTMLAnchorElement>(
      'a[data-link-review="unverified"]',
    )[0]
    expect(anchorA.getAttribute('data-link-review')).toBe('unverified')
    expect(anchorA.getAttribute('data-link-dest')).toBe(GUIDE)
    // …while the second link on the same host still reviews.
    const eventB = clickAnchor(container, 1)
    await tick()
    expect(eventB.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeTruthy()
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-cancel"]')!,
    )
    await tick()
    // And the indicator counts what acceptance has not taken: one link.
    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links unverified: 1')
  })

  // MUTATION: drop the message id from the store's key → the same address in
  // another message reads accepted → red. Ruling Q2: one link in ONE message.
  it('accepting a link in one message never accepts the same address in another', async () => {
    const { container } = render(() => (
      <ChatMessages
        messages={[
          linkMsg({ id: 'm-one' }),
          linkMsg({ id: 'm-two', content: 'Also [docs](https://external.example/guide) here.' }),
        ]}
      />
    ))
    const first = await openList(container)
    acceptItem(first[0])
    await tick()

    // The first message's anchor navigates; the second message's same-address
    // anchor still reviews — and its own indicator still counts it.
    const event = clickAnchor(container, 1)
    await tick()
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeTruthy()
    const labels = [
      ...container.querySelectorAll('[data-testid="links-unverified-indicator"]'),
    ].map((el) => el.getAttribute('aria-label'))
    expect(labels).toEqual(['Links accepted', 'Links unverified: 1'])
  })

  it('keeps the indicator visible when every link is accepted, reading the accepted state', async () => {
    const { container } = render(() => <ChatMessages messages={[linkMsg()]} />)
    const listed = await openList(container)
    acceptItem(listed[0])
    await tick()

    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links accepted')
    // Nothing left to accept: the action is gone, the indicator is not.
    expect(trigger(container)).toBeNull()
    expect(container.querySelector('[data-testid="link-review-strip"]')).toBeTruthy()
  })

  it('announces the acceptance-state change through a polite live region', async () => {
    const { container } = render(() => <ChatMessages messages={[twoLinks()]} />)
    const announcer = container.querySelector('[data-testid="link-acceptance-announcer"]')!
    expect(announcer.getAttribute('aria-live')).toBe('polite')
    expect(announcer.textContent).toBe('')

    const listed = await openList(container)
    acceptItem(listed[0])
    await tick()
    expect(announcer.textContent).toContain(GUIDE)
    expect(announcer.textContent).toContain('1 unverified link still to review')

    const again = await openList(container)
    acceptItem(again[0])
    await tick()
    expect(announcer.textContent).toBe('All links in this message are accepted for this session.')
  })

  // The defang composes as-is (slice 2, ruling Q5): a defanged anchor is inert
  // text in this rendering — it leaves the count and the Accept-as-safe list,
  // and no acceptance may bring it back.
  it('drops a defanged link from the list, and an acceptance never resurrects it', async () => {
    const { container } = render(() => <ChatMessages messages={[twoLinks()]} />)
    const anchors = container.querySelectorAll<HTMLAnchorElement>(
      'a[data-link-review="unverified"]',
    )
    fireEvent.click(anchors[0])
    await tick()
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('[data-testid="link-review-defang"]')!,
    )
    await tick()

    // The defanged link is no longer a link: not counted, not offered.
    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links unverified: 1')
    const listed = await openList(container)
    expect(listed.map((el) => el.textContent)).toEqual([`Accept as safe: ${OTHER}`])

    acceptItem(listed[0])
    await tick()
    // The surviving link is accepted; the defanged one stayed inert text —
    // never keyboard-reachable again (no anchor to its address), its words
    // kept. The accepted link's anchor stays stamped: the store decides, the
    // DOM records nothing.
    const stampedAfter = [...container.querySelectorAll<HTMLAnchorElement>('a[data-link-review]')]
    expect(stampedAfter.map((a) => a.getAttribute('data-link-dest'))).toEqual([OTHER])
    expect(container.querySelector('a[href="https://external.example/guide"]')).toBeNull()
    expect(container.textContent).toContain('first')
    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links accepted')
  })

  it('an acceptance survives a re-render derived from message.content — the stamps are what re-render', async () => {
    const [messages, setMessages] = createSignal<Message[]>([linkMsg({ id: 'm-stream' })])
    const { container } = render(() => <ChatMessages messages={messages()} />)
    const listed = await openList(container)
    acceptItem(listed[0])
    await tick()

    // A streaming content update: a NEW message object, the same id.
    setMessages([
      linkMsg({
        id: 'm-stream',
        content: linkMsg().content + ' See [more](https://external.example/more).',
      }),
    ])
    await tick()

    // Both anchors re-rendered stamped (slice 1's stamps untouched)…
    const stamped = container.querySelectorAll<HTMLAnchorElement>(
      'a[data-link-review="unverified"]',
    )
    expect(stamped.length).toBe(2)
    // …and the store still decides: the accepted one navigates, the new one reviews.
    const eventAccepted = new MouseEvent('click', { bubbles: true, cancelable: true })
    stamped[0].dispatchEvent(eventAccepted)
    await tick()
    expect(eventAccepted.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeNull()
    const eventNew = new MouseEvent('click', { bubbles: true, cancelable: true })
    stamped[1].dispatchEvent(eventNew)
    await tick()
    expect(eventNew.defaultPrevented).toBe(true)
  })

  // MUST 1 (code review r1): acceptance rode Menu.Item's onClick — Ark's
  // keyboard path selects through the machine's SELECT EVENT, never a DOM
  // click fired by the user's handler — so a keyboard user's Enter accepted
  // nothing (the reviewer's run: focus → Enter → Enter left the indicator at
  // "Links unverified: 1"). `onSelect` is the both-path prop: zag invokes it
  // on pointer AND keyboard selection. The pin drives the menu open by
  // keyboard (Enter on the trigger) and selects the item through the event
  // zag's keyboard path dispatches — `menu:select`, dispatched on the item
  // element by the machine's invokeOnSelect and the only thing the item's
  // onSelect listens for. The full machine keyboard walk (highlight →
  // Enter → clickHighlightedItem) is unreachable in jsdom: zag builds its
  // item selector as an UNQUOTED escaped value (`[data-ownedby=menu\:…\:]`),
  // which jsdom's CSS engine never matches, so the machine highlights
  // nothing here and its Enter step no-ops — environment limitation, not a
  // claim about browsers. The mutant the pin guards: acceptance back on
  // onClick — the select event reaches nothing and the link still reviews.
  // The action's accessible name is asserted here too (it comes from the
  // visible text; pinned through the role query so an orphaned name goes
  // red — review r1's note).
  it('accepts through the keyboard path: Enter opens, the select event accepts, the anchor navigates without a dialog', async () => {
    const { container, getByRole } = render(() => <ChatMessages messages={[linkMsg()]} />)
    // The action's accessible name (review r1 note: it comes from the visible
    // text — pinned through the role query, so an orphaned name goes red).
    const triggerEl = getByRole('button', { name: 'Accept as safe' }) as HTMLButtonElement
    expect(triggerEl.dataset.testid).toBe('accept-as-safe-trigger')
    expect(triggerEl.textContent).toBe('Accept as safe')

    // Keyboard: Enter on the trigger opens the menu.
    triggerEl.focus()
    fireEvent.keyDown(triggerEl, { key: 'Enter' })
    await tick()
    const item = document.querySelector('[data-testid="accept-as-safe-item"]')!
    expect(item).toBeTruthy()
    // ...and the machine's keyboard selection dispatches `menu:select` on the
    // highlighted item — the both-path prop fires here, not on a DOM click.
    item.dispatchEvent(new CustomEvent('menu:select'))
    await tick()

    // The keyboard selection accepted the link: the anchor navigates with no
    // dialog, the indicator reads the accepted state.
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    container.querySelector('a[data-link-review="unverified"]')!.dispatchEvent(event)
    await tick()
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeNull()
    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links accepted')
  })

  // SHOULD 1 (code review r1): the acceptance check sits in front of the
  // fail-closed branch, so a regression that made the guard TRUST a missing
  // key would go green. Pin both missing-key shapes: the exact pair is
  // pre-accepted in the store, then each key is stripped from the live DOM —
  // an unkeyable link can never prove acceptance, so its navigation stays
  // prevented. MUTATION: a null-handling "fix" that reads a missing key as
  // accepted (`messageId === null || dest === null || isAccepted(...)`) →
  // both shapes navigate → red.
  it('stays fail-closed when the anchor or its container is missing an acceptance key', async () => {
    const store = createLinkAcceptanceStore()
    store.accept('m-accept', GUIDE)
    const { container } = render(() => (
      <ChatMessages messages={[linkMsg()]} linkAcceptance={store} />
    ))
    const anchor = container.querySelector('a[data-link-review="unverified"]')!
    const prose = container.querySelector('[data-message-id]')!

    // Shape 1: a stamped anchor missing `data-link-dest`. Not keyable, not
    // reviewable (the dialog needs the dest too): intercepted, no dialog.
    anchor.removeAttribute('data-link-dest')
    const noDest = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(noDest)
    await tick()
    expect(noDest.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeNull()

    // Shape 2: a prose container missing `data-message-id`, on a fully
    // stamped anchor (shape 1's stripped dest is put back). The acceptance
    // key is unkeyable, so the pre-accepted pair must NOT take: intercepted.
    // The review dialog still opens — it keys on raw/dest, which remain —
    // the honest form of "no acceptance" here: what the branch fails closed
    // on is the NAVIGATION, and the review path is slice 2's own.
    anchor.setAttribute('data-link-dest', GUIDE)
    prose.removeAttribute('data-message-id')
    const noId = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(noId)
    await tick()
    expect(noId.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeTruthy()
  })

  it('uses the passed session store rather than its own fallback', () => {
    const store = createLinkAcceptanceStore()
    store.accept('m-one', 'https://external.example/guide')
    const { container } = render(() => (
      <ChatMessages messages={[linkMsg({ id: 'm-one' })]} linkAcceptance={store} />
    ))
    // Pre-accepted on mount: the anchor navigates without a dialog, the strip
    // reads the accepted state, and there is nothing left to accept.
    const anchor = container.querySelector<HTMLAnchorElement>('a[data-link-review="unverified"]')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-testid="link-review-dialog"]')).toBeNull()
    expect(indicator(container)!.getAttribute('aria-label')).toBe('Links accepted')
    expect(trigger(container)).toBeNull()
  })
})
