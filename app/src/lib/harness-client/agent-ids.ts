/**
 * Ids that agents used to be registered under, mapped to their current id.
 *
 * `conversations.agent_id` stores whatever id the turn ran under, so a rename
 * strands every row written before it: `getOrBuildPatterns` would throw
 * `Unknown agent: default` and the thread would simply fail to open. Rather
 * than a SQL migration, the id is mapped forward on read — `getAgent` for
 * display lookups off raw rows, `loadSession` for the resume path (which also
 * means the row rewrites itself to the current id on its next save), and the
 * turn runner for the id a request NAMES, because a tab loaded before the
 * rename keeps sending the old one.
 *
 * Its own module, with no imports, so that last caller can map an id without
 * loading the registry and every agent definition behind it.
 *
 * Only ever add here; an entry is cheap and removing one re-strands old rows.
 */
const RENAMED_AGENT_IDS: Record<string, string> = {
  // PR #234 — 'default' named its position in the list, not what it does.
  default: 'search',
  // 2026-10-03 — the two sandbox agents became one (owner decision: "only one
  // sandbox agent"). `sandbox-session` is its `basic` route, and
  // `flavoured-sandbox` is the router it kept, so both land on it.
  'sandbox-session': 'sandbox',
  'flavoured-sandbox': 'sandbox',
  // 2026-10-21 — `general` (planner → loop over every tool, no injection guard)
  // was REMOVED, not renamed: this is a retirement folded into its successor.
  // Stored conversations resume on `general-next` (the history still renders —
  // it is the event stream, not the agent — and the row rewrites itself to the
  // new id on its next save), and so does anything that still NAMES the id: a
  // stale tab, a routine, a trigger-endpoint URL. One rule for every entry
  // point, so none of them can throw `Unknown agent: general`.
  general: 'general-next',
}

/** Current id for a possibly-legacy agent id. Unknown ids pass through. */
export function canonicalAgentId(id: string): string {
  return RENAMED_AGENT_IDS[id] ?? id
}

/**
 * Whether a legacy id folds forward at an UNATTENDED entry point: a routine
 * firing, or a POST to `/api/agents/:id`, where nobody is watching the run.
 *
 * Open owner decision (the `general` removal): today a legacy id runs on its
 * successor there, as it does everywhere. Those runs have no one to notice the
 * surface changed (`general-next` adds an office sandbox and drops the raw
 * tools), so the alternative is to refuse the legacy id outright. That switch
 * is this one constant: set it to `false` and both entry points answer as they
 * do for an unknown agent (404 / "unknown agent — skipping").
 */
const FOLD_LEGACY_IDS_UNATTENDED = true

/** True when an unattended entry point may run under `id`. Both callers ask this
 *  before `getAgent`, so the decision lives here and nowhere else. */
export function unattendedIdAccepted(id: string): boolean {
  return FOLD_LEGACY_IDS_UNATTENDED || canonicalAgentId(id) === id
}
