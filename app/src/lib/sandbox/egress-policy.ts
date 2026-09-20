/**
 * egress-policy — the pure profile → container-args mapping for egress
 * enforcement (#116). Which docker network a sandbox sits on, which proxy it
 * is pointed at, and which hosts that proxy will accept: all decided here,
 * applied by `docker-backend.server.ts`.
 *
 * Enforcement model for the proxied profiles (`pypi`, `github-trusted`):
 * the sandbox container is attached to an **internal-only** docker network —
 * no route to the outside at the bridge level. The only process on that
 * network with external reach is the allowlist CONNECT proxy the backend
 * runs beside it (see `rootfs/egress-proxy/proxy.mjs`), and the sandbox is
 * handed the proxy through `HTTPS_PROXY`/`HTTP_PROXY` env vars. Well-behaved
 * clients (uv, pip, curl, git) honour those vars and are filtered by host;
 * anything that ignores them has no route out at all. Fail-closed by
 * construction — the allowlist is the network topology, not a request
 * header. Residual leak: DNS *resolution* may still resolve depending on
 * the host's docker DNS behaviour; connections are not routed — at most
 * this reveals that a hostname exists.
 *
 * `open` is deliberately unproxied — no enforcement and no audit, because
 * there is no chokepoint to log at. It is NOT a selectable profile (#357
 * channel 4): `EGRESS_PROFILES` and `isEgressProfile` admit only the three
 * above, so a caller that requests `open` fails CLOSED to `mcp-only` at the
 * backend, never falls through to the bridge — same as an unknown name. The
 * single-operator escape hatch is `SANDBOX_ENABLE_OPEN_EGRESS=1`, read at the
 * backend per boot via `isOpenEgressEnabled`; only then does `open` keep its
 * documented posture (default bridge, unproxied, unaudited).
 *
 * Pure and I/O-free — safe to import anywhere. Host allowlists are env-
 * overridable so a deployment can tighten them without a rebuild.
 */

import type { RuntimeConfig } from './types'

export type EgressProfile = NonNullable<RuntimeConfig['egress']>

/**
 * The SELECTABLE profiles — what a caller may request. `open` is deliberately
 * absent (#357 channel 4): it stays in the `EgressProfile` type for the
 * single-operator escape hatch (`isOpenEgressEnabled`), but no caller can
 * select it, and a requested `open` fails closed at the backend like an
 * unknown profile.
 */
export const EGRESS_PROFILES = ['mcp-only', 'pypi', 'github-trusted'] as const

export function isEgressProfile(value: unknown): value is EgressProfile {
  return typeof value === 'string' && (EGRESS_PROFILES as readonly string[]).includes(value)
}

/** The single-operator escape hatch that re-admits `open` (#357 channel 4). */
export const OPEN_EGRESS_ENV = 'SANDBOX_ENABLE_OPEN_EGRESS'

/**
 * Whether this deployment has opted into `open`'s documented posture (default
 * bridge, unproxied, unaudited). Env is a parameter, not `process.env`, so
 * this stays pure and I/O-free like the rest of the module; the backend reads
 * `process.env` per boot, the same layer as the other SANDBOX_* knobs.
 * Only the exact value `1` (trimmed) enables it — anything else, including
 * `true`/`yes`, is OFF: a knob that admits unrestricted egress fails closed
 * on a misspelling.
 */
export function isOpenEgressEnabled(env: Record<string, string | undefined>): boolean {
  return env[OPEN_EGRESS_ENV]?.trim() === '1'
}

/** Default host allowlists. `githubusercontent.com` covers the
 *  objects/raw/gist/media subdomains via the proxy's suffix matching. */
export const DEFAULT_EGRESS_ALLOWLISTS: Record<'pypi' | 'github-trusted', readonly string[]> = {
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  'github-trusted': [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'githubusercontent.com',
  ],
}

/** Docker network that carries a profile's sandboxes + its proxy. */
export function egressNetworkName(profile: 'pypi' | 'github-trusted'): string {
  return `kg-sandbox-egress-${profile}`
}

/** Container name of the profile's allowlist proxy (resolvable by that name
 *  from inside the internal network — docker's embedded DNS serves container
 *  names on user-defined networks). */
export function egressGatewayName(profile: 'pypi' | 'github-trusted'): string {
  return `${egressNetworkName(profile)}-gw`
}

/** Profiles routed through the allowlist proxy. */
export function isProxiedProfile(profile: EgressProfile): profile is 'pypi' | 'github-trusted' {
  return profile === 'pypi' || profile === 'github-trusted'
}

/** The env var that overrides a profile's default allowlist. */
const ALLOWLIST_ENV: Record<'pypi' | 'github-trusted', string> = {
  pypi: 'SANDBOX_EGRESS_PYPI_ALLOWLIST',
  'github-trusted': 'SANDBOX_EGRESS_GITHUB_ALLOWLIST',
}

/**
 * Resolve a proxied profile's host allowlist: the env override
 * (comma-separated) when set, else the committed defaults. The proxy matches
 * a host when it equals an entry or ends with `.` + entry, so `pypi.org`
 * admits `pypi.org` exactly while `githubusercontent.com` admits every
 * `*.githubusercontent.com` subdomain.
 */
export function egressAllowlist(
  profile: 'pypi' | 'github-trusted',
  env: Record<string, string | undefined>,
): string[] {
  const raw = env[ALLOWLIST_ENV[profile]]?.trim()
  if (!raw) return [...DEFAULT_EGRESS_ALLOWLISTS[profile]]
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  // An explicitly EMPTY override would mean "deny all egress", which is
  // expressible but should not be reachable by a stray `FOO=` line — same
  // convention as bash-guard: empty text means unset, not "allow nothing".
  return hosts.length > 0 ? hosts : [...DEFAULT_EGRESS_ALLOWLISTS[profile]]
}

/**
 * The `-e` argv that hands the sandbox its proxy. Both cases are set (curl
 * reads the uppercase pair, most runtimes the lowercase one) so no client
 * falls out of the policy by spelling.
 */
export function proxyEnvArgs(profile: 'pypi' | 'github-trusted', port: number): string[] {
  const proxy = `http://${egressGatewayName(profile)}:${port}`
  return [
    '-e',
    `HTTPS_PROXY=${proxy}`,
    '-e',
    `https_proxy=${proxy}`,
    '-e',
    `HTTP_PROXY=${proxy}`,
    '-e',
    `http_proxy=${proxy}`,
    '-e',
    'NO_PROXY=localhost,127.0.0.1',
    '-e',
    'no_proxy=localhost,127.0.0.1',
  ]
}
