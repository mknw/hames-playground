/**
 * Action-token *loading* — the filesystem half of `action-tokens.server.ts`
 * (the pure parser is covered in `action-tokens.test.ts`).
 *
 * `node:fs` is faked so the config-path search, the process-lifetime cache and
 * the two fail-closed exits (file missing, file unreadable) can be asserted
 * without writing into the real `configs/` dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const existsSync = vi.fn<(p: string) => boolean>()
const readFileSync = vi.fn<(p: string, enc: string) => string>()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const patched = {
    ...actual,
    existsSync: (p: string) => existsSync(p),
    readFileSync: (p: string, enc: string) => readFileSync(p, enc),
  }
  return { ...patched, default: patched }
})

import { resolveActionUser, __resetActionTokenCache } from '../../../lib/auth/action-tokens.server'

const YAML = `
tokens:
  - label: phone
    secret: s3cr3t-A
    userId: oid-1
`

beforeEach(() => {
  vi.clearAllMocks()
  __resetActionTokenCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetActionTokenCache()
})

describe('resolveActionUser', () => {
  it('resolves a configured secret to its owner', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(YAML)

    expect(resolveActionUser('s3cr3t-A')).toBe('oid-1')
  })

  it('returns null for an unknown or blank secret', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(YAML)

    expect(resolveActionUser('nope')).toBeNull()
    expect(resolveActionUser('')).toBeNull()
    expect(resolveActionUser(null)).toBeNull()
    expect(resolveActionUser(undefined)).toBeNull()
  })

  it('reads the config once and serves later calls from cache', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(YAML)

    resolveActionUser('s3cr3t-A')
    resolveActionUser('s3cr3t-A')

    expect(readFileSync).toHaveBeenCalledTimes(1)
  })

  it('searches the repo-root configs/ dir first', () => {
    existsSync.mockImplementation((p) => p.endsWith('/configs/action-tokens.yaml'))
    readFileSync.mockReturnValue(YAML)

    resolveActionUser('s3cr3t-A')

    expect(readFileSync.mock.calls[0][0]).toMatch(/configs\/action-tokens\.yaml$/)
  })

  it('rejects every request when the config file is absent', () => {
    existsSync.mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(resolveActionUser('s3cr3t-A')).toBeNull()
    expect(readFileSync).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('rejects every request when the config file cannot be read', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockImplementation(() => {
      throw new Error('EACCES')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(resolveActionUser('s3cr3t-A')).toBeNull()
    expect(err).toHaveBeenCalled()
  })

  it('re-reads the file after the cache is dropped', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(YAML)
    resolveActionUser('s3cr3t-A')

    __resetActionTokenCache()
    readFileSync.mockReturnValue(`
tokens:
  - secret: s3cr3t-A
    userId: oid-rotated
`)

    expect(resolveActionUser('s3cr3t-A')).toBe('oid-rotated')
  })
})
