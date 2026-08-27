/**
 * Infer and write org-graph structure from the roster already in Neo4j — no
 * Graph credential needed, this reads and writes the local database only.
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/enrich-org-edges.ts
 *
 * Run `ingest-roster.ts` first; this has nothing to derive structure from on
 * an empty graph. Safe to re-run at any time, including after a wipe +
 * re-ingest — see `enrich-org-edges.server.ts`'s header for why the
 * reclassification and the grouping edges are each idempotent.
 *
 * ## Output is redacted by construction
 * Everything printed is a count, a basis name or a confidence value — never a
 * display name, a mail address or a job title. See `_redact.ts` and the
 * non-negotiable in the dispatch this script was written for: titles are org
 * data too and stay out of anything that gets pasted into a PR.
 *
 * ## What "passing" looks like
 * Non-zero `resourcesReclassified` and `roleEdges`/`departmentEdges` on a
 * roster that has job titles and departments filled in; `0` everywhere is not
 * a failure, it means the roster has nothing this run's bases can see yet
 * (see `docs/org-graph.md` on how sparse `department` is on the live
 * tenant). `countNonConforming` should still report no drift afterwards: the
 * grouping edges use `MEMBER_OF`, which the ontology already declares, and
 * `Resource` conversion produces only `Resource` nodes.
 */
import { runOrgEdgeEnrichment } from '../enrich-org-edges.server'
import { countNonConforming } from '../schema.server'
import { resetDriver } from '../../neo4j/client'
import { formatCounts } from './_redact'

async function main(): Promise<void> {
  console.log('🔗 org-graph edge enrichment (local Neo4j, no Graph credential)')

  const startedAt = Date.now()
  const report = await runOrgEdgeEnrichment()

  console.log('\n— Resources —')
  console.log(`  reclassified (Member → Resource): ${report.resourcesReclassified}`)

  console.log('\n— Inferred edges —')
  console.log(`  cleared before re-derive: ${report.inferredEdgesCleared}`)
  console.log(`  role teams:               ${report.roleTeams}`)
  console.log(`  role edges (job-title):   ${report.roleEdges}`)
  console.log(`  department teams:         ${report.departmentTeams}`)
  console.log(`  department edges:         ${report.departmentEdges}`)
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
    console.error('\n✗ enrichment failed:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => resetDriver())
