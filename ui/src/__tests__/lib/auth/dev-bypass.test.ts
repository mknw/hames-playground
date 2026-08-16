import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isBypassEnabled, BYPASS_USER } from '../../../lib/auth/dev-bypass'

// `isBypassEnabled()` reads `import.meta.env` at call-time, so we can mutate
// the live env object between tests rather than re-importing the module.

describe('isBypassEnabled', () => {
  let originalDev: unknown
  let originalBypass: unknown

  beforeEach(() => {
    originalDev = import.meta.env.DEV
    originalBypass = import.meta.env.VITE_DEV_BYPASS_AUTH
  })

  afterEach(() => {
    ;(import.meta.env as Record<string, unknown>).DEV = originalDev
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH = originalBypass
  })

  it("returns true when DEV is true and VITE_DEV_BYPASS_AUTH is 'true'", () => {
    ;(import.meta.env as Record<string, unknown>).DEV = true
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH = 'true'
    expect(isBypassEnabled()).toBe(true)
  })

  it("returns false when DEV is true but VITE_DEV_BYPASS_AUTH is 'false'", () => {
    ;(import.meta.env as Record<string, unknown>).DEV = true
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH = 'false'
    expect(isBypassEnabled()).toBe(false)
  })

  it('returns false when DEV is true but VITE_DEV_BYPASS_AUTH is undefined', () => {
    ;(import.meta.env as Record<string, unknown>).DEV = true
    delete (import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH
    expect(isBypassEnabled()).toBe(false)
  })

  it("returns false in a production build even with VITE_DEV_BYPASS_AUTH='true' (the load-bearing prod guard)", () => {
    ;(import.meta.env as Record<string, unknown>).DEV = false
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH = 'true'
    expect(isBypassEnabled()).toBe(false)
  })

  it("returns false when DEV is false and VITE_DEV_BYPASS_AUTH is 'false'", () => {
    ;(import.meta.env as Record<string, unknown>).DEV = false
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH = 'false'
    expect(isBypassEnabled()).toBe(false)
  })

  it("rejects non-string-'true' values for VITE_DEV_BYPASS_AUTH (only the literal string opts in)", () => {
    ;(import.meta.env as Record<string, unknown>).DEV = true
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH = 'TRUE'
    expect(isBypassEnabled()).toBe(false)
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_BYPASS_AUTH = '1'
    expect(isBypassEnabled()).toBe(false)
  })
})

describe('misconfiguration warning at module load', () => {
  const env = import.meta.env as Record<string, unknown>
  const originalDev = env.DEV
  const originalBypass = env.VITE_DEV_BYPASS_AUTH

  afterEach(() => {
    env.DEV = originalDev
    env.VITE_DEV_BYPASS_AUTH = originalBypass
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('warns when a production build still has the bypass env var set', async () => {
    env.DEV = false
    env.VITE_DEV_BYPASS_AUTH = 'true'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()

    await import('../../../lib/auth/dev-bypass')

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('VITE_DEV_BYPASS_AUTH=true is set in a production build'),
    )
  })

  it('stays silent in a production build without the env var', async () => {
    env.DEV = false
    env.VITE_DEV_BYPASS_AUTH = 'false'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()

    await import('../../../lib/auth/dev-bypass')

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('BYPASS_USER', () => {
  it('exposes the shared mock user id agreed with the backend (dev-bypass-user)', () => {
    expect(BYPASS_USER).toEqual({
      id: 'dev-bypass-user',
      email: 'dev@local',
    })
  })
})
