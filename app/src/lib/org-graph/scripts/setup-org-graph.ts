/**
 * Apply the org-graph ontology to Neo4j.
 *
 * Two modes, and the asymmetry is the point:
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/setup-org-graph.ts
 *     → idempotent. Creates any missing constraint, deletes nothing. Safe on
 *       every run, every environment, forever.
 *
 *   … setup-org-graph.ts --wipe
 *     → the ONE-SHOT migration: drops every node, relationship and constraint,
 *       then applies the ontology. Authorised once, for the switch to an
 *       organisational-only graph (owner decision, 2026-08-25). It prompts for
 *       the confirmation phrase unless `--yes` is also passed.
 *
 * Run from `app/`. Needs the Neo4j compose service up (`docker compose up -d`
 * from the repo root) and `NEO4J_USER` / `NEO4J_PASSWORD` in `.env` if they
 * differ from the compose defaults.
 *
 * Prints a non-conformance count before and after, so the effect of the run is
 * visible rather than asserted.
 */
import { createInterface } from 'node:readline/promises'
import {
  countNonConforming,
  ensureOrgGraphSchema,
  listConstraintNames,
  wipeAndApplyOrgGraphSchema,
  WIPE_CONFIRMATION,
} from '../schema.server'
import { CONSTRAINT_NAMES } from '../ontology'
import { resetDriver } from '../../neo4j/client'

async function report(stage: string): Promise<void> {
  const [constraints, drift] = await Promise.all([listConstraintNames(), countNonConforming()])
  const missing = CONSTRAINT_NAMES.filter((n) => !constraints.includes(n))
  const leftover = constraints.filter((n) => !CONSTRAINT_NAMES.includes(n))
  console.log(`\n— ${stage} —`)
  console.log(
    `  ontology constraints present: ${CONSTRAINT_NAMES.length - missing.length}/${CONSTRAINT_NAMES.length}`,
  )
  if (missing.length) console.log(`  missing: ${missing.join(', ')}`)
  if (leftover.length) console.log(`  leftover (not in this ontology): ${leftover.join(', ')}`)
  if (drift.length === 0) {
    console.log('  non-conforming data: none')
    return
  }
  console.log('  non-conforming data:')
  for (const row of drift) {
    console.log(`    ${row.kind} ${row.detail.join('/') || '—'} × ${row.count}`)
  }
}

async function confirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      `\nThis DELETES every node, relationship and constraint in the graph.\n` +
        `Type ${WIPE_CONFIRMATION} to proceed: `,
    )
    return answer.trim() === WIPE_CONFIRMATION
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const wipe = process.argv.includes('--wipe')
  const preapproved = process.argv.includes('--yes')

  console.log(`🗂  org-graph schema setup${wipe ? ' — WIPE mode' : ''}`)
  await report('before')

  if (!wipe) {
    await ensureOrgGraphSchema()
    await report('after (constraints applied, nothing deleted)')
    console.log(
      '\nNote: pre-ontology data is left in place. This path never deletes; ' +
        'the counts above are the drift, not a failure.',
    )
    return
  }

  if (!preapproved && !(await confirm())) {
    console.log('\nAborted — nothing was deleted.')
    process.exitCode = 1
    return
  }

  const result = await wipeAndApplyOrgGraphSchema(WIPE_CONFIRMATION)
  console.log(
    `\nWiped: ${result.nodesDeleted} nodes, ${result.constraintsDropped} constraints dropped.`,
  )
  await report('after (wiped + ontology applied)')
}

main()
  .catch((err) => {
    console.error('\n✗ setup failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => resetDriver())
