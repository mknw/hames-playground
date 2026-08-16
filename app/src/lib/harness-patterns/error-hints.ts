/**
 * Hardcoded error hint lookup for common failure modes.
 *
 * TODO: Make config-aware — e.g., read the number of fallback clients
 * from BAML config to generate hints like "add multiple fallback models"
 * when only one client is configured, or "review the retry_policy for
 * clients declared in your BAML config" when retries are exhausted.
 */

interface ErrorHint {
  match: (error: string) => boolean
  hint: string
}

const ERROR_HINTS: ErrorHint[] = [
  {
    match: (e) => /413|payload too large|content_too_large/i.test(e),
    hint: 'Consider reducing "Max Tool Turns" or "Max Result Chars" in Settings.',
  },
  {
    match: (e) => /BamlValidationError/i.test(e),
    hint: 'The LLM output could not be parsed. This may resolve on the next loop iteration, or check your BAML fallback config.',
  },
  {
    match: (e) => /rate.?limit|429|too many requests/i.test(e),
    hint: 'Rate limited by the LLM provider. This may resolve on retry, or wait a moment.',
  },
  {
    match: (e) => /timeout|ETIMEDOUT|ECONNRESET/i.test(e),
    hint: 'Request timed out. The tool server may be unreachable.',
  },
  {
    match: (e) => /Tool not allowed/i.test(e),
    hint: 'The LLM tried to use a tool not in this agent\'s toolset.',
  },
  {
    match: (e) => /Max retries.*exceeded/i.test(e),
    hint: 'The actor-critic loop exhausted retries. Consider increasing "Max Retries" in Settings or simplifying the task.',
  },
  {
    match: (e) => /ECONNREFUSED/i.test(e),
    hint: 'Cannot connect to the tool server. Is Docker / the MCP gateway running?',
  },
]

/** Look up a user-facing hint for a given error message. */
export function getErrorHint(error: string): string | undefined {
  for (const h of ERROR_HINTS) {
    if (h.match(error)) return h.hint
  }
  return undefined
}
