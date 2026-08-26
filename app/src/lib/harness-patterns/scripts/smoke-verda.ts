/**
 * Live smoke test for the self-hosted Verda deployment (`VerdaQwen`).
 *
 * CI cannot run this — the endpoint is company-internal and reachable only
 * from a machine holding `VERDA_INFERENCE_API_KEY`. The hermetic half of the
 * proof lives in two files: which roles move (and what happens when the flag is
 * off or the env is wrong) in `clients-verda.test.ts`, and what the request body
 * carries in `verda-body-shape.test.ts`, both under
 * `src/__tests__/lib/harness-patterns/`. This script is the other half: that the
 * box actually answers, and that what it answers PARSES into the structured
 * types the patterns depend on.
 *
 * Its sibling `smoke-verda-load.ts` measures the same route under load.
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
 * Three calls, chosen for what they prove:
 *   1. `createCriticAdapter()` — the smallest structured-output round trip in
 *      the repo (no tool catalog, no gateway, no sandbox). If the endpoint is
 *      wired at all, this passes.
 *   2. `LoopController` — the envelope that historically breaks (a truncated
 *      or brace-less action is the repo's recurring parse failure), over a
 *      hand-written two-tool catalog so the script stays independent of the
 *      MCP gateway being up.
 *   3. `ActorController` WITH a populated attempt log and a context — the
 *      actor's RETRY shape, and the one call in this script that a passing
 *      first attempt does not cover. It 400d here (`System message must be at
 *      the beginning.`) until the two `_.role("system")` markers that followed
 *      the conversation in `actorCritic.baml` were rendered `user` instead;
 *      `src/__tests__/lib/harness-patterns/prompt-role-order.test.ts` is the
 *      hermetic pin, and this is the live one. Both of that fix's inputs are
 *      exercised at once: attempts non-empty AND context non-null, because
 *      each marker fires on a different one.
 *
 * All three calls assert the collector reports `clientName === 'VerdaQwen'`.
 * Being told the flag is on is not evidence that the call went there.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Collector } from '@boundaryml/baml'
import type { Attempt, ToolDescription } from '../../../../baml_client/types'
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

/**
 * How long the preflight waits for the model list.
 *
 * It is NOT sized for a cold start, deliberately — see {@link servedModelIds}
 * for why this request is not one. Measured on 2026-08-26: a healthy answer
 * took 1.2s; a bad minute on the same endpoint hung this fetch for ~4 minutes
 * before Node gave up with the bare string `fetch failed`, which reads as a
 * repo bug rather than as the endpoint being unreachable. Anything past a few
 * seconds here is a reachability problem worth reporting AS one.
 */
const MODELS_TIMEOUT_MS = 15_000

/**
 * The ids `GET /v1/models` reports. A plain fetch, not a BAML call: this runs
 * before the first billed completion and only needs the served id list.
 *
 * NOT A READINESS PROBE, and the distinction is load-bearing: measured on
 * 2026-08-26, this endpoint answered `/models` with a full vLLM payload in
 * 1.2s while a 21-token completion on the same deployment took 146s, because
 * the container was still cold. So a 200 here says "the deployment exists and
 * the key is accepted", never "the next completion will be quick" — the three
 * calls below are what measure that.
 *
 * The timeout is explicit because Node's `fetch` has none for this shape, and
 * an un-bounded preflight fails the smoke exactly when the endpoint is having
 * the trouble the smoke was run to investigate.
 */
export async function servedModelIds(timeoutMs: number = MODELS_TIMEOUT_MS): Promise<string[]> {
  const base = process.env.VERDA_INFERENCE_ENDPOINT ?? ''
  let res: Response
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${process.env.VERDA_INFERENCE_API_KEY ?? ''}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // `fetch failed` / `The operation was aborted` on their own name neither
    // the URL nor the cause, and this is the first thing the operator sees.
    throw new Error(
      `GET ${base}/models did not answer within ${timeoutMs / 1000}s ` +
        `(${err instanceof Error ? err.message : String(err)}). The deployment is unreachable ` +
        'from here, or VERDA_INFERENCE_ENDPOINT is wrong — check the host and that the value ' +
        'ends in `/v1`. A cold container does NOT cause this: it still answers /models fast.',
      { cause: err },
    )
  }
  if (!res.ok) throw new Error(`GET ${base}/models → ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data?: Array<{ id?: string }> }
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
}

async function preflight(): Promise<void> {
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
  // The model id is pinned in the client (read live from `GET /v1/models` on
  // 2026-08-25). Re-checked here rather than trusted, because the deployment —
  // not this repo — decides what it serves: a redeploy under a different id, or
  // a `--served-model-name`, turns every call into a 400 that reads like a
  // client bug. Cheap, and it runs before anything is billed.
  const client = readFileSync(path.resolve(process.cwd(), 'baml_src/verda-client.baml'), 'utf8')
  const pinned = /model "([^"]+)"/.exec(client)?.[1]
  const served = await servedModelIds()
  if (!pinned || !served.includes(pinned)) {
    throw new Error(
      `baml_src/verda-client.baml pins model ${JSON.stringify(pinned)}, but the endpoint ` +
        `serves ${served.map((m) => JSON.stringify(m)).join(', ') || '(nothing)'}. ` +
        'Put the served id in the client, run `pnpm baml-generate`, and re-run this.',
    )
  }
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
  console.log('\n▶ 1/3 Critic — smallest structured round trip')
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
  console.log('\n▶ 2/3 LoopController — the action envelope')
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

/**
 * The actor's retry shape: a non-empty attempt log AND a context block.
 *
 * `ActorController` is called directly rather than through
 * `createActorControllerAdapter`, for the same reason step 2 calls
 * `LoopController` directly — the adapter lists tools over the MCP gateway, and
 * this script must not need the gateway up. Calling the function is also what
 * lets the attempt log be HAND-BUILT: the failure only appears once there is
 * something in it, so an empty one would pass and prove nothing.
 */
async function actorRetry(): Promise<void> {
  console.log('\n▶ 3/3 ActorController — retry shape (attempt log + context)')
  const { b } = await import('../../../../baml_client')
  const collector = new Collector('smoke-verda-actor-retry')
  // 'controller' — the one role covers BOTH loop patterns' controllers, which
  // is exactly why the actor's 400 rode in on the same map entry that the
  // healthy LoopController scenarios had already been passing on.
  const opts = { collector, ...clientOverrideFor('controller') }
  const attempts: Attempt[] = [
    {
      n: 1,
      action: {
        reasoning: 'Ask the graph what labels it has before querying them.',
        tool_name: 'read_neo4j_cypher',
        tool_args: JSON.stringify({ query: 'MATCH (n) RETURN n LIMIT 1' }),
        status: 'Sampling a node',
        is_final: false,
      },
      result: '[]',
      feedback: 'Empty result — sample the schema instead of a node.',
    },
  ]
  const t0 = Date.now()
  const action = await b.ActorController(
    'What node labels exist in the graph?',
    'inspect the graph schema',
    TOOLS,
    attempts,
    'The graph is a knowledge graph of documents and the entities mentioned in them.',
    undefined, // few_shots
    2, // attempt_n — 1-based, so this is the retry
    5, // max_attempts
    undefined, // multi_call_mode
    opts,
  )
  const llmCall = extractLLMCallData(collector, 'ActorController', {}, t0, action)
  if (!llmCall) throw new Error('the collector captured nothing — is baml_client stale? (#154)')
  console.log(`   ${Date.now() - t0}ms · served by ${llmCall.clientName} (${llmCall.provider})`)
  assertServedByVerda('ActorController', collector)
  console.log(
    `   action: tool=${action.tool_name} status=${action.status} is_final=${action.is_final}`,
  )
  if (typeof action.tool_name !== 'string' || typeof action.reasoning !== 'string') {
    throw new Error('ControllerAction did not parse into its declared shape')
  }
}

async function main(): Promise<void> {
  console.log('🔒 Verda (self-hosted) smoke — confidential-compute route')
  await preflight()
  console.log('   flag on, env configured, controller role → VerdaQwen')
  console.log('   NOTE: a cold start can take minutes on the first call.')
  await critic()
  await controller()
  await actorRetry()
  console.log('\n✅ all three calls served by VerdaQwen and parsed into their declared types')
}

// Run only when this file IS the process entry point, so a test can import
// `servedModelIds` without firing three billed calls at a GPU. Resolved paths
// rather than URL strings, because tsx passes `argv[1]` exactly as it was typed
// and that is normally relative. Defaults to RUNNING when there is no `argv[1]`
// to compare: a launcher this check does not recognise must still execute the
// smoke, never silently do nothing.
const entryPoint = process.argv[1]
if (!entryPoint || path.resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\n❌ smoke failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
