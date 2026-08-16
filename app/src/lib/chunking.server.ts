/**
 * Document Chunking — Server Only (Issue #9)
 *
 * Splits a document's text into sized, overlapping chunks suitable for
 * embedding (#8) and vector storage. Sits between document upload (#6) and the
 * embedding step in the ingestion pipeline:
 *
 *   Upload → detect type → extract text → chunk(text) → embed(chunks) → index
 *                                          ↑ this module
 *
 * Three strategies, all char-budget driven (the `ChunkConfig` is character
 * based by design — token estimation lives elsewhere and would couple this
 * pure utility to the harness):
 *
 *   - `fixed`     — sliding window of `maxChars` with `overlap`. Works on any
 *                   text; the fallback when structure is absent.
 *   - `sentence`  — split on sentence boundaries, greedily pack until `maxChars`.
 *   - `paragraph` — split on blank lines, greedily pack until `maxChars`.
 *
 * Sentence/paragraph packing carries trailing units into the next chunk to
 * realise `overlap`, and falls back to a fixed window for any single unit that
 * alone exceeds `maxChars` (e.g. one giant paragraph). Every returned chunk
 * satisfies `content === text.slice(startOffset, endOffset)` (CSV is the one
 * documented exception — it prepends a repeated header).
 *
 * Pure and synchronous — no Redis, no MCP, no I/O. The `.server.ts` suffix is
 * for consistency with the pipeline neighbours; nothing here is truly
 * server-only, but keeping it server-side avoids shipping it to the client.
 */

import { assertServerOnImport } from './harness-patterns/assert.server'

assertServerOnImport()

// ============================================================================
// Public types (Issue #9 contract)
// ============================================================================

export type ChunkStrategy = 'fixed' | 'sentence' | 'paragraph'

export interface ChunkConfig {
  /** Target chunk size in characters. */
  maxChars: number
  /** Overlap between adjacent chunks, in characters. Clamped to `< maxChars`. */
  overlap: number
  /** Splitting strategy. */
  strategy: ChunkStrategy
}

export interface Chunk {
  /** 0-based position of this chunk in the sequence. */
  index: number
  /** The chunk text. */
  content: string
  /** Inclusive start offset into the source text. */
  startOffset: number
  /** Exclusive end offset into the source text. */
  endOffset: number
  /** Optional per-chunk annotations (e.g. CSV header flag). */
  metadata?: Record<string, unknown>
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxChars: 1000,
  overlap: 200,
  strategy: 'paragraph',
}

// ============================================================================
// Config normalisation
// ============================================================================

function normalizeConfig(config?: Partial<ChunkConfig>): ChunkConfig {
  const maxChars = Math.max(1, Math.floor(config?.maxChars ?? DEFAULT_CHUNK_CONFIG.maxChars))
  let overlap = Math.max(0, Math.floor(config?.overlap ?? DEFAULT_CHUNK_CONFIG.overlap))
  // Overlap must stay strictly below maxChars or fixed-window stepping stalls.
  if (overlap >= maxChars) overlap = maxChars - 1
  return {
    maxChars,
    overlap,
    strategy: config?.strategy ?? DEFAULT_CHUNK_CONFIG.strategy,
  }
}

// ============================================================================
// Strategy dispatch
// ============================================================================

/** Chunk `text` using the configured strategy (default: paragraph). */
export function chunkText(text: string, config?: Partial<ChunkConfig>): Chunk[] {
  const cfg = normalizeConfig(config)
  switch (cfg.strategy) {
    case 'fixed':
      return chunkFixed(text, cfg)
    case 'sentence':
      return chunkBySentence(text, cfg)
    case 'paragraph':
    default:
      return chunkByParagraph(text, cfg)
  }
}

// ============================================================================
// Fixed-window strategy
// ============================================================================

/** Sliding-window chunks of `maxChars` stepping by `maxChars - overlap`. */
export function chunkFixed(text: string, config?: Partial<ChunkConfig>): Chunk[] {
  const cfg = normalizeConfig(config)
  return fixedWindows(text, cfg.maxChars, cfg.overlap, 0, 0)
}

function fixedWindows(
  text: string,
  maxChars: number,
  overlap: number,
  baseOffset: number,
  startIndex: number,
): Chunk[] {
  const chunks: Chunk[] = []
  if (text.length === 0) return chunks
  const step = Math.max(1, maxChars - overlap)
  let start = 0
  let index = startIndex
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length)
    chunks.push({
      index: index++,
      content: text.slice(start, end),
      startOffset: baseOffset + start,
      endOffset: baseOffset + end,
    })
    if (end >= text.length) break
    start += step
  }
  return chunks
}

// ============================================================================
// Sentence / paragraph strategies (unit packing)
// ============================================================================

interface Unit {
  start: number
  end: number
}

/** Sentence boundary: terminal punctuation + optional closing quotes + space. */
const SENTENCE_SEP = /[.!?]+(?:["'’”)\]]+)?\s+/g
/** Paragraph boundary: a blank line, absorbing surrounding whitespace. */
const PARAGRAPH_SEP = /\n[ \t]*\n\s*/g

/** Split prose into sentences, then greedily pack into `maxChars` chunks. */
export function chunkBySentence(text: string, config?: Partial<ChunkConfig>): Chunk[] {
  const cfg = normalizeConfig(config)
  return packUnits(text, splitUnits(text, SENTENCE_SEP), cfg.maxChars, cfg.overlap)
}

/**
 * Split on blank lines, then greedily pack paragraphs into `maxChars` chunks.
 * A markdown heading binds forward to its section body (see {@link bindHeadings})
 * so a bare "## Heading" is never emitted as its own (useless) chunk. On
 * headingless prose this is a no-op, so no MIME-type dispatch is needed.
 */
export function chunkByParagraph(text: string, config?: Partial<ChunkConfig>): Chunk[] {
  const cfg = normalizeConfig(config)
  const units = bindHeadings(text, splitUnits(text, PARAGRAPH_SEP))
  return packUnits(text, units, cfg.maxChars, cfg.overlap)
}

/**
 * Cut `text` into contiguous units at each match of `separatorRe` (the
 * separator belongs to the preceding unit, so units cover the whole string).
 * Whitespace-only units are dropped.
 */
function splitUnits(text: string, separatorRe: RegExp): Unit[] {
  const units: Unit[] = []
  let start = 0
  let m: RegExpExecArray | null
  separatorRe.lastIndex = 0
  while ((m = separatorRe.exec(text)) !== null) {
    const end = m.index + m[0].length
    if (end > start) units.push({ start, end })
    start = end
    if (m.index === separatorRe.lastIndex) separatorRe.lastIndex++ // guard zero-width
  }
  if (start < text.length) units.push({ start, end: text.length })
  return units.filter((u) => text.slice(u.start, u.end).trim().length > 0)
}

/** An ATX markdown heading line: 1–6 `#` then whitespace (`# `, `### `, …). */
const HEADING_LINE = /^#{1,6}\s+/

/**
 * A unit whose every non-empty line is a heading — i.e. it carries no body of
 * its own. `# Header` (a lone heading) is pure; `# Header\ntext` (heading + body
 * with no blank line between, which `splitUnits` keeps as one unit) is not.
 */
function isPureHeadingUnit(text: string, u: Unit): boolean {
  let sawContent = false
  for (const line of text.slice(u.start, u.end).split('\n')) {
    if (line.trim() === '') continue
    sawContent = true
    if (!HEADING_LINE.test(line)) return false
  }
  return sawContent
}

/**
 * Fuse each run of consecutive pure-heading units with the body unit that
 * follows, so a markdown heading is never emitted as its own chunk (a bare
 * "## Architecture" retrieves nothing useful). Two stacked headings both attach
 * to the next paragraph. Units are contiguous (or separated only by whitespace
 * `splitUnits` dropped), so a fused unit is still a single span
 * `[firstHeading.start, body.end]` — the offset invariant
 * (`content === text.slice(start, end)`) is preserved, and a section longer than
 * `maxChars` still sub-splits in `packUnits` with the heading on the first
 * window. Trailing heading(s) with no following body (EOF) are left as-is.
 */
function bindHeadings(text: string, units: Unit[]): Unit[] {
  const out: Unit[] = []
  let i = 0
  while (i < units.length) {
    if (!isPureHeadingUnit(text, units[i])) {
      out.push(units[i])
      i++
      continue
    }
    let j = i
    while (j < units.length && isPureHeadingUnit(text, units[j])) j++
    if (j < units.length) {
      // Heading run [i, j) + the following body unit j → one contiguous span.
      out.push({ start: units[i].start, end: units[j].end })
      i = j + 1
    } else {
      // Nothing to bind forward to — keep the trailing heading(s) as-is.
      for (; i < j; i++) out.push(units[i])
    }
  }
  return out
}

/** Trim leading/trailing whitespace of a span, keeping offsets faithful. */
function trimSpan(text: string, start: number, end: number): [number, number] {
  let s = start
  let e = end
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--
  return [s, e]
}

/**
 * Greedily pack `units` into chunks of at most `maxChars`, carrying trailing
 * units forward to realise `overlap`. A single unit larger than `maxChars` is
 * sub-split with a fixed window so no chunk silently blows the budget.
 */
function packUnits(text: string, units: Unit[], maxChars: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = []
  let i = 0
  while (i < units.length) {
    // Extend the chunk while the span from this unit's start stays within budget.
    let j = i + 1
    while (j < units.length && units[j].end - units[i].start <= maxChars) j++

    const spanStart = units[i].start
    const spanEnd = units[j - 1].end

    if (j === i + 1 && spanEnd - spanStart > maxChars) {
      // Single oversized unit — sub-split with a fixed window.
      const sub = fixedWindows(
        text.slice(spanStart, spanEnd),
        maxChars,
        overlap,
        spanStart,
        chunks.length,
      )
      chunks.push(...sub)
    } else {
      const [s, e] = trimSpan(text, spanStart, spanEnd)
      if (e > s) {
        chunks.push({ index: chunks.length, content: text.slice(s, e), startOffset: s, endOffset: e })
      }
    }

    if (j >= units.length) break

    // Overlap: step back to re-include trailing units within `overlap` chars,
    // always advancing by at least one unit to guarantee progress.
    let nextI = j
    if (overlap > 0) {
      let k = j
      while (k - 1 > i && spanEnd - units[k - 1].start <= overlap) k--
      nextI = Math.max(k, i + 1)
    }
    i = nextI
  }
  // Renumber after any fixed-window sub-splits offset the running index.
  return chunks.map((c, idx) => ({ ...c, index: idx }))
}

// ============================================================================
// Type-aware entry point
// ============================================================================

/**
 * Chunk a document by MIME type, picking a sensible strategy and pre-processing
 * structured formats. Text/Markdown/JSON route through {@link chunkText}; CSV
 * uses row-based chunking with a repeated header.
 */
export function chunkDocument(
  content: string,
  mimeType: string,
  config?: Partial<ChunkConfig>,
): Chunk[] {
  const mime = mimeType.toLowerCase()
  if (mime.includes('csv') || mime.includes('tab-separated')) {
    return chunkCsv(content, config)
  }
  if (mime.includes('json')) {
    // Pretty-print so the paragraph/fixed splitter has line structure to work
    // with; fall back to the raw string if it isn't valid JSON.
    let pretty = content
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      /* not valid JSON — chunk as-is */
    }
    return chunkText(pretty, config)
  }
  return chunkText(content, config)
}

/**
 * Row-based CSV chunking: groups data rows until `maxChars`, prepending the
 * header row to each chunk so embeddings keep column context.
 *
 * Note: because the header is duplicated into every chunk, CSV chunk `content`
 * is NOT a slice of the source — `startOffset`/`endOffset` describe the span of
 * the *data rows* only, and `metadata.csvHeader` flags the prepend.
 */
export function chunkCsv(text: string, config?: Partial<ChunkConfig>): Chunk[] {
  const cfg = normalizeConfig(config)
  const isTsv = text.includes('\t') && !text.includes(',')
  void isTsv // delimiter detection is informational; we split on full lines

  // Offsets of each physical line.
  const lines: { text: string; start: number; end: number }[] = []
  {
    let pos = 0
    for (const raw of text.split('\n')) {
      const start = pos
      const end = pos + raw.length
      lines.push({ text: raw, start, end })
      pos = end + 1 // account for the consumed '\n'
    }
  }

  const nonEmpty = lines.filter((l) => l.text.trim().length > 0)
  if (nonEmpty.length === 0) return []

  const header = nonEmpty[0]
  const rows = nonEmpty.slice(1)
  if (rows.length === 0) {
    // Header only — emit it as a single chunk.
    return [{ index: 0, content: header.text, startOffset: header.start, endOffset: header.end }]
  }

  const chunks: Chunk[] = []
  let group: typeof rows = []
  let groupChars = header.text.length

  const flush = () => {
    if (group.length === 0) return
    const body = group.map((r) => r.text).join('\n')
    chunks.push({
      index: chunks.length,
      content: `${header.text}\n${body}`,
      startOffset: group[0].start,
      endOffset: group[group.length - 1].end,
      metadata: { csvHeader: true, rows: group.length },
    })
    group = []
    groupChars = header.text.length
  }

  for (const row of rows) {
    const add = row.text.length + 1
    if (group.length > 0 && groupChars + add > cfg.maxChars) flush()
    group.push(row)
    groupChars += add
  }
  flush()
  return chunks
}
