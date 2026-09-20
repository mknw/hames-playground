/**
 * Neo4j configure seam (design S5, #225 PR-C1): explicit config wins over the
 * env fallback, and the app-boot call passes byte-identical values to what the
 * fallback would have produced — which is what makes the PR-C1 peel
 * behavior-preserving. The fallback's own behavior stays pinned by the
 * existing `client.test.ts`; this file covers only the NEW surface
 * (`configureNeo4j` + the explicit path).
 *
 * PR-C2 will remove the env fallback inside the package and add the named
 * unset error; these tests then move co-located with the package.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const driverFactory = vi.fn()
const basic = vi.fn((user: string, password: string) => ({ user, password }))

vi.mock('neo4j-driver', () => ({
  default: {
    driver: (...args: unknown[]) => driverFactory(...args),
    auth: { basic: (...args: [string, string]) => basic(...args) },
  },
}))

vi.mock('../../../lib/config/endpoints', () => ({
  getEndpoints: () => ({ neo4j: { bolt: 'bolt://fallback-host:7687' } }),
}))

/** Fresh module registry per load so the singleton/config state starts unset. */
async function loadClient() {
  vi.resetModules()
  return import('../../../lib/neo4j/client')
}

/** What the app-boot call in `middleware.ts` passes (same expressions). */
function bootConfig() {
  return {
    url: 'bolt://fallback-host:7687' /* getEndpoints().neo4j.bolt (mocked) */,
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'password',
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  driverFactory.mockReset()
  basic.mockClear()
  delete process.env.NEO4J_USER
  delete process.env.NEO4J_PASSWORD
})

describe('configureNeo4j (S5 seam)', () => {
  it('builds the driver from explicit config, ignoring env and endpoints', async () => {
    process.env.NEO4J_USER = 'env-user'
    process.env.NEO4J_PASSWORD = 'env-pass'
    const fake = { close: vi.fn() }
    driverFactory.mockReturnValue(fake)

    const { configureNeo4j, getNeo4jDriver } = await loadClient()
    configureNeo4j({ url: 'bolt://explicit:7687', user: 'configured', password: 'sekret' })

    expect(getNeo4jDriver()).toBe(fake)
    expect(driverFactory).toHaveBeenCalledWith('bolt://explicit:7687', {
      user: 'configured',
      password: 'sekret',
    })
    // The env fallback must not have been consulted at all.
    expect(basic).toHaveBeenCalledTimes(1)
  })

  it('boot-call values are byte-identical to the env fallback they replace', async () => {
    process.env.NEO4J_USER = 'graph-reader'
    process.env.NEO4J_PASSWORD = 's3cret'
    driverFactory.mockReturnValue({ close: vi.fn() })

    // Configured instance first — exactly what middleware.ts does at boot.
    const configured = await loadClient()
    configured.configureNeo4j(bootConfig())
    configured.getNeo4jDriver()
    const bootCall = driverFactory.mock.calls.at(-1)

    // Then an UNCONFIGURED fresh instance — the PR-C1 fallback path.
    const fallback = await loadClient()
    fallback.getNeo4jDriver()

    expect(bootCall).toEqual(driverFactory.mock.calls.at(-1))
  })

  it('re-configure drops the live driver so the next call reconnects', async () => {
    const first = { close: vi.fn() }
    const second = { close: vi.fn() }
    driverFactory.mockReturnValueOnce(first).mockReturnValueOnce(second)

    const { configureNeo4j, getNeo4jDriver } = await loadClient()
    configureNeo4j({ url: 'bolt://a:7687', user: 'u', password: 'p' })
    expect(getNeo4jDriver()).toBe(first)

    configureNeo4j({ url: 'bolt://b:7687', user: 'u', password: 'p' })
    expect(getNeo4jDriver()).toBe(second)
    expect(driverFactory).toHaveBeenLastCalledWith('bolt://b:7687', { user: 'u', password: 'p' })
  })

  it('refuses an empty bolt url loudly rather than composing a broken driver', async () => {
    const { configureNeo4j } = await loadClient()
    expect(() => configureNeo4j({ url: '  ', user: 'u', password: 'p' })).toThrow(
      /non-empty bolt url/,
    )
    expect(driverFactory).not.toHaveBeenCalled()
  })
})
