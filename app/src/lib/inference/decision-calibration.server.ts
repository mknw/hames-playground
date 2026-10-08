/** Versioned host feed for #418 T8; no calls, no routing, no inferred fits. */
import { createHash } from 'node:crypto'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  configureDecisionCalibration,
  JEV_CLIENTS,
  LOGPROB_CLIENTS,
  type DecisionCalibrationTable,
} from '@hames-ai/harness-baml/clients.server'
import { getBamlFiles } from '@hames-ai/harness-baml/baml_client/inlinedbaml'
import { jevModelFor, parseDecisionsUrl } from '@hames-ai/harness-baml/jev-decide.server'
import calibrationContract from './decision-calibration-contract.json'

// Metadata only at host composition. A hermetic drift pin checks the actual
// production exports, without pulling tool transports onto this boot path.
const CALIBRATION_SPECS = calibrationContract.specs

assertServerOnImport()

export const CALIBRATION_REVISION = '418-t8-v1'
export interface CalibrationArtifact {
  schemaVersion: 1
  contractRevision: string
  status: 'unmeasured' | 'measured'
  clients: Record<string, { fingerprint: string; entries: DecisionCalibrationTable[string] }>
}

/** The model the configured Jev route sends; null when no usable route is configured (fits then never match). */
function jevRouteModel(): string | null {
  const url = parseDecisionsUrl(process.env.JEV_DECISIONS_URL ?? '')
  return typeof url === 'string' ? null : jevModelFor(url.hostname)
}

/** Bind fits to the ordered questions/labels and transport/model contract.
 * A local prompt/client change invalidates its fits, even under the same name. */
export function calibrationFingerprint(client: string, revision = CALIBRATION_REVISION): string {
  const files = getBamlFiles()
  const transport = JEV_CLIENTS.has(client)
    ? { method: 'jev', model: jevRouteModel(), revision: 'G7-G8-cuts-only-v1' }
    : LOGPROB_CLIENTS.has(client)
      ? { method: 'logprob', prompt: files['decide.baml'], client: files['local-client.baml'] }
      : undefined
  if (!transport) throw new Error(`Unknown calibration client: ${client}`)
  return createHash('sha256')
    .update(
      JSON.stringify({
        client,
        revision,
        specs: CALIBRATION_SPECS,
        transport,
      }),
    )
    .digest('hex')
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function refuse(): never {
  throw new Error('Missing or mismatched decision calibration artifact')
}

/** Strict boundary: validate EVERYTHING before replacing the process table.
 * Explicit unmeasured is an empty table, never an identity "calibration". */
export function feedDecisionCalibration(value: unknown): void {
  if (
    calibrationContract.revision !== CALIBRATION_REVISION ||
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.contractRevision !== CALIBRATION_REVISION ||
    !object(value.clients)
  )
    refuse()
  const clients = Object.entries(value.clients)
  if (value.status === 'unmeasured') {
    if (clients.length) refuse()
    configureDecisionCalibration({})
    return
  }
  if (value.status !== 'measured' || !clients.length) refuse()
  const table: Record<string, DecisionCalibrationTable[string]> = {}
  for (const [client, record] of clients) {
    if (
      !object(record) ||
      record.fingerprint !== calibrationFingerprint(client) ||
      !object(record.entries)
    )
      refuse()
    const keys = CALIBRATION_SPECS.map((s) => s.key)
    if (
      Object.keys(record.entries).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(record.entries as object, k))
    )
      refuse()
    for (const spec of CALIBRATION_SPECS) {
      const entry = record.entries[spec.key]
      if (
        !object(entry) ||
        Object.keys(entry).some(
          (k) =>
            !['temperature', 'bias', 'minConfidence', 'minMargin', 'n', 'fittedAt'].includes(k),
        )
      )
        refuse()
      if (
        !Number.isInteger(entry.n) ||
        (entry.n as number) < 1 ||
        typeof entry.fittedAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.fittedAt))
      )
        refuse()
      for (const cut of [entry.minConfidence, entry.minMargin])
        if (typeof cut !== 'number' || !Number.isFinite(cut) || cut < 0 || cut > 1) refuse()
      if (JEV_CLIENTS.has(client) && (entry.temperature !== undefined || entry.bias !== undefined))
        refuse()
      if (LOGPROB_CLIENTS.has(client)) {
        if (
          typeof entry.temperature !== 'number' ||
          !Number.isFinite(entry.temperature) ||
          entry.temperature <= 0 ||
          !object(entry.bias)
        )
          refuse()
        const letters = spec.labels.map((_, i) => String.fromCharCode(65 + i))
        if (
          Object.keys(entry.bias).length !== letters.length ||
          letters.some(
            (l) =>
              typeof (entry.bias as Record<string, unknown>)[l] !== 'number' ||
              !Number.isFinite((entry.bias as Record<string, number>)[l]),
          )
        )
          refuse()
      }
    }
    table[client] = record.entries as DecisionCalibrationTable[string]
  }
  configureDecisionCalibration(table)
}
