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
    hint: "The LLM tried to use a tool not in this agent's toolset.",
  },
  // No entry for a loop's own round-budget exhaustion ("Loop exhausted: reached
  // maxTurns…", "Max retries (N) exceeded"). Both loops build that hint with
  // `budgetHint` below, which knows whether the PATTERN or the SETTING bound —
  // a table keyed on the message cannot, and the entry that used to live here
  // told every reader to raise a setting that a pinned loop ignores (#269).
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

/** What each round budget is called where a reader can change it: the Settings
 *  slider's own label (`SettingsPanel.tsx`) and the pattern-config field. Both
 *  are strings a reader has to find in a UI or a file, so they are written the
 *  way they appear there rather than as the setting key. */
const BUDGET_LEVERS = {
  maxToolTurns: { slider: 'Max Tool Turns', field: 'maxTurns' },
  maxRetries: { slider: 'Max Retries', field: 'maxRetries' },
} as const

/**
 * The hint on a loop's round-budget exhaustion — the one place both loop
 * patterns word it, so `simpleLoop` and `actorCritic` cannot drift.
 *
 * It exists to name the RIGHT lever. `resolveTurnBudget` lets a pattern's own
 * declaration win over the request's setting, so for a pinned loop the Settings
 * slider is inert — and the pre-#269 wording ("increase maxToolTurns in
 * settings") was advice that changed nothing on the agent that actually hit the
 * cap. A developer reading the observability panel needs to be sent to the
 * agent's own config; a user on an unpinned loop needs the slider.
 *
 * @param key       which budget ran out — picks the lever names
 * @param declared  the pattern's own budget, if it declared one
 * @param effective the budget after clamping: what the loop really ran on
 * @param patternId the loop's id, so the hint names the config to edit
 */
export function budgetHint(
  key: keyof typeof BUDGET_LEVERS,
  declared: number | undefined,
  effective: number,
  patternId: string,
): string {
  const { slider, field } = BUDGET_LEVERS[key]
  const tail =
    'Nothing failed — the loop was still working when the budget ran out, so the answer is composed from the completed rounds only. Simplifying the task also fits it in fewer rounds.'
  if (declared === undefined) {
    return `This loop ran on the "${slider}" setting (${effective}). Raise it in Settings to give it more rounds. ${tail}`
  }
  const clamped = declared === effective ? '' : ` (clamped to ${effective})`
  return `This loop declares its own budget of ${declared}${clamped}, which overrides the "${slider}" setting — raise \`${field}\` on the \`${patternId}\` pattern in its agent config, not the setting. ${tail}`
}
