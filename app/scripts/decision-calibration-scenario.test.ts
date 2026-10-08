import { beforeEach, expect, it, vi } from 'vitest'
import type { DecideInput, DecideResult } from '@hames-ai/harness-patterns'
import { activeRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { feedDecisionCalibration } from '../src/lib/inference/decision-calibration.server'
import fixtures from '../evals/decision-calibration-fixtures.json'
const state = vi.hoisted(() => ({
  client: 'JevDecide',
  badKey: '',
  badSplit: '',
  writeFile: vi.fn(),
  tiers: [] as string[],
}))
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: state.writeFile }))
vi.mock('../evals/client', () => ({ expectedClientFor: () => state.client }))
vi.mock('@hames-ai/harness-baml/baml-adapters.server', () => ({
  createDecideAdapter:
    () =>
    async ({ spec, state: text }: DecideInput) => {
      state.tiers.push(activeRunFrame().inference?.tier ?? '')
      const item = fixtures.items.find((i) => i.key === spec.key && i.state === text)!
      const wrong = spec.key === state.badKey && item.split === state.badSplit
      const top = wrong ? spec.labels.find((l) => l.id !== item.truth)!.id : item.truth
      return {
        probs: Object.fromEntries(
          spec.labels.map((l) => [l.id, l.id === top ? 0.97 : 0.03 / (spec.labels.length - 1)]),
        ),
        method: state.client === 'JevDecide' ? 'jev' : 'logprob',
        calibrated: true,
        llmCall: { clientName: state.client, durationMs: 9 },
      } as DecideResult
    },
}))
import { decisionCalibrationScenario } from '../evals/scenarios/decision-calibration'
beforeEach(() => {
  state.writeFile.mockClear()
  state.badKey = ''
  state.badSplit = ''
  state.tiers = []
})
it('scenario artifact: writes only all-eight feasible, both client artifacts feed', async () => {
  for (const client of ['JevDecide', 'LocalQwenSmallDecide']) {
    state.client = client
    state.writeFile.mockClear()
    state.tiers = []
    const recordCall = vi.fn()
    const report = await decisionCalibrationScenario.run({
      routing: {} as never,
      recordCall,
      opts: () => ({ collector: [] }),
    })
    expect(state.writeFile).toHaveBeenCalledTimes(1)
    const artifact = JSON.parse(state.writeFile.mock.calls[0][1])
    expect(() => feedDecisionCalibration(artifact)).not.toThrow()
    expect(Object.keys(artifact.clients[client].entries)).toHaveLength(8)
    expect(recordCall).toHaveBeenCalledTimes(224)
    expect(new Set(state.tiers)).toEqual(new Set([client === 'JevDecide' ? 'anthropic' : 'verda']))
    expect(report.observations!.some((o) => o.name === `${client} × ALL: held-out pooled`)).toBe(
      true,
    )
  }
  state.client = 'JevDecide'
  state.badKey = 'route'
  state.badSplit = 'fit'
  state.writeFile.mockClear()
  const report = await decisionCalibrationScenario.run({
    routing: {} as never,
    recordCall: vi.fn(),
    opts: () => ({ collector: [] }),
  })
  expect(state.writeFile).not.toHaveBeenCalled()
  expect(report.observations!.find((o) => o.name === 'candidate artifact')!.value).toContain(
    'REFUSED',
  )
})
