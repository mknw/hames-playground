/**
 * Ingest the tenant's member roster into Neo4j, then verify it.
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/ingest-roster.ts
 *
 * Needs `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` (the app
 * registration's client-credentials identity, with the `User.Read.All`
 * *application* permission admin-consented) and the Neo4j compose service up.
 *
 * ## Output is redacted by construction
 * Everything printed on the success path is a count, a property name or a
 * reason code. No display name and no address is ever written to stdout — see
 * `_redact.ts`.
 *
 * The **error** path is the one that is not redacted by construction, because
 * the string does not originate here: a Graph failure message quotes the
 * request path, and on the memberships loop that path carries a member's Entra
 * object id. Still no name and no address, so the guarantee above holds
 * literally — but an opaque identifier for one employee is enough to make
 * "paste this into a PR" need a caveat, so the message goes through
 * `maskGraphIds` and does not.
 *
 * `--no-memberships` skips the per-member group reads. They are gated by a
 * one-request probe anyway (`probeGroupReadAccess`), so the flag is for when you
 * want to skip even that.
 *
 * ## What "passing" looks like
 * `written` equals `fetched` minus the rejected rows, the constraint list is
 * complete, and non-conformance is `none`. A non-zero `incomplete` tally is
 * expected, not a failure: it is the soft tier of the ontology reporting how
 * much of the directory is filled in (see `docs/org-graph.md`).
 */
import { ingestRoster } from '../roster-ingest.server'
import { countNonConforming, listConstraintNames } from '../schema.server'
import { CONSTRAINT_NAMES } from '../ontology'
import { loadDirectoryRoster } from '../roster-source.server'
import { resetDriver } from '../../neo4j/client'
import { formatCounts, maskGraphIds } from './_redact'

function requireEnv(): void {
  const missing = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].filter(
    (k) => !process.env[k]?.trim(),
  )
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(', ')}. Run with --env-file=.env from app/, or export them.`,
    )
  }
}

async function main(): Promise<void> {
  requireEnv()
  console.log('👥 org-graph roster ingest (app-only Graph credential)')

  const startedAt = Date.now()
  const report = await ingestRoster({
    includeMemberships: !process.argv.includes('--no-memberships'),
  })

  console.log('\n— Ingest —')
  console.log(`  pages walked:        ${report.pages}`)
  console.log(`  rows fetched:        ${report.fetched}`)
  console.log(`  members written:     ${report.written}`)
  console.log(`  rejected rows:       ${report.rejectedRows}`)
  console.log(`  rejected (hard):     ${formatCounts(report.rejected)}`)
  console.log(`  incomplete (soft):   ${formatCounts(report.incomplete)}`)
  console.log(`  stale (not in feed): ${report.stale}`)

  console.log('\n— Teams / MEMBER_OF —')
  console.log(`  attempted: ${report.memberships.attempted}`)
  console.log(`  teams:     ${report.memberships.teams}`)
  console.log(`  edges:     ${report.memberships.edges}`)
  if (report.memberships.blockedReason) {
    console.log(`  blocked:   ${report.memberships.blockedReason}`)
  }

  const constraints = await listConstraintNames()
  const missing = CONSTRAINT_NAMES.filter((n) => !constraints.includes(n))
  const drift = await countNonConforming()
  const roster = await loadDirectoryRoster()

  console.log('\n— Verification —')
  console.log(
    `  constraints:      ${CONSTRAINT_NAMES.length - missing.length}/${CONSTRAINT_NAMES.length}` +
      (missing.length ? ` (missing ${missing.join(', ')})` : ''),
  )
  console.log(`  non-conforming:   ${drift.length === 0 ? 'none' : ''}`)
  for (const row of drift) {
    console.log(`    ${row.kind} ${row.detail.join('/') || '—'} × ${row.count}`)
  }
  console.log(`  roster readable:  ${roster.length} rows with both displayName and mail`)

  // Row arithmetic, not the violation tallies: one rejected row can carry two
  // hard violations, so the tallies deliberately do not sum to a row count.
  const accounted = report.written + report.rejectedRows
  console.log(
    `  fetched accounted for: ${accounted}/${report.fetched} ` +
      `${accounted === report.fetched ? '✓' : '✗ MISMATCH'}`,
  )
  console.log(`\nElapsed ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

  if (missing.length || drift.length || accounted !== report.fetched) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(
      '\n✗ ingest failed:',
      maskGraphIds(err instanceof Error ? err.message : String(err)),
    )
    process.exitCode = 1
  })
  .finally(() => resetDriver())
