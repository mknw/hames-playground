/**
 * AuthProvider — the gate between an unauthenticated visitor and the app.
 *
 * Three behaviours are load-bearing and all of them are observable from
 * outside: children stay behind the loading splash until a session resolves,
 * an unauthenticated visitor is redirected to sign-in (and an authenticated one
 * away from the auth pages), and the dev bypass short-circuits the whole
 * round-trip. `getSessionUser` is stubbed because the real module is a
 * "use server" entry point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSignal } from 'solid-js'
import type { AuthUser } from '../../lib/auth/types'

const getSessionUser = vi.fn<() => Promise<AuthUser | null>>()
const isBypassEnabled = vi.fn(() => false)
const navigate = vi.fn()
const [pathname, setPathname] = createSignal('/')

vi.mock('~/lib/auth/server', () => ({
  getSessionUser: () => getSessionUser(),
}))

vi.mock('~/lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => isBypassEnabled(),
  BYPASS_USER: { id: 'dev-user', email: 'dev@example.test' },
}))

vi.mock('@solidjs/router', () => ({
  useLocation: () => ({
    get pathname() {
      return pathname()
    },
  }),
  useNavigate: () => navigate,
}))

const { render } = await import('@solidjs/testing-library')
const { AuthProvider, useAuth } = await import('../../components/AuthProvider')

const tick = () => new Promise((r) => setTimeout(r, 20))

const ada: AuthUser = { id: 'oid-1', email: 'ada@example.test', displayName: 'Ada' }

beforeEach(() => {
  getSessionUser.mockReset()
  isBypassEnabled.mockReturnValue(false)
  navigate.mockReset()
  setPathname('/')
})

describe('AuthProvider', () => {
  it('shows the splash until a session resolves, then the app', async () => {
    let resolve!: (u: AuthUser | null) => void
    getSessionUser.mockReturnValue(new Promise((r) => (resolve = r)))

    const { container } = render(() => (
      <AuthProvider>
        <div data-testid="app">secret dashboard</div>
      </AuthProvider>
    ))

    expect(container.textContent).toContain('Please wait while we verify your authentication')
    expect(container.querySelector('[data-testid="app"]')).toBeNull()

    resolve(ada)
    await tick()

    expect(container.querySelector('[data-testid="app"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Please wait')
  })

  it('redirects an unauthenticated visitor to sign-in and keeps the app hidden', async () => {
    getSessionUser.mockResolvedValue(null)

    const { container } = render(() => (
      <AuthProvider>
        <div data-testid="app">secret dashboard</div>
      </AuthProvider>
    ))
    await tick()

    expect(navigate).toHaveBeenCalledWith('/auth/signin', { replace: true })
    expect(container.querySelector('[data-testid="app"]')).toBeNull()
  })

  it('renders the auth page itself without a session and without redirecting', async () => {
    setPathname('/auth/signin')
    getSessionUser.mockResolvedValue(null)

    const { container } = render(() => (
      <AuthProvider>
        <div data-testid="signin">Sign in</div>
      </AuthProvider>
    ))
    await tick()

    expect(container.querySelector('[data-testid="signin"]')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('bounces an already-signed-in user off the sign-in page', async () => {
    setPathname('/auth/signin')
    getSessionUser.mockResolvedValue(ada)

    render(() => (
      <AuthProvider>
        <div />
      </AuthProvider>
    ))
    await tick()

    expect(navigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('leaves a signed-in user on the access-denied page', async () => {
    setPathname('/auth/access-denied')
    getSessionUser.mockResolvedValue(ada)

    render(() => (
      <AuthProvider>
        <div />
      </AuthProvider>
    ))
    await tick()

    expect(navigate).not.toHaveBeenCalled()
  })

  it('treats a failed session read as signed out instead of crashing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    getSessionUser.mockRejectedValue(new Error('tenant unreachable'))

    render(() => (
      <AuthProvider>
        <div data-testid="app" />
      </AuthProvider>
    ))
    await tick()

    expect(navigate).toHaveBeenCalledWith('/auth/signin', { replace: true })
    consoleError.mockRestore()
  })

  it('serves the dev bypass user without hitting the session module', async () => {
    isBypassEnabled.mockReturnValue(true)
    let seen: AuthUser | null = null

    const Probe = () => {
      const auth = useAuth()
      seen = auth.user()
      return <div data-testid="app" />
    }

    render(() => (
      <AuthProvider>
        <Probe />
      </AuthProvider>
    ))
    await tick()

    expect(getSessionUser).not.toHaveBeenCalled()
    expect(seen).toMatchObject({ id: 'dev-user', email: 'dev@example.test', displayName: 'Dev User' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('exposes signOut, which hands off to the server logout route', async () => {
    isBypassEnabled.mockReturnValue(true)
    // jsdom refuses a real navigation, so stand in a writable location.
    const original = window.location
    const stub = { href: '' }
    Object.defineProperty(window, 'location', { value: stub, writable: true, configurable: true })

    let signOut!: () => Promise<void>
    const Probe = () => {
      signOut = useAuth().signOut
      return <div />
    }
    render(() => (
      <AuthProvider>
        <Probe />
      </AuthProvider>
    ))
    await tick()

    await signOut()
    expect(stub.href).toBe('/api/auth/logout')

    Object.defineProperty(window, 'location', {
      value: original,
      writable: true,
      configurable: true,
    })
  })

  it('refetches the session on demand', async () => {
    getSessionUser.mockResolvedValue(ada)
    let refetch!: () => void
    const Probe = () => {
      refetch = useAuth().refetch
      return <div />
    }
    render(() => (
      <AuthProvider>
        <Probe />
      </AuthProvider>
    ))
    await tick()
    expect(getSessionUser).toHaveBeenCalledTimes(1)

    refetch()
    await tick()
    expect(getSessionUser).toHaveBeenCalledTimes(2)
  })

  it('refuses to hand out the context outside a provider', () => {
    const Orphan = () => {
      useAuth()
      return <div />
    }
    expect(() => render(() => <Orphan />)).toThrow(/must be used within an AuthProvider/)
  })
})
