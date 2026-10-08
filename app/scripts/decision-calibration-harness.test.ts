import { expect, it, vi } from 'vitest'
import type { LLMCallRecord } from '@hames-ai/harness-patterns'
import { runScenario } from '../evals/harness'
vi.mock('../evals/client', () => ({
  expectedClientFor: () => 'Expected',
  evalOverrideFor: () => undefined,
}))
it('adapter calls: serving identity, duration and output tokens reach runner result', async () => {
  const result = await runScenario(
    {
      id: 'synthetic',
      role: 'decide',
      title: 'synthetic',
      what: 'record adapter evidence',
      run: async (ctx) => {
        ctx.recordCall({
          clientName: 'Actual',
          durationMs: 17,
          usage: { outputTokens: 3 },
        } as LLMCallRecord)
        ctx.recordCall({ clientName: 'Untimed' } as LLMCallRecord)
        return { checks: [{ name: 'fixture', pass: true, detail: 'synthetic' }] }
      },
    },
    { mode: 'default', client: 'default' } as never,
  )
  expect(result.servedBy).toEqual(['Actual', 'Untimed'])
  expect(result.calls).toEqual([{ client: 'Actual', ms: 17, outputTokens: 3 }])
})
it('adapter calls: timing survives scenario failure', async () => {
  const result = await runScenario(
    {
      id: 'failure',
      role: 'decide',
      title: 'synthetic',
      what: 'record before failure',
      run: async (ctx) => {
        ctx.recordCall({ clientName: 'Actual', durationMs: 19 } as LLMCallRecord)
        throw new Error('synthetic failure')
      },
    },
    {} as never,
  )
  expect(result.calls).toEqual([{ client: 'Actual', ms: 19, outputTokens: undefined }])
  expect(result.error).toContain('synthetic failure')
})
