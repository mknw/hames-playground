/**
 * UserMenu — the avatar trigger, its initials fallback, and the sign-out item.
 *
 * `useAuth` is stubbed rather than wrapping the real AuthProvider: the provider
 * pulls in the server session module and is covered on its own in
 * `components/AuthProvider.test.tsx`. What matters here is what the menu
 * derives from whatever user it is handed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createSignal } from 'solid-js'
import type { AuthUser } from '../../../lib/auth/types'
import { installDomStubs } from './dom-stubs'

// The menu positioner runs floating-ui, which observes the trigger.
beforeAll(() => installDomStubs())

const [user, setUser] = createSignal<AuthUser | null>(null)
const signOut = vi.fn(async () => {})

vi.mock('~/components/AuthProvider', () => ({
  useAuth: () => ({ user, loading: () => false, refetch: vi.fn(), signOut }),
}))

const { render } = await import('@solidjs/testing-library')
const { UserMenu } = await import('../../../components/ark-ui/UserMenu')

const tick = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  signOut.mockClear()
  setUser(null)
})

describe('UserMenu', () => {
  it('renders nothing when signed out', () => {
    const { container } = render(() => <UserMenu />)
    expect(container.textContent).toBe('')
  })

  it('shows the display name and its two-letter initials', () => {
    setUser({ id: 'u1', email: 'ada.lovelace@example.com', displayName: 'Ada Lovelace' })
    const { container } = render(() => <UserMenu />)

    expect(container.textContent).toContain('Ada Lovelace')
    expect(container.textContent).toContain('AL')
  })

  it('falls back to the email initial when there is no display name', () => {
    setUser({ id: 'u2', email: 'grace@example.com', displayName: null })
    const { container } = render(() => <UserMenu />)

    expect(container.textContent).toContain('grace@example.com')
    expect(container.textContent).toContain('G')
  })

  it("falls back to 'U' when neither name nor email is known", () => {
    // `AuthUser.email` is typed non-null, but the component guards for a missing
    // one — exercise that guard through the same shape a stale session yields.
    setUser({ id: 'u3', email: null, displayName: null } as unknown as AuthUser)
    const { container } = render(() => <UserMenu />)

    expect(container.textContent).toContain('U')
  })

  it('caps the initials at two letters', () => {
    setUser({
      id: 'u4',
      email: 'ada.byron.king.lovelace@example.com',
      displayName: 'Ada Byron King Lovelace',
      profileImageUrl: 'https://example.test/ada.png',
    })
    const { container } = render(() => <UserMenu />)

    expect(container.textContent).toContain('AB')
    expect(container.textContent).not.toContain('ABKL')
    // A profile picture is rendered alongside the fallback.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/ada.png')
  })

  it('signs out from the menu item', async () => {
    setUser({ id: 'u1', email: 'ada@example.com', displayName: 'Ada' })
    const { container } = render(() => <UserMenu />)

    container.querySelector<HTMLElement>('[data-part="trigger"]')!.click()
    await tick()

    const logout = [...document.querySelectorAll<HTMLElement>('[data-part="item"]')].find(
      (el) => el.getAttribute('data-value') === 'logout',
    )!
    expect(logout, 'menu opens with a sign-out item').toBeTruthy()
    logout.click()
    await tick()

    expect(signOut).toHaveBeenCalledTimes(1)
  })
})
