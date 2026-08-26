/**
 * `pnpm eval:harness` — the harness/client compatibility suite.
 *
 * WHAT THIS IS FOR: run it whenever a BAML client changes — a new provider, a
 * new model id, a re-pointed role, a bumped `max_tokens` — to find out whether
 * the workflows this repo already ships still work on it. It is NOT a test
 * suite and is NOT a coverage instrument.
 *
 * IT NEVER RUNS IN CI, BY CONSTRUCTION AS WELL AS BY POLICY:
 *  - `app/vitest.config.ts` globs `src/**` + `__tests__/**` only, so nothing
 *    here is collectable by vitest; `evals/` is outside both its `include` and
 *    its coverage `include`.
 *  - `.github/workflows/ci.yml` runs typecheck · lint · format · test · build.
 *    None of them invoke `eval:harness`, and this file is not imported by
 *    anything under `src/`.
 *  - `src/__tests__/evals-not-in-ci.test.ts` pins all of that, and is itself a
 *    normal test — so the guard runs in CI even though the evals cannot.
 * Every scenario here makes real, billed LLM calls against a live endpoint.
 * That is the reason for the separation, not squeamishness about flakiness.
 *
 * USAGE (always from `app/`):
 *
 *   pnpm eval:harness                          # baseline: the declared Anthropic chains
 *   EVAL_CLIENT=VerdaQwen pnpm eval:harness    # the self-hosted deployment
 *   EVAL_RELIABILITY_N=5 pnpm eval:harness     # shorter reliability sample
 *   EVAL_ROLES=screen pnpm eval:harness        # narrow to one role while bisecting
 *
 * See `evals/README.md` for what each knob does and what the exit code means.
 */

import { Collector } from '@boundaryml/baml'
import { resolveEvalRouting } from './client'
import { runScenario, scenarioPassed, type Scenario, type ScenarioResult } from './harness'
import { renderReport, writeReport } from './report'
import { routerScenario } from './scenarios/router'
import {
  controllerFinalAnswerScenario,
  controllerToolCallScenario,
  controllerToolErrorScenario,
  truncationDetectionScenario,
} from './scenarios/controller'
import { criticAcceptScenario, criticRejectAndReviseScenario } from './scenarios/actor-critic'
import { synthesizerGroundedScenario } from './scenarios/synthesizer'
import { describeBatchScenario } from './scenarios/describe'
import { screenScenario } from './scenarios/screen'
import { plannerScenario } from './scenarios/planner'
import { reliabilityScenario } from './scenarios/reliability'

/** Declaration order is report order. Cheap structural checks first so a
 *  misconfigured run fails in a second rather than after twenty calls. */
export const SCENARIOS: Scenario[] = [
  truncationDetectionScenario,
  screenScenario,
  routerScenario,
  plannerScenario,
  controllerToolCallScenario,
  controllerFinalAnswerScenario,
  controllerToolErrorScenario,
  criticAcceptScenario,
  criticRejectAndReviseScenario,
  synthesizerGroundedScenario,
  describeBatchScenario,
  reliabilityScenario,
]

/** Scenario ids named in `EVAL_ONLY`, if any. Unknown ids throw rather than
 *  quietly running nothing. */
function selected(): Scenario[] {
  const raw = process.env.EVAL_ONLY?.trim()
  if (!raw) return SCENARIOS
  const want = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const picked = SCENARIOS.filter((s) => want.has(s.id))
  const unknown = [...want].filter((id) => !SCENARIOS.some((s) => s.id === id))
  if (unknown.length > 0) {
    throw new Error(
      `EVAL_ONLY names unknown scenario(s): ${unknown.join(', ')}\nKnown ids:\n  ` +
        SCENARIOS.map((s) => s.id).join('\n  '),
    )
  }
  return picked
}

/**
 * One cheap call before the expensive ones, so a stale key or a cold endpoint
 * reads as "the endpoint is not answering" rather than as eleven failed
 * scenarios. It is a real BAML call on the client under test — a `GET /models`
 * would prove the box is up without proving this key can complete on it.
 */
async function preflight(client: string | undefined): Promise<void> {
  const { b } = await import('../baml_client')
  const collector = new Collector('eval-preflight')
  const opts = { collector, ...(client ? { client } : {}) }
  const t0 = Date.now()
  await b.Critic('say the attempt is fine', [], opts)
  const calls = (collector.last?.calls ?? []) as Array<{
    selected?: boolean
    clientName?: string
  }>
  const served = (calls.find((c) => c.selected) ?? calls[0])?.clientName
  console.log(`   preflight ok in ${Date.now() - t0}ms · served by ${served ?? '(unreported)'}`)
  if (client && served !== client) {
    throw new Error(
      `preflight asked for ${client} but the call was served by ${served ?? 'an unreported client'}. ` +
        'Every later scenario would measure the wrong model, so this run stops here.',
    )
  }
}

async function main(): Promise<void> {
  const routing = resolveEvalRouting()
  const scenarios = selected()
  const startedAt = new Date().toISOString()

  console.log('🧪 harness/client compatibility eval')
  console.log(`   client under test : ${routing.client ?? 'default (declared Anthropic chains)'}`)
  console.log(`   routing           : ${routing.note}`)
  console.log(`   scenarios         : ${scenarios.length}`)
  if (routing.client === 'VerdaQwen') {
    console.log('   NOTE: the Verda box scales to zero — a cold start can take minutes.')
  }
  console.log('')

  await preflight(routing.client)

  const t0 = Date.now()
  const results: ScenarioResult[] = []
  // Sequential on purpose. The self-hosted endpoint is ONE box: running the
  // scenarios concurrently would measure queueing rather than the client, and
  // `smoke-verda-load.ts` is where throughput under concurrency belongs.
  for (const scenario of scenarios) {
    process.stdout.write(`   ▶ ${scenario.id} … `)
    const result = await runScenario(scenario, routing)
    results.push(result)
    const pass = scenarioPassed(result)
    const detail = result.error
      ? `THREW (${result.error.slice(0, 80)})`
      : `${result.checks.filter((c) => c.pass).length}/${result.checks.length}`
    console.log(`${pass ? '✅' : '❌'} ${detail} · ${result.ms}ms`)
  }

  const meta = { routing, startedAt, totalMs: Date.now() - t0 }
  const file = await writeReport(renderReport(results, meta), meta)

  const passed = results.filter(scenarioPassed).length
  console.log('')
  console.log(`   ${passed}/${results.length} scenarios passed · report: ${file}`)

  for (const r of results.filter((x) => !scenarioPassed(x))) {
    console.log(`\n   ❌ ${r.scenario.id}`)
    if (r.error) console.log(`      threw: ${r.error}`)
    for (const c of r.checks.filter((x) => !x.pass)) {
      console.log(`      ${c.name} — ${c.detail}`)
    }
  }

  // Non-zero on any failure so a human running this in a terminal, or a script
  // running it deliberately, gets an answer without reading the report.
  process.exitCode = passed === results.length ? 0 : 1
}

main().catch((err) => {
  console.error('\n❌ eval run failed:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
