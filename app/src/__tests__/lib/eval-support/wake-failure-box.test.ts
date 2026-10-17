// @vitest-environment node
import { it, expect } from 'vitest'
import { wakeFailureReason } from '../../../lib/eval-support/wake-failure'

it('names the box that failed, from the real wake messages', async () => {
  const w = await import('../../../lib/inference/wake.server')
  expect(wakeFailureReason(new Error(`${w.SMALL_LLM_WAKE_FAILED}: 3 attempts over 720s`))).toBe(
    'SMALL_LLM_WAKE_FAILED',
  )
  expect(wakeFailureReason(new Error(`${w.VERDA_WAKE_FAILED} (the 27B, X): 3 attempts`))).toBe(
    'VERDA_WAKE_FAILED',
  )
  expect(wakeFailureReason(new Error('aborted'))).toBe('PRIVATE_TIER_WAKE_FAILED')
})
