import { describe, it, expect, vi } from 'vitest'
import {
  settleMemory,
  type MemoryStoreConfig,
} from '@hames-ai/harness-patterns/memory-store.server'
import { createContext, createEvent } from '@hames-ai/harness-patterns/context.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type { DecideFn } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const choices: Record<string, string> = {
  target: 'personal_memory',
  confirm: 'skip',
  kind: 'preference',
  sensitive: 'ordinary',
}
const decide = (async ({ spec }: { spec: { key: string; labels: readonly { id: string }[] } }) => ({
  probs: Object.fromEntries(
    spec.labels.map((l) => [l.id, l.id === choices[spec.key.split('.').at(-1)!] ? 0.94 : 0.001]),
  ),
  method: 'logprob',
  calibrated: true,
})) as DecideFn
function fixture() {
  const ctx = createContext('I always prefer metric units, please keep that in mind.')
  ctx.events.push(
    createEvent('assistant_message', 'answer', { content: 'Metric units it is.', final: true }),
  )
  const transaction = vi.fn(async () => {
    throw Object.assign(new Error('delete won'), { code: '23503' })
  })
  const extract = vi.fn(async () => ({
    value: [
      {
        kind: 'preference',
        content: 'The user prefers metric units.',
        evidence: 'I always prefer metric units',
      },
    ],
  }))
  const cfg: MemoryStoreConfig = {
    owner: () => 'synthetic-owner',
    store: { transaction },
    decide,
    extract,
    embed: {
      spaceId: 'local:synthetic:1024',
      query: async () => [],
      documents: async () => [Array(1024).fill(0.1)],
    },
    awaitWake: async () => 'awake',
    settings: { enabled: () => true },
  }
  return { ctx, cfg, extract, transaction }
}
describe('host settle fail-closed seams', () => {
  it.each(['23503', '55P03'])(
    'a delete refusal %s counts failed, without retry or replacement conversation',
    async (code) => {
      const { ctx, cfg, transaction } = fixture()
      transaction.mockRejectedValue(Object.assign(new Error('delete won'), { code }))
      const report = await withRunFrame({ inference: { tier: 'verda' } }, () =>
        settleMemory(ctx, cfg, { conversationId: 'claimed-row-id' }),
      )
      expect(report.failed).toBe(1)
      expect(report.written).toBe(0)
      expect(transaction).toHaveBeenCalledTimes(1)
      expect(ctx.events.filter((e) => e.type === 'memory_written')).toHaveLength(0)
    },
  )
  it('a rejected or skipped wake never calls the extractor or write store', async () => {
    for (const awaitWake of [
      async () => {
        throw new Error('refused')
      },
      async () => 'skipped' as const,
    ]) {
      const { ctx, cfg, extract, transaction } = fixture()
      const report = await withRunFrame({ inference: { tier: 'verda' } }, () =>
        settleMemory(ctx, { ...cfg, awaitWake }, { conversationId: 'claimed-row-id' }),
      )
      expect(report.skipped).toBe('waking')
      expect(extract).not.toHaveBeenCalled()
      expect(transaction).not.toHaveBeenCalled()
    }
  })
})
