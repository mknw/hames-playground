import { JEV_KEY_ENV } from '@hames-ai/harness-baml/jev-decide.server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import calibrationContract from '../../../lib/inference/decision-calibration-contract.json'
import { CALIBRATION_REVISION } from '../../../lib/inference/decision-calibration.server'
import { CALIBRATION_SPECS } from '../../../lib/inference/decision-calibration-specs.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const read = (name: string) => readFileSync(path.resolve(process.cwd(), name), 'utf8')

describe('decision calibration scenario/script structure', () => {
  it('contract drift: metadata exactly matches current production questions and labels', () => {
    expect(calibrationContract.revision).toBe(CALIBRATION_REVISION)
    expect(calibrationContract.specs).toEqual(CALIBRATION_SPECS)
  })
  it('corpus: every production key plus eval route, labelled and disjoint fit/holdout', () => {
    const fixtures = JSON.parse(read('evals/decision-calibration-fixtures.json')) as {
      items: Array<{ id: string; key: string; state: string; truth: string; split: string }>
    }
    expect(CALIBRATION_SPECS.map((s) => s.key)).toEqual([
      'route',
      'memory.recall',
      'memory.store.target',
      'memory.store.confirm',
      'memory.store.kind',
      'memory.store.sensitive',
      'memory.merge',
      'document.injection',
    ])
    expect(new Set(fixtures.items.map((i) => i.id)).size).toBe(fixtures.items.length)
    expect(new Set(fixtures.items.map((i) => i.key))).toEqual(
      new Set(CALIBRATION_SPECS.map((s) => s.key)),
    )
    for (const spec of CALIBRATION_SPECS) {
      const items = fixtures.items.filter((i) => i.key === spec.key)
      const labels = spec.labels.map((l) => l.id)
      expect(
        items.every((i) => labels.includes(i.truth) && ['fit', 'holdout'].includes(i.split)),
      ).toBe(true)
      for (const split of ['fit', 'holdout']) {
        const rows = items.filter((i) => i.split === split)
        expect(rows.length).toBeGreaterThan(0)
        expect(new Set(rows.map((r) => r.truth))).toEqual(new Set(labels))
      }
      const fitStates = new Set(items.filter((i) => i.split === 'fit').map((i) => i.state))
      expect(items.filter((i) => i.split === 'holdout').some((i) => fitStates.has(i.state))).toBe(
        false,
      )
    }
  })
  it('scenario: registered, held-out metrics, cuts-only Jev verdict and actual serving evidence', () => {
    const source = read('src/lib/inference/decision-calibration-report.ts')
    const scenario = read('evals/scenarios/decision-calibration.ts')
    expect(read('evals/run.ts')).toMatch(/SCENARIOS[\s\S]*decisionCalibrationScenario,/)
    expect(scenario).toContain("id: 'decision-calibration'")
    expect(source).toContain('fitCalibration(fit, labels, jev, criteria.accuracyFloor)')
    expect(source).toContain('calibrationMetrics(holdout)')
    expect(source).toContain('[...spec.labels].reverse()')
    expect(source).toContain('orderSwapAgreement(pairs)')
    expect(source).toContain('read.llmCall.clientName !== client')
    expect(scenario).toContain('ctx.recordCall(read.llmCall)')
    expect(source).toContain('REOPEN G7(a): Jev measured ECE=')
    expect(scenario).toContain('candidate artifact (owner review before commit; never auto-fed)')
    expect(source).toContain('OWNER_TUNABLE_DEFAULTS')
    expect(scenario).toContain('tier: calibrationTier(jev)')
    expect(scenario).toContain('if (completeEntries(entries, CALIBRATION_SPECS))')
    expect(scenario).toContain('pooledReport(client, jev, pooled, criteria)')
  })
  it('runbook: current decision-only key and privacy controls', () => {
    const doc = read('../docs/testing/decision-calibration.md')
    expect(doc).toContain(JEV_KEY_ENV)
    expect(doc).not.toMatch(/OPENROUTER_API_KEY/)
  })
  it('host: composition feeds committed artifact; decide-only eval avoids unrelated preflight', () => {
    const config = read('src/lib/inference/config.server.ts')
    expect(config).toContain("from './decision-calibration.json'")
    expect(config).toContain('feedDecisionCalibration(decisionCalibrationArtifact)')
    expect(read('evals/run.ts')).toContain(
      "if (scenarios.some((s) => s.role !== 'decide')) await preflight(routing.client)",
    )
  })
  it('smoke: decide appended after screen, normalized distribution, serving client, max_tokens 2', () => {
    const smoke = read('src/lib/inference/scripts/smoke-verda.ts')
    expect(smoke).toContain(
      ' *   7. `smokeDecide()` — actual serving client, logprob method, normalized\n *      decision distribution and coverage on the small model.',
    )
    expect(smoke).toMatch(/await screen\(\)\s+await smokeDecide\(\)/)
    expect(smoke).toContain('result.llmCall?.clientName !== expected')
    expect(smoke).toContain('const expected = VERDA_CLIENT_BY_ROLE.decide')
    expect(smoke).toContain("result.method !== 'logprob'")
    const baml = read('../packages/harness-baml/baml_src/local-client.baml')
    expect(baml.slice(baml.indexOf('client<llm> LocalQwenSmallDecide'))).toMatch(/max_tokens 2\b/)
  })
})
