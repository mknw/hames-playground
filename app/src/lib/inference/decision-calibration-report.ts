/** Pure, synthetic calibration reporting; the caller owns transport and persistence. */
import type { DecisionSpec, DecideFn, DecisionCalibrationEntry } from '@hames-ai/harness-patterns'
import {
  applyFit,
  calibrationMetrics,
  fitCalibration,
  fitCuts,
  orderSwapAgreement,
  retainedMetrics,
  type CalibrationSample,
} from './decision-calibration-math'

export const OWNER_TUNABLE_DEFAULTS = { accuracyFloor: 0.95, eceCeiling: 0.05 } as const
export interface Criteria {
  accuracyFloor: number
  eceCeiling: number
}
export interface CalibrationItem {
  id: string
  key: string
  state: string
  truth: string
  split: string
}
export interface Observation {
  name: string
  value: string
}
const check = (name: string, pass: boolean, detail: string) => ({ name, pass, detail })
export function criterion(name: string, fallback: number): number {
  const raw = process.env[name]
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`)
  return value
}
export function diagnosticCriteria(): Criteria {
  return {
    accuracyFloor: criterion('EVAL_DECISION_ACCURACY', OWNER_TUNABLE_DEFAULTS.accuracyFloor),
    eceCeiling: criterion('EVAL_DECISION_ECE', OWNER_TUNABLE_DEFAULTS.eceCeiling),
  }
}
export function criteriaObservation(criteria: Criteria): Observation {
  return {
    name: 'diagnostic criteria (owner-tunable defaults, G10)',
    value: `fit retained accuracy >= ${criteria.accuracyFloor}; held-out ECE <= ${criteria.eceCeiling}. Small synthetic corpus; no statistical certification.`,
  }
}
export function calibrationTier(jev: boolean) {
  return jev ? 'anthropic' : 'verda'
}
export function completeEntries(
  entries: Record<string, DecisionCalibrationEntry>,
  specs: readonly DecisionSpec[],
) {
  return Object.keys(entries).length === specs.length
}
export function pooledReport(
  client: string,
  jev: boolean,
  samples: CalibrationSample[],
  criteria: Criteria,
) {
  const measured = calibrationMetrics(samples)
  return {
    observations: [
      { name: `${client} × ALL: held-out pooled`, value: JSON.stringify(measured) },
      {
        name: `${client} × ALL: VERDICT`,
        value:
          jev && measured.ece > criteria.eceCeiling
            ? `REOPEN G7(a): Jev pooled measured ECE=${measured.ece}; exceeds ${criteria.eceCeiling}. Owner decision required.`
            : `Pooled held-out ECE=${measured.ece}; diagnostic ceiling ${criteria.eceCeiling}.`,
      },
    ],
    checks: [
      check(
        'ALL: held-out pooled calibration',
        measured.ece <= criteria.eceCeiling,
        `ECE=${measured.ece}; ceiling=${criteria.eceCeiling}`,
      ),
    ],
  }
}
export async function evaluateKey({
  spec,
  items,
  decide,
  jev,
  client,
  criteria,
}: {
  spec: DecisionSpec
  items: readonly CalibrationItem[]
  decide: DecideFn
  jev: boolean
  client: string
  criteria: Criteria
}) {
  const observations: Observation[] = []
  const checks: ReturnType<typeof check>[] = []
  const labels = spec.labels.map((l) => l.id)
  const fit: CalibrationSample[] = []
  const holdout: CalibrationSample[] = []
  const pairs: Array<[CalibrationSample, CalibrationSample]> = []
  for (const item of items) {
    if (!labels.includes(item.truth)) throw new Error(`Unknown truth ${item.id}`)
    const result = await decide({ spec, state: item.state })
    const swapped = await decide({
      spec: { ...spec, labels: [...spec.labels].reverse() },
      state: item.state,
    })
    for (const read of [result, swapped]) {
      if (
        !read.llmCall ||
        read.llmCall.clientName !== client ||
        read.method !== (jev ? 'jev' : 'logprob')
      )
        throw new Error(`Unreported or mismatched serving client/method for ${item.id}`)
    }
    const sample = {
      truth: item.truth,
      probs: { ...result.probs },
      coverage: result.coverage,
    }
    const swap = {
      truth: item.truth,
      probs: { ...swapped.probs },
      coverage: swapped.coverage,
    }
    calibrationMetrics([sample, swap])
    if (item.split === 'fit') fit.push(sample)
    else {
      holdout.push(sample)
      pairs.push([sample, swap])
    }
  }
  const entry = {
    ...fitCalibration(fit, labels, jev, criteria.accuracyFloor),
    fittedAt: new Date().toISOString(),
  }
  const transformedFit = jev ? fit : fit.map((s) => applyFit(s, labels, entry))
  const transformed = jev ? holdout : holdout.map((s) => applyFit(s, labels, entry))
  const cutFit = fitCuts(transformedFit, criteria.accuracyFloor)
  const measured = calibrationMetrics(transformed)
  const retained = retainedMetrics(transformed, entry)
  observations.push(
    {
      name: `${client} × ${spec.key}: held-out raw`,
      value: JSON.stringify(calibrationMetrics(holdout)),
    },
    {
      name: `${client} × ${spec.key}: held-out fitted`,
      value: JSON.stringify({
        ...measured,
        coverage: measured.coverage ?? 'N/A (Jev)',
        orderSwapAgreementRaw: orderSwapAgreement(pairs),
        ...retained,
      }),
    },
    {
      name: `${client} × ${spec.key}: fitted values (fit split only)`,
      value: JSON.stringify(entry),
    },
    {
      name: `${client} × ${spec.key}: confidence cuts`,
      value: JSON.stringify(
        [0, 0.25, 0.5, 0.75, 0.9, 1].map((minConfidence) => ({
          minConfidence,
          ...retainedMetrics(transformed, { minConfidence, minMargin: entry.minMargin }),
        })),
      ),
    },
    {
      name: `${client} × ${spec.key}: VERDICT`,
      value:
        jev && measured.ece > criteria.eceCeiling
          ? `REOPEN G7(a): Jev measured ECE=${measured.ece}; exceeds ${criteria.eceCeiling}. Cuts alone cannot correct all-sample calibration. Owner decision required.`
          : `Held-out ECE=${measured.ece} ${measured.ece <= criteria.eceCeiling ? 'within' : 'exceeds'} diagnostic ceiling ${criteria.eceCeiling}; retained accuracy=${retained.metrics?.accuracy ?? 'N/A (none retained)'}.`,
    },
  )
  checks.push(
    check(
      `${spec.key}: nonempty fit and holdout`,
      fit.length > 0 && holdout.length > 0,
      `fit=${fit.length}; holdout=${holdout.length}`,
    ),
    check(
      `${spec.key}: cuts have a feasible fit`,
      cutFit.retained > 0,
      `${cutFit.retained}/${fit.length} fit samples retained at accuracy floor ${criteria.accuracyFloor}`,
    ),
    check(
      `${spec.key}: held-out calibration`,
      measured.ece <= criteria.eceCeiling,
      `ECE=${measured.ece}; ceiling=${criteria.eceCeiling}`,
    ),
    check(
      `${spec.key}: held-out retained accuracy`,
      !!retained.metrics && retained.metrics.accuracy >= criteria.accuracyFloor,
      JSON.stringify(retained),
    ),
  )
  return {
    observations,
    checks,
    entry: cutFit.retained > 0 ? entry : null,
    holdout: transformed,
  }
}
