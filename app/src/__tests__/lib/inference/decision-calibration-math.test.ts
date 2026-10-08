// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  applyFit,
  calibrationMetrics,
  fitCalibration,
  fitCuts,
  orderSwapAgreement,
  ranked,
  retainedMetrics,
} from '../../../lib/inference/decision-calibration-math'
import { calibrateLabelMass } from '@hames-ai/harness-patterns/patterns/typedDecision.server'

const correct = { truth: 'a', probs: { a: 0.8, b: 0.2 }, coverage: 0.9 }
const wrong = { truth: 'b', probs: { a: 0.6, b: 0.4 }, coverage: 0.7 }

describe('decision calibration maths — synthetic known answers', () => {
  it('metrics: accuracy, summed multiclass Brier, ten-bin p_max ECE, coverage', () => {
    const m = calibrationMetrics([correct, wrong])
    expect(m.accuracy).toBe(0.5)
    expect(m.brier).toBeCloseTo(0.4)
    expect(m.ece).toBeCloseTo(0.4)
    expect(m.coverage).toBeCloseTo(0.8)
    expect(
      calibrationMetrics([
        { truth: 'a', probs: { a: 0.5, b: 0.5 } },
        { truth: 'b', probs: { a: 0.5, b: 0.5 } },
      ]).ece,
    ).toBe(0)
    expect(
      calibrationMetrics([{ truth: 'c', probs: { a: 0.2, b: 0.3, c: 0.5 } }]).brier,
    ).toBeCloseTo(0.38)
    expect(calibrationMetrics([{ truth: 'a', probs: { a: 1, b: 0 } }]).ece).toBe(0)
    expect(calibrationMetrics([{ truth: 'a', probs: { a: 1, b: 0 } }]).coverage).toBeUndefined()
  })
  it('bins: ten-bin known answers across and within boundaries', () => {
    for (const [p, q, ece] of [
      [0.89, 0.95, 0.53],
      [0.81, 0.89, 0.35],
      [0.9, 0.95, 0.425],
    ]) {
      expect(
        calibrationMetrics([
          { truth: 'a', probs: { a: p, b: 1 - p } },
          { truth: 'b', probs: { a: q, b: 1 - q } },
        ]).ece,
      ).toBeCloseTo(ece)
    }
  })
  it('bias-only: known shift beats every temperature-only candidate', () => {
    const samples = [
      ...Array.from({ length: 20 }, () => ({ truth: 'b', probs: { a: 0.6, b: 0.4 } })),
      ...Array.from({ length: 20 }, () => ({ truth: 'a', probs: { a: 0.75, b: 0.25 } })),
    ]
    const entry = fitCalibration(samples, ['a', 'b'], false, 0.5)
    expect(entry.bias!.B).toBeGreaterThan(0.3)
    const temperatureOnly = Math.min(
      ...Array.from(
        { length: 1001 },
        (_, i) =>
          calibrationMetrics(
            samples.map((s) => applyFit(s, ['a', 'b'], { temperature: 0.05 * 400 ** (i / 1000) })),
          ).brier,
      ),
    )
    expect(
      calibrationMetrics(samples.map((s) => applyFit(s, ['a', 'b'], entry))).brier,
    ).toBeLessThan(temperatureOnly)
  })
  it('temperature bounds: extreme fits stay within [.05,20]', () => {
    for (const p of [0.8, 0.99]) {
      const samples =
        p === 0.8
          ? [
              { truth: 'a', probs: { a: p, b: 1 - p } },
              { truth: 'b', probs: { a: 1 - p, b: p } },
            ]
          : [
              { truth: 'a', probs: { a: p, b: 1 - p } },
              { truth: 'b', probs: { a: p, b: 1 - p } },
              { truth: 'a', probs: { a: 1 - p, b: p } },
              { truth: 'b', probs: { a: 1 - p, b: p } },
            ]
      const entry = fitCalibration(samples, ['a', 'b'], false, 0.5)
      expect(entry.temperature).toBeGreaterThanOrEqual(0.05)
      expect(entry.temperature).toBeLessThanOrEqual(20)
    }
  })
  it('tie-break: strictest observed confidence then margin among equal retention', () => {
    const cuts = fitCuts([correct, wrong], 0.95)
    expect(cuts.minConfidence).toBeCloseTo(ranked(correct).confidence)
    expect(cuts.minMargin).toBeCloseTo(ranked(correct).margin)
    expect(fitCuts([correct, wrong].reverse(), 0.95)).toEqual(cuts)
  })
  it('validation: missing, malformed and non-normalized distributions refuse', () => {
    expect(() => calibrationMetrics([])).toThrow()
    for (const probs of [{ a: 1 }, { a: 1, b: 1 }, { a: NaN, b: 0 }, { a: -1, b: 2 }]) {
      expect(() =>
        calibrationMetrics([{ truth: 'a', probs: probs as Record<string, number> }]),
      ).toThrow()
    }
    expect(() => ranked({ truth: 'absent', probs: { a: 0.8, b: 0.2 } })).toThrow()
  })
  it('cuts: maximize retention at empirical accuracy floor, expose infeasible fits', () => {
    const cuts = fitCuts([correct, wrong], 0.95)
    expect(cuts.retained).toBe(1)
    expect(retainedMetrics([correct, wrong], cuts)).toMatchObject({
      retained: 0.5,
      metrics: { accuracy: 1 },
    })
    expect(fitCuts([correct, wrong], 0.5).retained).toBe(2)
    expect(fitCuts([wrong], 0.95)).toEqual({ minConfidence: 1, minMargin: 1, retained: 0 })
    expect(retainedMetrics([wrong], fitCuts([wrong], 0.95)).metrics).toBeNull()
    expect(() => fitCuts([], 0.95)).toThrow()
    expect(() => fitCuts([correct], 2)).toThrow()
    expect(ranked(correct).confidence).toBeCloseTo(0.6)
    expect(ranked(correct).margin).toBeCloseTo(0.6)
  })
  it('order-swap: agreement is label-ID based, not option position', () => {
    const reverse = { ...correct, probs: { b: 0.2, a: 0.8 } }
    const changed = { ...correct, probs: { a: 0.2, b: 0.8 } }
    expect(
      orderSwapAgreement([
        [correct, reverse],
        [correct, changed],
      ]),
    ).toBe(0.5)
    expect(() => orderSwapAgreement([])).toThrow()
  })
  it('transform: fitted letter bias and temperature match the production transform', () => {
    const entry = { temperature: 2, bias: { A: 0, B: Math.log(2) } }
    const expected = calibrateLabelMass({ A: 0.8, B: 0.2 }, entry)
    const result = applyFit(correct, ['a', 'b'], entry)
    expect(result.probs.a).toBeCloseTo(expected.A!)
    expect(result.probs.b).toBeCloseTo(expected.B!)
    expect(
      applyFit({ truth: 'a', probs: { a: 1, b: 0 } }, ['a', 'b'], { temperature: 20 }).probs,
    ).toEqual({ a: 1, b: 0 })
  })
  it('fitter: logprob learns T/bias, lowers fit Brier; Jev produces cuts only', () => {
    const samples = [correct, correct, wrong, wrong]
    const entry = fitCalibration(samples, ['a', 'b'], false, 0.95)
    expect(entry.temperature).toBeGreaterThan(0)
    expect(Object.keys(entry.bias!)).toEqual(['A', 'B'])
    expect(
      calibrationMetrics(samples.map((s) => applyFit(s, ['a', 'b'], entry))).brier,
    ).toBeLessThan(calibrationMetrics(samples).brier)
    const jev = fitCalibration(samples, ['a', 'b'], true, 0.95)
    expect(jev).toEqual({
      minConfidence: fitCuts(samples, 0.95).minConfidence,
      minMargin: fitCuts(samples, 0.95).minMargin,
      n: 4,
    })
    expect(jev).not.toHaveProperty('temperature')
    expect(jev).not.toHaveProperty('bias')
  })
})
