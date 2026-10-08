import * as baml from '@hames-ai/harness-baml/baml_client/inlinedbaml'
import * as jev from '@hames-ai/harness-baml/jev-decide.server'
import type { DecisionCalibrationEntry } from '@hames-ai/harness-patterns'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  feedDecisionCalibration,
  calibrationFingerprint,
  CALIBRATION_REVISION,
  type CalibrationArtifact,
} from '../../../lib/inference/decision-calibration.server'
import { CALIBRATION_SPECS } from '../../../lib/inference/decision-calibration-specs.server'
import {
  LOGPROB_CLIENTS,
  configureDecisionCalibration,
  decisionCalibrationFor,
} from '@hames-ai/harness-baml/clients.server'
import calibrationContract from '../../../lib/inference/decision-calibration-contract.json'
import committed from '../../../lib/inference/decision-calibration.json'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

vi.mock('@hames-ai/harness-baml/baml_client/inlinedbaml', async (importOriginal) => ({
  ...(await importOriginal<typeof baml>()),
  getBamlFiles: vi.fn((await importOriginal<typeof baml>()).getBamlFiles),
}))
vi.mock('@hames-ai/harness-baml/jev-decide.server', async (importOriginal) => ({
  ...(await importOriginal<typeof jev>()),
}))
afterEach(() => {
  configureDecisionCalibration({})
  vi.restoreAllMocks()
})
function artifact(client = 'JevDecide'): CalibrationArtifact {
  return {
    schemaVersion: 1,
    contractRevision: CALIBRATION_REVISION,
    status: 'measured',
    clients: {
      [client]: {
        fingerprint: calibrationFingerprint(client),
        entries: Object.fromEntries(
          CALIBRATION_SPECS.map((s) => [
            s.key,
            {
              minConfidence: 0.6,
              minMargin: 0.3,
              n: 8,
              fittedAt: '2026-10-08T00:00:00Z',
              ...(client !== 'JevDecide' && {
                temperature: 2,
                bias: Object.fromEntries(s.labels.map((_, i) => [String.fromCharCode(65 + i), 0])),
              }),
            },
          ]),
        ),
      },
    },
  }
}

describe('decision calibration host feed', () => {
  it('fingerprint default revision: production path uses CALIBRATION_REVISION', () => {
    for (const client of ['JevDecide', 'LocalQwenSmallDecide']) {
      expect(calibrationFingerprint(client)).toBe(
        calibrationFingerprint(client, CALIBRATION_REVISION),
      )
      expect(calibrationFingerprint(client)).not.toBe(calibrationFingerprint(client, 'other'))
    }
  })
  it('valid: committed unmeasured stays empty; complete measured values reach the real seam', () => {
    feedDecisionCalibration(committed)
    expect(decisionCalibrationFor('JevDecide', 'memory.merge')).toBeUndefined()
    const value = artifact()
    feedDecisionCalibration(value)
    expect(decisionCalibrationFor('JevDecide', 'memory.merge')).toEqual(
      value.clients.JevDecide.entries['memory.merge'],
    )
    feedDecisionCalibration(artifact('LocalQwenSmallDecide'))
    expect(decisionCalibrationFor('LocalQwenSmallDecide', 'memory.recall')?.temperature).toBe(2)
    feedDecisionCalibration(committed)
    expect(decisionCalibrationFor('LocalQwenSmallDecide', 'memory.recall')).toBeUndefined()
  })
  it('atomic: invalid second client never installs the valid first client', () => {
    const value = artifact()
    value.clients.LocalQwenSmallDecide = {
      ...artifact('LocalQwenSmallDecide').clients.LocalQwenSmallDecide,
      fingerprint: 'x',
    }
    expect(() => feedDecisionCalibration(value)).toThrow()
    expect(decisionCalibrationFor('JevDecide', 'route')).toBeUndefined()
  })
  it('fingerprint inputs: client, revision, model, prompt and declaration affect digest', async () => {
    const baseline = calibrationFingerprint('LocalQwenSmallDecide')
    const files = baml.getBamlFiles()
    for (const filename of ['decide.baml', 'local-client.baml'] as const) {
      vi.mocked(baml.getBamlFiles).mockReturnValue({
        ...files,
        [filename]: files[filename] + ' changed',
      })
      expect(calibrationFingerprint('LocalQwenSmallDecide')).not.toBe(baseline)
    }
    vi.mocked(baml.getBamlFiles).mockReturnValue(files)
    const jevBefore = calibrationFingerprint('JevDecide')
    vi.spyOn(jev, 'JEV_MODEL', 'get').mockReturnValue('changed-model' as typeof jev.JEV_MODEL)
    expect(calibrationFingerprint('JevDecide')).not.toBe(jevBefore)
    expect(calibrationFingerprint('JevDecide')).not.toBe(baseline)
    expect(
      calibrationFingerprint('LocalQwenSmallDecide', CALIBRATION_REVISION + '-changed'),
    ).not.toBe(baseline)
    const clients = LOGPROB_CLIENTS as Set<string>
    clients.add('OtherLogprob')
    try {
      expect(calibrationFingerprint('OtherLogprob')).not.toBe(baseline)
    } finally {
      clients.delete('OtherLogprob')
    }
  })
  it('missing: absent artifact or missing required key refuses, preserves previous table', () => {
    feedDecisionCalibration(artifact())
    expect(() => feedDecisionCalibration(undefined)).toThrow()
    const missing = artifact()
    delete (missing.clients.JevDecide.entries as Record<string, unknown>)['memory.merge']
    expect(() => feedDecisionCalibration(missing)).toThrow()
    expect(decisionCalibrationFor('JevDecide', 'memory.merge')?.n).toBe(8)
  })
  it('contract revision: drift refuses even an otherwise valid artifact', () => {
    const revision = calibrationContract.revision
    try {
      calibrationContract.revision = 'stale'
      expect(() => feedDecisionCalibration(artifact())).toThrow()
    } finally {
      calibrationContract.revision = revision
    }
  })
  it('fingerprint: question text and canonical label order invalidate a previous fit', () => {
    const spec = calibrationContract.specs[0] as {
      question: string
      labels: readonly { id: string; description: string }[]
    }
    const question = spec.question
    const labels = spec.labels
    const before = calibrationFingerprint('JevDecide')
    try {
      spec.question = question + ' changed'
      expect(calibrationFingerprint('JevDecide')).not.toBe(before)
      spec.question = question
      spec.labels = [...labels].reverse()
      expect(calibrationFingerprint('JevDecide')).not.toBe(before)
    } finally {
      spec.question = question
      spec.labels = labels
    }
  })
  it('mismatched: schema, revision, client, fingerprint, status, unknown key all refuse', () => {
    for (const patch of [
      { schemaVersion: 2 },
      { contractRevision: 'stale' },
      { status: 'calibrated' },
      { clients: {} },
      { status: 'unmeasured' },
    ])
      expect(() => feedDecisionCalibration({ ...artifact(), ...patch })).toThrow()
    const stale = artifact()
    stale.clients.JevDecide.fingerprint = 'stale-question-or-model'
    expect(() => feedDecisionCalibration(stale)).toThrow()
    expect(() => calibrationFingerprint('unknown')).toThrow()
    const extra = artifact()
    ;(extra.clients.JevDecide.entries as Record<string, unknown>)['unknown'] = {}
    expect(() => feedDecisionCalibration(extra)).toThrow()
  })
  it('values: invalid n, dates, cuts, temperature and bias refuse', () => {
    for (const patch of [
      { n: 0 },
      { n: 1.5 },
      { fittedAt: 'bad' },
      { minConfidence: -0.1 },
      { minMargin: NaN },
      { minConfidence: 2 },
      { unknown: 1 },
    ]) {
      const a = artifact()
      a.clients.JevDecide.entries = {
        ...a.clients.JevDecide.entries,
        route: { ...a.clients.JevDecide.entries.route, ...patch },
      }
      expect(() => feedDecisionCalibration(a)).toThrow()
    }
    for (const patch of [
      { temperature: 0 },
      { temperature: Infinity },
      { bias: { A: NaN } },
      { bias: { A: 0, B: 0, C: NaN } },
      { bias: { LABEL: 0 } },
      { bias: { A: 0, B: 0, C: 0, D: 0 } },
    ]) {
      const a = artifact('LocalQwenSmallDecide')
      a.clients.LocalQwenSmallDecide.entries = {
        ...a.clients.LocalQwenSmallDecide.entries,
        route: {
          ...a.clients.LocalQwenSmallDecide.entries.route,
          ...(patch as DecisionCalibrationEntry),
        },
      }
      expect(() => feedDecisionCalibration(a)).toThrow()
    }
  })
  it('Jev: temperature and bias refused at both host and configureDecisionCalibration (G7)', () => {
    for (const patch of [{ temperature: 1 }, { bias: {} }]) {
      const a = artifact()
      a.clients.JevDecide.entries = {
        ...a.clients.JevDecide.entries,
        route: { ...a.clients.JevDecide.entries.route, ...patch },
      }
      expect(() => feedDecisionCalibration(a)).toThrow()
      expect(() => configureDecisionCalibration({ JevDecide: { route: patch } })).toThrow(
        /cuts only/,
      )
    }
  })
})
