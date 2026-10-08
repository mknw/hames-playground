/** Pure diagnostics for #418 T8. No provider imports or policy changes. */
import type { DecisionCalibrationEntry } from '@hames-ai/harness-patterns'

export interface CalibrationSample {
  truth: string
  probs: Record<string, number>
  coverage?: number
}

export function ranked(sample: CalibrationSample) {
  const labels = Object.entries(sample.probs).sort((a, b) => b[1] - a[1])
  if (
    labels.length < 2 ||
    !labels.some(([label]) => label === sample.truth) ||
    labels.some(([, p]) => !Number.isFinite(p) || p < 0 || p > 1) ||
    Math.abs(labels.reduce((s, [, p]) => s + p, 0) - 1) > 1e-6
  )
    throw new Error('Invalid calibration distribution')
  const [top, p] = labels[0]
  return {
    top,
    p,
    correct: top === sample.truth,
    confidence: (labels.length * p - 1) / (labels.length - 1),
    margin: p - labels[1][1],
  }
}

/** Multiclass Brier is SUM of squared errors, range 0..2. ECE uses p_max,
 * not the chance-recentred policy confidence, in ten equal-width bins. */
export function calibrationMetrics(samples: readonly CalibrationSample[]) {
  if (!samples.length) throw new Error('No calibration samples')
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, correct: 0 }))
  let correct = 0
  let brier = 0
  const coverage = samples.flatMap((s) => (s.coverage === undefined ? [] : [s.coverage]))
  for (const s of samples) {
    const r = ranked(s)
    correct += Number(r.correct)
    brier += Object.entries(s.probs).reduce(
      (sum, [label, p]) => sum + (p - Number(label === s.truth)) ** 2,
      0,
    )
    const bin = bins[Math.min(9, Math.floor(r.p * 10))]
    bin.n++
    bin.p += r.p
    bin.correct += Number(r.correct)
  }
  return {
    n: samples.length,
    accuracy: correct / samples.length,
    brier: brier / samples.length,
    ece: bins.reduce((sum, b) => sum + Math.abs(b.correct - b.p), 0) / samples.length,
    coverage: coverage.length ? coverage.reduce((a, b) => a + b, 0) / coverage.length : undefined,
    coverageN: coverage.length,
  }
}

export function orderSwapAgreement(
  pairs: readonly (readonly [CalibrationSample, CalibrationSample])[],
) {
  if (!pairs.length) throw new Error('No order-swap pairs')
  return pairs.filter(([a, b]) => ranked(a).top === ranked(b).top).length / pairs.length
}

/** Bias keys are answer LETTERS, matching calibrateLabelMass in the adapter. */
export function applyFit(
  s: CalibrationSample,
  labels: readonly string[],
  entry: DecisionCalibrationEntry,
): CalibrationSample {
  const z = labels.map((label, i) =>
    s.probs[label] > 0
      ? Math.log(s.probs[label]) / (entry.temperature ?? 1) +
        (entry.bias?.[String.fromCharCode(65 + i)] ?? 0)
      : -Infinity,
  )
  const weights = z.map((v) => Math.exp(v - Math.max(...z)))
  const total = weights.reduce((a, b) => a + b, 0)
  return { ...s, probs: Object.fromEntries(labels.map((l, i) => [l, weights[i] / total])) }
}

export function retainedMetrics(
  samples: readonly CalibrationSample[],
  entry: DecisionCalibrationEntry,
) {
  const kept = samples.filter((s) => {
    const r = ranked(s)
    return r.confidence >= (entry.minConfidence ?? 0) && r.margin >= (entry.minMargin ?? 0)
  })
  return {
    retained: kept.length / samples.length,
    metrics: kept.length ? calibrationMetrics(kept) : null,
  }
}

/** Exhaustive observed-boundary cuts. Maximise retained n at the requested
 * empirical accuracy; reject-all is explicit, never a fabricated perfect fit. */
export function fitCuts(samples: readonly CalibrationSample[], targetAccuracy: number) {
  const rows = samples.map(ranked)
  if (!rows.length || !Number.isFinite(targetAccuracy) || targetAccuracy < 0 || targetAccuracy > 1)
    throw new Error('Invalid cut fit')
  const confidences = [0, ...rows.map((r) => r.confidence)]
  const margins = [0, ...rows.map((r) => r.margin)]
  let best = { minConfidence: 1, minMargin: 1, retained: 0 }
  for (const c of confidences)
    for (const m of margins) {
      const kept = rows.filter((r) => r.confidence >= c && r.margin >= m)
      if (
        kept.length &&
        kept.filter((r) => r.correct).length / kept.length >= targetAccuracy &&
        kept.length > best.retained
      ) {
        best = { minConfidence: c, minMargin: m, retained: kept.length }
      }
    }
  return best
}

/** Deterministic bounded coordinate search minimising fit Brier. Jev never
 * enters the transform fitter: G7 permits cuts only. Holdout never fits. */
export function fitCalibration(
  samples: readonly CalibrationSample[],
  labels: readonly string[],
  jev: boolean,
  targetAccuracy: number,
): DecisionCalibrationEntry {
  calibrationMetrics(samples)
  let entry: DecisionCalibrationEntry = {}
  if (!jev) {
    let best = calibrationMetrics(samples).brier
    let temperature = 1
    const bias: Record<string, number> = Object.fromEntries(
      labels.map((_, i) => [String.fromCharCode(65 + i), 0]),
    )
    for (const step of [1, 0.5, 0.25, 0.125]) {
      for (let round = 0; round < 4; round++) {
        for (const parameter of ['temperature', ...Object.keys(bias).slice(1)]) {
          for (const direction of [-1, 1]) {
            const candidate = {
              temperature:
                parameter === 'temperature'
                  ? temperature * Math.exp(direction * step)
                  : temperature,
              bias: {
                ...bias,
                ...(parameter !== 'temperature' && {
                  [parameter]: bias[parameter] + direction * step,
                }),
              },
            }
            if (candidate.temperature < 0.05 || candidate.temperature > 20) continue
            const loss = calibrationMetrics(
              samples.map((s) => applyFit(s, labels, candidate)),
            ).brier
            if (loss < best - 1e-10) {
              best = loss
              temperature = candidate.temperature
              Object.assign(bias, candidate.bias)
            }
          }
        }
      }
    }
    entry = { temperature, bias }
  }
  const transformed = jev ? samples : samples.map((s) => applyFit(s, labels, entry))
  const { minConfidence, minMargin } = fitCuts(transformed, targetAccuracy)
  return { ...entry, minConfidence, minMargin, n: samples.length }
}
