/**
 * Nav — the captioned page-link group in the top bar (metrics · use cases),
 * and what each does on the page it opened.
 *
 * The links no longer flip their icon: each keeps its OWN glyph in both
 * states, carries a tiny caption naming it, and the pressed-in state marks
 * the page that is open — clicking that link again returns to the chat.
 * Everything else in the bar is delegated to ThemeSwitcher and UserMenu,
 * which have their own tests.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createSignal } from 'solid-js'
import { installDomStubs } from './ark-ui/dom-stubs'

beforeAll(() => installDomStubs())

const [pathname, setPathname] = createSignal('/')

vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({
    get pathname() {
      return pathname()
    },
  }),
}))

// The header inbox's RPC: same story as the strip's — nothing pending here.
// The inbox also lists conversations whose run waits on a decision
// (decision-loop-agent slice 9); none here.
vi.mock('~/lib/hitl/actions.server', () => ({
  listBlockingInbox: async () => [],
  listBlockingRequests: async () => [],
  answerHitl: async () => [],
}))
vi.mock('~/lib/memory/confirm-actions.server', () => ({
  listMemoryInbox: () => Promise.resolve([]),
}))

// The bar renders the preview strip, whose server action would otherwise be
// imported for real here. In a build, `'use server'` leaves the client with an
// RPC stub; under vitest the module is loaded as written, so the whole
// auth/DB/harness import graph comes with it. Stubbed to a never-resolving
// promise so the strip renders nothing and this file stays about the nav.
vi.mock('~/lib/harness-client/preview-header.server', () => ({
  getPreviewHeaderState: () => new Promise(() => {}),
  setPreviewInferenceTier: () => new Promise(() => {}),
}))

// The bar renders UserMenu, whose auth context is exercised elsewhere. The
// signed-in variant matters here for one case: `UserMenu` renders NOTHING
// without a user, so "the share page has no user menu" would be vacuously true
// against a signed-out stub.
const [signedInUser, setSignedInUser] = createSignal<{ id: string; email: string } | null>(null)
vi.mock('~/components/AuthProvider', () => ({
  useAuth: () => ({
    user: () => signedInUser(),
    loading: () => false,
    refetch: vi.fn(),
    signOut: vi.fn(async () => {}),
  }),
}))

const { render } = await import('@solidjs/testing-library')
const { default: Nav } = await import('../../components/Nav')

beforeEach(() => {
  localStorage.clear()
  setPathname('/')
  setSignedInUser(null)
})

describe('Nav', () => {
  /** The two page links, found by their stable accessible names. */
  const pageLink = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('a')].find((a) => a.getAttribute('aria-label') === label)!

  it('links to the dashboard and to the use-cases page from the chat route', () => {
    const { container } = render(() => <Nav />)

    const metrics = pageLink(container, 'Metrics dashboard')
    const useCases = pageLink(container, 'Use cases')
    expect(metrics.getAttribute('href')).toBe('/dashboard')
    expect(useCases.getAttribute('href')).toBe('/use-cases')

    // Each link keeps its OWN icon in both states — the icon no longer flips
    // to a chat glyph on the page it opened — and each carries its tiny
    // caption, so the two read as one captioned group.
    expect(metrics.querySelector('span')!.className).toContain('i-material-symbols-monitoring')
    expect(metrics.textContent).toContain('metrics')
    expect(useCases.querySelector('span')!.className).toContain('i-material-symbols-checklist')
    expect(useCases.textContent).toContain('use cases')

    // On the chat route neither page is open, so neither is pressed in.
    expect(metrics.getAttribute('aria-current')).toBeNull()
    expect(useCases.getAttribute('aria-current')).toBeNull()
  })

  it('renders the captions small and readable: 2xs (11px), on ui-text-primary', () => {
    // The #937 review's blocking finding: `text="2xs"` used to emit NO CSS
    // (no theme entry below `xs`), so the captions silently rendered at the
    // ambient 16px, and `ui-text-tertiary` measured below 4.5:1 on the pressed
    // tint. jsdom applies no stylesheet, so what is pinned here is the class
    // half of the chain; `uno-theme.test.ts` pins that `.text-2xs` actually
    // emits font-size: 0.6875rem, and `ui-text-primary` is the one existing
    // token the reviewer measured above 4.5:1 on the pressed tint in BOTH
    // themes. Drop either half and one of the two tests goes red.
    const { container } = render(() => <Nav />)
    const captions = [...container.querySelectorAll('nav a span')].filter((el) =>
      ['metrics', 'use cases'].includes(el.textContent ?? ''),
    )
    expect(captions).toHaveLength(2)
    for (const caption of captions) {
      expect(caption.getAttribute('text')).toContain('2xs')
      expect(caption.getAttribute('text')).toContain('ui-text-primary')
      expect(caption.getAttribute('text')).not.toContain('ui-text-tertiary')
    }
  })

  it('on the dashboard, the metrics link is pressed in and returns to chat', () => {
    setPathname('/dashboard')
    const { container } = render(() => <Nav />)

    const metrics = pageLink(container, 'Back to chat — metrics dashboard is open')
    expect(metrics.getAttribute('href')).toBe('/')
    expect(metrics.getAttribute('aria-current')).toBe('page')
    // Its own icon in both states: no chat glyph swap.
    expect(metrics.querySelector('span')!.className).toContain('i-material-symbols-monitoring')

    // The use-cases link is untouched by where the reader happens to be.
    const useCases = pageLink(container, 'Use cases')
    expect(useCases.getAttribute('href')).toBe('/use-cases')
    expect(useCases.getAttribute('aria-current')).toBeNull()
  })

  it('on the use-cases page, that link is pressed in and returns to chat', () => {
    setPathname('/use-cases')
    const { container } = render(() => <Nav />)

    const useCases = pageLink(container, 'Back to chat — use cases page is open')
    expect(useCases.getAttribute('href')).toBe('/')
    expect(useCases.getAttribute('aria-current')).toBe('page')
    expect(useCases.querySelector('span')!.className).toContain('i-material-symbols-checklist')

    const metrics = pageLink(container, 'Metrics dashboard')
    expect(metrics.getAttribute('href')).toBe('/dashboard')
    expect(metrics.getAttribute('aria-current')).toBeNull()
  })

  it('carries the theme control alongside the link', () => {
    const { container } = render(() => <Nav />)

    // ThemeSwitcher is the only button in the bar while signed out. It is a
    // menu trigger since the switch grew a third setting, so the title names
    // the current choice rather than the action.
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(
      /^Theme: (Light|Dark|System)$/,
    )
  })

  it('offers a visitor on a share link nothing they cannot have', () => {
    // Signed IN, deliberately: someone who has a session can still open a share
    // link, and that is the case where hiding the controls has to be a decision
    // by this component rather than a side effect of `UserMenu` rendering
    // nothing. The control assertion below is the same render on `/`.
    setSignedInUser({ id: 'oid-1', email: 'ada@example.test' })
    setPathname('/s/' + 'k'.repeat(43))
    const { container } = render(() => <Nav />)

    // No dashboard link (another user's metrics) and no user menu (a session
    // the visitor does not have). A control that fails when pressed is a worse
    // answer than one that is not there.
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[role="group"][aria-label="Preview status"]')).toBeNull()

    // The theme control stays: it is purely about how THIS page looks, touches
    // nothing but localStorage, and a link opened in a light-mode browser needs
    // it. `UserMenu` renders a button too, so its absence is what makes the
    // count meaningful here.
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute('title')).toMatch(/^Theme: (Light|Dark|System)$/)
  })

  it('does render the user menu for that same user on an ordinary route', () => {
    // The control for the case above: without this, "no user menu on /s/" would
    // pass against a bar that never renders one at all.
    setSignedInUser({ id: 'oid-1', email: 'ada@example.test' })
    setPathname('/')
    const { container } = render(() => <Nav />)

    expect(container.querySelectorAll('button').length).toBeGreaterThan(1)
    expect(container.querySelector('a')).not.toBeNull()
  })

  it('leaves the preview strip off the auth routes', () => {
    // The strip polls an authenticated action, so on the sign-in page every
    // poll is a rejection — and a failed FIRST poll now says so out loud.
    // Rendering it there would greet every signed-out visitor with a failure
    // notice for a feature they cannot reach yet.
    setPathname('/auth/signin')
    const { container } = render(() => <Nav />)

    expect(container.querySelector('[role="group"][aria-label="Preview status"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-header-unavailable"]')).toBeNull()
  })
})
