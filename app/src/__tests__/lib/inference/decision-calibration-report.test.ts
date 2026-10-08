// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecideFn, DecideResult, DecisionCalibrationEntry } from '@hames-ai/harness-patterns'
import {
  evaluateKey,
  diagnosticCriteria,
  criteriaObservation,
  criterion,
  OWNER_TUNABLE_DEFAULTS,
  calibrationTier,
  completeEntries,
  pooledReport,
} from '../../../lib/inference/decision-calibration-report'
import { CALIBRATION_SPECS } from '../../../lib/inference/decision-calibration-specs.server'
import {
  feedDecisionCalibration,
  calibrationFingerprint,
  CALIBRATION_REVISION,
} from '../../../lib/inference/decision-calibration.server'
import {
  decisionCalibrationFor,
  configureDecisionCalibration,
} from '@hames-ai/harness-baml/clients.server'
import { readFileSync } from 'node:fs'
import { applyFit, calibrationMetrics } from '../../../lib/inference/decision-calibration-math'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const fixtures = JSON.parse(readFileSync('evals/decision-calibration-fixtures.json', 'utf8'))
afterEach(() => {
  vi.unstubAllEnvs()
  configureDecisionCalibration({})
})
const criteria = OWNER_TUNABLE_DEFAULTS
function fake(jev: boolean, wrongSplit = '', probability = 0.97): DecideFn {
  return async ({ spec, state }) => {
    const item = fixtures.items.find(
      (i: { key: string; state: string }) => i.key === spec.key && i.state === state,
    )
    const top =
      item.split === wrongSplit ? spec.labels.find((l) => l.id !== item.truth)!.id : item.truth
    return {
      probs: Object.fromEntries(
        spec.labels.map((l) => [
          l.id,
          l.id === top ? probability : (1 - probability) / (spec.labels.length - 1),
        ]),
      ),
      method: jev ? 'jev' : 'logprob',
      calibrated: jev,
      coverage: jev ? undefined : 0.99,
      llmCall: { clientName: jev ? 'JevDecide' : 'LocalQwenSmallDecide', durationMs: 12 },
    } as DecideResult
  }
}
async function reports(jev = true, wrongSplit = '', probability = 0.97) {
  return Promise.all(
    CALIBRATION_SPECS.map((spec) =>
      evaluateKey({
        spec,
        items: fixtures.items.filter((i: { key: string }) => i.key === spec.key),
        decide: fake(jev, wrongSplit, probability),
        jev,
        client: jev ? 'JevDecide' : 'LocalQwenSmallDecide',
        criteria,
      }),
    ),
  )
}
const parsed = (r: Awaited<ReturnType<typeof evaluateKey>>, suffix: string) =>
  JSON.parse(r.observations.find((o) => o.name.endsWith(suffix))!.value)
describe('decision calibration behavioural report', () => {
  it('checks: passing and holdout fakes pin all four per-key checks and details', async () => {
    for (const jev of [true, false]) {
      for (const wrongSplit of ['', 'holdout']) {
        const rs = await reports(jev, wrongSplit)
        for (const [i, r] of rs.entries()) {
          const key = CALIBRATION_SPECS[i].key
          const measured = parsed(r, ': held-out fitted')
          const items = fixtures.items.filter((item: { key: string }) => item.key === key)
          const fitCount = items.filter((item: { split: string }) => item.split === 'fit').length
          const holdoutCount = items.length - fitCount
          expect(r.checks).toEqual([
            {
              name: `${key}: nonempty fit and holdout`,
              pass: true,
              detail: `fit=${fitCount}; holdout=${holdoutCount}`,
            },
            {
              name: `${key}: cuts have a feasible fit`,
              pass: true,
              detail: `${fitCount}/${fitCount} fit samples retained at accuracy floor 0.95`,
            },
            {
              name: `${key}: held-out calibration`,
              pass: wrongSplit === '',
              detail: `ECE=${measured.ece}; ceiling=0.05`,
            },
            {
              name: `${key}: held-out retained accuracy`,
              pass: wrongSplit === '',
              detail: JSON.stringify({ retained: measured.retained, metrics: measured.metrics }),
            },
          ])
        }
      }
    }
  })
  it('checks: exact .95 retained accuracy passes the owner floor', async () => {
    const spec = {
      key: 'floor',
      question: 'synthetic',
      labels: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
      ],
    }
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      key: spec.key,
      state: String(i),
      truth: i === 39 ? 'b' : 'a',
      split: i < 20 ? 'fit' : 'holdout',
    }))
    const decide: DecideFn = async () =>
      ({
        probs: { a: 0.95, b: 0.05 },
        method: 'jev',
        calibrated: true,
        llmCall: { clientName: 'JevDecide', functionName: 'Decide', variables: {} },
      }) as DecideResult
    const r = await evaluateKey({ spec, items, decide, jev: true, client: 'JevDecide', criteria })
    const measured = parsed(r, ': held-out fitted')
    expect(measured.metrics.accuracy).toBe(0.95)
    expect(r.checks.find((c) => c.name === 'floor: held-out retained accuracy')).toEqual({
      name: 'floor: held-out retained accuracy',
      pass: true,
      detail: JSON.stringify({ retained: measured.retained, metrics: measured.metrics }),
    })
  })
  it('moderate ECE: .8 probability at perfect accuracy reopens per-key and pooled Jev verdicts', async () => {
    const rs = await reports(true, '', 0.8)
    for (const r of rs) {
      expect(parsed(r, ': held-out fitted').ece).toBeCloseTo(0.2)
      expect(r.observations.at(-1)!.value).toMatch(/^REOPEN G7\(a\): Jev measured ECE=/)
    }
    const pool = pooledReport(
      'JevDecide',
      true,
      rs.flatMap((r) => r.holdout),
      criteria,
    )
    expect(JSON.parse(pool.observations[0].value).ece).toBeCloseTo(0.2)
    expect(pool.observations[1].value).toMatch(/^REOPEN G7\(a\): Jev pooled measured ECE=/)
  })
  it('pooled fitted holdout: non-identity logprob fit supplies concatenated per-key measured samples', async () => {
    const fitted = []
    const raw = []
    const returned = []
    for (const key of ['bias-one', 'bias-two']) {
      const spec = {
        key,
        question: 'synthetic bias',
        labels: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
        ],
      }
      const samples = [
        ...Array.from({ length: 20 }, () => ({ truth: 'b', probs: { a: 0.6, b: 0.4 } })),
        ...Array.from({ length: 20 }, () => ({ truth: 'a', probs: { a: 0.75, b: 0.25 } })),
      ]
      const items = ['fit', 'holdout'].flatMap((split) =>
        samples.map((sample, i) => ({
          id: `${split}-${i}`,
          key,
          state: String(i),
          truth: sample.truth,
          split,
        })),
      )
      const decide: DecideFn = async ({ state }) =>
        ({
          probs: samples[Number(state)].probs,
          method: 'logprob',
          calibrated: false,
          llmCall: { clientName: 'LocalQwenSmallDecide', functionName: 'Decide', variables: {} },
        }) as DecideResult
      const r = await evaluateKey({
        spec,
        items,
        decide,
        jev: false,
        client: 'LocalQwenSmallDecide',
        criteria,
      })
      expect(r.entry).not.toBeNull()
      expect(r.entry!.bias!.B).toBeGreaterThan(0.3)
      const measured = samples.map((sample) => applyFit(sample, ['a', 'b'], r.entry!))
      expect(parsed(r, ': held-out fitted').ece).toBe(calibrationMetrics(measured).ece)
      expect(r.holdout).toEqual(measured)
      fitted.push(...measured)
      raw.push(...samples)
      returned.push(...r.holdout)
    }
    const pool = pooledReport('LocalQwenSmallDecide', false, returned, criteria)
    const ece = JSON.parse(pool.observations[0].value).ece
    expect(ece).toBe(calibrationMetrics(fitted).ece)
    expect(ece).not.toBeCloseTo(calibrationMetrics(raw).ece)
  })

  it('verdict: all Jev keys reopen above ceiling, never at/below it or for logprob', async () => {
    for (const r of await reports(true, 'holdout'))
      expect(r.observations.at(-1)!.value).toMatch(/^REOPEN G7\(a\): Jev measured ECE=/)
    for (const probability of [0.97, 1])
      for (const r of await reports(true, '', probability))
        expect(r.observations.at(-1)!.value).not.toContain('REOPEN')
    const spec = CALIBRATION_SPECS[0]
    const items = fixtures.items.filter((i: { key: string }) => i.key === spec.key)
    const r = await evaluateKey({
      spec,
      items,
      decide: fake(true, '', 0.95),
      jev: true,
      client: 'JevDecide',
      criteria: { ...criteria, eceCeiling: 1 - 0.95 },
    })
    expect(r.observations.at(-1)!.value).not.toContain('REOPEN')
    for (const r of await reports(false, 'holdout'))
      expect(r.observations.at(-1)!.value).not.toContain('REOPEN')
  })
  it('verdict boundary: exact .05 per-key ECE does not reopen', async () => {
    const spec = {
      key: 'boundary',
      question: 'synthetic',
      labels: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
      ],
    }
    const items = Array.from({ length: 22 }, (_, i) => ({
      id: String(i),
      key: spec.key,
      state: String(i),
      truth: i < 13 ? 'a' : 'b',
      split: i < 2 ? 'fit' : 'holdout',
    }))
    const decide: DecideFn = async () =>
      ({
        probs: { a: 0.5, b: 0.5 },
        method: 'jev',
        calibrated: true,
        llmCall: { clientName: 'JevDecide', functionName: 'Decide', variables: {} },
      }) as DecideResult
    const r = await evaluateKey({ spec, items, decide, jev: true, client: 'JevDecide', criteria })
    expect(parsed(r, ': held-out fitted').ece).toBe(0.05)
    expect(r.checks.find((c) => c.name === 'boundary: held-out calibration')).toEqual({
      name: 'boundary: held-out calibration',
      pass: true,
      detail: 'ECE=0.05; ceiling=0.05',
    })
    expect(r.observations.at(-1)!.value).not.toContain('REOPEN')
  })
  it('holdout: reports holdout, fits fit only, retains order-swap raw label', async () => {
    for (const jev of [true, false]) {
      for (const r of await reports(jev, 'fit')) {
        expect(parsed(r, ': held-out raw').accuracy).toBe(1)
        expect(r.entry).toBeNull()
        expect(parsed(r, ': held-out fitted').orderSwapAgreementRaw).toBe(1)
      }
      for (const r of await reports(jev, 'holdout')) {
        expect(parsed(r, ': held-out raw').accuracy).toBe(0)
        expect(
          r.holdout.every(
            (s) => Object.entries(s.probs).sort((a, b) => b[1] - a[1])[0][0] !== s.truth,
          ),
        ).toBe(true)
      }
    }
  })
  it('defaults: labelled owner-tunable criteria and blank env use .95/.05', () => {
    vi.stubEnv('EVAL_DECISION_ACCURACY', undefined)
    vi.stubEnv('EVAL_DECISION_ECE', undefined)
    expect(diagnosticCriteria()).toEqual({ accuracyFloor: 0.95, eceCeiling: 0.05 })
    expect(criteriaObservation(diagnosticCriteria()).value).toContain('>= 0.95')
    expect(criteriaObservation(diagnosticCriteria()).value).toContain('<= 0.05')
    for (const value of ['', '  ']) {
      vi.stubEnv('EVAL_DECISION_ACCURACY', value)
      expect(criterion('EVAL_DECISION_ACCURACY', 0.95)).toBe(0.95)
    }
    for (const value of ['abc', '-0.1', '1.1']) {
      vi.stubEnv('EVAL_DECISION_ACCURACY', value)
      expect(() => criterion('EVAL_DECISION_ACCURACY', 0.95)).toThrow()
    }
    expect(calibrationTier(true)).toBe('anthropic')
    expect(calibrationTier(false)).toBe('verda')
  })
  it('artifact: infeasible entry null; all eight required; both clients round trip', async () => {
    expect((await reports(true, 'fit')).every((r) => r.entry === null)).toBe(true)
    const entries: Record<string, DecisionCalibrationEntry> = {}
    expect(completeEntries(entries, CALIBRATION_SPECS)).toBe(false)
    for (const jev of [true, false]) {
      const client = jev ? 'JevDecide' : 'LocalQwenSmallDecide'
      const rs = await reports(jev)
      for (let i = 0; i < rs.length; i++) {
        expect(rs[i].entry).not.toBeNull()
        entries[CALIBRATION_SPECS[i].key] = rs[i].entry!
        expect(completeEntries(entries, CALIBRATION_SPECS)).toBe(i === 7)
        if (jev) {
          expect(rs[i].entry).not.toHaveProperty('temperature')
          expect(rs[i].entry).not.toHaveProperty('bias')
        }
      }
      feedDecisionCalibration({
        schemaVersion: 1,
        contractRevision: CALIBRATION_REVISION,
        status: 'measured',
        clients: { [client]: { fingerprint: calibrationFingerprint(client), entries } },
      })
      expect(decisionCalibrationFor(client, 'route')).toEqual(entries.route)
      for (const key of Object.keys(entries)) delete entries[key]
    }
  })
  it('pooled: 56 holdouts, reopen above .05, one key error may stay below', async () => {
    const pool = pooledReport(
      'JevDecide',
      true,
      (await reports(true, 'holdout')).flatMap((r) => r.holdout),
      criteria,
    )
    expect(JSON.parse(pool.observations[0].value).n).toBe(56)
    expect(pool.observations[0].name).toBe('JevDecide × ALL: held-out pooled')
    expect(pool.observations[1].value).toMatch(/^REOPEN G7\(a\): Jev pooled measured ECE=/)
    expect(pool.checks[0].pass).toBe(false)
    const samples = (await reports(true, '', 1)).flatMap((r) => r.holdout)
    const first = samples[0]
    const other = Object.keys(first.probs).find((l) => l !== first.truth)!
    samples[0] = {
      ...first,
      probs: Object.fromEntries(Object.keys(first.probs).map((l) => [l, Number(l === other)])),
    }
    const sparse = pooledReport('JevDecide', true, samples, criteria)
    expect(JSON.parse(sparse.observations[0].value).ece).toBeLessThanOrEqual(0.05)
    expect(sparse.observations[1].value).not.toContain('REOPEN')
    expect(sparse.checks[0].pass).toBe(true)
    const threshold = pooledReport(
      'JevDecide',
      true,
      [{ truth: 'a', probs: { a: 0.9, b: 0.1 } }],
      criteria,
    )
    expect(threshold.observations[1].value).toContain('REOPEN')
  })
  it('serving: refuses absent/mismatched identity or method, records reversed reads', async () => {
    const spec = CALIBRATION_SPECS[0]
    const items = fixtures.items.filter((i: { key: string }) => i.key === spec.key)
    for (const jev of [true, false]) {
      for (const patch of [
        { method: 'verbalized' },
        { llmCall: undefined },
        { llmCall: { clientName: 'wrong' } },
      ]) {
        const decide: DecideFn = async (input) =>
          ({ ...(await fake(jev)(input)), ...patch }) as DecideResult
        await expect(
          evaluateKey({
            spec,
            items,
            decide,
            jev,
            client: jev ? 'JevDecide' : 'LocalQwenSmallDecide',
            criteria,
          }),
        ).rejects.toThrow(/serving/)
      }
      const seen: string[][] = []
      const decide: DecideFn = async (input) => {
        seen.push(input.spec.labels.map((l) => l.id))
        return fake(jev)(input)
      }
      await evaluateKey({
        spec,
        items,
        decide,
        jev,
        client: jev ? 'JevDecide' : 'LocalQwenSmallDecide',
        criteria,
      })
      expect(seen[1]).toEqual([...seen[0]].reverse())
      expect(seen).toHaveLength(items.length * 2)
    }
  })
})
