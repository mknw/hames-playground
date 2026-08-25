/**
 * Live smoke test for the self-hosted Verda deployment (`VerdaQwen`).
 *
 * CI cannot run this — the endpoint is company-internal and reachable only
 * from a machine holding `VERDA_INFERENCE_API_KEY`. The hermetic half of the
 * proof (which roles move, what happens when the flag is off, what happens
 * when the env is wrong) lives in
 * `src/__tests__/lib/harness-patterns/clients-verda.test.ts`. This script is
 * the other half: that the box actually answers, and that what it answers
 * PARSES into the structured types the patterns depend on.
 *
 * Run from `app/`:
 *
 *   USE_VERDA_INFERENCE=1 pnpm dlx tsx --env-file=.env \
 *     src/lib/harness-patterns/scripts/smoke-verda.ts
 *
 * `--env-file=.env` supplies `VERDA_INFERENCE_ENDPOINT` (which must END IN
 * `/v1` — see `assertVerdaConfigured`) and `VERDA_INFERENCE_API_KEY`. The flag
 * goes on the command line because the whole point is to exercise the override
 * path; without it this script routes to Anthropic and proves nothing, which
 * is why it refuses to run in that state.
 *
 * SCALE-TO-ZERO: the deployment sleeps when idle and bills only while awake,
 * so the FIRST call here pays a cold start (container pull + weight load) and
 * can take minutes. That is why `verda-client.baml` sets a long
 * `request_timeout_ms`, and why this script makes both of its calls
 * back-to-back rather than being run repeatedly — each separate session risks
 * paying another cold start.
 *
 * Two calls, chosen for what they prove:
 *   1. `createCriticAdapter()` — the smallest structured-output round trip in
 *      the repo (no tool catalog, no gateway, no sandbox). If the endpoint is
 *      wired at all, this passes.
 *   2. `LoopController` — the envelope that historically breaks (a truncated
 *      or brace-less action is the repo's recurring parse failure), over a
 *      hand-written two-tool catalog so the script stays independent of the
 *      MCP gateway being up.
 *
 * Both calls assert the collector reports `clientName === 'VerdaQwen'`. Being
 * told the flag is on is not evidence that the call went there.
 */

import { Collector } from '@boundaryml/baml'
import type { ToolDescription } from '../../../../baml_client/types'
import { createCriticAdapter, extractLLMCallData } from '../baml-adapters.server'
import { assertVerdaConfigured, clientOverrideFor, verdaInferenceEnabled } from '../clients.server'

const EXPECTED_CLIENT = 'VerdaQwen'

/** A catalog small enough to read in the transcript, real enough to choose from. */
const TOOLS: ToolDescription[] = [
  {
    name: 'read_neo4j_cypher',
    description: 'Run a READ-ONLY Cypher query against the graph and return rows.',
    args_schema: JSON.stringify({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    }),
  },
  {
    name: 'get_neo4j_schema',
    description: 'Return the graph schema: node labels, relationship types, properties.',
    args_schema: JSON.stringify({ type: 'object', properties: {} }),
  },
]

function preflight(): void {
  if (!verdaInferenceEnabled()) {
    throw new Error(
      'USE_VERDA_INFERENCE is not set to 1, so this run would route to Anthropic and prove ' +
        'nothing. Re-run as:\n' +
        '  USE_VERDA_INFERENCE=1 pnpm dlx tsx --env-file=.env ' +
        'src/lib/harness-patterns/scripts/smoke-verda.ts',
    )
  }
  // Same check the module performs at load; called explicitly so the failure
  // reads as a preflight rather than an import-time stack trace.
  assertVerdaConfigured()
  const override = clientOverrideFor('controller')
  if (override?.client !== EXPECTED_CLIENT) {
    throw new Error(
      `expected the controller role to resolve to ${EXPECTED_CLIENT}, got ${override?.client}`,
    )
  }
}

/** The client the collector says actually served the call — not the one we asked for. */
function servedBy(collector: Collector): string | undefined {
  const calls = (collector.last?.calls ?? []) as Array<{ selected?: boolean; clientName?: string }>
  return (calls.find((c) => c.selected) ?? calls[0])?.clientName
}

function assertServedByVerda(label: string, collector: Collector): void {
  const client = servedBy(collector)
  if (client !== EXPECTED_CLIENT) {
    throw new Error(
      `${label}: served by ${client ?? 'an unreported client'}, expected ${EXPECTED_CLIENT}`,
    )
  }
}

async function critic(): Promise<void> {
  console.log('\n▶ 1/2 Critic — smallest structured round trip')
  const collector = new Collector('smoke-verda-critic')
  const t0 = Date.now()
  const { result } = await createCriticAdapter()(
    'count the words in "the quick brown fox"',
    [
      {
        script: 'print(len("the quick brown fox".split()))',
        output: '4',
        toolName: 'sandbox_bash',
      },
    ],
    collector,
  )
  console.log(`   ${Date.now() - t0}ms · served by ${servedBy(collector)}`)
  assertServedByVerda('Critic', collector)
  console.log(
    `   verdict: is_sufficient=${result.is_sufficient} explanation=${JSON.stringify(result.explanation)}`,
  )
  if (typeof result.is_sufficient !== 'boolean') {
    throw new Error('CriticResult.is_sufficient did not parse as a boolean')
  }
}

async function controller(): Promise<void> {
  console.log('\n▶ 2/2 LoopController — the action envelope')
  const { b } = await import('../../../../baml_client')
  const collector = new Collector('smoke-verda-controller')
  const opts = { collector, ...clientOverrideFor('controller') }
  const t0 = Date.now()
  const action = await b.LoopController(
    'What node labels exist in the graph?',
    'inspect the graph schema',
    TOOLS,
    [], // turns — first turn
    undefined, // context
    undefined, // turns_previous_runs
    undefined, // few_shots
    undefined, // multi_call_mode
    undefined, // plan_context
    undefined, // return_style
    opts,
  )
  const llmCall = extractLLMCallData(
    collector,
    'LoopController',
    { user_message: 'What node labels exist in the graph?' },
    t0,
    action,
  )
  if (!llmCall) throw new Error('the collector captured nothing — is baml_client stale? (#154)')
  console.log(`   ${Date.now() - t0}ms · served by ${llmCall.clientName} (${llmCall.provider})`)
  assertServedByVerda('LoopController', collector)
  console.log(
    `   action: tool=${action.tool_name} status=${action.status} is_final=${action.is_final}`,
  )
  console.log(`   args:   ${JSON.stringify(action.tool_args)?.slice(0, 200)}`)
  console.log(
    `   tokens: in=${llmCall.usage?.inputTokens} out=${llmCall.usage?.outputTokens} ` +
      `cacheRead=${llmCall.usage?.cachedInputTokens} cacheWrite=${llmCall.usage?.cacheCreationInputTokens ?? 0}`,
  )
  // The point of the second call: the envelope's required fields survived the
  // trip. A truncated or brace-less action throws inside BAML before here, so
  // reaching this line at all is most of the result.
  if (typeof action.tool_name !== 'string' || typeof action.is_final !== 'boolean') {
    throw new Error('ControllerAction did not parse into its declared shape')
  }
  // The cache numbers above are printed, not asserted: the deployment's own
  // vLLM prefix cache is a server flag outside this repo. What IS ours is that
  // this client declares no `allowed_role_metadata`, so the controller
  // template's `cache_control` breakpoints are dropped and nothing here ASKS
  // for caching — a non-zero cache figure would mean that changed.
}

async function main(): Promise<void> {
  console.log('🔒 Verda (self-hosted) smoke — confidential-compute route')
  preflight()
  console.log('   flag on, env configured, controller role → VerdaQwen')
  console.log('   NOTE: a cold start can take minutes on the first call.')
  await critic()
  await controller()
  console.log('\n✅ both calls served by VerdaQwen and parsed into their declared types')
}

main().catch((err) => {
  console.error('\n❌ smoke failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
