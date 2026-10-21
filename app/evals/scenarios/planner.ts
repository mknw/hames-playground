/**
 * Planner — the plan's SHAPE, and the ceiling it has to fit under.
 *
 * This scenario exists because of one line: `planner: 'LargeQwen'` in
 * `SELF_DEPLOYED_CLIENT_BY_ROLE`. The composite consequence of that line is stated in
 * full on the entry itself and is not repeated here; what matters for this file
 * is that until it existed, nothing in the repo measured the role with the
 * harshest degradation path on the tier that is the deployment default. It was
 * recorded as a gap in `client.ts` and shipped as one.
 *
 * Four things are checkable without reading prose, and each is a way the
 * planner fails QUIETLY rather than loudly:
 *
 *  1. **A non-empty plan.** `PlanResult.plan` is a required string, so `""`
 *     parses fine and injects nothing — `formatPlanContext` returns undefined
 *     and the executor runs unplanned while the panel shows a successful plan
 *     step. `patterns/planner.server.ts` treats that as an error precisely
 *     because the type system cannot.
 *  2. **`n_steps` agrees with the plan.** The prompt states the field MUST
 *     equal the number of steps written. It is the cheapest available signal
 *     that the model followed a counting instruction under a halved output
 *     budget, and unlike the plan text it has a right answer.
 *  3. **The plan names only tools that exist.** The planner reads the same
 *     catalog the executor gets, so a plan naming a tool nobody has is a plan
 *     whose steps cannot be followed — the planner's version of the router
 *     picking a route with no handler. Checked as "at least one offered tool is
 *     named, and no obvious invention is", where an invention is a decoy name
 *     placed in the request and absent from the catalog.
 *  4. **It did not spend the whole ceiling.** The real risk on a self-hosted
 *     route is the output cap dropping 32 768 → 4 096 on the role whose
 *     output is longest. A plan that lands at the cap truncates mid-JSON, and
 *     the recovery is one retry of the same prompt — which truncates again.
 *     So the check is HEADROOM: output tokens strictly under the client's cap,
 *     with the ratio reported as an observation so a run that is merely close
 *     is visible before it is fatal.
 *
 * And one thing that is deliberately NOT a check: whether the plan is any
 * good. Grading a plan's strategy reads the reader, not the client (the same
 * rule the rest of this suite follows). The `reasoning` and `plan` lengths are
 * observations so two clients can be compared by a human.
 *
 * The prompt is fed a REAL-SHAPED catalog rather than two tools: the input side
 * of this role is unbudgeted (no `getContextWindow` trim, and the catalog IS
 * the prompt), so a small catalog would measure the one condition the planner
 * is never actually in. Twenty-odd tools with real descriptions is
 * still an order of magnitude short of the preview deployment's ~134, and that
 * gap is stated rather than papered over — see the observation on input tokens.
 */

import { ClientRegistry, Collector } from '@boundaryml/baml'
import type { PlanResult, ToolDescription } from '@hames-ai/harness-baml/baml_client/types'
import { thinkingFrom } from '@hames-ai/harness-baml/thinking-trace'
import { expectedClientFor, type EvalRouting } from '../client'
import { CLIENT_MAX_OUTPUT_TOKENS, MODEL_CONTEXT_WINDOWS } from '../../src/lib/settings'
import {
  check,
  servedBy,
  usageOf,
  type Check,
  type Observation,
  type Scenario,
  type ScenarioContext,
} from '../harness'

// G19 Q5: measurement configuration ONLY. Never change the shipped pair here.
export const THINKING_EVAL_MAX_TOKENS = 8192
export const THINKING_EVAL_TIMEOUT_MS = 340_000

/** Refuse a broad twin run BEFORE the generic Critic preflight can send it to
 * an undesignated function. A planner-only measurement is its own preflight. */
export function isThinkingPlannerRun(
  routing: EvalRouting,
  scenarios: readonly Scenario[],
): boolean {
  if (routing.client !== 'LargeQwenThink') return false
  if (
    routing.routed.length !== 1 ||
    routing.routed[0] !== 'planner' ||
    scenarios.length !== 1 ||
    scenarios[0].id !== 'planner-plan-shape'
  ) {
    throw new Error(
      'LargeQwenThink eval requires EVAL_ROLES=planner and EVAL_ONLY=planner-plan-shape',
    )
  }
  return true
}

/** A tool name that appears in the REQUEST and not in the catalog. A plan that
 *  names it has invented a capability the executor cannot call. */
const DECOY_TOOL = 'export_to_powerpoint'

function tool(
  name: string,
  description: string,
  props: Record<string, string> = {},
): ToolDescription {
  return {
    name,
    description,
    args_schema: JSON.stringify({
      type: 'object',
      properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
      required: Object.keys(props),
    }),
  }
}

/** Catalog shaped like a real agent's: several namespaces, overlapping
 *  capabilities, descriptions long enough to have to be read. */
const TOOLS: ToolDescription[] = [
  tool(
    'read_neo4j_cypher',
    'Run a READ-ONLY Cypher query against the knowledge graph and return rows.',
    { query: 'string' },
  ),
  tool(
    'write_neo4j_cypher',
    'Run a WRITE Cypher statement. Creates or updates nodes and relationships.',
    { query: 'string' },
  ),
  tool(
    'get_neo4j_schema',
    'Return the graph schema: node labels, relationship types and their properties.',
  ),
  tool('search', 'Search the public web and return ranked result titles, URLs and snippets.', {
    query: 'string',
  }),
  tool('fetch_content', 'Fetch one URL and return its readable text content.', { url: 'string' }),
  tool('resolve-library-id', 'Resolve a package name to a documentation library id.', {
    libraryName: 'string',
  }),
  tool('get-library-docs', 'Fetch documentation for a resolved library id.', {
    context7CompatibleLibraryID: 'string',
  }),
  tool('read_text_file', 'Read a UTF-8 text file from the workspace and return its contents.', {
    path: 'string',
  }),
  tool(
    'write_file',
    'Write text to a file in the workspace, creating parent directories as needed.',
    { path: 'string', content: 'string' },
  ),
  tool('list_directory', 'List the entries of a workspace directory, with types.', {
    path: 'string',
  }),
  tool(
    'search_files_content',
    'Grep the workspace for a pattern and return matching files and lines.',
    { pattern: 'string' },
  ),
  tool('json_get', 'Read a JSON document, or a path within it, from the document store.', {
    name: 'string',
    path: 'string',
  }),
  tool('json_set', 'Write a JSON document, or a path within it, to the document store.', {
    name: 'string',
    path: 'string',
    value: 'string',
  }),
  tool(
    'vector_search_hash',
    'Semantic search over stored document chunks by embedding similarity.',
    { index_name: 'string', query_vector: 'string' },
  ),
  tool('scan_keys', 'List document-store keys matching a glob pattern.', { pattern: 'string' }),
  tool('create_entities', 'Create entities in the long-term memory graph.', { entities: 'string' }),
  tool(
    'search_nodes',
    'Search the long-term memory graph for entities by name or observation text.',
    { query: 'string' },
  ),
  tool(
    'open_nodes',
    'Open named entities in the long-term memory graph and return their relations.',
    { names: 'string' },
  ),
  tool('read_neo4j_schema_stats', 'Return per-label node and relationship counts for the graph.'),
  tool('zip_files', 'Collect several workspace files into one archive for delivery.', {
    files: 'string',
    out: 'string',
  }),
]

const REQUEST =
  'Our knowledge graph has drifted from the documents it was built from. Work out which ' +
  'Document nodes no longer match a file in the document store, write the mismatches to ' +
  `a report file, and ${DECOY_TOOL} the summary so I can present it.`

const INTENT =
  'reconcile Document nodes in the graph against the document store and produce a written report of the mismatches'

const CONTEXT = 'The graph is a knowledge graph of documents and the entities mentioned in them.'

async function evaluatePlan(ctx: ScenarioContext, client: string, registry?: ClientRegistry) {
  const { b } = await import('@hames-ai/harness-baml/guarded-client.server')
  const collector = new Collector('eval-planner')
  const thinking = client === 'LargeQwenThink'
  const opts = {
    ...ctx.opts('planner', collector),
    ...(registry ? { clientRegistry: registry, client } : {}),
  }
  let plan: PlanResult | undefined
  let parsed = true
  try {
    if (thinking) {
      const answer = await b.PlannerThinking(REQUEST, INTENT, TOOLS, CONTEXT, opts)
      const selected = collector.last?.calls.find((c) => c.selected)
      const trace = thinkingFrom(selected)
      plan = { ...answer, reasoning: trace.kind === 'trace' ? trace.text : '' }
    } else {
      plan = await b.Planner(REQUEST, INTENT, TOOLS, CONTEXT, opts)
    }
  } catch (error) {
    if (!registry) throw error
    // Keep capped/trace-only/malformed samples in the distribution. No retry:
    // a thinking-off recovery must not masquerade as a successful twin sample.
    parsed = false
  }

  const text = plan?.plan ?? ''
  const checks: Check[] = [
    check('the envelope parsed', parsed, parsed ? 'parsed' : 'call failed; no retry'),
    check(
      'the plan is not empty',
      text.trim().length > 0,
      `plan is ${text.length} chars; reasoning is ${(plan?.reasoning ?? '').length}`,
    ),
  ]

  // `n_steps` against something countable in the text. Newline-separated
  // lines is what the prompt asks for ("2-6 steps, one line each"), so the
  // tolerance is deliberately loose — ±2 — because the check is "did it count
  // at all", not "did it format the way we would".
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  checks.push(
    check(
      'n_steps is in the region of the steps actually written',
      !!plan && plan.n_steps > 0 && Math.abs(plan.n_steps - lines.length) <= 2,
      `n_steps=${plan?.n_steps}, non-empty lines=${lines.length}`,
    ),
  )

  // Tool naming. Both halves matter: naming nothing is a plan the executor
  // cannot follow either, and it is the failure a vaguer model produces.
  const named = TOOLS.filter((t) => text.includes(t.name)).map((t) => t.name)
  checks.push(
    check(
      'the plan names at least one tool from the catalog',
      named.length > 0,
      named.length > 0 ? named.join(', ') : 'no offered tool named in the plan text',
    ),
  )
  checks.push(
    check(
      'the plan does not name the tool that does not exist',
      !text.includes(DECOY_TOOL),
      `decoy ${DECOY_TOOL} was ${text.includes(DECOY_TOOL) ? 'named' : 'not named'} (the request asks for it)`,
    ),
  )

  // THE cap check. `planParseRetry` can only recover a truncation by retrying
  // the same prompt, so a plan that lands at the ceiling is one that will
  // land there again and then throw — and the pattern turns that throw into a
  // silently unplanned run.
  const usage = usageOf(collector)
  const cap = thinking ? THINKING_EVAL_MAX_TOKENS : CLIENT_MAX_OUTPUT_TOKENS[client]
  const observations: Observation[] = [
    { name: 'client under test', value: client },
    {
      name: 'output cap',
      value:
        typeof cap === 'number'
          ? `${cap} tokens`
          : `NO CLIENT_MAX_OUTPUT_TOKENS ENTRY — truncation detection is dead for this client (SA-C2)`,
    },
    {
      name: 'output tokens used',
      value:
        usage?.output === undefined
          ? '(unreported)'
          : typeof cap === 'number'
            ? `${usage.output} (${Math.round((usage.output / cap) * 100)}% of cap)`
            : String(usage.output),
    },
    {
      name: 'input tokens used',
      value:
        usage?.input === undefined
          ? '(unreported)'
          : `${usage.input} against a ${MODEL_CONTEXT_WINDOWS[client] ?? 'unknown'} window, over ${TOOLS.length} tools — ` +
            'the preview deployment offers ~134, and this role has no input trim',
    },
    { name: 'plan chars', value: `${text.length} (reasoning ${(plan?.reasoning ?? '').length})` },
  ]
  checks.push(
    check(
      'the plan fits under the output cap with headroom',
      typeof cap === 'number' && usage?.output !== undefined && usage.output < cap * 0.9,
      usage?.output === undefined
        ? 'no output usage reported — cannot tell truncation from brevity'
        : `${usage.output} / ${cap ?? '(no cap known)'} tokens`,
    ),
  )

  if (registry) {
    checks.push(
      check(
        'the selected leaf is the requested client',
        servedBy(collector) === client,
        servedBy(collector) ?? '(unreported)',
      ),
    )
    const selected = collector.last?.calls.find((c) => c.selected)
    const trace = thinkingFrom(selected)
    const content = collector.last?.rawLlmResponse ?? ''
    checks.push(
      check(
        'content contains no </think>',
        !content.includes('</think>'),
        `${content.length} content chars`,
      ),
    )
    checks.push(
      thinking
        ? check(
            'reasoning is a non-empty parser trace',
            trace.kind === 'trace' && !!plan && plan.reasoning === trace.text,
            trace.kind === 'trace' ? `${trace.source}: ${trace.text.length} chars` : trace.reason,
          )
        : check(
            'thinking off has content and no parser trace',
            content.trim().length > 0 &&
              trace.kind === 'absent' &&
              (trace.reason === 'no-trace' || trace.reason === 'empty-trace'),
            `${content.length} content chars; ${trace.kind}`,
          ),
    )
    observations.push({
      name: 'parser trace chars',
      value: String(trace.kind === 'trace' ? trace.text.length : 0),
    })
  }
  return { checks, observations, collectors: [collector], outputTokens: usage?.output }
}

export const plannerScenario: Scenario = {
  id: 'planner-plan-shape',
  role: 'planner',
  title: 'Planner — non-empty plan, honest n_steps, only real tools, under the output cap',
  what: 'plan structure and output headroom; the thinking twin measures trace + answer with a same-box thinking-off comparison',
  run: async (ctx) => {
    const client = expectedClientFor(ctx.routing, 'planner')
    if (client !== 'LargeQwenThink') return evaluatePlan(ctx, client)
    isThinkingPlannerRun(ctx.routing, [plannerScenario])
    const n = Number(process.env.EVAL_PLANNER_N ?? 20)
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error('EVAL_PLANNER_N must be a positive integer')
    const { b } = await import('@hames-ai/harness-baml/guarded-client.server')
    const collector = new Collector('eval-planner-template')
    const opts = ctx.opts('planner', collector)
    const template = await b.request.PlannerThinking(REQUEST, INTENT, TOOLS, CONTEXT, opts)
    const off = await b.request.Planner(REQUEST, INTENT, TOOLS, CONTEXT, {
      ...opts,
      client: 'LargeQwen',
    })
    const transport = (request: typeof template) =>
      JSON.stringify({
        url: request.url,
        headers: Object.entries(request.headers)
          .map(([key, value]) => [key.toLowerCase(), value])
          .sort(([a], [b]) => a.localeCompare(b)),
        model: (request.body.json() as { model: string }).model,
      })
    if (transport(template) !== transport(off))
      throw new Error('Planner comparison requires the same endpoint, credentials and model')
    // Derive sampling/model from the committed twin, avoiding a second client
    // definition. Rendering a request is offline; it neither probes nor wakes.
    const { messages: _messages, ...body } = template.body.json() as Record<string, unknown>
    const registry = new ClientRegistry()
    registry.addLlmClient('LargeQwenThink', 'openai-generic', {
      ...body,
      base_url: process.env.LARGE_LLM_BASE_URL,
      api_key: process.env.LARGE_LLM_API_KEY,
      max_tokens: THINKING_EVAL_MAX_TOKENS,
      http: { connect_timeout_ms: 30_000, request_timeout_ms: THINKING_EVAL_TIMEOUT_MS },
    })
    const checks: Check[] = []
    const observations: Observation[] = [
      {
        name: 'measurement configuration',
        value: `${THINKING_EVAL_MAX_TOKENS} tokens / ${THINKING_EVAL_TIMEOUT_MS} ms; ${n} pairs; shipped pair unchanged`,
      },
    ]
    const collectors: Collector[] = []
    for (const mode of ['LargeQwenThink', 'LargeQwen']) {
      const tokens: number[] = []
      for (let i = 0; i < n; i++) {
        const result = await evaluatePlan(ctx, mode, registry)
        checks.push(
          ...result.checks.map((c) => ({ ...c, name: `${mode} sample ${i + 1}: ${c.name}` })),
        )
        observations.push(
          ...result.observations.map((o) => ({ ...o, name: `${mode} sample ${i + 1}: ${o.name}` })),
        )
        collectors.push(...result.collectors)
        if (result.outputTokens !== undefined) tokens.push(result.outputTokens)
      }
      const sorted = [...tokens].sort((a, b) => a - b)
      observations.push({
        name: `${mode} completion tokens (trace + answer)`,
        value: JSON.stringify(tokens),
      })
      observations.push({
        name: `${mode} token distribution`,
        value: sorted.length
          ? `reported=${sorted.length}/${n}; min=${sorted[0]}; p50=${sorted[Math.ceil(sorted.length * 0.5) - 1]}; p95=${sorted[Math.ceil(sorted.length * 0.95) - 1]}; max=${sorted.at(-1)}`
          : `reported=0/${n}; unavailable`,
      })
    }
    return { checks, observations, collectors }
  },
}
