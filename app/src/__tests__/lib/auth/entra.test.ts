/**
 * Entra auth-code flow wrapper (`entra.server.ts`).
 *
 * `@azure/msal-node` is faked so the three route-facing behaviours can be
 * asserted without a tenant: what the authorize URL is asked for, what a code
 * redemption yields (identity + serialized cache + home account), and how the
 * sign-out URL is composed.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const getAuthCodeUrl = vi.fn(async () => 'https://login.example/authorize?x=1')
const acquireTokenByCode = vi.fn()
const serialize = vi.fn(() => '{"Account":{}}')
const constructed: unknown[] = []

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    constructor(config: unknown) {
      constructed.push(config)
    }
    getAuthCodeUrl = getAuthCodeUrl
    acquireTokenByCode = acquireTokenByCode
    getTokenCache() {
      return { serialize }
    }
  },
  CryptoProvider: class {
    generatePkceCodes = async () => ({ verifier: 'ver-1', challenge: 'chal-1' })
    createNewGuid = () => 'guid-1'
  },
  ResponseMode: { QUERY: 'query', FORM_POST: 'form_post', FRAGMENT: 'fragment' },
}))

import {
  generatePkce,
  newStateValue,
  buildAuthCodeUrl,
  redeemAuthCode,
  buildLogoutUrl,
} from '../../../lib/auth/entra.server'
import type { EntraConfig } from '../../../lib/auth/entra-config.server'

const CFG: EntraConfig = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  authority: 'https://login.microsoftonline.com/tenant-1',
  redirectUri: 'https://app.example/api/auth/callback',
  postLogoutRedirectUri: 'https://app.example/auth/signin',
  scopes: ['User.Read', 'Mail.Read'],
}

beforeEach(() => {
  vi.clearAllMocks()
  constructed.length = 0
})

describe('PKCE + state', () => {
  it('returns an S256 verifier/challenge pair', async () => {
    await expect(generatePkce()).resolves.toEqual({ verifier: 'ver-1', challenge: 'chal-1' })
  })

  it('mints an opaque state/nonce value', () => {
    expect(newStateValue()).toBe('guid-1')
  })
})

describe('buildAuthCodeUrl', () => {
  it('requests the config scopes/redirect with PKCE S256 and the query response mode', async () => {
    const url = await buildAuthCodeUrl({
      state: 'st',
      nonce: 'no',
      codeChallenge: 'chal-1',
      cfg: CFG,
    })

    expect(url).toBe('https://login.example/authorize?x=1')
    expect(getAuthCodeUrl).toHaveBeenCalledWith({
      scopes: CFG.scopes,
      redirectUri: CFG.redirectUri,
      state: 'st',
      nonce: 'no',
      codeChallenge: 'chal-1',
      codeChallengeMethod: 'S256',
      responseMode: 'query',
    })
  })

  it('builds the MSAL client from the supplied config', async () => {
    await buildAuthCodeUrl({ state: 's', nonce: 'n', codeChallenge: 'c', cfg: CFG })

    expect(constructed).toEqual([
      {
        auth: {
          clientId: 'client-1',
          authority: 'https://login.microsoftonline.com/tenant-1',
          clientSecret: 'secret-1',
        },
      },
    ])
  })
})

describe('redeemAuthCode', () => {
  it('returns the identity, home account id and serialized token cache', async () => {
    acquireTokenByCode.mockResolvedValueOnce({
      idTokenClaims: { oid: 'oid-9', preferred_username: 'Ann@corp.com', name: 'Ann', tid: 't-1' },
      account: { homeAccountId: 'home-9' },
    })

    const out = await redeemAuthCode({ code: 'code-1', codeVerifier: 'ver-1', cfg: CFG })

    expect(out.identity).toEqual({
      userId: 'oid-9',
      email: 'Ann@corp.com',
      displayName: 'Ann',
      tenantId: 't-1',
    })
    expect(out.homeAccountId).toBe('home-9')
    expect(out.tokenCache).toBe('{"Account":{}}')
  })

  // The argument POSITION is the whole test. MSAL reads the nonce from
  // `acquireTokenByCode`'s SECOND argument only (`ClientApplication.mjs:64` →
  // `ResponseHandler.mjs:89-92`, msal-node 5.4.2 / msal-common 16.11.2); the
  // request type has no `nonce` field at all, so passing it there type-checks
  // via the spread and is then silently dropped — i.e. the ID token is accepted
  // without being bound to this authorize request. The previous version of this
  // test asserted `calls[n][0]`, which pinned exactly the shape MSAL ignores.
  it('hands the nonce to MSAL as the auth-code payload (second argument), not the request', async () => {
    acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'o', email: 'a@b.c' },
      account: null,
    })

    await redeemAuthCode({ code: 'c', codeVerifier: 'v', nonce: 'n-1', cfg: CFG })

    const [request, payload] = acquireTokenByCode.mock.calls[0]
    expect(request).not.toHaveProperty('nonce')
    expect(payload).toEqual({ code: 'c', nonce: 'n-1' })
  })

  it('passes no auth-code payload when no nonce was supplied', async () => {
    acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'o', email: 'a@b.c' },
      account: null,
    })

    await redeemAuthCode({ code: 'c', codeVerifier: 'v', cfg: CFG })

    expect(acquireTokenByCode.mock.calls[0][0]).not.toHaveProperty('nonce')
    expect(acquireTokenByCode.mock.calls[0][1]).toBeUndefined()
  })

  // The fix above is only correct while MSAL still reads the nonce from
  // `acquireTokenByCode`'s SECOND argument. That contract lives in
  // node_modules, so pin it the way this repo pins its other vendor facts: a
  // bump that moves the check goes red HERE, beside the call site it justifies,
  // instead of silently re-opening #314 finding 1.
  it('MSAL still reads the nonce from the auth-code payload, not the request', () => {
    const msal = readFileSync(createRequire(import.meta.url).resolve('@azure/msal-node'), 'utf8')
    expect(msal).toContain('acquireTokenByCode(request, authCodePayLoad)')
    expect(msal).toContain('idTokenClaims.nonce !== authCodePayload.nonce')
  })

  it('reports a null home account when MSAL returns no account', async () => {
    acquireTokenByCode.mockResolvedValueOnce({
      idTokenClaims: { oid: 'o', email: 'a@b.c' },
    })

    await expect(redeemAuthCode({ code: 'c', codeVerifier: 'v', cfg: CFG })).resolves.toMatchObject(
      { homeAccountId: null },
    )
  })

  it('throws when the token endpoint returns nothing', async () => {
    acquireTokenByCode.mockResolvedValueOnce(null)

    await expect(redeemAuthCode({ code: 'c', codeVerifier: 'v', cfg: CFG })).rejects.toThrow(
      /no result for the authorization code/,
    )
  })

  it('propagates the claim-validation failure for a token with no oid', async () => {
    acquireTokenByCode.mockResolvedValueOnce({ idTokenClaims: { email: 'a@b.c' } })

    await expect(redeemAuthCode({ code: 'c', codeVerifier: 'v', cfg: CFG })).rejects.toThrow(
      /no `oid` claim/,
    )
  })
})

describe('buildLogoutUrl', () => {
  it('composes the v2.0 logout endpoint with the post-logout redirect', () => {
    const url = new URL(buildLogoutUrl(CFG))

    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/logout',
    )
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(CFG.postLogoutRedirectUri)
  })
})
