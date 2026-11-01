/**
 * Ids that agents used to be registered under, mapped to their current id.
 *
 * Stored conversations and routines retain their original agent ids. Resolve each
 * retired id to the sole active agent when reading or running a turn, rather
 * than rewriting historical rows in a migration. The same mapping serves
 * display lookups, resumed turns, stale tabs and unattended entry points.
 *
 * Its own module, with no imports, so that last caller can map an id without
 * loading the registry and every agent definition behind it.
 *
 * Only ever add here; an entry is cheap and removing one re-strands old rows.
 */
const RENAMED_AGENT_IDS: Record<string, string> = {
  // Earlier aliases must remain direct mappings: canonicalAgentId is one hop.
  default: 'general-next',
  'sandbox-session': 'general-next',
  'flavoured-sandbox': 'general-next',
  general: 'general-next',
  // #898: retired selectable/exported agents.
  search: 'general-next',
  retriever: 'general-next',
  sandbox: 'general-next',
  'microsoft-365': 'general-next',
}

/** The agent a new chat opens with, and the id every caller that names none falls back to.
 * One constant, so the next change of default is one line. (#507 flip: was 'search'.) */
export const DEFAULT_AGENT_ID = 'general-next'

/** Current id for a possibly-legacy agent id. Unknown ids pass through. */
export function canonicalAgentId(id: string): string {
  return RENAMED_AGENT_IDS[id] ?? id
}

/**
 * Whether a legacy id folds forward at an UNATTENDED entry point: a routine
 * firing, or a POST to `/api/agents/:id`, where nobody is watching the run.
 *
 * #898 keeps saved routines and API callers running through the same successor
 * as saved conversations. This switch preserves the shared policy for both
 * unattended entry points.
 */
const FOLD_LEGACY_IDS_UNATTENDED = true

/** True when an unattended entry point may run under `id`. Both callers ask this
 *  before `getAgent`, so the decision lives here and nowhere else. */
export function unattendedIdAccepted(id: string): boolean {
  return FOLD_LEGACY_IDS_UNATTENDED || canonicalAgentId(id) === id
}
