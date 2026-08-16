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

    // ThemeSwitcher is the only button in the bar while signed out.
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(/Switch to .* mode/)
  })
})
