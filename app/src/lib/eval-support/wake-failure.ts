/** Diagnosable wake-failure text for the report: URLs shrink to host names, credentials never appear. */
export function describeWakeFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/https?:\/\/([^\s/:'"]+)[^\s'"]*/gi, (_u, host: string) => `<host ${host}>`)
    .replace(/\b(bearer|authorization:?)\s+\S+/gi, '$1 <redacted>')
    .replace(/\b(?:sk|key|tok)[-_][A-Za-z0-9_-]{8,}\b/gi, '<redacted>')
    .slice(0, 600)
}
