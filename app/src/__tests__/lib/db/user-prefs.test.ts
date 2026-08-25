/**
 * Per-user inference-tier preference — the store and the default.
 *
 * Hermetic (`db/client.server` mocked): what is pinned is the SQL, the
 * owner-scoping, and the default rule, which is the part carrying an owner
 * decision rather than a mechanism.
 *
 * The default deserves the attention: the owner's call is "every preview user
 * starts on the self-hosted tier", but `runWithInferenceTier('verda')` throws
 * when the endpoint is unset, so defaulting an unconfigured deployment there
 * would make every turn throw. Both halves of that are asserted, because a
 * later reading of just one of them would look like a bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const query = vi.fn()
vi.mock('../../../lib/db/client.server', () => ({
  query: (...args: unknown[]) => query(...args),
}))

import {
  defaultInferenceTier,
  getStoredInferenceTier,
  isInferenceTier,
  resolveInferenceTier,
  setStoredInferenceTier,
} from '../../../lib/db/user-prefs.server'

const ENV_KEYS = ['VERDA_INFERENCE_ENDPOINT', 'VERDA_INFERENCE_API_KEY'] as const
let saved: Record<string, string | undefined>

function configureVerda(): void {
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** The last non-bootstrap statement. */
function lastRealQuery(): { sql: string; params: unknown[] } {
  const calls = query.mock.calls.filter((c) => !String(c[0]).includes('CREATE TABLE IF NOT EXISTS'))
  const last = calls[calls.length - 1]
  return { sql: String(last?.[0] ?? ''), params: (last?.[1] as unknown[]) ?? [] }
}

describe('isInferenceTier', () => {
  it('admits exactly the two tiers', () => {
    expect(isInferenceTier('verda')).toBe(true)
    expect(isInferenceTier('anthropic')).toBe(true)
  })

  it('rejects everything else, including near-misses and nullish', () => {
    for (const bad of ['VERDA', 'Anthropic', '', 'openai', null, undefined, 1, {}]) {
      expect(isInferenceTier(bad)).toBe(false)
    }
  })
})

describe('defaultInferenceTier — the owner’s preview decision', () => {
  it('is verda once the self-hosted endpoint is configured', () => {
    configureVerda()
    expect(defaultInferenceTier()).toBe('verda')
  })

  it('is anthropic when it is not, because the verda position would throw', () => {
    // Not a second policy: the fall-through to Anthropic that a `verda` default
    // would need is refused by design upstream, so refusing to *default* there
    // is the only option left.
    expect(defaultInferenceTier()).toBe('anthropic')
  })

  it('is anthropic for a misshapen endpoint too', () => {
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    expect(defaultInferenceTier()).toBe('anthropic')
  })
})

describe('getStoredInferenceTier', () => {
  it('reads the row scoped to the user id it was given', async () => {
    query.mockResolvedValue({ rows: [{ inference_tier: 'verda' }] })

    expect(await getStoredInferenceTier('user-1')).toBe('verda')
    const { sql, params } = lastRealQuery()
    expect(sql).toContain('FROM user_prefs WHERE user_id = $1')
    expect(params).toEqual(['user-1'])
  })

  it('returns null when the user has never chosen', async () => {
    query.mockResolvedValue({ rows: [] })
    expect(await getStoredInferenceTier('user-1')).toBeNull()
  })

  it('returns null for a NULL column rather than a falsy tier', async () => {
    query.mockResolvedValue({ rows: [{ inference_tier: null }] })
    expect(await getStoredInferenceTier('user-1')).toBeNull()
  })

  it('treats a tier this build does not know as "never chosen"', async () => {
    // The column is TEXT so adding a tier is not a migration. The cost is that
    // a row written by another build can hold a value that would reach
    // `runWithInferenceTier` as a silent no-op — reading like a choice while
    // changing nothing.
    query.mockResolvedValue({ rows: [{ inference_tier: 'openai' }] })
    expect(await getStoredInferenceTier('user-1')).toBeNull()
  })
})

describe('resolveInferenceTier', () => {
  it('prefers the stored choice over the default', async () => {
    configureVerda() // default would be 'verda'
    query.mockResolvedValue({ rows: [{ inference_tier: 'anthropic' }] })

    expect(await resolveInferenceTier('user-1')).toBe('anthropic')
  })

  it('falls back to the default when nothing is stored', async () => {
    configureVerda()
    query.mockResolvedValue({ rows: [] })

    expect(await resolveInferenceTier('user-1')).toBe('verda')
  })

  it('is the single resolver the header and the run both use', async () => {
    // If these two ever diverged the switch would show one thing while the
    // turn did another, which is the failure that makes a preview switch worse
    // than no switch.
    query.mockResolvedValue({ rows: [{ inference_tier: 'verda' }] })
    expect(await resolveInferenceTier('user-1')).toBe(await getStoredInferenceTier('user-1'))
  })
})

describe('setStoredInferenceTier', () => {
  it('upserts one row per user and bumps updated_at', async () => {
    await setStoredInferenceTier('user-1', 'verda')

    const { sql, params } = lastRealQuery()
    expect(sql).toContain('INSERT INTO user_prefs')
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE')
    expect(sql).toContain('updated_at     = NOW()')
    expect(params).toEqual(['user-1', 'verda'])
  })

  it('binds the tier as a parameter rather than interpolating it', async () => {
    await setStoredInferenceTier("user-'; DROP TABLE user_prefs; --", 'anthropic')

    const { sql, params } = lastRealQuery()
    expect(sql).not.toContain('DROP TABLE')
    expect(params[0]).toBe("user-'; DROP TABLE user_prefs; --")
  })
})
