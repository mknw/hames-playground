/**
 * egress-policy tests — the pure profile → network/proxy/cache mapping behind
 * egress enforcement (#116). The argv is applied (and gateway boots asserted)
 * in docker-backend.test.ts; the proxy's own filtering in egress-proxy.test.ts.
 * These pin the names, the allowlist resolution and the env plumbing — a wrong
 * host string here is a silent policy hole there.
 */

import { describe, it, expect } from 'vitest'
import {
  OPEN_EGRESS_ENV,
  isEgressProfile,
  isOpenEgressEnabled,
  isProxiedProfile,
  egressNetworkName,
  egressGatewayName,
  egressAllowlist,
  proxyEnvArgs,
  DEFAULT_EGRESS_ALLOWLISTS,
} from '../../../lib/sandbox/egress-policy'

describe('isEgressProfile / isProxiedProfile', () => {
  it('recognizes exactly the three SELECTABLE profiles — open is not one of them', () => {
    for (const p of ['mcp-only', 'pypi', 'github-trusted'] as const) {
      expect(isEgressProfile(p)).toBe(true)
    }
    // 'open' is not selectable (#357 channel 4): a caller cannot request it —
    // the backend fails closed on it unless SANDBOX_ENABLE_OPEN_EGRESS=1.
    expect(isEgressProfile('open')).toBe(false)
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

describe('isOpenEgressEnabled (#357 channel 4)', () => {
  it(`is enabled ONLY by ${OPEN_EGRESS_ENV}=1 — unset is off`, () => {
    expect(isOpenEgressEnabled({})).toBe(false)
    expect(isOpenEgressEnabled({ [OPEN_EGRESS_ENV]: '' })).toBe(false)
    expect(isOpenEgressEnabled({ [OPEN_EGRESS_ENV]: ' ' })).toBe(false)
    expect(isOpenEgressEnabled({ [OPEN_EGRESS_ENV]: '0' })).toBe(false)
    expect(isOpenEgressEnabled({ [OPEN_EGRESS_ENV]: 'true' })).toBe(false)
    // Fail-closed spelling: anything that is not exactly '1' does not enable
    // unrestricted egress — a stray 'yes' or 'TRUE' must never open the box.
    expect(isOpenEgressEnabled({ [OPEN_EGRESS_ENV]: '1' })).toBe(true)
    expect(isOpenEgressEnabled({ [OPEN_EGRESS_ENV]: ' 1 ' })).toBe(true)
  })
})

describe('egress names', () => {
  it('derives the network + gateway names from the profile AND the boot id', () => {
    expect(egressNetworkName('pypi', 'sbx-abc123')).toBe('kg-sandbox-egress-pypi-sbx-abc123')
    expect(egressGatewayName('pypi', 'sbx-abc123')).toBe('kg-sandbox-egress-pypi-sbx-abc123-gw')
    expect(egressGatewayName('github-trusted', 'sbx-abc123')).toBe(
      'kg-sandbox-egress-github-trusted-sbx-abc123-gw',
    )
  })

  it('TWO boots of the same profile get DIFFERENT network and gateway names (per-boot isolation, Lane B)', () => {
    // The whole point of the bootId suffix: two boots of the same profile
    // must share no network and no gateway — a shared per-profile network
    // made every boot of that profile mutually reachable at L3.
    const a = egressNetworkName('pypi', 'sbx-aaaaaaaa')
    const b = egressNetworkName('pypi', 'sbx-bbbbbbbb')
    expect(a).not.toBe(b)
    expect(egressGatewayName('pypi', 'sbx-aaaaaaaa')).not.toBe(
      egressGatewayName('pypi', 'sbx-bbbbbbbb'),
    )
    // …and each gateway lives on exactly ITS boot's network.
    expect(egressGatewayName('pypi', 'sbx-aaaaaaaa')).toBe(`${a}-gw`)
    expect(egressGatewayName('pypi', 'sbx-bbbbbbbb')).toBe(`${b}-gw`)
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
    const args = proxyEnvArgs('pypi', 'sbx-abc123', 3128)
    const joined = args.join(' ')
    // uppercase (curl) + lowercase (most runtimes), both pointing at THIS
    // boot's gateway (container name on the boot's own internal network)
    expect(joined).toContain('HTTPS_PROXY=http://kg-sandbox-egress-pypi-sbx-abc123-gw:3128')
    expect(joined).toContain('https_proxy=http://kg-sandbox-egress-pypi-sbx-abc123-gw:3128')
    expect(joined).toContain('HTTP_PROXY=http://kg-sandbox-egress-pypi-sbx-abc123-gw:3128')
    expect(joined).toContain('http_proxy=http://kg-sandbox-egress-pypi-sbx-abc123-gw:3128')
    expect(joined).toContain('NO_PROXY=localhost,127.0.0.1')
    expect(joined).toContain('no_proxy=localhost,127.0.0.1')
    // everything is -e NAME=value pairs
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe('-e')
      expect(args[i + 1]).toMatch(/^[A-Za-z_]+=/)
    }
  })
})
