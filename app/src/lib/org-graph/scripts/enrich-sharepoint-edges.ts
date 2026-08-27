/**
 * Infer `COLLABORATES_WITH` edges from the owner's own SharePoint activity
 * visibility — the second org-graph enrichment lane, `docs/org-graph.md` §8's
 * "not implemented" note, now implemented via the owner's delegated Graph
 * token rather than a widened app-only permission.
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/enrich-sharepoint-edges.ts
 *
 * Needs `ORG_GRAPH_OWNER_EMAIL` in `.env` — the email of an account that has
 * signed into this app at least once (so a Graph token cache exists for it;
 * `/auth/signin`) with `Sites.Read.All` and `Files.Read.All` consented (both
 * are in `DEFAULT_GRAPH_SCOPES` and were requested at that sign-in). Run
 * `ingest-roster.ts` first — there is no roster to match identities against
 * on an empty graph. Safe to re-run at any time; see
 * `enrich-sharepoint-edges.server.ts`'s header for why "resumable/re-runnable"
 * means idempotent full re-derivation here, not incremental delta persistence.
 *
 * ## Output is redacted by construction
 * Everything printed is a count, a confidence bucket or a reason code — never
 * a name, a site title, a file title or a path. The module this script calls
 * never even requests a title or path field from Graph in the first place
 * (see `DELTA_SELECT`), so there is nothing to redact on the way out; this
 * script's own `console.log` calls are a second, redundant guarantee of the
 * same property.
 *
 * ## What "passing" looks like
 * `pairsWritten` proportional to how much shared SharePoint activity the
 * owner's own visibility covers — `0` is not a failure, it means the owner's
 * token saw no cross-member folder activity (a very young tenant, or one
 * where the owner's own site access is narrow). `countNonConforming` should
 * report no drift afterwards: this lane only ever writes `COLLABORATES_WITH`
 * edges stamped `inferred: true`, which the ontology now declares.
 */
import {
  runSharePointCoactivityEnrichment,
  GraphAuthRequiredError,
} from '../enrich-sharepoint-edges.server'
import { countNonConforming } from '../schema.server'
import { resetDriver } from '../../neo4j/client'
import { formatCounts } from './_redact'

function requireOwnerEmail(): string {
  const email = process.env.ORG_GRAPH_OWNER_EMAIL?.trim()
  if (!email) {
    throw new Error(
      'ORG_GRAPH_OWNER_EMAIL is not set — put the email of an account that has ' +
        'signed into this app (so a Graph token cache exists for it) in .env.',
    )
  }
  return email
}

async function main(): Promise<void> {
  console.log('🔗 SharePoint co-activity enrichment (owner-delegated Graph, local Neo4j)')

  const ownerEmail = requireOwnerEmail()
  const startedAt = Date.now()
  const report = await runSharePointCoactivityEnrichment(ownerEmail, new Date())

  console.log('\n— Coverage —')
  console.log(
    `  sites covered:   ${report.sitesCovered}${report.sitesTruncated ? ' (capped)' : ''}`,
  )
  console.log(
    `  drives covered:  ${report.drivesCovered}${report.drivesTruncated ? ' (capped)' : ''}`,
  )
  console.log(`  items scanned:   ${report.itemsScanned}`)
  console.log(`  identity hits:   ${report.itemsWithResolvedIdentity}`)

  console.log('\n— Inferred edges —')
  console.log(`  cleared before re-derive: ${report.edgesCleared}`)
  console.log(`  pairs written:            ${report.pairsWritten}`)
  console.log(`  confidence distribution:  ${formatCounts(report.confidenceDistribution)}`)

  const drift = await countNonConforming()
  console.log('\n— Verification —')
  console.log(`  non-conforming: ${drift.length === 0 ? 'none' : ''}`)
  for (const row of drift) {
    console.log(`    ${row.kind} ${row.detail.join('/') || '—'} × ${row.count}`)
  }

  console.log(`\nElapsed ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

  if (drift.length) process.exitCode = 1
}

main()
  .catch((err) => {
    if (err instanceof GraphAuthRequiredError) {
      console.error(
        "\n✗ the owner's Microsoft 365 sign-in is missing or has expired — " +
          'sign in again at /auth/signin with the ORG_GRAPH_OWNER_EMAIL account, ' +
          'then re-run this script.',
      )
    } else {
      console.error('\n✗ enrichment failed:', err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
  })
  .finally(() => resetDriver())
