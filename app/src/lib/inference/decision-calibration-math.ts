/** Pure diagnostics for #418 T8. No provider imports or policy changes. */
import type { AnyDecisionSpec, DecisionCalibrationEntry } from '@hames-ai/harness-patterns'

export interface CalibrationSample {
  truth: string
  probs: Record<string, number>
  coverage?: number
  type?: 'score' | 'noul'
  /** Canonical low-to-high ids, required for a score, independent of wire order. */
  levels?: readonly string[]
}

export function ranked(sample: CalibrationSample) {
  const ordered =
    sample.type === 'score'
      ? sample.levels
      : sample.type === 'noul'
        ? ['true', 'false']
        : Object.keys(sample.probs)
  if (
    !ordered ||
    new Set(ordered).size !== ordered.length ||
    ordered.length !== Object.keys(sample.probs).length ||
    ordered.some((l) => !Object.hasOwn(sample.probs, l)) ||
    (sample.type === 'score' && (ordered.length < 2 || ordered.length > 10))
  )
    throw new Error('Invalid calibration labels')
  const labels = ordered.map((l) => [l, sample.probs[l]] as const).sort((a, b) => b[1] - a[1])
  if (
    labels.length < 2 ||
    !labels.some(([label]) => label === sample.truth) ||
    labels.some(([, p]) => !Number.isFinite(p) || p < 0 || p > 1) ||
    Math.abs(labels.reduce((s, [, p]) => s + p, 0) - 1) > 1e-6
  )
    throw new Error('Invalid calibration distribution')
  const [top, p] = labels[0]
  const mode = ordered.indexOf(top)
  const gold = ordered.indexOf(sample.truth)
  const midpoint = (ordered.length - 1) / 2
  const uniformMad = ordered.reduce((s, _, i) => s + Math.abs(i - midpoint), 0) / ordered.length
  const ordinalConfidence = Math.max(
    0,
    1 - ordered.reduce((s, l, i) => s + sample.probs[l] * Math.abs(i - mode), 0) / uniformMad,
  )
  return {
    top,
    p,
    correct: top === sample.truth,
    confidence:
      sample.type === 'score'
        ? ordinalConfidence
        : sample.type === 'noul'
          ? Math.abs(2 * sample.probs.true - 1)
          : (labels.length * p - 1) / (labels.length - 1),
    withinOneCorrect: Math.abs(mode - gold) <= 1,
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
  const type = samples[0].type
  if (
    samples.some(
      (s) =>
        s.type !== type ||
        (type === 'score' && JSON.stringify(s.levels) !== JSON.stringify(samples[0].levels)),
    )
  )
    throw new Error('Cannot pool different calibration types or rubrics')
  let rps = 0
  let mae = 0
  let withinOne = 0
  let logLoss = 0
  const binaryRows: Array<[number, number]> = []
  const cumulativeRows: Array<Array<[number, number]>> =
    type === 'score' ? samples[0].levels!.slice(1).map(() => []) : []
  const coverage = samples.flatMap((s) => (s.coverage === undefined ? [] : [s.coverage]))
  for (const s of samples) {
    const r = ranked(s)
    correct += Number(r.correct)
    if (type === 'noul') {
      const p = s.probs.true
      const y = Number(s.truth === 'true')
      binaryRows.push([p, y])
      logLoss -= Math.log(y ? p : 1 - p)
    }
    if (type === 'score') {
      const levels = s.levels!
      const gold = levels.indexOf(s.truth)
      mae += Math.abs(levels.reduce((sum, l, i) => sum + i * s.probs[l], 0) - gold)
      withinOne += Number(r.withinOneCorrect)
      for (let k = 1; k < levels.length; k++) {
        const p = levels.slice(k).reduce((sum, l) => sum + s.probs[l], 0)
        const y = Number(gold >= k)
        rps += (p - y) ** 2 / (levels.length - 1)
        cumulativeRows[k - 1].push([p, y])
      }
    }
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
    brier: brier / samples.length / (type === 'noul' ? 2 : 1),
    ...(type === 'noul' && { logLoss: logLoss / samples.length }),
    ...(type === 'score' && {
      rps: rps / samples.length,
      mae: mae / samples.length,
      exactAccuracy: correct / samples.length,
      withinOneAccuracy: withinOne / samples.length,
    }),
    ece:
      type === 'noul'
        ? binaryEce(binaryRows)
        : type === 'score'
          ? cumulativeRows.reduce((sum, rows) => sum + binaryEce(rows), 0) / cumulativeRows.length
          : bins.reduce((sum, b) => sum + Math.abs(b.correct - b.p), 0) / samples.length,
    eceKind: type === 'noul' ? 'binary' : type === 'score' ? 'cumulative' : 'top-label',
    coverage: coverage.length ? coverage.reduce((a, b) => a + b, 0) / coverage.length : undefined,
    coverageN: coverage.length,
  }
}

function binaryEce(rows: readonly (readonly [number, number])[]): number {
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0 }))
  for (const [p, y] of rows) {
    const bin = bins[Math.min(9, Math.floor(p * 10))]
    bin.p += p
    bin.y += y
  }
  return bins.reduce((sum, b) => sum + Math.abs(b.y - b.p), 0) / rows.length
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
    return (
      r.confidence >= (entry.minConfidence ?? 0) &&
      (s.type !== undefined || r.margin >= (entry.minMargin ?? 0))
    )
  })
  return {
    retained: kept.length / samples.length,
    metrics: kept.length ? calibrationMetrics(kept) : null,
  }
}

/** Exhaustive observed-boundary cuts. Maximise retained n at the requested
 * empirical accuracy; reject-all is explicit, never a fabricated perfect fit. */
export function fitCuts(
  samples: readonly CalibrationSample[],
  targetAccuracy: number,
): { minConfidence: number; minMargin?: number; retained: number } {
  const rows = samples.map(ranked)
  if (!rows.length || !Number.isFinite(targetAccuracy) || targetAccuracy < 0 || targetAccuracy > 1)
    throw new Error('Invalid cut fit')
  const confidences = [0, ...rows.map((r) => r.confidence)]
  const type = samples[0].type
  const margins = type ? [0] : [0, ...rows.map((r) => r.margin)]
  let best = { minConfidence: 1, minMargin: 1, retained: 0 }
  for (const c of confidences)
    for (const m of margins) {
      const kept = rows.filter((r) => r.confidence >= c && r.margin >= m)
      if (
        kept.length &&
        kept.filter((r) => (type === 'score' ? r.withinOneCorrect : r.correct)).length /
          kept.length >=
          targetAccuracy &&
        (kept.length > best.retained ||
          (kept.length === best.retained &&
            (c > best.minConfidence || (c === best.minConfidence && m > best.minMargin))))
      ) {
        best = { minConfidence: c, minMargin: m, retained: kept.length }
      }
    }
  return type ? { minConfidence: best.minConfidence, retained: best.retained } : best
}

/** Deterministic bounded coordinate search minimising the type's proper loss. Jev never
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
    let best = fittingLoss(samples)
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
            const loss = fittingLoss(samples.map((s) => applyFit(s, labels, candidate)))
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
  return {
    ...entry,
    minConfidence,
    ...(samples[0].type === undefined && { minMargin }),
    n: samples.length,
  }
}

/** Fit the proper loss for the declared type, never the cut concentration. */
function fittingLoss(samples: readonly CalibrationSample[]): number {
  const m = calibrationMetrics(samples)
  return samples[0].type === 'score' ? m.rps! : samples[0].type === 'noul' ? m.logLoss! : m.brier
}

export function calibrationLabels(spec: AnyDecisionSpec): readonly string[] {
  return spec.type === 'score'
    ? spec.levels.map((l) => l.id)
    : spec.type === 'noul'
      ? ['true', 'false']
      : spec.labels.map((l) => l.id)
}
