/**
 * The Entra sign-in round-trip as the browser sees it (#119):
 * `/api/auth/login` → Entra → `/api/auth/callback`, plus the sign-out redirect.
 *
 * MSAL and Postgres are mocked, but the cookie plumbing is NOT: the handshake
 * cookie the login route sets is the one the callback route reads back, signed
 * and verified through the real HMAC helpers. That is the part these routes own
 * — a state/verifier that survives the round-trip, and no session minted when
 * it doesn't.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

process.env.AUTH_SESSION_SECRET = 'test-secret-for-cookie-signing'

// ── MSAL (entra.server) ─────────────────────────────────────────────────────
let pkce = { verifier: 'verifier-1', challenge: 'challenge-1' }
let stateValues = ['state-1', 'nonce-1']
const buildAuthCodeUrl = vi.fn<(args: Record<string, unknown>) => Promise<string>>(
  async () => 'https://login.microsoftonline.com/authorize?x=1',
)
const redeemAuthCode = vi.fn<
  (args: Record<string, unknown>) => Promise<{
    identity: { userId: string; email: string; displayName: string; tenantId: string }
    homeAccountId: string
    tokenCache: string
  }>
>()
const buildLogoutUrl = vi.fn(() => 'https://login.microsoftonline.com/logout')
vi.mock('~/lib/auth/entra.server', () => ({
  generatePkce: async () => pkce,
  newStateValue: () => stateValues.shift() ?? 'exhausted',
  buildAuthCodeUrl: (args: Record<string, unknown>) => buildAuthCodeUrl(args),
  redeemAuthCode: (args: Record<string, unknown>) => redeemAuthCode(args),
  buildLogoutUrl: () => buildLogoutUrl(),
}))

let entraConfigured = true
vi.mock('~/lib/auth/entra-config.server', () => ({
  isEntraConfigured: () => entraConfigured,
  buildEntraConfig: () => ({ tenantId: 't', clientId: 'c', clientSecret: 's', redirectUri: 'r' }),
}))

// ── Persistence ─────────────────────────────────────────────────────────────
const upsertUser = vi.fn<(user: Record<string, unknown>) => Promise<void>>(async () => {})
vi.mock('~/lib/auth/users.server', () => ({
  upsertUser: (user: Record<string, unknown>) => upsertUser(user),
}))

const saveUserTokenCache = vi.fn<
  (userId: string, cache: string, homeAccountId: string) => Promise<void>
>(async () => {})
vi.mock('~/lib/auth/user-tokens.server', () => ({
  saveUserTokenCache: (userId: string, cache: string, home: string) =>
    saveUserTokenCache(userId, cache, home),
}))

const createSession = vi.fn<(input: Record<string, unknown>) => Promise<string>>(
  async () => 'session-abc',
)
const deleteSession = vi.fn<(id: string) => Promise<void>>(async () => {})
const getSession = vi.fn<(id: string) => Promise<{ userId: string }>>(async () => ({
  userId: 'user-1',
}))
vi.mock('~/lib/auth/session-store.server', () => ({
  DEFAULT_SESSION_TTL_SECONDS: 28800,
  createSession: (input: Record<string, unknown>) => createSession(input),
  deleteSession: (id: string) => deleteSession(id),
  getSession: (id: string) => getSession(id),
}))

const onSessionStart = vi.fn()
const onSessionEnd = vi.fn()
vi.mock('~/lib/routines/dispatch.server', () => ({ onSessionStart, onSessionEnd }))

const login = await import('../../../routes/api/auth/login')
const callback = await import('../../../routes/api/auth/callback')
const logout = await import('../../../routes/api/auth/logout')
const { HANDSHAKE_COOKIE, SESSION_COOKIE, parseCookies } =
  await import('../../../lib/auth/cookies.server')

/** `Set-Cookie` values a response carries, as a name→value map. */
function setCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    Object.assign(out, parseCookies(pair))
  }
  return out
}

function evt(url: string, cookie?: string) {
  return {
    params: {},
    request: new Request(url, { headers: cookie ? { cookie } : {} }),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_ALLOWED_EMAILS', 'alice@example.test')
  entraConfigured = true
  pkce = { verifier: 'verifier-1', challenge: 'challenge-1' }
  stateValues = ['state-1', 'nonce-1']
  createSession.mockResolvedValue('session-abc')
  redeemAuthCode.mockResolvedValue({
    identity: {
      userId: 'user-1',
      email: 'alice@example.test',
      displayName: 'Alice',
      tenantId: 'tenant-1',
    },
    homeAccountId: 'home-1',
    tokenCache: '{"cache":true}',
  })
})

describe('GET /api/auth/login', () => {
  it('503s with setup guidance when Entra is not configured', async () => {
    entraConfigured = false
    const res = await login.GET(evt('http://x/api/auth/login'))
    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/AZURE_TENANT_ID/)
    expect(buildAuthCodeUrl).not.toHaveBeenCalled()
  })

  it('302s to the authorize URL and stashes state + verifier in the handshake cookie', async () => {
    const res = await login.GET(evt('http://x/api/auth/login'))

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://login.microsoftonline.com/authorize?x=1')
    // The challenge (not the verifier) is what goes to the IdP.
    expect(buildAuthCodeUrl.mock.calls[0][0]).toMatchObject({
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: 'challenge-1',
    })
    expect(setCookies(res)[HANDSHAKE_COOKIE]).toBeTruthy()
  })

  it('500s without setting a handshake cookie when the URL build fails', async () => {
    buildAuthCodeUrl.mockRejectedValueOnce(new Error('msal exploded'))
    const res = await login.GET(evt('http://x/api/auth/login'))
    expect(res.status).toBe(500)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })
})

describe('GET /api/auth/callback', () => {
  /** Run login, then hand its handshake cookie to the callback. */
  async function roundTrip(query: string, cookieOverride?: string) {
    const started = await login.GET(evt('http://x/api/auth/login'))
    const handshake = setCookies(started)[HANDSHAKE_COOKIE]
    const cookie = cookieOverride ?? `${HANDSHAKE_COOKIE}=${encodeURIComponent(handshake)}`
    return callback.GET(evt(`http://x/api/auth/callback?${query}`, cookie))
  }

  it('mints a session, records the user, and fires session_start on a valid code', async () => {
    const res = await roundTrip('code=auth-code&state=state-1')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
    // The verifier stashed at login is what gets redeemed — never sent to the browser.
    expect(redeemAuthCode.mock.calls[0][0]).toMatchObject({
      code: 'auth-code',
      codeVerifier: 'verifier-1',
      nonce: 'nonce-1',
    })
    expect(upsertUser).toHaveBeenCalledWith({
      id: 'user-1',
      email: 'alice@example.test',
      displayName: 'Alice',
      tenantId: 'tenant-1',
    })
    expect(saveUserTokenCache).toHaveBeenCalledWith('user-1', '{"cache":true}', 'home-1')
    expect(onSessionStart).toHaveBeenCalledWith('user-1')

    const cookies = setCookies(res)
    expect(cookies[SESSION_COOKIE]).toBe('session-abc')
    expect(cookies[HANDSHAKE_COOKIE]).toBe('') // handshake cleared
  })

  it('sends an unlisted email to access-denied with no session', async () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', 'someone-else@example.test')
    const res = await roundTrip('code=auth-code&state=state-1')

    expect(res.headers.get('Location')).toBe('/auth/access-denied')
    expect(createSession).not.toHaveBeenCalled()
    expect(setCookies(res)[SESSION_COOKIE]).toBeUndefined()
  })

  it('bounces back to sign-in when Entra reported an error', async () => {
    const res = await roundTrip('error=access_denied&error_description=user+cancelled')
    expect(res.headers.get('Location')).toBe('/auth/signin')
    expect(redeemAuthCode).not.toHaveBeenCalled()
  })

  it('bounces back to sign-in when code or state is missing', async () => {
    expect((await roundTrip('state=state-1')).headers.get('Location')).toBe('/auth/signin')
    expect((await roundTrip('code=auth-code')).headers.get('Location')).toBe('/auth/signin')
    expect(redeemAuthCode).not.toHaveBeenCalled()
  })

  it('refuses a state that does not match the handshake cookie (CSRF)', async () => {
    const res = await roundTrip('code=auth-code&state=attacker-chosen')
    expect(res.headers.get('Location')).toBe('/auth/signin')
    expect(redeemAuthCode).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('refuses a forged (unsigned) handshake cookie', async () => {
    const forged = Buffer.from(
      JSON.stringify({ state: 'state-1', verifier: 'v', nonce: 'n', iat: Date.now() }),
    ).toString('base64url')
    const res = await roundTrip(
      'code=auth-code&state=state-1',
      `${HANDSHAKE_COOKIE}=${forged}.not-a-real-signature`,
    )
    expect(res.headers.get('Location')).toBe('/auth/signin')
    expect(redeemAuthCode).not.toHaveBeenCalled()
  })

  it('refuses a missing handshake cookie', async () => {
    const res = await callback.GET(evt('http://x/api/auth/callback?code=auth-code&state=state-1'))
    expect(res.headers.get('Location')).toBe('/auth/signin')
    expect(createSession).not.toHaveBeenCalled()
  })

  it('mints no session when code redemption throws', async () => {
    redeemAuthCode.mockRejectedValueOnce(new Error('invalid_grant'))
    const res = await roundTrip('code=stale&state=state-1')
    expect(res.headers.get('Location')).toBe('/auth/signin')
    expect(createSession).not.toHaveBeenCalled()
    expect(onSessionStart).not.toHaveBeenCalled()
  })

  it('mints no session when the user upsert fails', async () => {
    upsertUser.mockRejectedValueOnce(new Error('postgres down'))
    const res = await roundTrip('code=auth-code&state=state-1')
    expect(res.headers.get('Location')).toBe('/auth/signin')
    expect(createSession).not.toHaveBeenCalled()
  })
})

describe('GET /api/auth/logout (Entra configured)', () => {
  it('redirects to the IdP sign-out and clears the session cookie', async () => {
    const res = await logout.GET(evt('http://x/api/auth/logout', `${SESSION_COOKIE}=abc123`))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://login.microsoftonline.com/logout')
    expect(setCookies(res)[SESSION_COOKIE]).toBe('')
  })

  it('falls back to the local sign-in page when the IdP URL cannot be built', async () => {
    buildLogoutUrl.mockImplementationOnce(() => {
      throw new Error('missing tenant')
    })
    const res = await logout.GET(evt('http://x/api/auth/logout', `${SESSION_COOKIE}=abc123`))
    expect(res.headers.get('Location')).toBe('/auth/signin')
    expect(deleteSession).toHaveBeenCalledWith('abc123')
  })
})
