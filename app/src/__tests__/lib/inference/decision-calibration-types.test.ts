import { describe, expect, it, vi } from 'vitest'
import {
  calibrationMetrics,
  fitCalibration,
  fitCuts,
  ranked,
  applyFit,
  retainedMetrics,
  type CalibrationSample,
} from '../../../lib/inference/decision-calibration-math'
import {
  evaluateKey,
  pooledReport,
  criteriaObservation,
  OWNER_TUNABLE_DEFAULTS,
} from '../../../lib/inference/decision-calibration-report'
import {
  EVAL_SCORE_SPEC,
  EVAL_NOUL_SPEC,
} from '../../../lib/inference/decision-calibration-specs.server'
import {
  scoreScoreDecision,
  scoreNoulDecision,
} from '@hames-ai/harness-patterns/patterns/typedDecision.server'
import type { DecideFn, DecideResult } from '@hames-ai/harness-patterns'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const levels = ['can_wait', 'soon', 'now']
const score = (p: number[], truth = 'can_wait'): CalibrationSample => ({
  type: 'score',
  levels,
  truth,
  probs: Object.fromEntries(levels.map((l, i) => [l, p[i]])),
})
const noul = (p: number, truth = 'true'): CalibrationSample => ({
  type: 'noul',
  truth,
  probs: { true: p, false: 1 - p },
})
const metrics = calibrationMetrics
const criteria = OWNER_TUNABLE_DEFAULTS

describe('S5 calibration by type — known answers', () => {
  it('rps-math: ordinal distance matters, expected MAE and mode accuracy are distinct', () => {
    expect(metrics([score([0, 1, 0])])).toMatchObject({
      rps: 0.5,
      mae: 1,
      accuracy: 0,
      exactAccuracy: 0,
      withinOneAccuracy: 1,
    })
    expect(metrics([score([0, 0, 1])])).toMatchObject({ rps: 1, mae: 2, withinOneAccuracy: 0 })
    expect(metrics([score([0.6, 0.4, 0], 'now')]).mae).toBeCloseTo(1.6)
    expect(metrics([score([0, 0, 1], 'can_wait'), score([1, 0, 0], 'now')]).mae).toBe(2)
    expect(metrics([score([0, 0, 1])]).brier).toBe(2)
    const m = metrics([score([0.2, 0.5, 0.3], 'soon')])
    expect(m.rps).toBeCloseTo(0.065)
    expect(m.mae).toBeCloseTo(0.1)
    expect(m.exactAccuracy).toBe(1)
  })
  it('noul-binary-ece: ten bins of P(true) preserve directional errors', () => {
    const samples = [noul(0.8), noul(0.2)]
    const m = metrics(samples)
    expect(m.eceKind).toBe('binary')
    expect(m.ece).toBeCloseTo(0.5)
    expect(m.brier).toBeCloseTo(0.34)
    expect(m.logLoss).toBeCloseTo(-Math.log(0.16) / 2)
    expect(metrics(samples.map(({ type: _type, ...s }) => s)).ece).toBeCloseTo(0.3)
    expect(metrics([noul(1)]).logLoss).toBe(0)
    expect(metrics([noul(0)]).logLoss).toBe(Infinity)
    expect(metrics([noul(0.89), noul(0.95, 'false')]).ece).toBeCloseTo(0.53)
    expect(metrics([noul(0.81), noul(0.89, 'false')]).ece).toBeCloseTo(0.35)
  })
  it('cumulative-ece: threshold reliability averaged over thresholds, never concentration ECE', () => {
    expect(metrics([score([0.5, 0, 0.5], 'soon')])).toMatchObject({
      ece: 0.5,
      eceKind: 'cumulative',
    })
    expect(metrics([score([0.2, 0.5, 0.3], 'soon')]).ece).toBeCloseTo(0.25)
    expect(metrics([score([0, 1, 0], 'soon')]).ece).toBe(0)
    expect(() => metrics([noul(0.8), score([0.2, 0.5, 0.3])])).toThrow(/pool/)
    expect(() =>
      metrics([
        score([0.2, 0.5, 0.3]),
        {
          type: 'score',
          levels: ['a', 'b', 'c', 'd'],
          truth: 'a',
          probs: { a: 0.25, b: 0.25, c: 0.25, d: 0.25 },
        },
      ]),
    ).toThrow(/pool/)
  })
  it('type-confidence: diagnostic cuts use the same confidence and tie-break as core', () => {
    for (const s of [score([0, 0.5, 0.5]), score([0.5, 0, 0.5]), score([0.2, 0.5, 0.3])]) {
      const d = scoreScoreDecision({
        spec: EVAL_SCORE_SPEC,
        policy: { fallback: 'now' },
        state: 'synthetic',
        result: {
          probs: s.probs as Record<'can_wait' | 'soon' | 'now', number>,
          method: 'logprob',
          calibrated: true,
        },
      }).decision
      expect(ranked(s).confidence).toBe(d.confidence)
      expect(ranked(s).top).toBe(d.top)
    }
    for (const p of [0, 0.2, 0.5, 0.8, 1]) {
      const s = noul(p)
      const d = scoreNoulDecision({
        spec: EVAL_NOUL_SPEC,
        policy: { fallback: false },
        state: 'synthetic',
        result: {
          probs: s.probs as Record<'true' | 'false', number>,
          method: 'logprob',
          calibrated: true,
        },
      }).decision
      expect(ranked(s).confidence).toBe(d.confidence)
    }
    const tied = score([0.5, 0.5, 0])
    tied.probs = { now: 0, soon: 0.5, can_wait: 0.5 }
    expect(ranked(tied).top).toBe('can_wait')
  })
  it('type-cuts: score maximises within-one, noul exact, neither fits margin', () => {
    const samples = [score([0, 1, 0]), score([0, 0, 1])]
    expect(fitCuts(samples, 0.95)).toEqual({ minConfidence: 1, retained: 0 }) // same confidence, incompatible truths
    expect(fitCuts([score([0.5, 0.45, 0.05], 'now'), score([0.35, 0, 0.65], 'now')], 0.95)).toEqual(
      { minConfidence: 1, retained: 0 },
    )
    const adjacent = [score([0, 1, 0])]
    expect(fitCuts(adjacent, 0.95)).toEqual({ minConfidence: 1, retained: 1 })
    expect(retainedMetrics(adjacent, { minConfidence: 1 })).toMatchObject({
      retained: 1,
      metrics: { exactAccuracy: 0, withinOneAccuracy: 1 },
    })
    expect(fitCuts([noul(0.8), noul(0.4)], 0.95)).toEqual({
      minConfidence: Math.abs(2 * 0.8 - 1),
      retained: 1,
    })
    expect(fitCalibration(adjacent, levels, true, 0.95)).not.toHaveProperty('minMargin')
    expect(fitCalibration([noul(0.8)], ['true', 'false'], true, 0.95)).toEqual({
      minConfidence: Math.abs(2 * 0.8 - 1),
      n: 1,
    })
  })
  it('noul-fit-zero-mass: zero gold mass does not erase the other samples fit', () => {
    const base = [
      noul(0.9, 'false'),
      noul(0.9, 'false'),
      noul(0.8, 'false'),
      noul(0.85),
      noul(0.3, 'false'),
    ]
    const samples = [...base, noul(0)]
    const fitted = fitCalibration(samples, ['true', 'false'], false, 0.5)
    expect({ temperature: fitted.temperature, bias: fitted.bias }).not.toEqual({
      temperature: 1,
      bias: { A: 0, B: 0 },
    })
    expect(calibrationMetrics(samples).logLoss).toBe(Infinity)
  })
  it('type-fitting-loss: deterministic score RPS and noul log loss minima', () => {
    // Mixed, nonseparable probabilities distinguish ordinal/log-loss from Brier optima.
    const ordinal = [
      score([0.7, 0.2, 0.1]),
      score([0.5, 0.2, 0.3], 'soon'),
      score([0.1, 0.2, 0.7], 'now'),
      score([0.2, 0.6, 0.2], 'now'),
    ]
    const binary = [
      noul(0.9),
      noul(0.9, 'false'),
      noul(0.6),
      noul(0.4, 'false'),
      noul(0.1, 'false'),
    ]
    for (const samples of [ordinal, binary]) {
      const labels = samples[0].type === 'score' ? levels : ['true', 'false']
      const fitted = fitCalibration(samples, labels, false, 0.5)
      const measured = metrics(samples.map((s) => applyFit(s, labels, fitted)))
      const baseline = metrics(samples)
      if (samples[0].type === 'score') expect(measured.rps!).toBeLessThan(baseline.rps!)
      else expect(measured.logLoss!).toBeLessThan(baseline.logLoss!)
      expect(fitted.bias).toHaveProperty('A', 0)
      expect(fitted).not.toHaveProperty('minMargin')
      // Fit with the wrong loss for the SAME observations must choose different parameters.
      const wrong = fitCalibration(
        samples.map(({ type: _type, levels: _levels, ...s }) => s),
        labels,
        false,
        0.5,
      )
      expect({ temperature: fitted.temperature, bias: fitted.bias }, samples[0].type).not.toEqual({
        temperature: wrong.temperature,
        bias: wrong.bias,
      })
    }
  })
  it('type-validation: missing/extra labels, bad truth, malformed probabilities and rubric reject', () => {
    for (const s of [
      { ...noul(0.8), probs: { true: 0.8, false: 0.2, other: 0 } },
      { ...noul(0.8), truth: 'unknown' },
      { ...score([0.2, 0.5, 0.3]), levels: ['can_wait', 'soon'] },
      { ...score([0.2, 0.5, 0.3]), levels: undefined },
      noul(NaN),
    ])
      expect(() => metrics([s])).toThrow()
  })
})

async function report(type: 'score' | 'noul', p = 0.8) {
  const spec = type === 'score' ? EVAL_SCORE_SPEC : EVAL_NOUL_SPEC
  const items = ['fit', 'holdout'].map((split) => ({
    id: split,
    key: spec.key,
    split,
    state: split,
    truth: type === 'score' ? 'soon' : 'true',
  }))
  const seen: unknown[] = []
  const decide = (async (input) => {
    seen.push(input.spec)
    return {
      probs: type === 'score' ? { can_wait: 0, soon: p, now: 1 - p } : { true: p, false: 1 - p },
      method: 'jev',
      calibrated: true,
      llmCall: { clientName: 'JevDecide', functionName: 'Decide', variables: {} },
    } as DecideResult
  }) as DecideFn
  const result = await evaluateKey({
    spec,
    items,
    decide,
    jev: true,
    client: 'JevDecide',
    criteria,
  })
  return {
    seen,
    result,
    measured: JSON.parse(
      result.observations.find((o) => o.name.endsWith(': held-out fitted'))!.value,
    ),
  }
}
describe('S5 type reports and coordinator ruling', () => {
  it('score-verdict-normal-branch: the non-REOPEN score verdict carries both accuracies', async () => {
    const items = ['fit', 'holdout'].map((split) => ({
      id: split,
      key: EVAL_SCORE_SPEC.key,
      split,
      state: split,
      truth: 'soon',
    }))
    const decide = (async () =>
      ({
        probs: { can_wait: 0, soon: 0.2, now: 0.8 },
        method: 'logprob',
        calibrated: true,
        llmCall: { clientName: 'LocalQwenSmallDecide', functionName: 'Decide', variables: {} },
      }) as DecideResult) as DecideFn
    const r = await evaluateKey({
      spec: EVAL_SCORE_SPEC,
      items,
      decide,
      jev: false,
      client: 'LocalQwenSmallDecide',
      criteria,
    })
    const verdict = r.observations.find((o) => o.name.endsWith(': VERDICT'))!.value
    expect(verdict).toMatch(/^Held-out ECE=.*; retained within-one accuracy=1; exact accuracy=1\.$/)
  })
  it('noul counted as agreeing: native read once, agreement explicitly N/A, no denominator', async () => {
    const r = await report('noul')
    expect(r.seen).toEqual([EVAL_NOUL_SPEC, EVAL_NOUL_SPEC])
    expect(r.measured.orderSwapAgreementRaw).toBe('N/A (native noul has no option order)')
    expect(r.measured.eceKind).toBe('binary')
    expect(r.result.observations.at(-1)!.value).toContain('binary ECE')
  })
  it('score swap: reverses levels, preserves canonical metric scale and exact companion', async () => {
    const r = await report('score')
    expect(r.seen[1]).toEqual({ ...EVAL_SCORE_SPEC, levels: [...EVAL_SCORE_SPEC.levels].reverse() })
    expect(r.measured).toMatchObject({
      eceKind: 'cumulative',
      orderSwapAgreementRaw: 1,
      exactAccuracy: 1,
      withinOneAccuracy: 1,
    })
    expect(r.result.observations.at(-1)!.value).toContain('cumulative ECE')
  })
  it('score-retained-within-one: an adjacent wrong mode passes while exact remains zero', async () => {
    const r = await report('score', 0.2)
    expect(r.measured.metrics).toMatchObject({ exactAccuracy: 0, withinOneAccuracy: 1 })
    expect(r.result.checks.find((c) => c.name.endsWith(': held-out retained accuracy'))?.pass).toBe(
      true,
    )
    expect(r.result.entry).not.toBeNull()
    const verdict = r.result.observations.find((o) => o.name.endsWith(': VERDICT'))!.value
    expect(verdict).toContain('exact accuracy=0')
    expect(verdict).toContain('within-one accuracy=1')
  })
  it('infinite-log-loss-report: zero probability is explicitly Infinity rather than unknown null', async () => {
    const r = await report('noul', 0)
    expect(r.measured.logLoss).toBe('Infinity')
  })
  it('empty pool passes: every type reports no data and fails its own gate', () => {
    for (const type of ['choice', 'score', 'noul'] as const) {
      const r = pooledReport('JevDecide', true, [], criteria, type)
      expect(r.observations[0].value).toBe('no data')
      expect(r.checks[0]).toMatchObject({ pass: false, detail: 'no data' })
    }
  })
  it('type-pool-gates: separate ECE labels and red gates, no mixed overall ECE', async () => {
    for (const type of ['choice', 'score', 'noul'] as const) {
      const samples =
        type === 'choice'
          ? [{ truth: 'a', probs: { a: 0.8, b: 0.2 } }]
          : (await report(type)).result.holdout
      const pool = pooledReport('JevDecide', true, samples, criteria, type)
      expect(pool.observations[0].name).toContain(`ALL (${type})`)
      expect(JSON.parse(pool.observations[0].value).eceKind).toBe(
        type === 'score' ? 'cumulative' : type === 'noul' ? 'binary' : 'top-label',
      )
      expect(pool.checks[0].pass).toBe(false)
      expect(pool.observations[1].value).toContain('REOPEN G7(a)')
      expect(pool.observations[1].value).toContain(
        type === 'score' ? 'cumulative ECE' : type === 'noul' ? 'binary ECE' : 'top-label ECE',
      )
    }
    expect(() =>
      pooledReport('JevDecide', true, [noul(0.8), score([0.2, 0.5, 0.3])], criteria),
    ).toThrow()
    expect(criteriaObservation(criteria).value).toContain('diagnostics until the owner live run')
  })
})
