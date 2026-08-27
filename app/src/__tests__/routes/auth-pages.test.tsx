/**
 * The three routed pages that carry no state of their own: sign-in,
 * access-denied and the 404. Each one exists to hand the user their next
 * action, so what is asserted here is that action — where the links point,
 * and the one conditional bit of copy sign-in shows after a failed round-trip.
 *
 * Since #226 B8 they are also the app's first themed surfaces, so the last
 * block guards the two properties that made them a finding: no raw `class=`
 * utilities, and the page ground on a theme-aware token.
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { render } from '@solidjs/testing-library'
import { MemoryRouter, Route, createMemoryHistory } from '@solidjs/router'
import SignIn from '~/routes/auth/signin'
import AccessDenied from '~/routes/auth/access-denied'
import NotFound from '~/routes/[...404]'

/** Mount `component` inside a memory router opened at `at` (path + query). */
function renderRoute(component: () => unknown, at: string) {
  const history = createMemoryHistory()
  history.set({ value: at, replace: true })
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="*" component={component as never} />
    </MemoryRouter>
  ))
}

const hrefs = (container: HTMLElement) =>
  [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))

describe('sign-in page', () => {
  it('offers the Microsoft hand-off as a real navigation, not a client route', async () => {
    const { container, findByText } = renderRoute(SignIn, '/auth/signin')
    await findByText('Sign in with Microsoft')

    const link = container.querySelector('a[href="/api/auth/login"]')!
    // Without rel="external" the router intercepts the click and the server
    // handler never runs — the sign-in silently 404s.
    expect(link.getAttribute('rel')).toBe('external')
  })

  it('shows no error hint on a first visit', async () => {
    const { container, findByText } = renderRoute(SignIn, '/auth/signin')
    await findByText('Sign in with Microsoft')
    expect(container.textContent).not.toContain("Sign-in didn't complete")
  })

  it('hints at a failed round-trip when the callback sent us back with ?error', async () => {
    const { findByText } = renderRoute(SignIn, '/auth/signin?error=state_mismatch')
    // The hint is deliberately generic — the reason never reaches the browser.
    const hint = await findByText(/Sign-in didn't complete/)
    expect(hint.textContent).not.toMatch(/state_mismatch/)
  })
})

describe('access-denied page', () => {
  it('routes an unauthorized user back to sign-in', async () => {
    const { container, findByText } = renderRoute(AccessDenied, '/auth/access-denied')
    await findByText('Access Denied')
    expect(hrefs(container)).toContain('/auth/signin')
  })
})

describe('404 page', () => {
  it('offers a way back to both app surfaces', async () => {
    const { container, findByText } = renderRoute(NotFound, '/nope')
    await findByText('Not Found')
    expect(hrefs(container)).toEqual(expect.arrayContaining(['/', '/dashboard']))
  })
})

/**
 * B8's finding was a syntax one before it was a visual one: these were the
 * only non-icon `class=` attributes in the app. A regression here is invisible
 * — a stray `class="bg-white"` renders perfectly — so it is checked in source.
 */
describe('house design language', () => {
  const sources = [
    'src/routes/auth/signin.tsx',
    'src/routes/auth/access-denied.tsx',
    'src/routes/[...404].tsx',
    'src/components/AuthProvider.tsx',
    // The boot splash, added in #295. It is the fallback for BOTH gates on the
    // post-login path, so it is now the first surface a cold visit paints —
    // exactly the role that put `AuthProvider.tsx` on this list.
    'src/components/ark-ui/AppLoadingSplash.tsx',
  ]

  /**
   * The subset that paints a full-screen ground of its own.
   *
   * `AuthProvider.tsx` is deliberately NOT here since #295: it stopped
   * rendering a surface and now renders `<AppLoadingSplash />`, which is. The
   * property this pins — every screen a visitor can be looking at is grounded
   * on a theme-aware token — has to follow the file that actually paints, or it
   * degrades into requiring dead markup in a component that only delegates.
   */
  const grounded = sources.filter((file) => file !== 'src/components/AuthProvider.tsx')

  it.each(sources)('%s uses class= only for icon glyphs', (file) => {
    const source = readFileSync(file, 'utf8')
    const nonIcon = [...source.matchAll(/class="([^"]*)"/g)]
      .map((m) => m[1])
      .filter((value) => !/^i-material-symbols(-light)?-[\w-]+$/.test(value))

    expect(nonIcon).toEqual([])
  })

  it.each(grounded)('%s grounds itself on a theme-aware token', (file) => {
    const source = readFileSync(file, 'utf8')
    // A page still on `bg-gray-50` / `bg-dark-bg-*` would not follow the
    // switcher, which is the whole point of the fix.
    expect(source).toMatch(/bg="ui-bg-/)
    expect(source).not.toMatch(/bg="[^"]*\bdark-bg-/)
  })
})
