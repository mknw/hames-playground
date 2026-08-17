/**
 * LIVE bench — batched vs per-item tool-result compaction (#83 Part E).
 *
 * `compactBulkData` used to spend one `ResultDescribe` call per oversized tool
 * result of a turn; it now folds them into one `ResultDescribeBatch` call. This
 * measures the two arms against the real describe-tier client on the same
 * fixtures and prints a table: calls, input/output tokens, wall clock.
 *
 * What it can and cannot show:
 *  - INPUT TOKENS are the real saving — the system prompt and output schema are
 *    sent once instead of N times.
 *  - OUTPUT TOKENS are roughly conserved: N summaries are N summaries.
 *  - WALL CLOCK is NOT expected to improve. The per-item arm already ran its
 *    calls in parallel, so it costs ~one latency; the batch generates N
 *    summaries serially inside one response. It is background work fired after
 *    the SSE response reaches the user, so request count and tokens are what
 *    matter, and the bench reports latency only so a regression is visible.
 *
 * OFF by default so `pnpm test:run` stays offline. Needs `ANTHROPIC_API_KEY`
 * (env or app/.env). Run with:
 *
 *   cd app && RUN_EVALS=1 pnpm test:run src/__tests__/bench/describe-batch-bench.test.ts
 *
 * Cost: N+1 calls on the describe-tier client (Haiku) with ~1k-token inputs —
 * fractions of a cent per run.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Compared against '1', not truthiness: `RUN_EVALS=0` is a non-empty string,
// so a truthiness check would spend real calls for someone who asked for OFF.
const RUN_EVALS = process.env.RUN_EVALS === '1'

function ensureApiKey(): void {
  if (process.env.ANTHROPIC_API_KEY) return
  // vitest cwd is app/ — fall back to app/.env
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ANTHROPIC_API_KEY='))
  if (!line) throw new Error('ANTHROPIC_API_KEY not in env or app/.env')
  process.env.ANTHROPIC_API_KEY = line
    .slice('ANTHROPIC_API_KEY='.length)
    .trim()
    .replace(/^["']|["']$/g, '')
}

interface Fixture {
  tool: string
  toolArgs: string
  reasoning: string
  result: string
}

/** Six results of the shape a real multi-tool turn produces, each already
 *  truncated the way compactBulkData truncates (maxResultForSummary = 3000). */
const FIXTURES: Fixture[] = [
  {
    tool: 'read_neo4j_cypher',
    toolArgs: '{"query":"MATCH (p:Person)-[:WORKS_ON]->(pr:Project) RETURN p.name, pr.name"}',
    reasoning: 'List who works on which project so I can answer the ownership question.',
    result: JSON.stringify(
      Array.from({ length: 18 }, (_, i) => ({
        'p.name': ['Ada', 'Grace', 'Alan', 'Barbara', 'Edsger', 'Donald'][i % 6],
        'pr.name': ['ingest-pipeline', 'graph-ui', 'retriever'][i % 3],
        since: 2019 + (i % 6),
      })),
    ),
  },
  {
    tool: 'get_neo4j_schema',
    toolArgs: '{}',
    reasoning: 'Check the labels available before writing a second query.',
    result: JSON.stringify({
      labels: ['Person', 'Project', 'Document', 'Chunk', 'Tool', 'Session'],
      relationships: [
        'WORKS_ON', 'AUTHORED', 'MENTIONS', 'PART_OF', 'DERIVED_FROM', 'INVOKED',
      ],
      properties: {
        Person: ['name', 'email', 'role'],
        Project: ['name', 'status', 'started'],
        Document: ['path', 'sha', 'ingestedAt', 'pages'],
      },
    }),
  },
  {
    tool: 'fetch',
    toolArgs: '{"url":"https://example.dev/blog/graph-embeddings"}',
    reasoning: 'The user asked what the article recommends.',
    result:
      '# Graph embeddings in practice\n\n' +
      'Three families dominate production use: random-walk methods (node2vec, ' +
      'DeepWalk), convolutional aggregators (GraphSAGE, GAT) and factorisation ' +
      'approaches. For graphs under ten million edges the walk-based methods ' +
      'remain competitive and are far cheaper to retrain, which matters when the ' +
      'graph is rebuilt nightly. The post recommends starting with node2vec, ' +
      'measuring link-prediction AUC, and only moving to GraphSAGE once node ' +
      'features carry real signal. It closes with a warning about evaluating on ' +
      'a random edge split, which leaks structure and flatters every model.',
  },
  {
    tool: 'read_text_file',
    toolArgs: '{"path":"/work/report/summary.md","head":40}',
    reasoning: 'Read back the file the previous step wrote to confirm it landed.',
    result:
      '# Q3 ingestion summary\n\n' +
      '- 412 documents ingested, 11 skipped (unsupported MIME)\n' +
      '- 38,204 chunks embedded, mean 41 tokens\n' +
      '- 3 duplicate SHAs detected and folded\n' +
      '- Longest single document: handbook.pdf (318 pages)\n' +
      '- Vector index rebuilt in 94s\n\n' +
      'Follow-ups: the skipped files are all .pages archives; the parser lane ' +
      'tracks them separately.',
  },
  {
    tool: 'search_redis_documents',
    toolArgs: '{"query":"retention policy","k":5}',
    reasoning: 'Find what the stash already holds about retention before answering.',
    result: JSON.stringify([
      { source: 'policies/retention.md', score: 0.81, text: 'Session transcripts are kept 90 days, then compacted to summaries only.' },
      { source: 'policies/retention.md', score: 0.77, text: 'Uploaded documents persist until the owning user deletes them.' },
      { source: 'adr/0007-storage.md', score: 0.64, text: 'Redis holds the hot path; cold copies move to object storage nightly.' },
      { source: 'runbook/cleanup.md', score: 0.58, text: 'The reaper runs hourly and never touches keys with an active lease.' },
    ]),
  },
  {
    tool: 'list_commits',
    toolArgs: '{"repo":"harness-playground","perPage":8}',
    reasoning: 'The user wants to know what changed this week.',
    result: JSON.stringify(
      [
        'fix(session): make the uncacheable flag concurrency-safe',
        'test: pin extractPromptTemplates against a parenthesised signature',
        'fix(planner): throw LLMCallError on an empty plan',
        'feat(stash): inline document viewer with chat citations',
        'refactor(tools): group MCP tools by inferred namespace',
        'docs: record the describe-tier client choice in ADR-0002',
        'fix(ui): stop the graph tab remounting Cytoscape on every turn',
        'chore(deps): bump @boundaryml/baml to 0.224.0',
      ].map((message, i) => ({ sha: `c0ffee${i}`, message, author: 'mknw' })),
    ),
  },
]

/** Eight small results — the other shape a turn takes: several cheap lookups
 *  (`multiToolCalls` batches up to 4 per turn, over several turns) where the
 *  per-call prompt overhead, not the payload, is what dominates the input. */
const SMALL_FIXTURES: Fixture[] = [
  { tool: 'get', toolArgs: '{"key":"session:active"}', reasoning: 'Check the active session.', result: '"sess_8812"' },
  { tool: 'llen', toolArgs: '{"name":"queue:ingest"}', reasoning: 'How deep is the queue?', result: '17' },
  { tool: 'smembers', toolArgs: '{"name":"flags:enabled"}', reasoning: 'Which flags are on?', result: '["retriever","code-mode","stash-viewer"]' },
  { tool: 'dbsize', toolArgs: '{}', reasoning: 'Rough size of the store.', result: '4128' },
  { tool: 'get_file_info', toolArgs: '{"path":"/work/out.csv"}', reasoning: 'Did the export land?', result: '{"size":20481,"modified":"2026-08-17T08:11:02Z"}' },
  { tool: 'type', toolArgs: '{"key":"doc:handbook"}', reasoning: 'Is it a hash or JSON?', result: '"ReJSON-RL"' },
  { tool: 'hget', toolArgs: '{"name":"doc:handbook","key":"pages"}', reasoning: 'How long is it?', result: '"318"' },
  { tool: 'get_indexes', toolArgs: '{}', reasoning: 'Which vector indexes exist?', result: '["idx:chunks","idx:titles"]' },
]

/** Sum of a Collector's usage across every call it recorded. */
function usageOf(collector: { usage: { inputTokens: number | null; outputTokens: number | null } }) {
  return {
    input: collector.usage.inputTokens ?? 0,
    output: collector.usage.outputTokens ?? 0,
  }
}

function pct(from: number, to: number): string {
  if (from === 0) return 'n/a'
  const delta = ((to - from) / from) * 100
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`
}

const SCENARIOS: Array<{ name: string; fixtures: Fixture[] }> = [
  { name: 'six large results (payload-dominated)', fixtures: FIXTURES },
  { name: 'eight small results (overhead-dominated)', fixtures: SMALL_FIXTURES },
]

describe.runIf(RUN_EVALS)('describe compaction — batched vs per-item (live)', () => {
  it.each(SCENARIOS)(
    'answers every item in one call and sends fewer input tokens than N calls — $name',
    async ({ name, fixtures: FIXTURES }) => {
      ensureApiKey()
      const { b } = await import('../../../baml_client')
      const { Collector } = await import('@boundaryml/baml')

      // Arm A — the old shape: one call per result, all in flight at once.
      const perItem = new Collector('per-item')
      const aStart = Date.now()
      const singles = await Promise.all(
        FIXTURES.map((f) =>
          b.ResultDescribe(f.tool, f.toolArgs, f.reasoning, f.result, { collector: perItem }),
        ),
      )
      const aMs = Date.now() - aStart

      // Arm B — the new shape: one batched call for the whole turn.
      const batched = new Collector('batched')
      const bStart = Date.now()
      const out = await b.ResultDescribeBatch(
        FIXTURES.map((f, i) => ({
          id: String(i + 1),
          tool: f.tool,
          tool_args: f.toolArgs,
          reasoning: f.reasoning,
          result: f.result,
        })),
        { collector: batched },
      )
      const bMs = Date.now() - bStart

      const a = usageOf(perItem)
      const bUse = usageOf(batched)
      const aCalls = perItem.logs.length
      const bCalls = batched.logs.length

      console.log(
        [
          '',
          `### compactBulkData — ${name} (${FIXTURES.length} results)`,
          '',
          '| arm | calls | input tok | output tok | total tok | wall clock |',
          '| --- | ----- | --------- | ---------- | --------- | ---------- |',
          `| per-item (before) | ${aCalls} | ${a.input} | ${a.output} | ${a.input + a.output} | ${aMs} ms |`,
          `| batched (after) | ${bCalls} | ${bUse.input} | ${bUse.output} | ${bUse.input + bUse.output} | ${bMs} ms |`,
          `| delta | ${bCalls - aCalls} | ${pct(a.input, bUse.input)} | ${pct(a.output, bUse.output)} | ${pct(a.input + a.output, bUse.input + bUse.output)} | ${pct(aMs, bMs)} |`,
          '',
        ].join('\n'),
      )

      // The correctness claim: one summary per item, every requested id present,
      // nothing merged away.
      expect(out.summaries.length).toBe(FIXTURES.length)
      expect(new Set(out.summaries.map((s) => s.id))).toEqual(
        new Set(FIXTURES.map((_, i) => String(i + 1))),
      )
      for (const s of out.summaries) expect(s.summary.trim().length).toBeGreaterThan(0)

      // The efficiency claim: one request instead of N, and fewer input tokens
      // because the system prompt and output schema are sent once.
      expect(bCalls).toBe(1)
      expect(aCalls).toBe(FIXTURES.length)
      expect(bUse.input).toBeLessThan(a.input)

      // Sanity on the baseline arm — a broken fixture would make the comparison
      // meaningless.
      for (const s of singles) expect(s.trim().length).toBeGreaterThan(0)
    },
    180_000,
  )
})
