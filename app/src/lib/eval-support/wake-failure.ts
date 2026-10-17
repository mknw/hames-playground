import { WakeFailure } from '../inference/wake-failure'
/** Diagnosable wake-failure text for the report: URLs shrink to host names, credentials never appear. */
const SECRET_ENV = ['VERDA_INFERENCE_API_KEY', 'SMALL_LLM_API_KEY']

export function describeWakeFailure(err: unknown): string {
  let raw = err instanceof Error ? err.message : String(err)
  const keys = SECRET_ENV.map((name) => process.env[name] ?? '').filter((v) => v.length >= 8)
  for (const key of keys) raw = raw.split(key).join('<redacted>')
  // The response body is cut before this runs, so a key echo can arrive truncated: a literal check
  // cannot match a partial key, but a long token-like run that is a piece of one is still ours.
  raw = raw.replace(/[A-Za-z0-9+/=_.-]{12,}/g, (m) =>
    keys.some((k) => k.includes(m)) ? '<redacted>' : m,
  )
  return raw
    .replace(
      /https?:\/\/(?:[^\s/@'"]*@)?([^\s/:?#@'"]+)[^\s'"]*/gi,
      (_u, host: string) => `<host ${host}>`,
    )
    .replace(/\b(authorization\s*:\s*)?(bearer|basic)\s+\S+/gi, '$1$2 <redacted>')
    .replace(
      /\b(authorization|x-api-key|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1$2<redacted>',
    )
    .slice(0, 600)
}

export type WakeFailureReason =
  'VERDA_WAKE_FAILED' | 'SMALL_LLM_WAKE_FAILED' | 'PRIVATE_TIER_WAKE_FAILED'

/**
 * Stop reason naming the box that failed, read from the typed error the wake throws and never
 * from its message, which embeds remote response text. Anything that is not a `WakeFailure`
 * (a bare abort, a thrown string) cannot be attributed and says so rather than guessing.
 */
export function wakeFailureReason(err: unknown): WakeFailureReason {
  if (!(err instanceof WakeFailure)) return 'PRIVATE_TIER_WAKE_FAILED'
  return err.box === 'small' ? 'SMALL_LLM_WAKE_FAILED' : 'VERDA_WAKE_FAILED'
}
