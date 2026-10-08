import { afterEach, describe, expect, it, vi } from 'vitest'
const { decide } = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('@hames-ai/harness-baml/baml-adapters.server', () => ({
  createDecideAdapter: () => decide,
}))
import { smokeDecide } from '../../../lib/inference/scripts/smoke-verda'

afterEach(() => vi.restoreAllMocks())
describe('decide smoke — synthetic adapter, no live requests', () => {
  const valid = {
    probs: { yes: 0.9, no: 0.1 },
    method: 'logprob',
    coverage: 0.99,
    llmCall: { clientName: 'LocalQwenSmallDecide' },
  }
  it('smoke evidence: a usable private-tier result passes; wrong/missing client refuses', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    decide.mockResolvedValue(valid)
    await expect(smokeDecide()).resolves.toBeUndefined()
    for (const llmCall of [undefined, { clientName: 'VerdaQwen' }, { clientName: 'JevDecide' }]) {
      decide.mockResolvedValue({ ...valid, llmCall })
      await expect(smokeDecide()).rejects.toThrow(/served by/)
    }
    decide.mockResolvedValue({ ...valid, method: 'jev' })
    await expect(smokeDecide()).rejects.toThrow(/served by/)
  })
  it('smoke distribution: invalid normalization and empty coverage refuse', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const patch of [
      { probs: { yes: 0.9, no: 0.9 } },
      { probs: { yes: NaN, no: 0.1 } },
      { coverage: 0 },
    ]) {
      decide.mockResolvedValue({ ...valid, ...patch })
      await expect(smokeDecide()).rejects.toThrow(/distribution/)
    }
  })
})
