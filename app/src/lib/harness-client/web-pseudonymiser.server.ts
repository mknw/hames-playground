/** G14's single production import site for lib/privacy. Builds one ephemeral
 *  roster/table per invocation; nothing is persisted, cached or reversed. */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { PseudonymiseForWeb } from '@hames-ai/harness-patterns'
import { extractRoster } from '../privacy/graph-roster'
import { rosterFromDirectory, mergeRosters } from '../privacy/org-roster'
import { buildTable, apply } from '../privacy/pseudonymise'
import { loadDirectoryRoster } from '../org-graph/roster-source.server'

assertServerOnImport()

const isPlaceholder = (name: string | null): boolean => /^PERSON_\d/i.test(name ?? '')

/** `none` is only for a deployment without an org graph. Set it in code at
 *  the composition root, never from an env var. A required empty/unreadable
 *  directory throws: the wrapper withholds earlier content and all web calls. */
export function createWebPseudonymiser({
  directory = 'required',
}: { directory?: 'required' | 'none' } = {}): PseudonymiseForWeb {
  return async (payloads, latestUserMessage) => {
    const members = directory === 'none' ? [] : await loadDirectoryRoster()
    const directoryRoster = rosterFromDirectory(members)
    if (directory !== 'none' && directoryRoster.length === 0) {
      throw new Error('Web privacy requires a non-empty directory')
    }
    // Fixed directory order first, so colleagues retain their placeholder
    // numbers. External identities follow in first-seen order (E1).
    // Earlier info expansions can carry placeholders in labelled name fields.
    // They are already rewritten: harvesting them as new identities would map
    // PERSON_2 to another person's number on the next invocation.
    const payloadRoster = extractRoster(payloads)
      .map((entry) => ({
        ...entry,
        name: isPlaceholder(entry.name) ? null : entry.name,
        nameVariants: entry.nameVariants.filter((name) => !isPlaceholder(name)),
      }))
      .filter((entry) => entry.address || entry.nameVariants.length > 0)
    const roster = mergeRosters(directoryRoster, payloadRoster)
    const table = buildTable(roster)
    // A literal the principal actually named in this message may leave. Test
    // each form with the same Unicode/part boundaries as the input rewrite.
    const outgoingTable = {
      entries: table.entries.map((entry) => ({
        ...entry,
        forms: entry.forms.filter(
          (form) =>
            apply(latestUserMessage, { entries: [{ ...entry, forms: [form] }] }) ===
            latestUserMessage,
        ),
      })),
    }
    return {
      apply: <T>(value: T): T => apply(value, table),
      check: (args) => {
        let decoded: string
        try {
          // Decode escaped runs, leaving a literal percent ("5% growth") alone.
          // Check literal + as well as form-URL + below, so tagged addresses
          // and names separated by URL-encoded spaces are both covered.
          decoded = JSON.stringify(args).replace(/(?:%[\da-f]{2})+/gi, decodeURIComponent)
        } catch {
          return 'Web call refused: arguments could not be URL-decoded.'
        }
        // Any suffix: the pure builder may add new forms without weakening
        // this rule. A stable directory placeholder is an identifier too (E3).
        if (/PERSON_\d+/i.test(decoded)) return 'Placeholders are not search terms.'
        if ([decoded, decoded.replace(/\+/g, ' ')].some((s) => apply(s, outgoingTable) !== s)) {
          return 'The query contained a private identity; rephrase without it.'
        }
      },
    }
  }
}
