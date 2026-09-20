/**
 * Tests for the Neo4j driver singleton — EXPLICIT CONFIG ONLY (#225 PR-C2).
 *
 * `neo4j-driver` is mocked; the observable surface is "one driver per process
 * until reset, built from exactly the config the host handed over". There is
 * deliberately NO env fallback in the package (design S5, the C1-deferred
 * work): unset config is a NAMED error at first use, and the environment is
 * never consulted — the two `NEO4J_USER`/`NEO4J_PASSWORD` tests below pin
 * that by setting the vars and proving they change nothing.
 *
 * The env-credential behaviour these tests replace (PR-C1's transitional
 * fallback) lived in the host app's `client.test.ts` + `client-config-seam
 * .test.ts`; the surviving cases — configure wins, re-configure drops the
 * live driver, the empty-url refusal — moved here with the module.
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

/** Fresh module registry per test so the driver/config state starts unset. */
async function loadClient() {
  vi.resetModules()
  return import('../../neo4j/client')
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  driverFactory.mockReset()
  basic.mockClear()
  delete process.env.NEO4J_USER
  delete process.env.NEO4J_PASSWORD
})

describe('getNeo4jDriver', () => {
  it('builds the driver from exactly the explicit config', async () => {
    const fake = { close: vi.fn() }
    driverFactory.mockReturnValue(fake)

    const { configureNeo4j, getNeo4jDriver } = await loadClient()
    configureNeo4j({ url: 'bolt://explicit:7687', user: 'configured', password: 'sekret' })

    expect(getNeo4jDriver()).toBe(fake)
    expect(driverFactory).toHaveBeenCalledTimes(1)
    expect(driverFactory).toHaveBeenCalledWith('bolt://explicit:7687', {
      user: 'configured',
      password: 'sekret',
    })
  })

  it('NEVER consults the environment — set vars change nothing', async () => {
    // The package must not grow an env fallback back: these vars would have
    // fed the PR-C1 transitional path the host used to carry.
    process.env.NEO4J_USER = 'env-user'
    process.env.NEO4J_PASSWORD = 'env-pass'
    driverFactory.mockReturnValue({ close: vi.fn() })

    const { configureNeo4j, getNeo4jDriver } = await loadClient()
    configureNeo4j({ url: 'bolt://a:7687', user: 'u', password: 'p' })
    getNeo4jDriver()

    expect(basic).toHaveBeenCalledTimes(1)
    expect(basic).toHaveBeenCalledWith('u', 'p')
  })

  it('throws the NAMED unset error at first use when never configured', async () => {
    const { getNeo4jDriver, Neo4jNotConfiguredError } = await loadClient()

    expect(() => getNeo4jDriver()).toThrow(Neo4jNotConfiguredError)
    expect(() => getNeo4jDriver()).toThrow(/configureNeo4j/)
    expect(driverFactory).not.toHaveBeenCalled()
  })

  it('the named unset error still throws with env credentials present', async () => {
    // The inverse of the env test above: the env vars alone must not satisfy
    // the client — only an explicit configure does.
    process.env.NEO4J_USER = 'env-user'
    process.env.NEO4J_PASSWORD = 'env-pass'

    const { getNeo4jDriver } = await loadClient()
    expect(() => getNeo4jDriver()).toThrow(/Neo4j is not configured/)
    expect(driverFactory).not.toHaveBeenCalled()
  })

  it('returns the same driver on repeated calls', async () => {
    driverFactory.mockReturnValue({ close: vi.fn() })
    const { configureNeo4j, getNeo4jDriver } = await loadClient()
    configureNeo4j({ url: 'bolt://a:7687', user: 'u', password: 'p' })
    expect(getNeo4jDriver()).toBe(getNeo4jDriver())
    expect(driverFactory).toHaveBeenCalledTimes(1)
  })
})

describe('configureNeo4j', () => {
  it('refuses an empty bolt url loudly rather than composing a broken driver', async () => {
    const { configureNeo4j } = await loadClient()
    expect(() => configureNeo4j({ url: '  ', user: 'u', password: 'p' })).toThrow(
      /non-empty bolt url/,
    )
    expect(driverFactory).not.toHaveBeenCalled()
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
})

describe('resetDriver', () => {
  it('closes the live driver so the next call reconnects', async () => {
    const first = { close: vi.fn().mockResolvedValue(undefined) }
    const second = { close: vi.fn() }
    driverFactory.mockReturnValueOnce(first).mockReturnValueOnce(second)

    const { configureNeo4j, getNeo4jDriver, resetDriver } = await loadClient()
    configureNeo4j({ url: 'bolt://a:7687', user: 'u', password: 'p' })
    getNeo4jDriver()
    await resetDriver()

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(getNeo4jDriver()).toBe(second)
  })

  it('is a no-op when no driver was ever created', async () => {
    const { configureNeo4j, resetDriver } = await loadClient()
    configureNeo4j({ url: 'bolt://a:7687', user: 'u', password: 'p' })
    await expect(resetDriver()).resolves.toBeUndefined()
    expect(driverFactory).not.toHaveBeenCalled()
  })
})

describe('verifyConnection', () => {
  it('reports true when the driver can reach the database', async () => {
    driverFactory.mockReturnValue({
      close: vi.fn(),
      verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    })
    const { configureNeo4j, verifyConnection } = await loadClient()
    configureNeo4j({ url: 'bolt://a:7687', user: 'u', password: 'p' })
    await expect(verifyConnection()).resolves.toBe(true)
  })

  it('reports false instead of throwing when connectivity fails', async () => {
    driverFactory.mockReturnValue({
      close: vi.fn(),
      verifyConnectivity: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    })
    const { configureNeo4j, verifyConnection } = await loadClient()
    configureNeo4j({ url: 'bolt://a:7687', user: 'u', password: 'p' })
    await expect(verifyConnection()).resolves.toBe(false)
  })

  it('reports false (not a throw) when unconfigured', async () => {
    const { verifyConnection } = await loadClient()
    await expect(verifyConnection()).resolves.toBe(false)
    expect(driverFactory).not.toHaveBeenCalled()
  })
})
