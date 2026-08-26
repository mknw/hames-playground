/**
 * Reading the roster back out of the graph — Server Only.
 *
 * The other half of the pseudonymisation seam. `roster-ingest.server.ts` puts
 * the directory into the graph; this reads it out as the plain records
 * `lib/privacy/org-roster.ts` turns into a substitution roster.
 *
 * ## Why this module imports nothing from `lib/privacy/`
 * It returns `{ displayName, mail }[]` — the structural shape
 * `privacy/org-roster.ts` declares as `DirectoryPerson` — rather than
 * `RosterEntry[]`. Two reasons, and the second is the load-bearing one:
 *
 *  1. `lib/privacy/` is pure by contract (no I/O, no model, no server-only
 *     modules), and having it read a graph would end that.
 *  2. It keeps the direction of dependency honest about what has and has not
 *     been decided. A **mapping source** now exists; a **hook** does not. Where
 *     the substitution actually runs is one of the three open questions in
 *     `docs/plan/graph-pseudonymisation.md`, and PR #258 puts a source-scan
 *     tripwire in front of them. Wiring privacy imports into a server module
 *     here would trip that tripwire while answering none of its questions.
 *
 * So the composition — `rosterFromDirectory(await loadDirectoryRoster())` — is
 * written down exactly once, in the manual verification script under
 * `scripts/`, and nowhere on a production path.
 *
 * Not a `'use server'` module: see `schema.server.ts`'s header (SD-13). This
 * returns the whole tenant's names and addresses, which is precisely the shape
 * of function that must not be browser-reachable.
 */
import neo4j from 'neo4j-driver'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { getNeo4jDriver } from '../neo4j/client'

assertServerOnImport()

/** One member, reduced to the two fields a substitution roster needs. */
export interface DirectoryRosterRow {
  displayName: string
  mail: string
}

/**
 * Every `Member` in the graph, ordered by `entraId`.
 *
 * The order matters and is therefore fixed rather than left to the planner:
 * placeholder numbering in `buildTable` is roster-positional, so an unordered
 * read would hand the same directory a different numbering on every call. Sorted
 * on `entraId` — immutable per person, unlike `displayName` and `mail` — the
 * numbering changes only when the roster's membership does.
 *
 * `department` and `jobTitle` are deliberately not selected: they are not
 * identity literals, so reading them here would carry personal data into a
 * substitution path that has no use for it.
 */
export async function loadDirectoryRoster(): Promise<DirectoryRosterRow[]> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run(
      `MATCH (m:Member)
       WHERE m.displayName IS NOT NULL AND m.mail IS NOT NULL
       RETURN m.displayName AS displayName, m.mail AS mail
       ORDER BY m.entraId`,
    )
    return result.records.map((record) => ({
      displayName: String(record.get('displayName')),
      mail: String(record.get('mail')),
    }))
  } finally {
    await session.close()
  }
}
