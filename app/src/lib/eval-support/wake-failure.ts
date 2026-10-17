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

/**
 * Stop reason naming the box that failed. `ensurePrivateTierAwake` rejects with the first box's
 * own message (the 27B's carries "the 27B", the small box's "small model box"); anything else,
 * such as a bare abort, cannot be attributed and says so rather than guessing a box.
 */
export function wakeFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('small model box')) return 'SMALL_LLM_WAKE_FAILED'
  if (msg.includes('the 27B')) return 'VERDA_WAKE_FAILED'
  return 'PRIVATE_TIER_WAKE_FAILED'
}
