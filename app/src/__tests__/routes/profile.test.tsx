/**
 * Profile page render (`/profile`).
 *
 * The route exists because the user menu has always linked to it and the link
 * landed on the 404 page. What is worth pinning here is what the page is FOR:
 * the identity it was handed reaches the DOM, a users row that does not exist
 * yet degrades to em dashes rather than to "Invalid Date", the tier is rendered
 * through the same label map the header switch uses, and a failed load says so
 * instead of painting an empty page (there is no ErrorBoundary above this
 * route).
 *
 * The server action is stubbed — importing it for real would pull in `pg`.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProfileView } from '~/lib/auth/profile.server'

const getProfile = vi.fn<() => Promise<ProfileView>>()

vi.mock('~/lib/auth/profile.server', () => ({
  getProfile: () => getProfile(),
}))

// The theme control is the real one (it is the page's only editable setting),
// so it needs `matchMedia`, which jsdom does not implement.
vi.stubGlobal(
  'matchMedia',
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
)

const { render } = await import('@solidjs/testing-library')
const { default: Profile } = await import('~/routes/profile')

const tick = () => new Promise((r) => setTimeout(r, 20))

const profile = (over: Partial<ProfileView> = {}): ProfileView => ({
  email: 'someone@example.test',
  displayName: 'Someone Example',
  firstLogin: Date.UTC(2026, 0, 2, 3, 4, 5),
  lastLogin: Date.UTC(2026, 7, 26, 9, 0, 0),
  tier: 'verda',
  ...over,
})

describe('Profile route', () => {
  it('renders the identity it was handed and the resolved tier', async () => {
    getProfile.mockResolvedValue(profile())

    const { container } = render(() => <Profile />)
    await tick()
    const text = container.textContent ?? ''

    expect(text).toContain('Someone Example')
    expect(text).toContain('someone@example.test')
    // The tier label comes from `preview-header-format`, shared with the header
    // switch — two spellings of the same value would read as two settings.
    expect(text).toContain('Private (Verda)')
    expect(text).toContain(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toLocaleString())
  })

  it('shows the theme control — the one setting the page can actually change', async () => {
    getProfile.mockResolvedValue(profile())

    const { container } = render(() => <Profile />)
    await tick()

    expect(container.querySelector('[aria-label^="Theme:"]')).toBeTruthy()
  })

  it('degrades a missing users row to em dashes rather than an invalid date', async () => {
    getProfile.mockResolvedValue(profile({ displayName: null, firstLogin: null, lastLogin: null }))

    const { container } = render(() => <Profile />)
    await tick()
    const text = container.textContent ?? ''

    expect(text).not.toContain('Invalid Date')
    expect(text).toContain('—')
  })

  it('reports a failed load instead of rendering nothing', async () => {
    getProfile.mockRejectedValue(new Error('database is asleep'))

    const { container } = render(() => <Profile />)
    await tick()

    expect(container.textContent).toContain('Could not load your profile')
    expect(container.textContent).toContain('database is asleep')
  })
})
