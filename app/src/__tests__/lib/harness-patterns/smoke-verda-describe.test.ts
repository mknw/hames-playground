/** Step 5's verdict with fake describe calls; never run the live smoke or preflight. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as adapters from '@hames-ai/harness-baml/baml-adapters.server'
import { VERDA_CLIENT_BY_ROLE } from '@hames-ai/harness-baml/clients.server'
import { notifyLlmUsage } from '@hames-ai/harness-patterns/llm-usage-observer.server'
import { smokeDescribe } from '../../../lib/inference/scripts/smoke-verda'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network is forbidden in this hermetic test')
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(adapters, 'describeToolResultsBatchOp').mockImplementation(async () => {
    notifyLlmUsage({
      functionName: 'ResultDescribeBatch',
      clientName: VERDA_CLIENT_BY_ROLE.describe,
    })
    return new Map([['a', 'Synthetic batch summary']])
  })
  vi.spyOn(adapters, 'describeToolResultOp').mockImplementation(async () => {
    notifyLlmUsage({ functionName: 'ResultDescribe', clientName: VERDA_CLIENT_BY_ROLE.describe })
    return 'Synthetic single summary'
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('smokeDescribe', () => {
  it('accepts both describe calls accounted against the mapped private client', async () => {
    await expect(smokeDescribe()).resolves.toBeUndefined()
  })

  it.each(['ResultDescribeBatch', 'ResultDescribe'])(
    'rejects %s on the stale 27B client',
    async (fn) => {
      if (fn === 'ResultDescribeBatch') {
        vi.mocked(adapters.describeToolResultsBatchOp).mockImplementation(async () => {
          notifyLlmUsage({ functionName: fn, clientName: 'VerdaQwen' })
          return new Map([['a', 'Synthetic batch summary']])
        })
      } else {
        vi.mocked(adapters.describeToolResultOp).mockImplementation(async () => {
          notifyLlmUsage({ functionName: fn, clientName: 'VerdaQwen' })
          return 'Synthetic single summary'
        })
      }

      await expect(smokeDescribe()).rejects.toThrow(
        `${fn}: accounted against VerdaQwen, expected ${VERDA_CLIENT_BY_ROLE.describe}`,
      )
    },
  )

  it.each(['ResultDescribeBatch', 'ResultDescribe'])(
    'rejects missing accounting for %s',
    async (fn) => {
      if (fn === 'ResultDescribeBatch') {
        vi.mocked(adapters.describeToolResultsBatchOp).mockResolvedValue(
          new Map([['a', 'Synthetic batch summary']]),
        )
      } else {
        vi.mocked(adapters.describeToolResultOp).mockResolvedValue('Synthetic single summary')
      }

      await expect(smokeDescribe()).rejects.toThrow(`${fn} produced no usage sample`)
    },
  )
})
