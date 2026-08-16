/**
 * The three routed pages that carry no state of their own: sign-in,
 * access-denied and the 404. Each one exists to hand the user their next
 * action, so what is asserted here is that action — where the links point,
 * and the one conditional bit of copy sign-in shows after a failed round-trip.
 */

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
