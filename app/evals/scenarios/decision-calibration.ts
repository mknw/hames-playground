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
import type { DecisionCalibrationEntry, DecideFn } from '@hames-ai/harness-patterns'
import { expectedClientFor } from '../client'
import { type Scenario, type Observation, type Check } from '../harness'
import fixtures from '../decision-calibration-fixtures.json'
import { CALIBRATION_SPECS } from '../../src/lib/inference/decision-calibration-specs.server'
import {
  CALIBRATION_REVISION,
  calibrationFingerprint,
  type CalibrationArtifact,
} from '../../src/lib/inference/decision-calibration.server'
import type { CalibrationSample } from '../../src/lib/inference/decision-calibration-math'
import {
  evaluateKey,
  diagnosticCriteria,
  criteriaObservation,
  calibrationTier,
  completeEntries,
  pooledReport,
} from '../../src/lib/inference/decision-calibration-report'

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
    const criteria = diagnosticCriteria()
    configureDecisionCalibration({}) // the eval process measures RAW distributions
    const observations: Observation[] = [
      criteriaObservation(criteria),
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
    const pooled: CalibrationSample[] = []
    let calls = 0
    await withRunFrame(
      {
        inference: {
          tier: calibrationTier(jev),
          clientOverride: (role) => (role === 'decide' ? { client } : undefined),
        },
      },
      async () => {
        const adapter = createDecideAdapter()
        const decide: DecideFn = async (input) => {
          const read = await adapter(input)
          if (read.llmCall) {
            ctx.recordCall(read.llmCall)
            calls++
          }
          return read
        }
        for (const spec of CALIBRATION_SPECS) {
          const items = fixtures.items.filter((item) => item.key === spec.key)
          const report = await evaluateKey({ spec, items, decide, jev, client, criteria })
          observations.push(...report.observations)
          checks.push(...report.checks)
          pooled.push(...report.holdout)
          if (report.entry) entries[spec.key] = report.entry
        }
      },
    )
    const pool = pooledReport(client, jev, pooled, criteria)
    observations.push(...pool.observations)
    checks.push(...pool.checks)
    if (completeEntries(entries, CALIBRATION_SPECS)) {
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
