/** Diagnosable wake-failure text for the report: URLs shrink to host names, credentials never appear. */
const SECRET_ENV = ['VERDA_INFERENCE_API_KEY', 'SMALL_LLM_API_KEY']

export function describeWakeFailure(err: unknown): string {
  let raw = err instanceof Error ? err.message : String(err)
  for (const name of SECRET_ENV) {
    const value = process.env[name]
    if (value && value.length >= 8) raw = raw.split(value).join('<redacted>')
  }
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
