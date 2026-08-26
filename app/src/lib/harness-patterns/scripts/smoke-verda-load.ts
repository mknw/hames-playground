/**
 * Live LOAD measurement for the self-hosted Verda deployment (`VerdaQwen`).
 *
 * Sibling of `smoke-verda.ts`, which answers "does the route work". This one
 * answers "what does it do under the preview's load", and it exists because
 * every capacity claim about a single-GPU vLLM box is otherwise a guess: the
 * deployment serves one replica, so concurrency is queueing, not scaling.
 *
 * Named `smoke-*` on purpose — the coverage config excludes
 * `src/lib/**\/scripts/smoke-*.ts` because these scripts talk to live
 * infrastructure and cannot run in CI. Same reason applies here.
 *
 * Run from `app/` (the endpoint bills while awake — run it once, in one burst):
 *
 *   USE_VERDA_INFERENCE=1 pnpm dlx tsx --env-file=.env \
 *     src/lib/harness-patterns/scripts/smoke-verda-load.ts
 *
 * WHAT IT MEASURES, and why each phase is shaped the way it is:
 *
 *   1. SEQUENTIAL — n calls one at a time at controller size. This is the
 *      only phase where latency is the model's, not the queue's, so it is the
 *      baseline every other number is read against.
 *   2. CONCURRENCY 4 and 8 — the preview is 5-15 humans, who do not type at
 *      once; 8 in flight is the realistic ceiling. Read the aggregate
 *      completion-token rate against phase 1: a box that batches cleanly holds
 *      or raises it while per-call latency stretches, and a box that is
 *      collapsing loses it.
 *   3. RELIABILITY — 20 controller-shaped calls, counting BAML parse failures
 *      separately from transport failures. A parse failure here is the failure
 *      mode that matters: the loops treat it as a bad turn and retry, so an
 *      unreliable envelope shows up as a slow agent, not as an error.
 *
 * Every call goes through the REAL generated `b.LoopController` with the real
 * override (`clientOverrideFor('controller')`), so the request shape is the
 * one production sends — prompt scaffolding, JSON schema block, `max_tokens`,
 * `chat_template_kwargs` and all. A hand-rolled `fetch` would measure a
 * request this repo never makes.
 *
 * Two honesty notes that belong with the numbers, not in a footnote:
 *   - p95 here is usually the MAXIMUM, not a tail estimate. `pct` is
 *     nearest-rank with a ceiling, so its index is `ceil(0.95n) - 1`: at
 *     n = 3 (sequential), n = 8 (4-way) and n = 16 (8-way) that is the last
 *     element, i.e. the worst observation. Only the 20-call reliability phase
 *     has enough samples for it to be the second-worst. It is reported as p95
 *     because that is what it approximates, not because n justifies the name.
 *   - The user message is varied per call. The deployment may run vLLM's
 *     prefix cache (a server flag, outside this repo), and a fixed prompt
 *     would measure that cache rather than the model.
 */

import { Collector } from '@boundaryml/baml'
import type { LoopTurn, ToolDescription } from '../../../../baml_client/types'
import { assertVerdaConfigured, clientOverrideFor, verdaInferenceEnabled } from '../clients.server'

const EXPECTED_CLIENT = 'VerdaQwen'

/** Phase sizes. Small on purpose: this is a measurement, not a soak, and the
 *  box is billed per GPU-second while awake. */
const SEQUENTIAL_CALLS = 3
const CONCURRENCY_ROUNDS = 2
const RELIABILITY_CALLS = 20

/** A catalog sized to a real agent's turn, so the prompt lands in the 2-4k
 *  token band a controller actually sees rather than the ~600 of the smoke. */
const TOOLS: ToolDescription[] = [
  [
    'read_neo4j_cypher',
    'Run a READ-ONLY Cypher query against the graph and return rows.',
    { query: 'string' },
  ],
  [
    'get_neo4j_schema',
    'Return the graph schema: node labels, relationship types, property keys.',
    {},
  ],
  [
    'write_neo4j_cypher',
    'Run a write Cypher statement (CREATE/MERGE/SET) against the graph.',
    { query: 'string' },
  ],
  [
    'search',
    'Web search. Returns ranked result titles, URLs and snippets for a query.',
    { query: 'string', count: 'number' },
  ],
  [
    'fetch_content',
    'Fetch a URL and return its readable text content, markdown-converted.',
    { url: 'string' },
  ],
  [
    'search_redis_documents',
    'Semantic search over the document stash; returns matching chunks with scores.',
    { query: 'string', k: 'number' },
  ],
  [
    'json_get',
    'Read a JSON document from Redis at a key and optional JSONPath.',
    { name: 'string', path: 'string' },
  ],
  [
    'json_set',
    'Write a JSON document to Redis at a key and JSONPath.',
    { name: 'string', path: 'string', value: 'string' },
  ],
  [
    'read_text_file',
    'Read a UTF-8 text file from the workspace and return its contents.',
    { path: 'string' },
  ],
  [
    'write_file',
    'Write UTF-8 text to a path in the workspace, creating parents as needed.',
    { path: 'string', content: 'string' },
  ],
  [
    'sandbox_bash',
    'Run a shell command inside the session sandbox and return stdout/stderr.',
    { command: 'string' },
  ],
  [
    'search_nodes',
    'Search the memory graph for entities matching a query string.',
    { query: 'string' },
  ],
].map(([name, description, props]) => ({
  name: name as string,
  description: description as string,
  args_schema: JSON.stringify({
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(props as Record<string, string>).map(([k, t]) => [k, { type: t }]),
    ),
    required: Object.keys(props as Record<string, string>).slice(0, 1),
  }),
}))

/** Two completed turns with results, i.e. the turn log a mid-loop controller
 *  reads. Kept realistic in size — the turn log is what grows a controller
 *  prompt in production. */
const TURNS: LoopTurn[] = [
  {
    n: 1,
    reasoning: 'Read the schema before writing any query, so the labels are real.',
    status: 'Reading the graph schema.',
    tool_call: { tool: 'get_neo4j_schema', args: '{}' },
    tool_result: {
      tool: 'get_neo4j_schema',
      success: true,
      result: JSON.stringify({
        labels: ['Person', 'Organisation', 'Document', 'Project', 'Meeting', 'Topic', 'Location'],
        relationships: ['WORKS_FOR', 'AUTHORED', 'MENTIONS', 'ATTENDED', 'PART_OF', 'LOCATED_IN'],
        properties: {
          Person: ['name', 'email', 'role', 'createdAt'],
          Organisation: ['name', 'domain', 'sector'],
          Document: ['title', 'path', 'ingestedAt', 'chunkCount'],
          Project: ['name', 'status', 'startedAt', 'owner'],
        },
        _source: { server: 'neo4j', tool: 'get_neo4j_schema' },
      }),
    },
  },
  {
    n: 2,
    reasoning: 'Listed projects with their status so the counts can be grouped.',
    status: 'Querying projects.',
    tool_call: {
      tool: 'read_neo4j_cypher',
      args: JSON.stringify({ query: 'MATCH (p:Project) RETURN p.name, p.status LIMIT 25' }),
    },
    tool_result: {
      tool: 'read_neo4j_cypher',
      success: true,
      result: JSON.stringify({
        rows: Array.from({ length: 12 }, (_, i) => ({
          'p.name': `project-${i}`,
          'p.status': i % 3 === 0 ? 'active' : i % 3 === 1 ? 'paused' : 'done',
        })),
        _source: { server: 'neo4j', tool: 'read_neo4j_cypher' },
      }),
    },
  },
  {
    n: 3,
    reasoning: 'The graph gives status but not the narrative, so pull the stashed notes.',
    status: 'Searching the document stash.',
    tool_call: {
      tool: 'search_redis_documents',
      args: JSON.stringify({ query: 'project status notes owner handover', k: 6 }),
    },
    tool_result: {
      tool: 'search_redis_documents',
      success: true,
      // Six retrieved chunks. This is the single biggest contributor to a real
      // controller prompt — a retrieval result, quoted in full in the turn log —
      // and it is what lifts the measured prompt into the 2-4k band a mid-loop
      // controller actually carries.
      result: JSON.stringify({
        matches: Array.from({ length: 6 }, (_, i) => ({
          score: Number((0.82 - i * 0.04).toFixed(3)),
          documentId: `doc-${100 + i}`,
          title: `Weekly note ${i + 1} — project-${i} review`,
          text:
            `Status review for project-${i}. The team closed out the ingestion work and moved the ` +
            `remaining schema questions to the owner. Blockers this week: the export job still ` +
            `retries on large batches, and the handover document has not been signed off by the ` +
            `sponsor. Decisions recorded: keep the current retention window, defer the dashboard ` +
            `rewrite to next quarter, and split the migration into two phases so the first can ` +
            `ship behind a flag. Next steps assigned to the owner: confirm the sponsor sign-off, ` +
            `re-run the failing export against the smaller batch size, and write the phase-one ` +
            `acceptance criteria down before the next review. Risks noted: a single maintainer on ` +
            `the export path, and no measured baseline for the dashboard rewrite.`,
        })),
        _source: { server: 'redis', tool: 'search_redis_documents' },
      }),
    },
  },
]

/** Pushes the completion toward ~300 tokens, which is the output size the
 *  measurement is specified at. Without it the envelope answers in ~100 —
 *  honest for a real turn, but it under-reports the decode rate. */
const CONTEXT =
  'Explain your choice thoroughly in `reasoning`: four to six full sentences ' +
  'covering what the turn log already establishes, what is still missing, why ' +
  'the tool you picked is the one that closes that gap, and what you expect ' +
  'its result to contain.'

/** Varied per call so the numbers are not measuring vLLM's prefix cache. */
function question(i: number): string {
  const asks = [
    'How many projects are active, and who owns each one?',
    'Which people work for organisations that appear in the project list?',
    'Summarise the documents that mention any paused project.',
    'What is the earliest startedAt among the active projects?',
    'Which topics connect the done projects to each other?',
  ]
  return `${asks[i % asks.length]} (request ${i + 1})`
}

interface CallResult {
  ms: number
  promptTokens?: number
  completionTokens?: number
  client?: string
  parseError?: string
  transportError?: string
}

async function oneCall(i: number): Promise<CallResult> {
  const { b } = await import('../../../../baml_client')
  const collector = new Collector(`load-${i}`)
  const opts = { collector, ...clientOverrideFor('controller') }
  const t0 = Date.now()
  try {
    await b.LoopController(
      question(i),
      'answer the question from the graph',
      TOOLS,
      TURNS,
      CONTEXT,
      undefined, // turns_previous_runs
      undefined, // few_shots
      undefined, // multi_call_mode
      undefined, // plan_context
      undefined, // return_style
      opts,
    )
    return { ms: Date.now() - t0, ...usage(collector) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // BAML raises the same class for "the model wrote something unparseable"
    // and for "the model wrote nothing"; both are envelope failures from the
    // loop's point of view. A transport failure is a different problem and is
    // counted separately, because mixing them would let a 502 read as an
    // unreliable model.
    const isParse = /BamlValidationError|BamlClientFinishReasonError|Failed to parse/i.test(
      `${(err as { name?: string }).name ?? ''} ${message}`,
    )
    return {
      ms: Date.now() - t0,
      ...usage(collector),
      ...(isParse
        ? { parseError: message.slice(0, 200) }
        : { transportError: message.slice(0, 200) }),
    }
  }
}

function usage(collector: Collector): Partial<CallResult> {
  const call = (collector.last?.calls ?? []).find((c) => (c as { selected?: boolean }).selected) as
    { clientName?: string; usage?: { inputTokens?: number; outputTokens?: number } } | undefined
  return {
    client: call?.clientName,
    promptTokens: call?.usage?.inputTokens ?? undefined,
    completionTokens: call?.usage?.outputTokens ?? undefined,
  }
}

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

function stats(label: string, results: CallResult[], wallMs: number): void {
  const ok = results.filter((r) => !r.parseError && !r.transportError)
  const sorted = ok.map((r) => r.ms).sort((a, b) => a - b)
  const out = ok.reduce((n, r) => n + (r.completionTokens ?? 0), 0)
  const inTok = ok.reduce((n, r) => n + (r.promptTokens ?? 0), 0)
  const perCall = ok.length ? out / ok.length : 0
  console.log(
    `\n${label}\n` +
      `  n=${results.length} ok=${ok.length} parseFail=${results.filter((r) => r.parseError).length} ` +
      `transportFail=${results.filter((r) => r.transportError).length}\n` +
      `  latency ms: min=${sorted[0]} p50=${pct(sorted, 50)} p95=${pct(sorted, 95)} max=${sorted[sorted.length - 1]}\n` +
      `  tokens: prompt avg=${Math.round(inTok / (ok.length || 1))} completion avg=${Math.round(perCall)}\n` +
      `  decode rate: per-call avg=${(out / (sorted.reduce((a, b) => a + b, 0) / 1000 || 1)).toFixed(1)} tok/s ` +
      `· aggregate=${(out / (wallMs / 1000)).toFixed(1)} tok/s over ${(wallMs / 1000).toFixed(1)}s wall`,
  )
  for (const r of results) {
    if (r.parseError) console.log(`  ⚠ parse: ${r.parseError}`)
    if (r.transportError) console.log(`  ⚠ transport: ${r.transportError}`)
  }
  const wrong = ok.map((r) => r.client).filter((c) => c !== EXPECTED_CLIENT)
  if (wrong.length)
    throw new Error(`${label}: ${wrong.length} call(s) served by ${wrong.join(',')}`)
}

async function burst(
  n: number,
  offset: number,
): Promise<{ results: CallResult[]; wallMs: number }> {
  const t0 = Date.now()
  const results = await Promise.all(Array.from({ length: n }, (_, i) => oneCall(offset + i)))
  return { results, wallMs: Date.now() - t0 }
}

async function main(): Promise<void> {
  if (!verdaInferenceEnabled()) {
    throw new Error(
      'USE_VERDA_INFERENCE is not 1 — this run would measure Anthropic. See the header.',
    )
  }
  assertVerdaConfigured()
  console.log('🔒 Verda load measurement — self-hosted, single replica')
  console.log(
    `   catalog=${TOOLS.length} tools · turn log=${TURNS.length} turns · output target ~300 tokens`,
  )

  let cursor = 0

  // Phase 1 — sequential baseline. The first call also absorbs any cold start.
  const seq: CallResult[] = []
  const seqT0 = Date.now()
  for (let i = 0; i < SEQUENTIAL_CALLS; i++) {
    const r = await oneCall(cursor++)
    console.log(
      `   seq ${i + 1}/${SEQUENTIAL_CALLS}: ${r.ms}ms in=${r.promptTokens} out=${r.completionTokens}`,
    )
    seq.push(r)
  }
  stats('PHASE 1 — sequential (baseline, 1 in flight)', seq, Date.now() - seqT0)

  // Phase 2 — the two concurrency points.
  for (const width of [4, 8]) {
    const all: CallResult[] = []
    let wall = 0
    for (let round = 0; round < CONCURRENCY_ROUNDS; round++) {
      const { results, wallMs } = await burst(width, cursor)
      cursor += width
      wall += wallMs
      console.log(`   ${width}-way round ${round + 1}: ${wallMs}ms wall for ${width} calls`)
      all.push(...results)
    }
    stats(`PHASE 2 — ${width} parallel (${CONCURRENCY_ROUNDS} rounds)`, all, wall)
  }

  // Phase 3 — envelope reliability, run 4 at a time so it finishes in the burst.
  const rel: CallResult[] = []
  const relT0 = Date.now()
  while (rel.length < RELIABILITY_CALLS) {
    const width = Math.min(4, RELIABILITY_CALLS - rel.length)
    const { results } = await burst(width, cursor)
    cursor += width
    rel.push(...results)
    console.log(`   reliability ${rel.length}/${RELIABILITY_CALLS}`)
  }
  stats(
    'PHASE 3 — structured-output reliability (20 controller-shaped calls)',
    rel,
    Date.now() - relT0,
  )

  console.log(`\ntotal calls: ${cursor}`)
}

main().catch((err) => {
  console.error('\n❌ load run failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
