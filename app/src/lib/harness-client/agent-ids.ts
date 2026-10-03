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
}

/** Current id for a possibly-legacy agent id. Unknown ids pass through. */
export function canonicalAgentId(id: string): string {
  return RENAMED_AGENT_IDS[id] ?? id
}
