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
 * `gpu-admin.server.ts` calls it only when Modal reports a container.
 *
 * ## The cache
 *
 * One sample per box, cached process-side for the probe's own TTL (12 s), so
 * the panel's 3 s poll rides it rather than re-asking a live box; a failed
 * read caches `null` for the same window so a booting box's 503s cost one
 * request per window, not one per poll. Process-local like every clock on
 * this route, for the same reasons.
 *
 * No user id, no conversation id, no prompt, no content (SD-10): the read
 * carries a box key and its own Authorization header.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { inferenceEnv } from '@hames-ai/harness-baml/inference-env.server'
import { MODAL_PROBE_CACHE_TTL_MS, type ModalBox } from './modal-control.server'

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

const cache: Partial<Record<ModalBox, BoxStatusSample | null>> = {}

/** Test-only reset: drop both cached samples. */
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
 * Read one box's `/status`, from the cache when fresh. NEVER THROWS and
 * never decides whether the box may be asked — the caller owns that gate
 * (`gpu-admin.server.ts` opens it only on the control plane's container
 * count). `null` when unreadable (unconfigured box, a 503 while the weights
 * load, a timeout, a body that is not the expected JSON).
 */
export async function readBoxStatus(box: ModalBox): Promise<BoxStatusSample | null> {
  const cached = cache[box]
  if (
    cached !== undefined &&
    cached !== null &&
    Date.now() - cached.at < MODAL_PROBE_CACHE_TTL_MS
  ) {
    return cached
  }
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
    const sample: BoxStatusSample = {
      restored: typeof body.restored === 'boolean' ? body.restored : null,
      gpu: typeof body.gpu === 'string' && body.gpu !== '' ? body.gpu : null,
      at: Date.now(),
    }
    cache[box] = sample
    return sample
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
