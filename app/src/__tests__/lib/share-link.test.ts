/**
 * `share-link` — where a conversation lives in the URL, and which routes render
 * without a session.
 *
 * `isPublicRoute` is the load-bearing half: `AuthProvider` uses it to decide
 * whether to send a visitor to sign-in, so a prefix match that is too loose is
 * an unauthenticated visitor let onto a page that assumes a user, and one that
 * is too tight is a share link that redirects to sign-in and never comes back.
 */
import { describe, it, expect } from 'vitest'
import {
  CONVERSATION_PARAM,
  SHARE_ROUTE_PREFIX,
  isPublicRoute,
  sharePath,
  shareUrl,
} from '../../lib/share-link'

describe('sharePath / shareUrl', () => {
  it('builds a path under the share prefix', () => {
    expect(sharePath('abc123')).toBe('/s/abc123')
  })

  it('percent-encodes the token rather than pasting it into a path', () => {
    // Minted tokens are base64url and need no encoding; this is about what
    // happens when something else ends up here.
    expect(sharePath('a/b?c')).toBe('/s/a%2Fb%3Fc')
  })

  it('joins onto an origin without doubling the slash', () => {
    expect(shareUrl('https://kg.example', 'abc')).toBe('https://kg.example/s/abc')
    expect(shareUrl('https://kg.example/', 'abc')).toBe('https://kg.example/s/abc')
  })
})

describe('isPublicRoute', () => {
  it('admits the share route and the auth routes', () => {
    expect(isPublicRoute('/s/abc')).toBe(true)
    expect(isPublicRoute('/auth/signin')).toBe(true)
    expect(isPublicRoute('/auth/access-denied')).toBe(true)
  })

  it('does not admit a path that merely starts with the same letters', () => {
    expect(isPublicRoute('/sabotage')).toBe(false)
    expect(isPublicRoute('/authoring')).toBe(false)
    expect(isPublicRoute('/settings')).toBe(false)
  })

  it('does not admit the prefixes themselves, which render nothing', () => {
    expect(isPublicRoute('/s')).toBe(false)
    expect(isPublicRoute('/auth')).toBe(false)
  })

  it('keeps the gated routes gated', () => {
    expect(isPublicRoute('/')).toBe(false)
    expect(isPublicRoute('/?c=some-conversation')).toBe(false)
    expect(isPublicRoute('/dashboard')).toBe(false)
    expect(isPublicRoute('/api/agents/search')).toBe(false)
  })
})

describe('the constants the router and the auth gate share', () => {
  it('keeps the prefix and the builder in agreement', () => {
    // A prefix without its trailing slash would make `/sabotage` public; a
    // builder that dropped it would emit `/sabc`. One constant, both jobs.
    expect(SHARE_ROUTE_PREFIX).toBe('/s/')
    expect(sharePath('x').startsWith(SHARE_ROUTE_PREFIX)).toBe(true)
    expect(isPublicRoute(sharePath('x'))).toBe(true)
  })

  it('names the conversation parameter once', () => {
    expect(CONVERSATION_PARAM).toBe('c')
  })
})
