/**
 * The direct-Redis *connection* half of `redis-direct.server.ts`: the lazy
 * singleton, its env-derived options, the two teardown paths, and the
 * `STASH_DIRECT_REDIS` toggle that decides whether the Data Stash talks to
 * redis directly or through the MCP gateway.
 *
 * `ioredis` is faked, so nothing here opens a socket. The properties that
 * matter: importing the module must never connect (`lazyConnect`), the client
 * is shared until explicitly dropped, and a connection error is logged rather
 * than thrown at the server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const gatewayCallTool = vi.fn(async () => ({ success: true, data: 'gateway' }))
vi.mock('../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: (...args: unknown[]) => gatewayCallTool(...(args as [])),
}))

const built: Array<Record<string, unknown>> = []
const disconnect = vi.fn()
const quit = vi.fn(async () => 'OK')
const handlers = new Map<string, (err: Error) => void>()

vi.mock('ioredis', () => ({
  Redis: class {
    constructor(opts: Record<string, unknown>) {
      built.push(opts)
    }
    on(evt: string, fn: (err: Error) => void) {
      handlers.set(evt, fn)
      return this
    }
    disconnect = disconnect
    quit = quit
    smembers = vi.fn(async () => ['a'])
  },
}))

import {
  getRedis,
  resetRedisDirect,
  closeRedisDirect,
  stashCallTool,
  directCallTool,
  gatewayCallTool as reExportedGateway,
} from '../../lib/redis-direct.server'

const ENV_KEYS = [
  'REDIS_HOST_DIRECT',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PWD',
  'REDIS_PASSWORD',
  'REDIS_SSL',
  'STASH_DIRECT_REDIS',
] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

beforeEach(() => {
  resetRedisDirect()
  built.length = 0
  handlers.clear()
  vi.clearAllMocks()
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  resetRedisDirect()
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('getRedis', () => {
  it('connects lazily to localhost:6379 by default', () => {
    getRedis()

    expect(built).toHaveLength(1)
    expect(built[0]).toMatchObject({ host: 'localhost', port: 6379, lazyConnect: true })
    expect(built[0].password).toBeUndefined()
    expect(built[0].tls).toBeUndefined()
  })

  it('prefers REDIS_HOST_DIRECT over REDIS_HOST', () => {
    process.env.REDIS_HOST = 'redis'
    process.env.REDIS_HOST_DIRECT = 'localhost-direct'

    getRedis()

    expect(built[0]).toMatchObject({ host: 'localhost-direct' })
  })

  it('reads host, port, password and TLS from the environment', () => {
    process.env.REDIS_HOST = 'cache.internal'
    process.env.REDIS_PORT = '6380'
    process.env.REDIS_PWD = 'hunter2'
    process.env.REDIS_SSL = 'true'

    getRedis()

    expect(built[0]).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      password: 'hunter2',
      tls: {},
    })
  })

  it('accepts REDIS_PASSWORD as the password fallback', () => {
    process.env.REDIS_PASSWORD = 'from-fallback'

    getRedis()

    expect(built[0]).toMatchObject({ password: 'from-fallback' })
  })

  it('reuses the singleton across calls', () => {
    expect(getRedis()).toBe(getRedis())
    expect(built).toHaveLength(1)
  })

  it('logs a connection error instead of letting it crash the server', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    getRedis()

    handlers.get('error')!(new Error('ECONNREFUSED'))

    expect(err).toHaveBeenCalledWith(expect.stringContaining('[redis-direct]'), 'ECONNREFUSED')
    err.mockRestore()
  })
})

describe('teardown', () => {
  it('resetRedisDirect drops the client so the next call reconnects', () => {
    const first = getRedis()

    resetRedisDirect()

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(getRedis()).not.toBe(first)
  })

  it('closeRedisDirect quits gracefully', async () => {
    getRedis()

    await closeRedisDirect()

    expect(quit).toHaveBeenCalledTimes(1)
    expect(disconnect).not.toHaveBeenCalled()
    expect(built).toHaveLength(1)
  })

  it('closeRedisDirect falls back to disconnect when QUIT fails', async () => {
    getRedis()
    quit.mockRejectedValueOnce(new Error('already gone'))

    await closeRedisDirect()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('closeRedisDirect is a no-op when nothing is connected', async () => {
    await closeRedisDirect()

    expect(quit).not.toHaveBeenCalled()
    expect(built).toHaveLength(0)
  })
})

describe('stashCallTool', () => {
  it('routes through the MCP gateway by default', async () => {
    expect(stashCallTool()).toBe(reExportedGateway)

    await stashCallTool()('smembers', { name: 'k' })
    expect(gatewayCallTool).toHaveBeenCalled()
  })

  it('routes directly when STASH_DIRECT_REDIS=1', async () => {
    process.env.STASH_DIRECT_REDIS = '1'

    expect(stashCallTool()).toBe(directCallTool)

    await stashCallTool()('smembers', { name: 'k' })
    expect(gatewayCallTool).not.toHaveBeenCalled()
  })

  it('is read per call, so flipping the flag takes effect without a re-import', () => {
    process.env.STASH_DIRECT_REDIS = '1'
    expect(stashCallTool()).toBe(directCallTool)

    process.env.STASH_DIRECT_REDIS = '0'
    expect(stashCallTool()).toBe(reExportedGateway)
  })
})
