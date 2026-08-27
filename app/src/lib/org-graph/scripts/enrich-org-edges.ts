/**
 * Infer and write org-graph structure from the roster already in Neo4j — no
 * Graph credential needed, this reads and writes the local database only.
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/enrich-org-edges.ts
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/enrich-org-edges.ts --apply
 *
 * Run `ingest-roster.ts` first; this has nothing to derive structure from on
 * an empty graph. Safe to re-run at any time, including after a wipe +
 * re-ingest — see `enrich-org-edges.server.ts`'s header for why the
 * reclassification and the grouping edges are each idempotent.
 *
 * ## `--apply` gates the one irreversible step
 * Without it (the default) this still clears and re-derives every inferred
 * `MEMBER_OF` grouping — only `reclassifyResourceAccounts`'s `Member`-deleting
 * MERGE is held back. A dry run instead prints every candidate through
 * `_redact.ts`'s `mask()`, so what would be deleted is reviewable without a
 * name or address ever reaching this process's stdout. Same shape as
 * `schema.server.ts`'s `WIPE_CONFIRMATION`: an irreversible write needs an
 * explicit argument, never a default.
 *
 * ## Output is redacted by construction
 * Everything printed is a count, a basis name, a confidence value, or a
 * `mask()`ed candidate — never a display name or a mail address in the
 * clear, and never a job title. See `_redact.ts` and the non-negotiable in
 * the dispatch this script was written for: titles are org data too and stay
 * out of anything that gets pasted into a PR. The catch below routes through
 * `mask()` and `maskGraphIds()` for the same reason: a Neo4j constraint
 * violation quotes the offending property value, and this script's writes
 * carry mail addresses and slugged job titles.
 *
 * ## What "passing" looks like
 * With `--apply`: non-zero `resourcesReclassified` and
 * `roleEdges`/`departmentEdges` on a roster that has job titles and
 * departments filled in; `0` everywhere is not a failure, it means the
 * roster has nothing this run's bases can see yet (see `docs/org-graph.md`
 * on how sparse `department` is on the live tenant). Without it: the same,
 * plus a printed candidate list to review before the next `--apply` run.
 * `countNonConforming` should still report no drift afterwards either way:
 * the grouping edges use `MEMBER_OF`, which the ontology already declares,
 * and `Resource` conversion produces only `Resource` nodes.
 */
import { runOrgEdgeEnrichment } from '../enrich-org-edges.server'
import { countNonConforming } from '../schema.server'
import { resetDriver } from '../../neo4j/client'
import { formatCounts, mask, maskGraphIds } from './_redact'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  console.log(
    `🔗 org-graph edge enrichment (local Neo4j, no Graph credential)${apply ? '' : ' — DRY RUN, no --apply'}`,
  )

  const startedAt = Date.now()
  const report = await runOrgEdgeEnrichment({ apply })

  console.log('\n— Resources —')
  if (apply) {
    console.log(`  reclassified (Member → Resource): ${report.resourcesReclassified}`)
  } else if (report.reclassificationCandidates.length > 0) {
    console.log(`  candidates (Member → Resource), NOT applied — re-run with --apply to write:`)
    for (const c of report.reclassificationCandidates) {
      console.log(`    ${mask(c.displayName)} <${mask(c.mail)}>`)
    }
  } else {
    console.log('  reclassified (Member → Resource): 0')
  }

  console.log('\n— Inferred edges —')
  console.log(`  cleared before re-derive: ${report.inferredEdgesCleared}`)
  console.log(`  role teams:               ${report.roleTeams}`)
  console.log(`  role edges (job-title):   ${report.roleEdges}`)
  console.log(`  department teams:         ${report.departmentTeams}`)
  console.log(`  department edges:         ${report.departmentEdges}`)
  console.log(`  orphan teams cleared:     ${report.orphanTeamsCleared}`)
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
    const message = err instanceof Error ? err.message : String(err)
    console.error('\n✗ enrichment failed:', mask(maskGraphIds(message)))
    process.exitCode = 1
  })
  .finally(() => resetDriver())
