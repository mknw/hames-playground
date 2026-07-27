/**
 * LIVE prompt-cache benchmark (#122). The V1/V2/V3 A/B is settled (schemes
 * converged at ~89% cached input / ~64% cost reduction; bench arms removed) —
 * this now measures the PRODUCTION controllers so cache behavior can be
 * re-verified after any template change. Calls the real Anthropic API and
 * reports actual cache read/write behavior per call.
 *
 * VARIANT ISOLATION: each variant gets a per-variant salt woven into the
 * FIRST TOOL's description. Tools render inside the system block, i.e. at the
 * very top of the hashed prefix — so no variant can read entries another
 * variant wrote (observed in an earlier run: V1's turn-1 "read" was actually
 * the through-system entry V2 had written minutes before). Without this,
 * byte-identical variants (V2/V3) would share nearly ALL entries and the
 * later one would show ~100% cache for free.
 *
 * OFF by default (skipped) so `pnpm test:run` stays offline. Run with:
 *
 *   cd ui && CACHE_BENCH=1 pnpm vitest run src/__tests__/bench/prompt-cache-bench.test.ts
 *
 * Report: printed to stdout AND written to .harness-logs/cache-bench-latest.md
 * (plus a timestamped copy). ~8 calls total, prompts ~4k tokens, max_tokens
 * clamped to 512 → well under $0.10 per run at Sonnet 5 intro pricing.
 *
 * Method:
 *  - Per variant, 4 sequential calls simulating one actor run (0..3 prior
 *    attempts) with IDENTICAL scripted fixtures — the model's replies are not
 *    fed back, so both variants see the same bytes except their markers.
 *  - The intent carries a per-run salt → every bench run starts cache-cold
 *    (otherwise a rerun within the 5-min TTL reads the previous run's cache
 *    and corrupts the call-1 row).
 *  - Requests are rendered by BAML (`b.request.*`) and POSTed directly, so
 *    `usage` is read raw from the API — no dependence on Collector fields.
 *  - The static prefix is padded well past the minimum cacheable length
 *    (model-dependent, up to ~4k tokens) — below it the API silently skips
 *    caching and BOTH variants would report zeros.
 *
 * Reading the table:
 *  - in_total = uncached + cache_read + cache_write (input side only; output
 *    tokens have no cached variant — caching applies to the request prefix).
 *  - hit attribution is an ESTIMATE: the API reports aggregate read/write
 *    tokens, not which breakpoint fired; we match cache_read against the
 *    estimated size of each marked prefix.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const RUN = process.env.CACHE_BENCH === '1'
const bench = RUN ? it : it.skip

// Sonnet 5 $/MTok — intro pricing through 2026-08-31 (standard: in 3.00 / out 15.00).
const IN_PER_MTOK = 2.0
const OUT_PER_MTOK = 10.0
const CACHE_WRITE_MULT = 1.25
const CACHE_READ_MULT = 0.1

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
type Block = { type: string; text?: string; cache_control?: unknown }
type Body = { system?: Block[]; messages: Array<{ role: string; content: Block[] }>; max_tokens?: number }

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  // vitest cwd is ui/ — fall back to ui/.env
  const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('ANTHROPIC_API_KEY='))
  if (!line) throw new Error('ANTHROPIC_API_KEY not in env or ui/.env')
  return line.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
}

// ---------------------------------------------------------------------------
// Fixtures — identical for both variants. The tool catalog is padded so the
// static prefix comfortably clears the minimum cacheable length.
// ---------------------------------------------------------------------------
const LOREM =
  'Executes against the workspace graph store with full provenance tracking; ' +
  'supports pagination, cursor resumption, schema-aware validation of every ' +
  'parameter, structured error surfaces, and per-call rate accounting. '

/** Tool catalog with a per-variant isolation salt in tool 0's description —
 *  tools render at the top of the system block, so this de-shares the entire
 *  prefix between variants. */
const toolsFor = (isoSalt: string) => Array.from({ length: 8 }, (_, i) => ({
  name: `bench_tool_${i}`,
  description: `${i === 0 ? `[iso:${isoSalt}] ` : ''}Benchmark tool #${i}. ${LOREM.repeat(6)}`,
  args_schema: JSON.stringify({
    type: 'object',
    properties: {
      query: { type: 'string', description: `Primary query argument for bench_tool_${i}. ${LOREM}` },
      limit: { type: 'number', description: 'Max results to return' },
      cursor: { type: 'string', description: 'Opaque pagination cursor from a previous call' },
    },
    required: ['query'],
  }),
}))

const CONTEXT = `ENABLED SERVERS: neo4j, redis, filesystem\n${LOREM.repeat(10)}`

const RESULT_BLOB = (n: number) =>
  `{"rows": ${n * 7}, "sample": "${LOREM.repeat(3)}", "cursor": "c${n}"}`

const ATTEMPTS = [1, 2, 3].map((n) => ({
  n,
  action: {
    reasoning: `attempt ${n}: probe the graph for the requested aggregate`,
    tool_name: `bench_tool_${n}`,
    tool_args: `{"query": "MATCH (x:Bench) RETURN count(x) // variant-invariant fixture ${n}", "limit": ${n * 10}}`,
    status: 'success',
    is_final: false,
  },
  result: RESULT_BLOB(n),
  error: null,
  feedback: n === 1 ? 'not sufficient — need the per-label breakdown too' : null,
}))

type CallRow = {
  turn: number
  in_total: number
  in_uncached: number
  cache_read: number
  cache_write: number
  out: number
  ms: number
  price_cached: number
  price_nocache: number
  hit: string
}

const estTokens = (chars: number) => Math.round(chars / 3.6)

/** Estimated token size of the prefix ending at each marked block. */
function markedPrefixSizes(body: Body): Array<{ label: string; tokens: number }> {
  const ordered: Array<{ text: string; marked: boolean }> = [
    ...(body.system ?? []).map((blk) => ({ text: blk.text ?? '', marked: !!blk.cache_control })),
    ...body.messages.flatMap((m) => m.content.map((blk) => ({ text: blk.text ?? '', marked: !!blk.cache_control }))),
  ]
  const out: Array<{ label: string; tokens: number }> = []
  let chars = 0
  for (const blk of ordered) {
    chars += blk.text.length
    if (blk.marked) out.push({ label: blk.text.slice(0, 28).replace(/\n/g, ' '), tokens: estTokens(chars) })
  }
  return out
}

function price(u: Usage, cached: boolean): number {
  const read = u.cache_read_input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  const inCost = cached
    ? (u.input_tokens + write * CACHE_WRITE_MULT + read * CACHE_READ_MULT) * IN_PER_MTOK
    : (u.input_tokens + write + read) * IN_PER_MTOK
  return (inCost + u.output_tokens * OUT_PER_MTOK) / 1_000_000
}

async function callApi(req: { url: string; headers: object; body: { json(): unknown } }, key: string): Promise<{ usage: Usage; ms: number }> {
  const body = req.body.json() as Body
  body.max_tokens = 512 // clamp for bench speed/cost; irrelevant to caching
  const t0 = Date.now()
  const resp = await fetch(req.url, {
    method: 'POST',
    headers: {
      ...(req.headers as Record<string, string>),
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  const json = (await resp.json()) as { usage?: Usage; error?: unknown }
  if (resp.status !== 200 || !json.usage) {
    throw new Error(`API ${resp.status}: ${JSON.stringify(json.error ?? json).slice(0, 400)}`)
  }
  return { usage: json.usage, ms }
}

function attributeHit(u: Usage, prefixes: Array<{ label: string; tokens: number }>): string {
  const read = u.cache_read_input_tokens ?? 0
  if (read === 0) return (u.cache_creation_input_tokens ?? 0) > 0 ? 'miss (wrote)' : 'no cache activity'
  let best = 'unknown'
  let bestDelta = Infinity
  for (const p of prefixes) {
    const d = Math.abs(p.tokens - read)
    if (d < bestDelta) { bestDelta = d; best = `≈"${p.label}…" (est ${p.tokens}t)` }
  }
  // reads can also land between markers via automatic prefix checking
  return `read ${read}t ${best}`
}

function renderTable(rows: CallRow[]): string {
  const header =
    '| turn | in_total | uncached | cache_read | cache_write | out | ms | $cached | $nocache | hit |\n' +
    '|---|---|---|---|---|---|---|---|---|---|'
  const lines = rows.map((r) =>
    `| ${r.turn} | ${r.in_total} | ${r.in_uncached} | ${r.cache_read} | ${r.cache_write} | ${r.out} | ${r.ms} | $${r.price_cached.toFixed(6)} | $${r.price_nocache.toFixed(6)} | ${r.hit} |`)
  return [header, ...lines].join('\n')
}

describe('prompt-cache live bench: V1 vs V2', () => {
  bench('runs both variants and writes the report', async () => {
    const key = apiKey()
    const { b } = await import('../../../baml_client')
    const salt = `bench-${Date.now()}`
    const userMessage = `[${salt}] Compute the per-label node counts for the Bench subgraph and report the three largest labels with their counts.`

    const variants = [
      { tag: 'actor', name: 'ActorController (production)', fn: b.request.ActorController.bind(b.request) },
    ] as const

    const sections: string[] = [
      `# Prompt-cache bench — ${new Date().toISOString()}`,
      `Salt: \`${salt}\` · model per ControllerAnthropic chain · pricing $${IN_PER_MTOK}/$${OUT_PER_MTOK} per MTok (intro)`,
    ]

    for (const variant of variants) {
      const rows: CallRow[] = []
      const tools = toolsFor(`${variant.tag}-${salt}`)
      for (let len = 0; len <= 3; len++) {
        const req = await variant.fn(
          userMessage, userMessage, tools, ATTEMPTS.slice(0, len) as never,
          CONTEXT, undefined, len + 1, 4)
        const prefixes = markedPrefixSizes(req.body.json() as Body)
        const { usage, ms } = await callApi(req as never, key)
        rows.push({
          turn: len + 1,
          in_total: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          in_uncached: usage.input_tokens,
          cache_read: usage.cache_read_input_tokens ?? 0,
          cache_write: usage.cache_creation_input_tokens ?? 0,
          out: usage.output_tokens,
          ms,
          price_cached: price(usage, true),
          price_nocache: price(usage, false),
          hit: attributeHit(usage, prefixes),
        })
      }
      const totCached = rows.reduce((s, r) => s + r.price_cached, 0)
      const totNo = rows.reduce((s, r) => s + r.price_nocache, 0)
      const totIn = rows.reduce((s, r) => s + r.in_total, 0)
      const totRead = rows.reduce((s, r) => s + r.cache_read, 0)
      sections.push(
        `\n## ${variant.name}\n` +
        renderTable(rows) +
        `\n\n**Totals:** input ${totIn}t (${((totRead / totIn) * 100).toFixed(1)}% served from cache) · ` +
        `$${totCached.toFixed(6)} with caching vs $${totNo.toFixed(6)} without → ` +
        `**${(((totNo - totCached) / totNo) * 100).toFixed(1)}% saved**`)
    }

    const report = sections.join('\n')
    mkdirSync('.harness-logs', { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(`.harness-logs/cache-bench-${stamp}.md`, report)
    writeFileSync('.harness-logs/cache-bench-latest.md', report)
    process.stdout.write('\n' + report + '\n\nReport → ui/.harness-logs/cache-bench-latest.md\n')

    expect(report).toContain('Totals:')
  }, 180_000)
})
