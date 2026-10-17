/**
 * Memory ranking — the pure half of recall (#419 M1)
 *
 * Tokenizer, BM25, the two floors, reciprocal-rank fusion and the cap/budget.
 * Everything here is deterministic and free of I/O, so `memoryRecall`'s pins
 * (`bm25-rrf-floors`) can assert the arithmetic without a store, an embedder or
 * a gate.
 *
 * The order is the design's, and the ORDER is the point:
 *
 *   1. FLOORS first. Each channel keeps only what clears ITS floor — semantic
 *      `s_v ≥ τ_v`; lexical a shared non-stopword query term of length ≥ 3 whose
 *      `idf ≥ τ_idf`. RRF is rank-only, so a fused score cannot reject garbage:
 *      the worst memory in a corpus of irrelevant ones still ranks first.
 *      Applying the floors AFTER fusion would let the rejected rows take rank
 *      positions from the ones that survive.
 *   2. FUSE the survivors with RRF (k = 60) over the two channels' ranked lists.
 *   3. CAP by count, then by tokens.
 */

import { assertServerOnImport } from './assert.server'
import { estimateTokens } from './token-budget.server'

assertServerOnImport()

// ----------------------------------------------------------------------------
// Tokenizer
// ----------------------------------------------------------------------------

/**
 * Small stopword lists for the three languages the product serves (EN/NL/FR).
 * Deliberately short and never stemmed: the semantic channel covers meaning,
 * this one exists to match the words a person actually used, so a long list
 * would only delete the few that carry the match. Compared after NFKC +
 * lowercasing.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // EN
  ...'a an and are as at be but by for from has have he her his i if in is it its me my of on or our she so that the their them there they this to us was we were what when where which who will with you your'.split(
    ' ',
  ),
  // NL
  ...'aan al als ben bij dan dat de den der deze die dit door een en er ge geen had heb heeft het hij hun ik in is je kan maar me met mij mijn na niet nog nu of om ons op over te toen tot u uit van voor was wat we wel werd wij ze zich zijn zo zou'.split(
    ' ',
  ),
  // FR
  ...'au aux avec ce ces dans de des du elle en est et il je la le les leur lui ma mais me mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous'.split(
    ' ',
  ),
])

const RUN = /[\p{L}\p{N}]+/gu
/** A whitespace-delimited chunk whose alphanumeric parts are joined by an
 *  identifier connector: `user_id`, `a@b.com`, `v1.2.3`, `src/lib/x`, `foo-bar`. */
const IDENTIFIER = /[\p{L}\p{N}]+(?:[_.@/:#-][\p{L}\p{N}]+)+/gu

/**
 * NFKC, lowercase, split into `\p{L}`/`\p{N}` runs — and IDENTIFIERS WHOLE:
 * a chunk like `user_id` or `a@b.com` is emitted as one token IN ADDITION to its
 * parts, so a query naming the identifier matches it exactly while a query
 * naming one part still matches that part. Stopwords are removed, nothing is
 * stemmed.
 */
export function tokenize(text: string): string[] {
  const norm = text.normalize('NFKC').toLowerCase()
  const out: string[] = []
  for (const m of norm.matchAll(RUN)) out.push(m[0])
  for (const m of norm.matchAll(IDENTIFIER)) out.push(m[0])
  return out.filter((t) => !STOPWORDS.has(t))
}

const codePoints = (s: string): number => Array.from(s).length

// ----------------------------------------------------------------------------
// The ranked item and the parameters
// ----------------------------------------------------------------------------

/** One row as ranking sees it: the text, its semantic similarity, its recency. */
export interface RankInput {
  readonly id: string
  readonly content: string
  /** `s_v = 1 − cosine distance`. */
  readonly semantic: number
  readonly lastSeenMs: number
}

export interface RankParams {
  /** BM25 term-frequency saturation. Default 1.2. */
  readonly k1?: number
  /** BM25 length normalisation. Default 0.75. */
  readonly b?: number
  /** RRF constant. Default 60. */
  readonly rrfK?: number
  /** τ_v — the semantic floor. */
  readonly minSemantic: number
  /** τ_idf — the lexical floor's rarity bar. */
  readonly minIdf: number
}

export const DEFAULT_BM25_K1 = 1.2
export const DEFAULT_BM25_B = 0.75
export const DEFAULT_RRF_K = 60

export interface Ranked {
  readonly id: string
  /** The fused score, for ordering only — it is NOT comparable across queries. */
  readonly score: number
  readonly semantic: number
  readonly lexical: number
}

export interface Ranking {
  /** Survivors of the floors, best first. */
  readonly ranked: readonly Ranked[]
  /** Rows ranked (the corpus). */
  readonly considered: number
}

// ----------------------------------------------------------------------------
// BM25
// ----------------------------------------------------------------------------

/** Lucene's non-negative idf: `ln(1 + (N − n + 0.5)/(n + 0.5))`. */
export function idf(corpusSize: number, docFreq: number): number {
  return Math.log(1 + (corpusSize - docFreq + 0.5) / (docFreq + 0.5))
}

function termCounts(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

// ----------------------------------------------------------------------------
// Ranking
// ----------------------------------------------------------------------------

/** Order by `s_v` desc, then recency desc, then id — the design's tie-break,
 *  with the id as the last resort so the order is total and reproducible. */
function byTieBreak(
  a: { semantic: number; lastSeenMs: number; id: string },
  b: { semantic: number; lastSeenMs: number; id: string },
): number {
  return b.semantic - a.semantic || b.lastSeenMs - a.lastSeenMs || (a.id < b.id ? -1 : 1)
}

/**
 * Rank the corpus for one query: BM25 over it, the two floors, RRF over the
 * survivors. The corpus is EXACTLY the rows passed — the caller hands in the
 * user's own rows in the turn's tiers, so no idf carries another user's signal.
 */
export function rankMemories(
  query: string,
  rows: readonly RankInput[],
  params: RankParams,
): Ranking {
  const k1 = params.k1 ?? DEFAULT_BM25_K1
  const b = params.b ?? DEFAULT_BM25_B
  const rrfK = params.rrfK ?? DEFAULT_RRF_K
  const n = rows.length
  if (n === 0) return { ranked: [], considered: 0 }

  const docs = rows.map((r) => ({ row: r, counts: termCounts(tokenize(r.content)) }))
  const lengths = docs.map((d) => Array.from(d.counts.values()).reduce((s, c) => s + c, 0))
  const avgdl = lengths.reduce((s, l) => s + l, 0) / n || 1

  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.counts.keys()) df.set(t, (df.get(t) ?? 0) + 1)

  const queryTerms = [...new Set(tokenize(query))]

  const scored = docs.map((d, i) => {
    let lexical = 0
    let qualifies = false
    for (const t of queryTerms) {
      const f = d.counts.get(t)
      if (!f) continue
      const termIdf = idf(n, df.get(t) ?? 0)
      lexical += (termIdf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * lengths[i]) / avgdl))
      // The lexical floor: a SHARED, non-stopword term of length ≥ 3 that is
      // rare enough in this user's corpus to mean something.
      if (codePoints(t) >= 3 && termIdf >= params.minIdf) qualifies = true
    }
    const semanticPass = d.row.semantic >= params.minSemantic
    return {
      row: d.row,
      lexical,
      lexicalPass: qualifies && lexical > 0,
      semanticPass,
    }
  })

  // 1. Floors BEFORE fusion: each channel's list holds only what cleared it.
  const semanticList = scored.filter((s) => s.semanticPass).map((s) => s.row)
  semanticList.sort(byTieBreak)
  const lexicalList = scored
    .filter((s) => s.lexicalPass)
    .sort((x, y) => y.lexical - x.lexical || byTieBreak(x.row, y.row))

  // 2. RRF over the two ranked lists.
  const fused = new Map<string, number>()
  semanticList.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (rrfK + i + 1)))
  lexicalList.forEach((s, i) =>
    fused.set(s.row.id, (fused.get(s.row.id) ?? 0) + 1 / (rrfK + i + 1)),
  )

  const byId = new Map(scored.map((s) => [s.row.id, s]))
  const ranked: Ranked[] = [...fused.entries()]
    .map(([id, score]) => {
      const { row, lexical } = byId.get(id)!
      return { id, score, semantic: row.semantic, lexical, row }
    })
    .sort((x, y) => y.score - x.score || byTieBreak(x.row, y.row))
    .map(({ row: _row, ...r }) => r)

  return { ranked, considered: n }
}

// ----------------------------------------------------------------------------
// Cap and budget
// ----------------------------------------------------------------------------

/** The share of the responder's context window memory may ever take. */
export const MEMORY_CONTEXT_SHARE = 0.05

/**
 * The effective token budget: `maxMemoryTokens`, hard-capped at 5% of the
 * responder's context window when it is known.
 */
export function memoryTokenBudget(maxMemoryTokens: number, contextWindow?: number): number {
  if (contextWindow === undefined || !(contextWindow > 0)) return maxMemoryTokens
  return Math.min(maxMemoryTokens, Math.floor(contextWindow * MEMORY_CONTEXT_SHARE))
}

/**
 * Take the best-first list down to `maxMemories` rows and `budgetTokens`
 * tokens. Stops at the first row that does not fit rather than skipping to a
 * smaller, lower-ranked one: the block is "the best few", and a lower-ranked
 * row slipping in past a better one that did not fit would invert that.
 */
export function capMemories<T>(
  items: readonly T[],
  render: (item: T) => string,
  maxMemories: number,
  budgetTokens: number,
): { kept: T[]; tokens: number } {
  const kept: T[] = []
  let tokens = 0
  for (const item of items) {
    if (kept.length >= maxMemories) break
    const t = estimateTokens(render(item))
    if (tokens + t > budgetTokens) break
    kept.push(item)
    tokens += t
  }
  return { kept, tokens }
}
