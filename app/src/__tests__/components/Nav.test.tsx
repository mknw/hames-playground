/**
 * Nav — the dashboard/chat toggle in the top bar (#132).
 *
 * The single interesting behaviour is that the one icon link flips both its
 * destination and its affordance depending on whether the dashboard is the
 * current route; everything else in the bar is delegated to ThemeSwitcher and
 * UserMenu, which have their own tests.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createSignal } from 'solid-js'
import { installDomStubs } from './ark-ui/dom-stubs'

beforeAll(() => installDomStubs())

const [pathname, setPathname] = createSignal('/')

vi.mock('@solidjs/router', () => ({
  useLocation: () => ({
    get pathname() {
      return pathname()
    },
  }),
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

// The bar renders UserMenu, whose auth context is exercised elsewhere.
vi.mock('~/components/AuthProvider', () => ({
  useAuth: () => ({
    user: () => null,
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
})

describe('Nav', () => {
  it('links to the dashboard from the chat route', () => {
    const { container } = render(() => <Nav />)
    const link = container.querySelector('a')!

    expect(link.getAttribute('href')).toBe('/dashboard')
    expect(link.getAttribute('aria-label')).toBe('Metrics dashboard')
    expect(link.querySelector('span')!.className).toContain('i-material-symbols-monitoring')
  })

  it('links back to the chat while on the dashboard', () => {
    setPathname('/dashboard')
    const { container } = render(() => <Nav />)
    const link = container.querySelector('a')!

    expect(link.getAttribute('href')).toBe('/')
    expect(link.getAttribute('aria-label')).toBe('Back to chat')
    expect(link.querySelector('span')!.className).toContain('i-material-symbols-chat-outline')
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
