/**
 * Nav — the page links in the top bar, restyled as tab headers (owner,
 * round 4): icon and label on one line, one shared height, no boxed look,
 * and what each does on the page it opened.
 *
 * Each tab keeps its OWN glyph in both states, and the pressed-in state marks
 * the page that is open — clicking that tab again returns to the chat.
 *
 * Two additions are pinned here too: the **chat tab** (#1048) — the owner's
 * "there is no obvious way to return to the chat interface; the chat button
 * should be next to them when one of them is selected, and disappear when the
 * user is on chat" — and the **admin tab** (#1047), which the server's
 * `isAdminUser` answer alone may show. Everything else in the bar is delegated
 * to ThemeSwitcher and UserMenu, which have their own tests.
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
  keepPrivateTierWarm: () => new Promise(() => {}),
}))

// The admin tab's question. Driven per test with `setAdminAnswer`, because the
// tab must appear ONLY when the server says so (#1047's owner amendment).
const isAdminUser = vi.fn()
vi.mock('~/lib/harness-client/gpu-admin.server', () => ({
  isAdminUser: () => isAdminUser(),
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

const { render, waitFor } = await import('@solidjs/testing-library')
const { default: Nav } = await import('../../components/Nav')

beforeEach(() => {
  localStorage.clear()
  setPathname('/')
  setSignedInUser(null)
  isAdminUser.mockReset()
  isAdminUser.mockResolvedValue(false)
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

  it('reads as a tab strip: one line, shared height, no boxed button look', () => {
    // Owner, round 4: the links were boxed buttons of variable height (icon
    // above a tiny caption). Now each tab is an icon followed by its label on
    // ONE line at one shared height (h="11" — the house ≥44px header-target
    // bar from the parent PR's review), with no border attribute at all.
    // The label span collapses below md via the `.nav-tab-label` preflight
    // class — jsdom applies no stylesheet, so what is pinned here is the
    // attribute/class half of the chain; the real render is the screenshots.
    const { container } = render(() => <Nav />)
    const tabs = [...container.querySelectorAll('nav a')].filter((a) =>
      ['Metrics dashboard', 'Use cases'].includes(a.getAttribute('aria-label') ?? ''),
    )
    expect(tabs).toHaveLength(2)
    for (const tab of tabs) {
      expect(tab.getAttribute('flex'), 'one line, not a column').toContain('items-center')
      expect(tab.getAttribute('h'), 'every tab the same height').toBe('11')
      expect(tab.getAttribute('border'), 'no boxed button look').toBeNull()
      const label = [...tab.querySelectorAll('span')].find((el) =>
        el.className.includes('nav-tab-label'),
      )
      expect(label, 'the label collapses below md').toBeDefined()
    }
  })

  it('marks the open page as the selected tab, on the ui tokens', () => {
    setPathname('/use-cases')
    const { container } = render(() => <Nav />)
    const useCases = pageLink(container, 'Back to chat — use cases page is open')
    // The selected tab is a subtle accent background on the themed tokens —
    // the old cyber-* fixed hexes are graph-canvas data colours now.
    expect(useCases.getAttribute('bg')).toContain('ui-accent/10')
    expect(useCases.getAttribute('bg')).not.toContain('cyber-')
    const metrics = pageLink(container, 'Metrics dashboard')
    expect(metrics.getAttribute('bg')).toContain('transparent')
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

  // ---- The chat tab (#1048) ----------------------------------------------
  it('offers no chat tab on the chat itself — it would point where you already are', () => {
    const { container } = render(() => <Nav />)
    expect(pageLink(container, 'Chat')).toBeUndefined()
  })

  it('shows the chat tab next to metrics and use cases when one is selected', () => {
    for (const path of ['/dashboard', '/use-cases']) {
      setPathname(path)
      const { container, unmount } = render(() => <Nav />)
      const chat = pageLink(container, 'Chat')
      expect(chat, path).toBeDefined()
      expect(chat.getAttribute('href')).toBe('/')
      // Not the selected tab — the open page keeps `aria-current`.
      expect(chat.getAttribute('aria-current')).toBeNull()
      unmount()
    }
  })

  it('shows the chat tab on the admin page too, and nowhere it was not asked for', () => {
    // Not on a route that is no page tab (profile), then on /admin:
    setPathname('/profile')
    const off = render(() => <Nav />)
    expect(pageLink(off.container, 'Chat')).toBeUndefined()
    off.unmount()

    isAdminUser.mockResolvedValue(true)
    setPathname('/admin')
    const on = render(() => <Nav />)
    expect(pageLink(on.container, 'Chat')).toBeDefined()
  })

  // ---- The admin tab (#1047) ----------------------------------------------
  it('renders no admin tab when the server says this user is not an admin', async () => {
    const { container } = render(() => <Nav />)
    await waitFor(() => expect(isAdminUser).toHaveBeenCalled())
    expect(pageLink(container, 'Admin')).toBeUndefined()
  })

  it('renders the admin tab only once the server answers true, as a tab like the others', async () => {
    isAdminUser.mockResolvedValue(true)
    setPathname('/dashboard')
    const { container } = render(() => <Nav />)
    const admin = await waitFor(() => {
      const tab = pageLink(container, 'Admin')
      expect(tab).toBeDefined()
      return tab
    })
    expect(admin.getAttribute('href')).toBe('/admin')
    expect(admin.getAttribute('aria-current')).toBeNull()
    expect(admin.querySelector('span')!.className).toContain(
      'i-material-symbols-admin-panel-settings',
    )
    expect(admin.textContent).toContain('admin')
  })

  it('marks the admin tab as the selected page when the panel is open', async () => {
    isAdminUser.mockResolvedValue(true)
    setPathname('/admin')
    const { container } = render(() => <Nav />)
    // On its own page the tab's label says what pressing it now does, as the
    // metrics and use-cases tabs do on theirs.
    const admin = await waitFor(() => {
      const tab = pageLink(container, 'Back to chat — the admin panel is open')
      expect(tab).toBeDefined()
      return tab
    })
    expect(admin.getAttribute('aria-current')).toBe('page')
    expect(admin.getAttribute('href')).toBe('/')
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
