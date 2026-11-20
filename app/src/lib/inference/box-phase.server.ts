/**
 * Where a self-deployed box is in its start, from Modal's control plane — Server Only.
 *
 * ONE derivation, read by both the admin panel's per-box line
 * (`harness-client/gpu-admin.server.ts`) and the chat's warming notice
 * (`harness-client/preview-header.server.ts`, `getWarmingBoxStates`), so the
 * two surfaces cannot name two different states for one box (#1057 §3: "the
 * same control-plane state as the admin panel").
 *
 * The phases follow what Modal CREATES, not what the box's endpoint answers
 * (a booting box answers a bare 503 whether it is slow or failing):
 *
 *  - `cold` — Modal lists no container and no boot is pending: scaled to zero.
 *  - `waiting` — no container yet, but a boot has been asked for (the wake
 *    poll, the switch, the loop) less than `modalNotStartingAfterMs()` ago.
 *  - `not-starting` — no container, and the ask is older than that: Modal is
 *    not creating one.
 *  - `booting` — Modal has created a container (its task list, with a start
 *    time) that is not registered to serve yet — a full boot happens inside it.
 *  - `up` — a container is registered to serve.
 *  - `unknown` — the control-plane read failed.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  modalBootPendingSince,
  modalNotStartingAfterMs,
  type ModalBoxProbe,
  type ModalBox,
  type ModalContainer,
} from './modal-control.server'

assertServerOnImport()

export type BoxPhase = 'cold' | 'waiting' | 'not-starting' | 'booting' | 'up' | 'unknown'

export interface BoxPhaseReading {
  phase: BoxPhase
  /** `booting` / `up`: the oldest container's start per Modal (`null` while it
   *  is still `Pending`). `waiting` / `not-starting`: when the boot was asked
   *  for. `null` otherwise. The base the elapsed time is measured from. */
  startedAtMs: number | null
  /** Containers Modal reports; `null` when the read failed. */
  containers: number | null
  /** The container to read `/status` from — the oldest READY one — or `null`. */
  ready: ModalContainer | null
  /** `booting` only: Modal did not say whether a container is serving. */
  readinessUnknown: boolean
  /** `not-starting`: how long the boot has been asked for, ms. */
  waitedMs: number
  /** The probe's own reason when the read failed. */
  reason: string | null
}

export function readBoxPhase(box: ModalBox, probe: ModalBoxProbe, now: number): BoxPhaseReading {
  if (!probe.ok || probe.containerCount === null) {
    return {
      phase: 'unknown',
      startedAtMs: null,
      containers: null,
      ready: null,
      readinessUnknown: false,
      waitedMs: 0,
      reason: probe.reason,
    }
  }
  if (probe.containerCount === 0) {
    const pendingSince = modalBootPendingSince(box)
    const waitedMs = pendingSince !== null ? now - pendingSince : 0
    const phase: BoxPhase =
      pendingSince === null ? 'cold' : waitedMs > modalNotStartingAfterMs() ? 'not-starting' : 'waiting'
    return {
      phase,
      startedAtMs: pendingSince,
      containers: 0,
      ready: null,
      readinessUnknown: false,
      waitedMs,
      reason: null,
    }
  }
  const ready =
    probe.containers
      .filter((c) => c.ready === true)
      .sort((a, b) => (a.startedAtMs ?? Infinity) - (b.startedAtMs ?? Infinity))[0] ?? null
  return {
    phase: ready ? 'up' : 'booting',
    startedAtMs: probe.oldestContainerStartedAtMs,
    containers: probe.containerCount,
    ready,
    readinessUnknown: !ready && probe.containers.some((c) => c.ready === null),
    waitedMs: 0,
    reason: null,
  }
}
