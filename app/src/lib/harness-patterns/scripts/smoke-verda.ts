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
 * Five calls, chosen for what they prove:
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
 *   4. `routeMessageOp` — the ROUTER, which joined the tier on 2026-08-26. It
 *      is the first LLM call of every turn and it is handed the user's raw
 *      message, which is why it moved; it is also the one call in this script
 *      that goes through a production op rather than a BAML function directly.
 *   5. `describeToolResultsBatchOp` and `describeToolResultOp` — the DESCRIBE
 *      role, which joined on the same day and is handed tool results VERBATIM.
 *      Neither takes a collector: they own one internally for accounting, so
 *      the client they were served by is read off the usage observer — the same
 *      path the preview header's on-prem share is computed from, which makes
 *      this the only step here that proves the accounting agrees with the
 *      routing.
 *
 * Every call asserts the client reported for it is `VerdaQwen`. Being told the
 * flag is on is not evidence that the call went there.
 *
 * What is deliberately NOT here: `ScreenUntrustedContent`. It is the one role a
 * tier decision leaves on Anthropic (SA-M5 / SD-4), so a call to it from this
 * script would either fail the assertion or, worse, pass — and passing would
 * mean the exception had been undone.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Collector } from '@boundaryml/baml'
import type { Attempt, ToolDescription } from '../../../../baml_client/types'
import {
  createCriticAdapter,
  describeToolResultOp,
  describeToolResultsBatchOp,
  extractLLMCallData,
} from '../baml-adapters.server'
import { assertVerdaConfigured, clientOverrideFor, verdaInferenceEnabled } from '../clients.server'
import { observeLlmUsage } from '../llm-usage-observer.server'
import { routeMessageOp } from '../routing.server'

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
 * How long the preflight waits for the model list, on the FIRST attempt.
 *
 * A healthy warm answer took 1.2s (measured 2026-08-26), so anything past a few
 * seconds is either a reachability problem or a cold container — and the two
 * are told apart by {@link COLD_MODELS_TIMEOUT_MS} below, not by this number.
 */
const MODELS_TIMEOUT_MS = 15_000

/**
 * How long the SECOND attempt waits, after the first timed out.
 *
 * This exists because the docstring on {@link servedModelIds} was wrong, and it
 * was wrong in the direction that made this script unrunnable. It claimed
 * `/models` answers fast even from cold, on a 2026-08-25 observation. Re-measured
 * on 2026-08-26 from a fully scaled-to-zero deployment, `GET /v1/models` took
 * **277 seconds** — the gateway queues it behind the container start like any
 * other request — while the same call against a warm box took 1.2s. So the
 * single 15s attempt turned every cold run into "the deployment is unreachable
 * from here", which is both false and the most expensive kind of false: it sends
 * the operator to check DNS and the endpoint value when the truth is "wait".
 *
 * Two attempts rather than one long one, so the FAST failure is still fast when
 * the endpoint really is unreachable (an unauthenticated request 404s in 150ms,
 * which is what a wrong host looks like), and the slow path is entered only
 * after the fast one has already told us something.
 */
const COLD_MODELS_TIMEOUT_MS = 420_000

/**
 * The ids `GET /v1/models` reports. A plain fetch, not a BAML call: this runs
 * before the first billed completion and only needs the served id list.
 *
 * NOT A READINESS PROBE, and the distinction is load-bearing: a 200 here says
 * "the deployment exists and the key is accepted", never "the next completion
 * will be quick" — the calls below are what measure that. Measured 2026-08-26
 * on a warm box: `/models` in 1.2s, a 21-token completion 146s earlier the same
 * day while the container was still starting.
 *
 * It is NOT, however, immune to the cold start, which is what the earlier note
 * here claimed. From a scaled-to-zero deployment this call took 277s
 * (re-measured 2026-08-26) — the gateway holds it open behind the container
 * start. Hence the two-attempt shape: see {@link COLD_MODELS_TIMEOUT_MS}.
 *
 * The timeouts are explicit because Node's `fetch` has none for this shape, and
 * an un-bounded preflight fails the smoke exactly when the endpoint is having
 * the trouble the smoke was run to investigate.
 */
export async function servedModelIds(
  timeoutMs: number = MODELS_TIMEOUT_MS,
  retryOnTimeout: boolean = true,
): Promise<string[]> {
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
    // A first timeout is AMBIGUOUS — unreachable host, or a cold container
    // whose gateway is holding the request — so it is reported as ambiguous and
    // retried once on the long budget rather than diagnosed wrongly.
    if (retryOnTimeout) {
      console.log(
        `   /models did not answer in ${timeoutMs / 1000}s. Either the deployment is ` +
          'unreachable, or it is scaled to zero and this request is queued behind the ' +
          `container start (measured: 277s). Waiting up to ${COLD_MODELS_TIMEOUT_MS / 1000}s…`,
      )
      return await servedModelIds(COLD_MODELS_TIMEOUT_MS, false)
    }
    throw new Error(
      `GET ${base}/models did not answer within ${timeoutMs / 1000}s ` +
        `(${err instanceof Error ? err.message : String(err)}). The deployment is unreachable ` +
        'from here, or VERDA_INFERENCE_ENDPOINT is wrong — check the host and that the value ' +
        'ends in `/v1`. This budget is long enough to cover a cold start, so waiting longer ' +
        'is not the answer.',
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
  console.log('\n▶ 1/5 Critic — smallest structured round trip')
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
  console.log('\n▶ 2/5 LoopController — the action envelope')
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
  console.log('\n▶ 3/5 ActorController — retry shape (attempt log + context)')
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

async function router(): Promise<void> {
  console.log('\n▶ 4/5 Router — the turn’s first call, on the user’s raw message')
  const collector = new Collector('smoke-verda-router')
  const t0 = Date.now()
  const result = await routeMessageOp(
    'What node labels exist in the graph?',
    [],
    [
      { name: 'neo4j', description: 'Query the knowledge graph.' },
      { name: 'web_search', description: 'Search the public web.' },
    ],
    collector,
  )
  console.log(`   ${Date.now() - t0}ms · served by ${servedBy(collector)}`)
  assertServedByVerda('Router', collector)
  console.log(
    `   route=${result.tool_name} needs_tool=${result.tool_call_needed} ` +
      `intent=${JSON.stringify(result.intent).slice(0, 120)}`,
  )
  // `intent` is the field every downstream pattern reads, and a null route on a
  // graph question would be a routing miss rather than a transport failure —
  // printed rather than asserted, because this script measures the route, not
  // the model's judgement.
  if (typeof result.intent !== 'string' || result.intent.length === 0) {
    throw new Error('RouterResult.intent did not parse as a non-empty string')
  }
}

/**
 * The describe role, through the accounting path rather than a collector.
 *
 * Neither describe op exposes its collector — both wrap `withUsageAccounting`,
 * which creates one, hands it to the call and reads it in a `finally`. So the
 * evidence here is the usage SAMPLE, which is what `usage-recorder.server.ts`
 * attributes a tier from in production. If these two agree, the header's
 * on-prem share is measuring the same thing the routing did.
 */
async function describe(): Promise<void> {
  console.log('\n▶ 5/5 describe — tool results, verbatim, on the box')
  const seen = new Map<string, string | undefined>()
  const stop = observeLlmUsage((sample) => seen.set(sample.functionName, sample.clientName))
  try {
    const t0 = Date.now()
    const batch = await describeToolResultsBatchOp([
      {
        id: 'a',
        tool: 'read_neo4j_cypher',
        toolArgs: JSON.stringify({ query: 'MATCH (n) RETURN labels(n) LIMIT 5' }),
        reasoning: 'Find out what kinds of node exist.',
        result: '[{"labels":["Document"]},{"labels":["Person"]},{"labels":["Topic"]}]',
      },
      {
        id: 'b',
        tool: 'get_neo4j_schema',
        toolArgs: '{}',
        reasoning: 'Confirm the relationship types.',
        result: '{"relationships":["MENTIONS","AUTHORED_BY"]}',
      },
    ])
    console.log(`   batch ${Date.now() - t0}ms · served by ${seen.get('ResultDescribeBatch')}`)
    console.log(`   summaries: ${JSON.stringify([...batch.entries()]).slice(0, 240)}`)

    const t1 = Date.now()
    const single = await describeToolResultOp(
      'read_neo4j_cypher',
      JSON.stringify({ query: 'MATCH (n:Person) RETURN count(n)' }),
      'Count the people.',
      '[{"count(n)":42}]',
    )
    console.log(`   single ${Date.now() - t1}ms · served by ${seen.get('ResultDescribe')}`)
    console.log(`   summary: ${JSON.stringify(single).slice(0, 200)}`)

    // Both call sites, separately. They live in one file, so the source scan in
    // `clients-verda.test.ts` cannot tell them apart; here they can be.
    for (const fn of ['ResultDescribeBatch', 'ResultDescribe']) {
      if (!seen.has(fn)) {
        throw new Error(
          `${fn} produced no usage sample — the call never reached a model, or the ` +
            'accounting chokepoint stopped notifying (which would also empty the header).',
        )
      }
      if (seen.get(fn) !== EXPECTED_CLIENT) {
        throw new Error(
          `${fn}: accounted against ${seen.get(fn) ?? 'an unreported client'}, ` +
            `expected ${EXPECTED_CLIENT}`,
        )
      }
    }
    // `describeToolResultOp` swallows its own errors and returns '' — so an
    // empty summary here means the call FAILED on the box, and the assertion
    // above would have passed on a sample from a failed attempt.
    if (single.trim() === '') {
      throw new Error('ResultDescribe returned an empty summary — the call failed on the box')
    }
    if (batch.size === 0) {
      throw new Error('ResultDescribeBatch returned no summaries — the batch failed on the box')
    }
  } finally {
    stop()
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
  await router()
  await describe()
  console.log('\n✅ every call served by VerdaQwen and parsed into its declared type')
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
