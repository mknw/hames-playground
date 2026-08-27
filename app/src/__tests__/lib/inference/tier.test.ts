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

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
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

const getStoredInferenceTier = vi.fn<(id: string) => Promise<'verda' | 'anthropic' | null>>(
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
 *  `verdaConfigured()` asks about both, so a fixture setting only the first
 *  describes a deployment on which the private position is refused. */
const ENV_KEYS = [
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
  'SMALL_LLM_BASE_URL',
] as const
let saved: Record<string, string | undefined>

function configureVerda(): void {
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
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
  it('prefers the conversation over everything else', () => {
    configureVerda() // the default would be 'verda'
    expect(resolveTier('anthropic', 'verda')).toBe('anthropic')
  })

  it('falls to the user’s last-used tier when the conversation has none', () => {
    configureVerda()
    expect(resolveTier(null, 'anthropic')).toBe('anthropic')
  })

  it('falls to the deployment default when neither says anything', () => {
    configureVerda()
    expect(resolveTier(null, null)).toBe('verda')
  })

  it('is anthropic by default when the private tier is unconfigured', () => {
    // Not a second policy — `runWithInferenceTier('verda')` throws when the
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
})

describe('chooseConversationTier', () => {
  it('writes BOTH the conversation and the seed, against the owner it was given', async () => {
    configureVerda()
    await expect(chooseConversationTier('conv-1', 'user-1', 'verda')).resolves.toBe('verda')

    // The row write is what makes the flip stick to THIS conversation; the seed
    // write is where a flip lands when the conversation has no row yet, and is
    // what makes the next new chat start here.
    expect(setConversationInferenceTier).toHaveBeenCalledWith('conv-1', 'user-1', 'verda')
    expect(setStoredInferenceTier).toHaveBeenCalledWith('user-1', 'verda')
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
    configureVerda()
    setConversationInferenceTier.mockRejectedValueOnce(new Error('postgres is down'))

    await expect(chooseConversationTier('conv-1', 'user-1', 'verda')).rejects.toThrow(
      'postgres is down',
    )
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it('refuses a tier it does not recognise rather than storing it', async () => {
    for (const bad of ['openai', null, { tier: 'verda' }, '']) {
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
    await expect(chooseConversationTier('conv-1', 'user-1', 'verda')).rejects.toThrow(
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
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    await expect(chooseConversationTier('conv-1', 'user-1', 'verda')).rejects.toThrow(
      /self-hosted inference endpoint is not configured/,
    )
  })
})
