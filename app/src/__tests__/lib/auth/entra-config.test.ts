/**
 * Entra config validation (#119). `buildEntraConfig` is pure w.r.t. its `env`
 * arg, so no `process.env` juggling.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// Bypass the server-only guard in the jsdom test env.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  buildEntraConfig,
  isEntraConfigured,
  msalConfiguration,
  AAD_HOST,
  DEFAULT_GRAPH_SCOPES,
} from '../../../lib/auth/entra-config.server'

const full = {
  AZURE_TENANT_ID: 'tid',
  AZURE_CLIENT_ID: 'cid',
  AZURE_CLIENT_SECRET: 'secret',
}

describe('isEntraConfigured', () => {
  it('is true only when all three secrets are present + non-blank', () => {
    expect(isEntraConfigured(full)).toBe(true)
    expect(isEntraConfigured({ ...full, AZURE_CLIENT_SECRET: '' })).toBe(false)
    expect(isEntraConfigured({ ...full, AZURE_TENANT_ID: '   ' })).toBe(false)
    expect(isEntraConfigured({})).toBe(false)
  })
})

describe('buildEntraConfig', () => {
  it('derives the single-tenant authority and dev defaults', () => {
    const cfg = buildEntraConfig(full)
    expect(cfg.authority).toBe(`${AAD_HOST}/tid`)
    expect(cfg.redirectUri).toBe('http://localhost:3444/api/auth/callback')
    expect(cfg.postLogoutRedirectUri).toBe('http://localhost:3444/auth/signin')
    expect(cfg.scopes).toEqual([...DEFAULT_GRAPH_SCOPES])
  })

  it('requests the full connector scope set at sign-in (#110)', () => {
    const cfg = buildEntraConfig(full)
    // One consent must cover every connector: background runs have no user
    // present to consent later.
    for (const s of [
      'User.Read',
      'email',
      'Mail.Read',
      'Calendars.Read',
      'Files.Read.All',
      'Sites.Read.All',
    ]) {
      expect(cfg.scopes).toContain(s)
    }
  })

  // Mutation: adding Mail.Send, Calendars.ReadWrite, Files.ReadWrite.All or
  // a new *.Write / *.Send scope to DEFAULT_GRAPH_SCOPES must turn this red.
  it('never requests a write or send scope in the default set', () => {
    expect(DEFAULT_GRAPH_SCOPES.filter((scope) => /write|send/i.test(scope))).toEqual([])
  })

  it('AZURE_GRAPH_SCOPES trims the set without a code change', () => {
    const cfg = buildEntraConfig({ ...full, AZURE_GRAPH_SCOPES: 'User.Read, Mail.Read' })
    expect(cfg.scopes).toEqual(['User.Read', 'Mail.Read'])
  })

  // Mutation: delete parseScopes' write/send rejection. Every case must fail.
  it.each([
    'Mail.Send',
    'Calendars.ReadWrite',
    'Files.ReadWrite.All',
    'Tasks.ReadWrite.Shared',
    'Custom.Write',
    'Custom.Write.All',
    'Custom.Send',
    'Custom.Send.Shared',
    'Custom.SendMail',
    'https://graph.microsoft.com/Mail.Send',
    'mail.sEND',
  ])('rejects the write override %s instead of silently dropping it', (scope) => {
    expect(() =>
      buildEntraConfig({ ...full, AZURE_GRAPH_SCOPES: `User.Read, ${scope} Mail.Read` }),
    ).toThrow(/AZURE_GRAPH_SCOPES.*write\/send.*read-only/)
  })

  it('accepts all shipped read scopes in an override', () => {
    expect(
      buildEntraConfig({ ...full, AZURE_GRAPH_SCOPES: DEFAULT_GRAPH_SCOPES.join(', ') }).scopes,
    ).toEqual([...DEFAULT_GRAPH_SCOPES])
  })

  it('accepts whitespace-separated overrides and ignores blanks', () => {
    const cfg = buildEntraConfig({ ...full, AZURE_GRAPH_SCOPES: '  User.Read   Mail.Read  ' })
    expect(cfg.scopes).toEqual(['User.Read', 'Mail.Read'])
  })

  it('falls back to the default set for a blank/empty override', () => {
    expect(buildEntraConfig({ ...full, AZURE_GRAPH_SCOPES: '   ' }).scopes).toEqual([
      ...DEFAULT_GRAPH_SCOPES,
    ])
    expect(buildEntraConfig({ ...full, AZURE_GRAPH_SCOPES: ' , , ' }).scopes).toEqual([
      ...DEFAULT_GRAPH_SCOPES,
    ])
  })

  it('strips reserved OIDC scopes from an override (MSAL would throw)', () => {
    const cfg = buildEntraConfig({
      ...full,
      AZURE_GRAPH_SCOPES: 'openid profile offline_access User.Read',
    })
    expect(cfg.scopes).toEqual(['User.Read'])
  })

  it('does NOT list reserved OIDC scopes (MSAL adds them)', () => {
    const cfg = buildEntraConfig(full)
    for (const reserved of ['openid', 'profile', 'offline_access']) {
      expect(cfg.scopes).not.toContain(reserved)
    }
  })

  it('honors explicit redirect / post-logout overrides', () => {
    const cfg = buildEntraConfig({
      ...full,
      AUTH_REDIRECT_URI: 'https://app.example/api/auth/callback',
      AUTH_POST_LOGOUT_REDIRECT_URI: 'https://app.example/auth/signin',
    })
    expect(cfg.redirectUri).toBe('https://app.example/api/auth/callback')
    expect(cfg.postLogoutRedirectUri).toBe('https://app.example/auth/signin')
  })

  it('throws naming the specific missing var', () => {
    expect(() => buildEntraConfig({ AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' })).toThrow(
      /AZURE_TENANT_ID/,
    )
    expect(() => buildEntraConfig({ AZURE_TENANT_ID: 't', AZURE_CLIENT_SECRET: 's' })).toThrow(
      /AZURE_CLIENT_ID/,
    )
    expect(() => buildEntraConfig({ AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c' })).toThrow(
      /AZURE_CLIENT_SECRET/,
    )
  })

  it('msalConfiguration mirrors the auth fields', () => {
    const msal = msalConfiguration(buildEntraConfig(full))
    expect(msal.auth.clientId).toBe('cid')
    expect(msal.auth.authority).toBe(`${AAD_HOST}/tid`)
    expect(msal.auth.clientSecret).toBe('secret')
  })
})

describe('scope validation at server boot', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  // Mutation: delete the module-scope parseScopes call; this must turn red.
  it('refuses a write override on import before credentials or requests are needed', async () => {
    vi.resetModules()
    vi.stubEnv('AZURE_GRAPH_SCOPES', 'User.Read Mail.Send')
    await expect(import('../../../lib/auth/entra-config.server')).rejects.toThrow(
      /AZURE_GRAPH_SCOPES.*write\/send.*read-only/,
    )
  })

  it('allows a read-only override on import without credentials', async () => {
    vi.resetModules()
    vi.stubEnv('AZURE_GRAPH_SCOPES', 'Mail.Read Calendars.Read')
    await expect(import('../../../lib/auth/entra-config.server')).resolves.toBeDefined()
  })
})
