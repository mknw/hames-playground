/**
 * Tests for the Neo4j driver singleton.
 *
 * `neo4j-driver` and the endpoint config are mocked; the observable surface is
 * "one driver per process until reset, credentials taken from the env".
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
  getEndpoints: () => ({ neo4j: { bolt: 'bolt://test-host:7687' } }),
}))

/** Fresh module registry per test so the driver singleton starts unset. */
async function loadClient() {
  vi.resetModules()
  return import('../../../lib/neo4j/client')
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
  it('builds the driver from the configured bolt endpoint', async () => {
    const fake = { close: vi.fn() }
    driverFactory.mockReturnValue(fake)

    const { getNeo4jDriver } = await loadClient()
    expect(getNeo4jDriver()).toBe(fake)
    expect(driverFactory).toHaveBeenCalledWith('bolt://test-host:7687', {
      user: 'neo4j',
      password: 'password',
    })
  })

  it('uses NEO4J_USER / NEO4J_PASSWORD when they are set', async () => {
    driverFactory.mockReturnValue({ close: vi.fn() })
    process.env.NEO4J_USER = 'graph-reader'
    process.env.NEO4J_PASSWORD = 's3cret'

    const { getNeo4jDriver } = await loadClient()
    getNeo4jDriver()
    expect(basic).toHaveBeenCalledWith('graph-reader', 's3cret')
  })

  it('returns the same driver on repeated calls', async () => {
    driverFactory.mockReturnValue({ close: vi.fn() })
    const { getNeo4jDriver } = await loadClient()
    expect(getNeo4jDriver()).toBe(getNeo4jDriver())
    expect(driverFactory).toHaveBeenCalledTimes(1)
  })
})

describe('resetDriver', () => {
  it('closes the live driver so the next call reconnects', async () => {
    const first = { close: vi.fn().mockResolvedValue(undefined) }
    const second = { close: vi.fn() }
    driverFactory.mockReturnValueOnce(first).mockReturnValueOnce(second)

    const { getNeo4jDriver, resetDriver } = await loadClient()
    getNeo4jDriver()
    await resetDriver()

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(getNeo4jDriver()).toBe(second)
  })

  it('is a no-op when no driver was ever created', async () => {
    const { resetDriver } = await loadClient()
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
    const { verifyConnection } = await loadClient()
    await expect(verifyConnection()).resolves.toBe(true)
  })

  it('reports false instead of throwing when connectivity fails', async () => {
    driverFactory.mockReturnValue({
      close: vi.fn(),
      verifyConnectivity: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    })
    const { verifyConnection } = await loadClient()
    await expect(verifyConnection()).resolves.toBe(false)
  })
})
