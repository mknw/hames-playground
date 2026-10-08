/** LIVE ONLY. Importing this declaration makes no calls. G7/G10 diagnostics. */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createDecideAdapter } from '@hames-ai/harness-baml/baml-adapters.server'
import {
  configureDecisionCalibration,
  JEV_CLIENTS,
  LOGPROB_CLIENTS,
} from '@hames-ai/harness-baml/clients.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type { DecisionCalibrationEntry } from '@hames-ai/harness-patterns'
import { expectedClientFor } from '../client'
import { check, type Scenario, type Observation, type Check } from '../harness'
import fixtures from '../decision-calibration-fixtures.json'
import { CALIBRATION_SPECS } from '../../src/lib/inference/decision-calibration-specs.server'
import {
  CALIBRATION_REVISION,
  calibrationFingerprint,
  type CalibrationArtifact,
} from '../../src/lib/inference/decision-calibration.server'
import {
  applyFit,
  calibrationMetrics,
  fitCalibration,
  fitCuts,
  orderSwapAgreement,
  retainedMetrics,
  type CalibrationSample,
} from '../../src/lib/inference/decision-calibration-math'

/** Owner-tunable diagnostic defaults (G10), not consumer policies. */
function criterion(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`)
  return value
}

export const decisionCalibrationScenario: Scenario = {
  id: 'decision-calibration',
  role: 'decide',
  title: 'Decision calibration — per client × key, fit and held-out diagnostics',
  what: 'measure OUR synthetic questions, produce a reviewed calibration candidate; Jev takes cuts only (G7)',
  run: async (ctx) => {
    const client = expectedClientFor(ctx.routing, 'decide')
    const jev = JEV_CLIENTS.has(client)
    if (!jev && !LOGPROB_CLIENTS.has(client))
      throw new Error(`Unsupported calibration client ${client}`)
    const accuracyFloor = criterion('EVAL_DECISION_ACCURACY', 0.95)
    const eceCeiling = criterion('EVAL_DECISION_ECE', 0.05)
    configureDecisionCalibration({}) // the eval process measures RAW distributions
    const observations: Observation[] = [
      {
        name: 'diagnostic criteria (owner-tunable defaults, G10)',
        value: `fit retained accuracy >= ${accuracyFloor}; held-out ECE <= ${eceCeiling}. Small synthetic corpus; no statistical certification.`,
      },
      {
        name: 'fit mode',
        value: jev
          ? 'CUTS ONLY (G7); temperature/bias forbidden. Cuts cannot change all-sample ECE.'
          : 'temperature + per-letter bias + confidence/margin cuts',
      },
      {
        name: 'corpus',
        value: `${fixtures.revision}; disjoint predeclared fit/holdout; eval-only route; production recall/store/merge/injection questions`,
      },
    ]
    const checks: Check[] = []
    const entries: Record<string, DecisionCalibrationEntry> = {}
    let calls = 0
    await withRunFrame(
      {
        inference: {
          tier: jev ? 'anthropic' : 'verda',
          clientOverride: (role) => (role === 'decide' ? { client } : undefined),
        },
      },
      async () => {
        const decide = createDecideAdapter()
        for (const spec of CALIBRATION_SPECS) {
          const items = fixtures.items.filter((item) => item.key === spec.key)
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
              ctx.recordCall(read.llmCall)
              calls++
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
            ...fitCalibration(fit, labels, jev, accuracyFloor),
            fittedAt: new Date().toISOString(),
          }
          const transformedFit = jev ? fit : fit.map((s) => applyFit(s, labels, entry))
          const transformed = jev ? holdout : holdout.map((s) => applyFit(s, labels, entry))
          const cutFit = fitCuts(transformedFit, accuracyFloor)
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
                orderSwapAgreement: orderSwapAgreement(pairs),
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
                jev && measured.ece > eceCeiling
                  ? `REOPEN G7(a): Jev measured ECE=${measured.ece}; exceeds ${eceCeiling}. Cuts alone cannot correct all-sample calibration. Owner decision required.`
                  : `Held-out ECE=${measured.ece} ${measured.ece <= eceCeiling ? 'within' : 'exceeds'} diagnostic ceiling ${eceCeiling}; retained accuracy=${retained.metrics?.accuracy ?? 'N/A (none retained)'}.`,
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
              `${cutFit.retained}/${fit.length} fit samples retained at accuracy floor ${accuracyFloor}`,
            ),
            check(
              `${spec.key}: held-out calibration`,
              measured.ece <= eceCeiling,
              `ECE=${measured.ece}; ceiling=${eceCeiling}`,
            ),
            check(
              `${spec.key}: held-out retained accuracy`,
              !!retained.metrics && retained.metrics.accuracy >= accuracyFloor,
              JSON.stringify(retained),
            ),
          )
          if (cutFit.retained > 0) entries[spec.key] = entry
        }
      },
    )
    if (Object.keys(entries).length === CALIBRATION_SPECS.length) {
      const artifact: CalibrationArtifact = {
        schemaVersion: 1,
        contractRevision: CALIBRATION_REVISION,
        status: 'measured',
        clients: { [client]: { fingerprint: calibrationFingerprint(client), entries } },
      }
      const directory = path.resolve(process.cwd(), 'evals/reports')
      await mkdir(directory, { recursive: true })
      const destination = path.join(directory, `decision-calibration-${client}-${Date.now()}.json`)
      await writeFile(destination, JSON.stringify(artifact, null, 2) + '\n')
      observations.push({
        name: 'candidate artifact (owner review before commit; never auto-fed)',
        value: destination,
      })
    } else
      observations.push({
        name: 'candidate artifact',
        value: 'REFUSED: at least one key has no feasible cuts; no complete artifact written.',
      })
    observations.push({ name: 'actual serving client and calls', value: `${client}: ${calls}` })
    return { checks, observations }
  },
}
