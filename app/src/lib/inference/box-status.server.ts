/**
 * Each self-deployed box's own `/status`, read when the control plane says a
 * container is up — Server Only.
 *
 * `/status` is the box's own readiness file: its supervisor writes it after
 * the post-restore checks, so an answer names the facts only the box knows —
 * `restored` (snapshot restore vs full boot) and `gpu` (`nvidia-smi`'s name,
 * on the small box). Reading it is the ONE request the admin read path may
 * send to a box, and only under the control plane's say-so: a request to a
 * scaled-to-zero box STARTS a GPU container (`small-gpu.server.ts` states the
 * rule), so this module never decides for itself whether to ask —
 * `gpu-admin.server.ts` calls it only for a container Modal reports ready.
 *
 * ## Once per container, never on a timer
 *
 * Every request to a box goes through Modal's proxy, and a request resets the
 * box's scaledown window (the same reason a keep-warm ping keeps a box up) —
 * so a panel that re-read `/status` on its poll while a container was up would
 * HOLD THE BOX UP for as long as the page was open, and a read that lands just
 * after a scale-to-zero starts a fresh container (#1057 review: 100 reads in
 * 600 s from one open panel, switch OFF). What `/status` reports —
 * `restored`, `gpu` — is a property of the container, fixed for its life, so
 * it is read ONCE per container id and the result, a failure included, is
 * remembered for that id. A different id (a new container) is a new read; the
 * same id is never asked again, by anyone, however many panels poll. Process
 * -local like every clock on this route.
 *
 * No user id, no conversation id, no prompt, no content (SD-10): the read
 * carries a box key and its own Authorization header.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { inferenceEnv } from '@hames-ai/harness-baml/inference-env.server'
import type { ModalBox } from './modal-control.server'

assertServerOnImport()

/** The `/status` facts one box reports, reduced to what any caller asks of it. */
export interface BoxStatusSample {
  /** `true` a snapshot restore, `false` a full boot; `null` when the file
   *  does not say. */
  restored: boolean | null
  /** `nvidia-smi`'s name for the GPU the container landed on, on the box
   *  that reports one; `null` when absent. */
  gpu: string | null
  /** When this sample was taken. */
  at: number
}

interface Remembered {
  containerId: string
  /** The one read for this container: pending while in flight, so a second
   *  caller shares it instead of sending a second request. */
  read: Promise<BoxStatusSample | null>
}

const cache: Partial<Record<ModalBox, Remembered>> = {}

/** Test-only reset: forget both boxes' reads. */
export function resetBoxStatusCacheForTests(): void {
  delete cache.large
  delete cache.small
}

function boxStatusUrl(box: ModalBox): { url: string; key: string | null } {
  if (box === 'large') {
    const base = (inferenceEnv('LARGE_LLM_BASE_URL') ?? '').replace(/\/v1\/?$/, '')
    return { url: `${base}/status`, key: inferenceEnv('LARGE_LLM_API_KEY') ?? null }
  }
  const base = (process.env.SMALL_LLM_BASE_URL ?? '').replace(/\/v1\/?$/, '')
  return { url: `${base}/status`, key: process.env.SMALL_LLM_API_KEY ?? null }
}

/**
 * Read one box's `/status` for one container — ONCE per container id. NEVER
 * THROWS and never decides whether the box may be asked — the caller owns that
 * gate (`gpu-admin.server.ts` opens it only for a container the control plane
 * lists as READY, i.e. registered to serve). `null` when unreadable
 * (unconfigured box, a non-200, a timeout, a body that is not the expected
 * JSON) — and that `null` is remembered too, so a failing read is not retried
 * on the poll.
 */
export function readBoxStatus(box: ModalBox, containerId: string): Promise<BoxStatusSample | null> {
  const remembered = cache[box]
  if (remembered && remembered.containerId === containerId) return remembered.read
  const read = fetchBoxStatus(box)
  cache[box] = { containerId, read }
  return read
}

async function fetchBoxStatus(box: ModalBox): Promise<BoxStatusSample | null> {
  const { url, key } = boxStatusUrl(box)
  if (!/^https?:\/\//.test(url)) return null // unconfigured box — nothing to ask
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    })
    if (!res.ok) {
      await res.text().catch(() => '') // drain: an undrained body holds the socket
      return null
    }
    const body = (await res.json().catch(() => null)) as {
      restored?: unknown
      gpu?: unknown
    } | null
    if (body === null) return null
    return {
      restored: typeof body.restored === 'boolean' ? body.restored : null,
      gpu: typeof body.gpu === 'string' && body.gpu !== '' ? body.gpu : null,
      at: Date.now(),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
