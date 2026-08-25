/**
 * The app-only (client-credentials) Graph credential.
 *
 * Sits beside `graph-token.test.ts`, which covers the delegated path, and is a
 * separate file because it needs a different MSAL double. What is pinned here
 * is the part that makes an app-only credential safe to have at all:
 *
 *  - it asks for `.default`, i.e. exactly the application roles the tenant
 *    consented to, and cannot request anything else;
 *  - a denial is `GraphAppPermissionError`, never the "sign in again" error —
 *    no user can fix an app-only 403;
 *  - the caller cannot supply or override `Authorization`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const acquireTokenByClientCredential = vi.fn()
const acquireTokenSilent = vi.fn()

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    getTokenCache() {
      return {
        deserialize: vi.fn(),
        serialize: vi.fn(() => '{}'),
        hasChanged: vi.fn(() => false),
        getAccountByHomeId: vi.fn(async () => null),
        getAllAccounts: vi.fn(async () => []),
      }
    }
    acquireTokenSilent = acquireTokenSilent
    acquireTokenByClientCredential = acquireTokenByClientCredential
  },
  InteractionRequiredAuthError: class extends Error {},
}))

vi.mock('../../../lib/auth/entra-config.server', () => ({
  buildEntraConfig: () => ({
    tenantId: 't',
    clientId: 'c',
    clientSecret: 's',
    authority: 'https://login.microsoftonline.com/t',
    redirectUri: 'r',
    postLogoutRedirectUri: 'p',
    scopes: ['User.Read'],
  }),
  msalConfiguration: () => ({ auth: { clientId: 'c' } }),
}))

vi.mock('../../../lib/auth/user-tokens.server', () => ({
  loadUserTokenCache: vi.fn(async () => null),
  saveUserTokenCache: vi.fn(async () => undefined),
}))

import {
  GRAPH_APP_SCOPE,
  GRAPH_BASE,
  GraphAppPermissionError,
  GraphAuthRequiredError,
  getAppGraphToken,
  graphAppFetch,
  resetAppGraphToken,
} from '../../../lib/auth/graph-token.server'

const ok = (json: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => json }))

beforeEach(() => {
  vi.clearAllMocks()
  resetAppGraphToken()
  acquireTokenByClientCredential.mockResolvedValue({
    accessToken: 'app-tok',
    expiresOn: new Date(Date.now() + 3_600_000),
  })
})

describe('getAppGraphToken', () => {
  it('requests the .default scope of the Graph resource, and nothing else', async () => {
    // Client credentials cannot request individual permissions: `.default`
    // means "whatever the tenant admin-consented". A code-supplied scope list
    // would be a lie about what the token can do.
    await expect(getAppGraphToken()).resolves.toBe('app-tok')
    expect(acquireTokenByClientCredential).toHaveBeenCalledWith({ scopes: [GRAPH_APP_SCOPE] })
    expect(GRAPH_APP_SCOPE).toBe('https://graph.microsoft.com/.default')
  })

  it('memoizes the token instead of re-acquiring per call', async () => {
    await getAppGraphToken()
    await getAppGraphToken()
    expect(acquireTokenByClientCredential).toHaveBeenCalledTimes(1)
  })

  it('re-acquires once the cached token is inside the expiry skew', async () => {
    acquireTokenByClientCredential.mockResolvedValueOnce({
      accessToken: 'nearly-dead',
      expiresOn: new Date(Date.now() + 5_000),
    })
    await expect(getAppGraphToken()).resolves.toBe('nearly-dead')
    await expect(getAppGraphToken()).resolves.toBe('app-tok')
    expect(acquireTokenByClientCredential).toHaveBeenCalledTimes(2)
  })

  it('assumes an hour when MSAL omits expiresOn', async () => {
    acquireTokenByClientCredential.mockResolvedValueOnce({ accessToken: 'no-expiry' })
    await getAppGraphToken()
    await getAppGraphToken()
    expect(acquireTokenByClientCredential).toHaveBeenCalledTimes(1)
  })

  it('throws GraphAppPermissionError — not the re-auth error — on an empty result', async () => {
    for (const result of [null, {}, { accessToken: '' }]) {
      resetAppGraphToken()
      acquireTokenByClientCredential.mockResolvedValueOnce(result)
      const err = await getAppGraphToken().then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(GraphAppPermissionError)
      expect(err).not.toBeInstanceOf(GraphAuthRequiredError)
    }
  })

  it('resetAppGraphToken forces a fresh acquisition', async () => {
    await getAppGraphToken()
    resetAppGraphToken()
    await getAppGraphToken()
    expect(acquireTokenByClientCredential).toHaveBeenCalledTimes(2)
  })
})

describe('graphAppFetch', () => {
  it('attaches the app token and parses JSON', async () => {
    const fetchMock = ok({ value: [] })
    vi.stubGlobal('fetch', fetchMock)

    await expect(graphAppFetch('/users')).resolves.toEqual({ value: [] })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${GRAPH_BASE}/users`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer app-tok')
  })

  it('cannot have its credential overridden by a caller header', async () => {
    const fetchMock = ok({})
    vi.stubGlobal('fetch', fetchMock)

    await graphAppFetch('/users', { headers: { Authorization: 'Bearer attacker' } })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer app-tok')
  })

  it('passes an absolute nextLink through unchanged', async () => {
    const fetchMock = ok({})
    vi.stubGlobal('fetch', fetchMock)
    await graphAppFetch('https://graph.microsoft.com/v1.0/users?$skiptoken=abc')
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('$skiptoken=abc')
  })

  it('maps 401/403 to GraphAppPermissionError with the status', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status, statusText: 'no' })),
      )
      const err = await graphAppFetch('/groups').then(
        () => null,
        (e) => e as GraphAppPermissionError,
      )
      // Telling a user to "sign in again" for a missing application permission
      // would send them somewhere that cannot help.
      expect(err).toBeInstanceOf(GraphAppPermissionError)
      expect(err).not.toBeInstanceOf(GraphAuthRequiredError)
      expect(err!.status).toBe(status)
    }
  })

  it('does not leak the Graph error body into the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ error: { message: 'secret request detail' } }),
      })),
    )
    const err = await graphAppFetch('/groups').then(
      () => null,
      (e) => e as Error,
    )
    expect(err!.message).not.toContain('secret request detail')
  })

  it('throws a plain error on any other failure status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' })),
    )
    const err = await graphAppFetch('/users').then(
      () => null,
      (e) => e as Error,
    )
    expect(err).not.toBeInstanceOf(GraphAppPermissionError)
    expect(err!.message).toContain('429')
  })

  it('returns null on 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 204 })),
    )
    await expect(graphAppFetch('/users/x', { method: 'DELETE' })).resolves.toBeNull()
  })
})
