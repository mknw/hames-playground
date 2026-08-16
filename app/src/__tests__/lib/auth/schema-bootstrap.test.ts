/**
 * Lazy schema bootstrap shared by `users.server.ts` and
 * `user-tokens.server.ts`.
 *
 * Both stores run their `CREATE TABLE IF NOT EXISTS` once per process. The
 * behaviour worth pinning is the failure path: a DDL error (Postgres not up
 * yet at first call) must surface to the caller AND leave the module able to
 * retry, rather than caching a rejected promise that poisons every later call
 * for the lifetime of the process.
 *
 * Each case re-imports the module so it starts from an un-bootstrapped state —
 * the "once per process" cache is module-level by design.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>()

vi.mock('../../../lib/db/client.server', () => ({
  query: (sql: string, params?: unknown[]) => query(sql, params),
}))

process.env.TOKEN_ENCRYPTION_KEY ||= 'unit-test-token-encryption-key'

const STORES = [
  {
    name: 'users',
    ddl: /CREATE TABLE IF NOT EXISTS users/,
    async read() {
      const m = await import('../../../lib/auth/users.server')
      return m.getUser('oid-1')
    },
  },
  {
    name: 'user_tokens',
    ddl: /CREATE TABLE IF NOT EXISTS user_tokens/,
    async read() {
      const m = await import('../../../lib/auth/user-tokens.server')
      return m.hasUserTokenCache('oid-1')
    },
  },
] as const

beforeEach(() => {
  query.mockReset()
  vi.resetModules()
})

describe.each(STORES)('$name schema bootstrap', ({ ddl, read }) => {
  const ddlCalls = () => query.mock.calls.filter((c) => ddl.test(c[0]))

  it('creates the table before the first read', async () => {
    query.mockResolvedValue({ rows: [] })

    await read()

    expect(query.mock.calls[0][0]).toMatch(ddl)
  })

  it('runs the DDL once across calls', async () => {
    query.mockResolvedValue({ rows: [] })

    await read()
    await read()

    expect(ddlCalls()).toHaveLength(1)
  })

  it('surfaces a DDL failure and still allows a retry afterwards', async () => {
    query.mockRejectedValueOnce(new Error('postgres starting up'))

    await expect(read()).rejects.toThrow('postgres starting up')

    query.mockResolvedValue({ rows: [] })
    await read()

    expect(ddlCalls()).toHaveLength(2)
  })
})
