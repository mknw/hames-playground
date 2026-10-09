import * as baml from '@hames-ai/harness-baml/baml_client/inlinedbaml'
import * as jev from '@hames-ai/harness-baml/jev-decide.server'
import type { DecisionCalibrationEntry } from '@hames-ai/harness-patterns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { calibrationLabels } from '../../../lib/inference/decision-calibration-math'
import committed from '../../../lib/inference/decision-calibration.json'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

vi.mock('@hames-ai/harness-baml/baml_client/inlinedbaml', async (importOriginal) => ({
  ...(await importOriginal<typeof baml>()),
  getBamlFiles: vi.fn((await importOriginal<typeof baml>()).getBamlFiles),
}))
vi.mock('@hames-ai/harness-baml/jev-decide.server', async (importOriginal) => ({
  ...(await importOriginal<typeof jev>()),
}))
beforeEach(() => {
  vi.stubEnv('JEV_DECISIONS_URL', 'https://api.typesafe.ai/v1/systemone')
})
afterEach(() => {
  vi.unstubAllEnvs()
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
              ...((s.type ?? 'choice') === 'choice' && { minMargin: 0.3 }),
              n: 8,
              fittedAt: '2026-10-08T00:00:00Z',
              ...(client !== 'JevDecide' && {
                temperature: 2,
                bias: Object.fromEntries(
                  calibrationLabels(s).map((_, i) => [String.fromCharCode(65 + i), 0]),
                ),
              }),
            },
          ]),
        ),
      },
    },
  }
}

describe('decision calibration host feed', () => {
  it('r545-gate-fingerprint: an unset URL fingerprints the gated default route', () => {
    vi.stubEnv('JEV_DECISIONS_URL', 'https://api.typesafe.ai/v1/systemone')
    const direct = calibrationFingerprint('JevDecide')
    vi.stubEnv('JEV_DECISIONS_URL', '')
    expect(calibrationFingerprint('JevDecide')).not.toBe(direct) // gate false: no route
  })
  it('r545-calibration: TypeSafe and OpenRouter route models invalidate each other', () => {
    process.env.JEV_DECISIONS_URL = 'https://api.typesafe.ai/v1/systemone'
    const direct = calibrationFingerprint('JevDecide')
    process.env.JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'
    expect(calibrationFingerprint('JevDecide')).not.toBe(direct)
  })
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
    vi.spyOn(jev, 'jevModelFor').mockReturnValue('changed-model')
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

it('feed-refuses-margin-on-score-noul: any margin property refuses atomically on both clients', () => {
  for (const client of ['JevDecide', 'LocalQwenSmallDecide']) {
    for (const key of ['eval.score', 'eval.noul']) {
      const value = artifact(client)
      const entries = value.clients[client].entries as Record<string, DecisionCalibrationEntry>
      expect(() => feedDecisionCalibration(value)).not.toThrow()
      expect(decisionCalibrationFor(client, key)).not.toHaveProperty('minMargin')
      for (const minMargin of [0, 0.4, undefined]) {
        entries[key] = { ...entries[key], minMargin }
        expect(() => feedDecisionCalibration(value)).toThrow()
        expect(decisionCalibrationFor(client, key)).not.toHaveProperty('minMargin')
      }
    }
  }
})
it('feed-type-bias: score needs every level letter, noul precisely A and B', () => {
  for (const [key, invalid] of [
    [
      'eval.score',
      [
        { A: 0, B: 0 },
        { A: 0, B: 0, C: 0, D: 0 },
        { A: 0, B: 0, C: NaN },
      ],
    ],
    ['eval.noul', [{ A: 0 }, { A: 0, B: 0, C: 0 }, { true: 0, false: 0 }]],
  ] as const) {
    for (const bias of invalid) {
      const value = artifact('LocalQwenSmallDecide')
      const entries = value.clients.LocalQwenSmallDecide.entries as Record<
        string,
        DecisionCalibrationEntry
      >
      entries[key] = { ...entries[key], bias: Object.fromEntries(Object.entries(bias)) }
      expect(() => feedDecisionCalibration(value)).toThrow()
    }
  }
})
it('fingerprint-includes-type: old fit invalidated by type alone, envelope remains v1', () => {
  expect(committed).toEqual({
    schemaVersion: 1,
    contractRevision: '418-t8-v2',
    status: 'unmeasured',
    clients: {},
  })
  const spec = calibrationContract.specs[0]
  const type = spec.type
  const value = artifact()
  const before = calibrationFingerprint('LocalQwenSmallDecide')
  try {
    // Drop only the discriminant: same key/question/options/revision.
    delete (spec as { type?: string }).type
    expect(calibrationFingerprint('LocalQwenSmallDecide')).not.toBe(before)
    expect(calibrationFingerprint('JevDecide')).not.toBe(value.clients.JevDecide.fingerprint)
    expect(() => feedDecisionCalibration(value)).toThrow()
  } finally {
    spec.type = type
  }
})
it('fingerprint-type-details: changed level order or noul criteria invalidates fit', () => {
  for (const key of ['eval.score', 'eval.noul']) {
    const spec = calibrationContract.specs.find((s) => s.key === key)!
    const original = { ...spec }
    const before = calibrationFingerprint('LocalQwenSmallDecide')
    try {
      if (spec.type === 'score') spec.levels = [...spec.levels!].reverse()
      else spec.criteria = { ...spec.criteria!, true: 'Changed true criterion' }
      expect(calibrationFingerprint('LocalQwenSmallDecide')).not.toBe(before)
    } finally {
      Object.assign(spec, original)
    }
  }
})
