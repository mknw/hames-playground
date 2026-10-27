/**
 * The tier a CONVERSATION runs on — the resolution order and the one write.
 *
 * This module is the single answer to "where does this turn's calls land", and
 * both the turn runner and the switch beside the agent selector go through it.
 * That is the property worth pinning: two resolvers, one of them a prefix of
 * the other, is exactly how a control ends up showing a tier the run does not
 * take.
 *
 * The repository and the prefs row are mocked. What is under test is the ORDER
 * and the refusals, not SQL — `db/conversations.test.ts` owns the column's
 * round trip against a real Postgres.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const getConversationInferenceTier = vi.fn<(id: string, userId: string) => Promise<string | null>>(
  async () => null,
)
const setConversationInferenceTier = vi.fn<
  (id: string, userId: string, tier: string) => Promise<void>
>(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  getConversationInferenceTier: (id: string, userId: string) =>
    getConversationInferenceTier(id, userId),
  setConversationInferenceTier: (id: string, userId: string, tier: string) =>
    setConversationInferenceTier(id, userId, tier),
}))

const getStoredInferenceTier = vi.fn<(id: string) => Promise<'self_deployed' | 'anthropic' | null>>(
  async () => null,
)
const setStoredInferenceTier = vi.fn<(id: string, tier: string) => Promise<void>>(async () => {})
vi.mock('../../../lib/db/user-prefs.server', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/db/user-prefs.server')>(
    '../../../lib/db/user-prefs.server',
  )
  return {
    ...actual,
    getStoredInferenceTier: (id: string) => getStoredInferenceTier(id),
    setStoredInferenceTier: (id: string, tier: string) => setStoredInferenceTier(id, tier),
  }
})

import {
  chooseConversationTier,
  resolveConversationTier,
  resolveTier,
} from '../../../lib/inference/tier.server'

/** BOTH endpoints the private tier needs — the 27B and the 4B summarizer.
 *  `selfDeployedConfigured()` asks about both, so a fixture setting only the first
 *  describes a deployment on which the private position is refused. */
const ENV_KEYS = [
  'INFERENCE_TIERS',
  'LARGE_LLM_BASE_URL',
  'LARGE_LLM_API_KEY',
  'SMALL_LLM_BASE_URL',
  'SMALL_LLM_DECISIONS_URL',
  'SMALL_LLM_API_KEY',
] as const
let saved: Record<string, string | undefined>

function configureSelfDeployed(): void {
  process.env.LARGE_LLM_BASE_URL = 'https://example.invalid/deployment/v1'
  process.env.LARGE_LLM_API_KEY = 'test-key'
  process.env.SMALL_LLM_DECISIONS_URL = 'https://private.example/v1/systemone'
  process.env.SMALL_LLM_API_KEY = 'synthetic-private-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.clearAllMocks()
  getConversationInferenceTier.mockResolvedValue(null)
  getStoredInferenceTier.mockResolvedValue(null)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('resolveTier — the order', () => {
  it('normalizes a legacy conversation before considering a public seed', () => {
    expect(resolveTier('verda', 'anthropic')).toBe('self_deployed')
  })

  it('prefers the conversation over everything else', () => {
    configureSelfDeployed() // the default would be 'self_deployed'
    expect(resolveTier('anthropic', 'self_deployed')).toBe('anthropic')
  })

  it('falls to the user’s last-used tier when the conversation has none', () => {
    configureSelfDeployed()
    expect(resolveTier(null, 'anthropic')).toBe('anthropic')
  })

  it('falls to the deployment default when neither says anything', () => {
    configureSelfDeployed()
    expect(resolveTier(null, null)).toBe('self_deployed')
  })

  it('is anthropic by default when the private tier is unconfigured', () => {
    // Not a second policy — `runWithInferenceTier('self_deployed')` throws when the
    // endpoint is unset, so defaulting there would make every turn fail rather
    // than fall through (the fall-through is refused by design).
    expect(resolveTier(null, null)).toBe('anthropic')
  })

  it('treats a value this build does not recognise as "no tier of its own"', () => {
    // The column is TEXT so adding a tier is not a migration; the cost is that
    // a row written by another build can hold something meaningless here.
    // Passing it through would reach `runWithInferenceTier` as a silent no-op
    // that READS like a choice, which is worse than falling back.
    expect(resolveTier('openai', 'anthropic')).toBe('anthropic')
    expect(resolveTier('', 'anthropic')).toBe('anthropic')
  })
})

describe('resolveConversationTier', () => {
  it('reads the row and the seed for the SAME owner', async () => {
    getConversationInferenceTier.mockResolvedValue('anthropic')
    expect(await resolveConversationTier('conv-1', 'user-1')).toBe('anthropic')
    expect(getConversationInferenceTier).toHaveBeenCalledWith('conv-1', 'user-1')
    expect(getStoredInferenceTier).toHaveBeenCalledWith('user-1')
  })

  it('answers for a conversation that does not exist yet', async () => {
    // Every chat before its first message. The repository cannot distinguish
    // "no row", "not yours" and "no tier", and neither should this: all three
    // resolve through the seed, which is what that chat's first turn will
    // record on the row it creates.
    getConversationInferenceTier.mockResolvedValue(null)
    getStoredInferenceTier.mockResolvedValue('anthropic')
    expect(await resolveConversationTier('never-persisted', 'user-1')).toBe('anthropic')
  })

  it('keeps a conversation tier it read when the SEED read fails', async () => {
    // The two reads are independent and their failures have to be too. Under
    // `Promise.all` this rejected, and the caller's fall-back is the env flag
    // (`activeInferenceTier()`), not `defaultInferenceTier()` — so on the
    // deployment shape docs/PREVIEW.md allows (endpoints configured,
    // USE_SELF_DEPLOYED_INFERENCE unset) a conversation the user had PINNED to the
    // private tier ran its next turn on Anthropic, while its sidebar glyph
    // still said Private. The seed is only ever consulted when the column has
    // nothing, so losing it here costs nothing at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getConversationInferenceTier.mockResolvedValue('self_deployed')
    getStoredInferenceTier.mockRejectedValue(new Error('user_prefs schema is unavailable'))

    await expect(resolveConversationTier('conv-1', 'user-1')).resolves.toBe('self_deployed')

    // `allSettled` is also what makes the failure invisible — the caller's
    // `.catch()` can no longer fire — so the resolver says which half it lost.
    // Exactly one line, because the half that DID answer must not be reported
    // as a failure too.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('last-used inference tier for user-1')
    warn.mockRestore()
  })

  it('falls to the seed when the CONVERSATION read fails, rather than rejecting', async () => {
    // The other direction of the same decoupling, pinned so the asymmetry is
    // visible: there is no recorded tier to keep, so the user's last-used one
    // is the nearest answer left. Still a fall-back — a nearer one than the
    // caller's env flag.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getConversationInferenceTier.mockRejectedValue(new Error('conversations is unavailable'))
    getStoredInferenceTier.mockResolvedValue('anthropic')

    await expect(resolveConversationTier('conv-1', 'user-1')).resolves.toBe('anthropic')

    // The half worth naming: this is the read whose failure routes a PINNED
    // thread somewhere else while the sidebar glyph still shows the column.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("conversation conv-1's own inference tier")
    warn.mockRestore()
  })

  it('falls to the deployment default when BOTH reads fail', async () => {
    // Fail-closed by construction: `defaultInferenceTier()` answers `anthropic`
    // on a deployment with no endpoint and `self_deployed` on one that has it. The
    // pre-existing fall-open ABOVE this function — a rejection reaching
    // `turn.server.ts`'s `activeInferenceTier()` — is #303 and is deliberately
    // not touched here; this pins that the rejection no longer happens.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getConversationInferenceTier.mockRejectedValue(new Error('conversations is unavailable'))
    getStoredInferenceTier.mockRejectedValue(new Error('user_prefs is unavailable'))

    await expect(resolveConversationTier('conv-1', 'user-1')).resolves.toBe('anthropic')

    // Both halves reported, one line each, so the log distinguishes a total
    // read failure from either single one.
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("conversation conv-1's own inference tier"),
      expect.stringContaining('last-used inference tier for user-1'),
    ])

    configureSelfDeployed()
    await expect(resolveConversationTier('conv-1', 'user-1')).resolves.toBe('self_deployed')
    warn.mockRestore()
  })
})

describe('chooseConversationTier', () => {
  it('writes BOTH the conversation and the seed, against the owner it was given', async () => {
    configureSelfDeployed()
    await expect(chooseConversationTier('conv-1', 'user-1', 'self_deployed')).resolves.toBe(
      'self_deployed',
    )

    // The row write is what makes the flip stick to THIS conversation; the seed
    // write is where a flip lands when the conversation has no row yet, and is
    // what makes the next new chat start here.
    expect(setConversationInferenceTier).toHaveBeenCalledWith('conv-1', 'user-1', 'self_deployed')
    expect(setStoredInferenceTier).toHaveBeenCalledWith('user-1', 'self_deployed')
    // ROW FIRST. The seed is the observable half — one row per user — so
    // ordering them is what makes its arrival imply the conversation's, instead
    // of leaving a window where the choice looks landed and the conversation is
    // still on the old tier.
    expect(setConversationInferenceTier.mock.invocationCallOrder[0]).toBeLessThan(
      setStoredInferenceTier.mock.invocationCallOrder[0],
    )
  })

  it('leaves the seed alone when the conversation write fails', async () => {
    // The better failure direction: a flip that did not take must not silently
    // re-aim the user's next new chat.
    configureSelfDeployed()
    setConversationInferenceTier.mockRejectedValueOnce(new Error('postgres is down'))

    await expect(chooseConversationTier('conv-1', 'user-1', 'self_deployed')).rejects.toThrow(
      'postgres is down',
    )
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it("reads a pre-rename tab's legacy literal as self_deployed and stores the new one", async () => {
    configureSelfDeployed()
    await expect(chooseConversationTier('conv-1', 'user-1', 'verda')).resolves.toBe('self_deployed')
    expect(setConversationInferenceTier).toHaveBeenCalledWith('conv-1', 'user-1', 'self_deployed')
    expect(setStoredInferenceTier).toHaveBeenCalledWith('user-1', 'self_deployed')
  })

  it('refuses a tier it does not recognise rather than storing it', async () => {
    for (const bad of ['openai', null, { tier: 'self_deployed' }, '', 'Verda', 'private']) {
      await expect(chooseConversationTier('conv-1', 'user-1', bad)).rejects.toThrow(
        /Unknown inference tier/,
      )
    }
    expect(setConversationInferenceTier).not.toHaveBeenCalled()
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it('refuses the private position when the endpoint is unconfigured', async () => {
    // Storing it would park a row that `runWithInferenceTier` throws on, so the
    // user's next message breaks — and the alternative the flag exists to
    // prevent (quietly running on Anthropic instead) is worse still.
    await expect(chooseConversationTier('conv-1', 'user-1', 'self_deployed')).rejects.toThrow(
      /self-hosted inference endpoint is not configured/,
    )
    expect(setConversationInferenceTier).not.toHaveBeenCalled()
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it('still allows opting OUT when the endpoint is unconfigured', async () => {
    await expect(chooseConversationTier('conv-1', 'user-1', 'anthropic')).resolves.toBe('anthropic')
    expect(setConversationInferenceTier).toHaveBeenCalledWith('conv-1', 'user-1', 'anthropic')
  })

  it('refuses the private position when only the 27B endpoint is configured', async () => {
    // The private tier is two models, so its configuration is a conjunction:
    // a deployment with no summarizer endpoint is REFUSED rather than descaled
    // onto the 27B, which would be a routing change nobody asked for.
    process.env.LARGE_LLM_BASE_URL = 'https://example.invalid/deployment/v1'
    process.env.LARGE_LLM_API_KEY = 'test-key'
    await expect(chooseConversationTier('conv-1', 'user-1', 'self_deployed')).rejects.toThrow(
      /self-hosted inference endpoint is not configured/,
    )
  })
})

describe('private-only deployment', () => {
  beforeEach(() => {
    process.env.INFERENCE_TIERS = 'private'
    configureSelfDeployed()
  })

  it.each([
    ['anthropic', 'anthropic'],
    ['anthropic', 'self_deployed'],
    [null, 'anthropic'],
    [null, null],
    ['unknown', 'anthropic'],
    ['self_deployed', 'anthropic'],
  ] as const)('clamps stored tier %s and seed %s to private', (stored, seed) => {
    expect(resolveTier(stored, seed)).toBe('self_deployed')
  })

  it('clamps old rows through the asynchronous resolver', async () => {
    getConversationInferenceTier.mockResolvedValue('anthropic')
    getStoredInferenceTier.mockResolvedValue('anthropic')
    expect(await resolveConversationTier('old-conversation', 'user-1')).toBe('self_deployed')
  })

  it('refuses a public selection before either write', async () => {
    await expect(chooseConversationTier('conv-1', 'user-1', 'anthropic')).rejects.toThrow(
      /private inference only/,
    )
    expect(setConversationInferenceTier).not.toHaveBeenCalled()
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it('allows the private selection', async () => {
    await expect(chooseConversationTier('conv-1', 'user-1', 'self_deployed')).resolves.toBe(
      'self_deployed',
    )
  })
})
