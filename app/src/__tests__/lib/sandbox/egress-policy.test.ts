/**
 * egress-policy tests — the pure profile → network/proxy/cache mapping behind
 * egress enforcement (#116). The argv is applied (and gateway boots asserted)
 * in docker-backend.test.ts; the proxy's own filtering in egress-proxy.test.ts.
 * These pin the names, the allowlist resolution and the env plumbing — a wrong
 * host string here is a silent policy hole there.
 */

import { describe, it, expect } from 'vitest'
import {
  isEgressProfile,
  isProxiedProfile,
  egressNetworkName,
  egressGatewayName,
  egressAllowlist,
  proxyEnvArgs,
  DEFAULT_EGRESS_ALLOWLISTS,
} from '../../../lib/sandbox/egress-policy'

describe('isEgressProfile / isProxiedProfile', () => {
  it('recognizes exactly the four named profiles', () => {
    for (const p of ['mcp-only', 'pypi', 'github-trusted', 'open'] as const) {
      expect(isEgressProfile(p)).toBe(true)
    }
    // An unknown string is NOT a profile — the backend fails closed on it.
    expect(isEgressProfile('unrestricted')).toBe(false)
    expect(isEgressProfile(undefined)).toBe(false)
  })

  it('marks pypi and github-trusted as proxied; mcp-only and open are not', () => {
    expect(isProxiedProfile('pypi')).toBe(true)
    expect(isProxiedProfile('github-trusted')).toBe(true)
    expect(isProxiedProfile('mcp-only')).toBe(false)
    expect(isProxiedProfile('open')).toBe(false)
  })
})

describe('egress names', () => {
  it('derives a stable network + gateway container name per profile', () => {
    expect(egressNetworkName('pypi')).toBe('kg-sandbox-egress-pypi')
    expect(egressGatewayName('pypi')).toBe('kg-sandbox-egress-pypi-gw')
    expect(egressGatewayName('github-trusted')).toBe('kg-sandbox-egress-github-trusted-gw')
  })
})

describe('egressAllowlist', () => {
  it('defaults: pypi is pypi.org + files.pythonhosted.org', () => {
    expect(egressAllowlist('pypi', {})).toEqual(DEFAULT_EGRESS_ALLOWLISTS.pypi)
    expect(egressAllowlist('github-trusted', {})).toEqual(
      DEFAULT_EGRESS_ALLOWLISTS['github-trusted'],
    )
  })

  it('env override replaces the default list (tighten or re-scope)', () => {
    expect(
      egressAllowlist('pypi', { SANDBOX_EGRESS_PYPI_ALLOWLIST: 'internal-mirror.corp, pypi.org' }),
    ).toEqual(['internal-mirror.corp', 'pypi.org'])
  })

  it('an empty override value means unset, not "allow nothing"', () => {
    expect(egressAllowlist('pypi', { SANDBOX_EGRESS_PYPI_ALLOWLIST: '  ' })).toEqual(
      DEFAULT_EGRESS_ALLOWLISTS.pypi,
    )
  })
})

describe('proxyEnvArgs', () => {
  it('hands the sandbox both proxy spellings and a localhost no-proxy carve-out', () => {
    const args = proxyEnvArgs('pypi', 3128)
    const joined = args.join(' ')
    // uppercase (curl) + lowercase (most runtimes), both pointing at the
    // gateway's container name on the internal network
    expect(joined).toContain('HTTPS_PROXY=http://kg-sandbox-egress-pypi-gw:3128')
    expect(joined).toContain('https_proxy=http://kg-sandbox-egress-pypi-gw:3128')
    expect(joined).toContain('HTTP_PROXY=http://kg-sandbox-egress-pypi-gw:3128')
    expect(joined).toContain('http_proxy=http://kg-sandbox-egress-pypi-gw:3128')
    expect(joined).toContain('NO_PROXY=localhost,127.0.0.1')
    expect(joined).toContain('no_proxy=localhost,127.0.0.1')
    // everything is -e NAME=value pairs
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe('-e')
      expect(args[i + 1]).toMatch(/^[A-Za-z_]+=/)
    }
  })
})
