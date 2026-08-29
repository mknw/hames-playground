/**
 * `/s/:token` — what an anonymous visitor is shown.
 *
 * The claims here are about the PAGE, not about the token (that is
 * `lib/db/conversation-sharing.test.ts`) and not about the projection (that is
 * `lib/harness-client/shared-conversation.test.ts`). Two of them are the reason
 * this file exists at all:
 *
 *   - a miss renders the SAME page whatever kind of miss it was, and never a
 *     sentence that admits a conversation is behind the link;
 *   - read-only is structural — the composer, the sidebar, the agent picker and
 *     the share control are not on the page, rather than on it and disabled.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createSignal } from 'solid-js'
import { installDomStubs } from '../components/ark-ui/dom-stubs'
import { installDomObservers } from '../mocks/dom-observers'

beforeAll(() => {
  installDomStubs()
  // `ChatMessages` mounts an Ark `ScrollArea`, whose zag machine constructs an
  // `IntersectionObserver` jsdom does not have.
  installDomObservers()
})

const [token, setToken] = createSignal('k'.repeat(43))

vi.mock('@solidjs/router', () => ({
  useParams: () => ({
    get token() {
      return token()
    },
  }),
}))

const loadSharedConversation = vi.fn()
vi.mock('~/lib/harness-client/shared-conversation.server', () => ({
  loadSharedConversation: (t: string) => loadSharedConversation(t) as unknown,
}))

const { render } = await import('@solidjs/testing-library')
const { default: SharedConversation } = await import('../../routes/s/[token]')

const tick = () => new Promise((r) => setTimeout(r, 20))

const VIEW = {
  id: 'conv-1',
  title: 'Q3 numbers',
  sharedAt: Date.parse('2026-08-27T09:00:00.000Z'),
  messages: [
    { id: 'm1', role: 'user' as const, content: 'what did finance send?', timestamp: 10 },
    { id: 'm2', role: 'assistant' as const, content: 'The CFO sent Q3.', timestamp: 15 },
  ],
}

beforeEach(() => {
  loadSharedConversation.mockReset()
  setToken('k'.repeat(43))
})

describe('the shared conversation page', () => {
  it('renders the transcript, with a banner naming what this is', async () => {
    loadSharedConversation.mockResolvedValue(VIEW)
    const { container } = render(() => <SharedConversation />)
    await tick()

    expect(loadSharedConversation).toHaveBeenCalledWith('k'.repeat(43))
    expect(container.querySelector('[data-testid="shared-conversation-title"]')!.textContent).toBe(
      'Q3 numbers',
    )
    expect(container.textContent).toContain('what did finance send?')
    expect(container.textContent).toContain('The CFO sent Q3.')

    // A visitor cannot infer "read-only" from an absent text box, so it is said.
    const banner = container.querySelector('[data-testid="shared-conversation-banner"]')!
    expect(banner.textContent).toContain('Shared conversation')
    expect(banner.textContent).toContain('read-only')
  })

  it('renders both turns as their own bubbles, in order', async () => {
    loadSharedConversation.mockResolvedValue(VIEW)
    const { container } = render(() => <SharedConversation />)
    await tick()

    expect(container.querySelectorAll('[data-role="user"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(1)
  })

  it('offers nothing to type into, and nothing to drive an agent with', async () => {
    loadSharedConversation.mockResolvedValue(VIEW)
    const { container } = render(() => <SharedConversation />)
    await tick()

    // Read-only by construction: this route does not mount the composer, the
    // sidebar, the agent picker or the share control. Every one of them drives
    // an owner-scoped action that would reject this caller anyway — a page that
    // offered them and then failed would be the worse answer.
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('[data-testid="share-conversation"]')).toBeNull()
    expect(container.textContent).not.toContain('New Chat')
    expect(container.textContent).not.toContain('Agent:')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('renders the same page for a revoked link as for one that never existed', async () => {
    loadSharedConversation.mockResolvedValue(null)
    const { container: revoked } = render(() => <SharedConversation />)
    await tick()

    setToken('z'.repeat(43))
    const { container: unknown_ } = render(() => <SharedConversation />)
    await tick()

    for (const container of [revoked, unknown_]) {
      expect(container.querySelector('[data-testid="shared-conversation-missing"]')).not.toBeNull()
      expect(container.textContent).toContain('This link doesn’t work')
      // The sentence that would confirm there is something behind the link.
      expect(container.textContent).not.toContain('no longer shared')
      expect(container.textContent).not.toContain('revoked')
    }
    expect(revoked.textContent).toBe(unknown_.textContent)
  })

  it('shows no transcript while the answer is still in flight', async () => {
    loadSharedConversation.mockReturnValue(new Promise(() => {}))
    const { container } = render(() => <SharedConversation />)
    await tick()

    expect(container.querySelector('[role="status"]')!.textContent).toContain('Loading')
    // Neither the transcript nor the not-found page: an unresolved read must
    // not flash "this link doesn't work" at someone whose link is fine.
    expect(container.querySelector('[data-testid="shared-conversation-missing"]')).toBeNull()
  })

  it('renders an untitled conversation without an empty heading', async () => {
    loadSharedConversation.mockResolvedValue({ ...VIEW, title: null })
    const { container } = render(() => <SharedConversation />)
    await tick()

    expect(container.querySelector('[data-testid="shared-conversation-title"]')).toBeNull()
    expect(container.textContent).toContain('The CFO sent Q3.')
  })
})
