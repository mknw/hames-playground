/**
 * Chunking Tests (Issue #9)
 *
 * Pure-function coverage for the fixed / sentence / paragraph strategies, the
 * type-aware `chunkDocument` dispatcher, and the offset invariant
 * (`content === text.slice(startOffset, endOffset)` for non-CSV strategies).
 */

import { describe, it, expect, vi } from 'vitest'

// chunking self-asserts server-only on import; stub it out under jsdom.
vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  chunkText,
  chunkFixed,
  chunkBySentence,
  chunkByParagraph,
  chunkDocument,
  chunkCsv,
  DEFAULT_CHUNK_CONFIG,
  type Chunk,
} from '../../lib/chunking.server'

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Offsets must faithfully slice the source for non-CSV strategies. */
function assertOffsetInvariant(text: string, chunks: Chunk[]) {
  for (const c of chunks) {
    expect(text.slice(c.startOffset, c.endOffset)).toBe(c.content)
  }
}

/** Indices are a contiguous 0..n-1 run. */
function assertContiguousIndices(chunks: Chunk[]) {
  chunks.forEach((c, i) => expect(c.index).toBe(i))
}

// ----------------------------------------------------------------------------

describe('chunking (Issue #9)', () => {
  describe('chunkFixed', () => {
    it('produces sliding windows stepping by maxChars - overlap', () => {
      const text = 'abcdefghij' // 10 chars
      const chunks = chunkFixed(text, { maxChars: 4, overlap: 1 })
      // step = 3 → windows at 0,3,6 ([6,10) hits the end and stops); fully covers 10 chars
      expect(chunks.map((c) => c.content)).toEqual(['abcd', 'defg', 'ghij'])
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
    })

    it('returns a single chunk when text fits in one window', () => {
      const chunks = chunkFixed('short', { maxChars: 100, overlap: 10 })
      expect(chunks).toHaveLength(1)
      expect(chunks[0].content).toBe('short')
    })

    it('returns [] for empty text', () => {
      expect(chunkFixed('', { maxChars: 10, overlap: 2 })).toEqual([])
    })

    it('does not stall when overlap >= maxChars (clamped)', () => {
      const chunks = chunkFixed('abcdefgh', { maxChars: 3, overlap: 99 })
      // overlap clamped to maxChars-1 = 2 → step 1
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.length).toBeLessThan(20)
      assertOffsetInvariant('abcdefgh', chunks)
    })
  })

  describe('chunkByParagraph', () => {
    it('merges short paragraphs up to maxChars and splits on blank lines', () => {
      const text = 'Para one.\n\nPara two.\n\nA much longer third paragraph that stands alone here.'
      const chunks = chunkByParagraph(text, { maxChars: 25, overlap: 0 })
      expect(chunks.length).toBeGreaterThan(1)
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
      // Content is trimmed of surrounding whitespace.
      chunks.forEach((c) => expect(c.content).toBe(c.content.trim()))
    })

    it('falls back to a fixed window for a single oversized paragraph', () => {
      const huge = 'x'.repeat(50)
      const chunks = chunkByParagraph(huge, { maxChars: 10, overlap: 0 })
      expect(chunks.length).toBe(5)
      assertOffsetInvariant(huge, chunks)
      assertContiguousIndices(chunks)
    })

    it('returns [] for whitespace-only input', () => {
      expect(chunkByParagraph('   \n\n  \n', { maxChars: 10 })).toEqual([])
    })
  })

  describe('heading binding (markdown)', () => {
    it('keeps a heading in the same chunk as its following paragraph', () => {
      const text = '# Architecture\n\nThe system uses a layered design.'
      const chunks = chunkByParagraph(text, { maxChars: 1000, overlap: 0 })
      expect(chunks).toHaveLength(1)
      expect(chunks[0].content).toContain('# Architecture')
      expect(chunks[0].content).toContain('The system uses a layered design.')
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
    })

    it('prepends two consecutive headings to the paragraph they introduce', () => {
      const text = '# Top\n\n## Sub\n\nBody text here.'
      const chunks = chunkByParagraph(text, { maxChars: 1000, overlap: 0 })
      expect(chunks).toHaveLength(1)
      expect(chunks[0].content).toContain('# Top')
      expect(chunks[0].content).toContain('## Sub')
      expect(chunks[0].content).toContain('Body text here.')
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
    })

    it('puts the heading on the first window only when the section overflows', () => {
      const body = 'x'.repeat(60)
      const text = `## Architecture\n\n${body}` // 77 chars > maxChars
      const chunks = chunkByParagraph(text, { maxChars: 40, overlap: 0 })
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks[0].content.startsWith('## Architecture')).toBe(true)
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].content).not.toContain('## Architecture')
      }
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
    })

    it('keeps a trailing heading with no body rather than dropping it', () => {
      const text = 'Some body paragraph.\n\n# Dangling'
      const chunks = chunkByParagraph(text, { maxChars: 1000, overlap: 0 })
      expect(chunks.map((c) => c.content).join('\n')).toContain('# Dangling')
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
    })

    it('is a no-op on headingless prose (paragraphs still split normally)', () => {
      const text = 'First paragraph here.\n\nSecond paragraph here.'
      const chunks = chunkByParagraph(text, { maxChars: 25, overlap: 0 })
      expect(chunks.map((c) => c.content)).toEqual([
        'First paragraph here.',
        'Second paragraph here.',
      ])
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
    })
  })

  describe('chunkBySentence', () => {
    it('splits on sentence punctuation and packs to maxChars', () => {
      const text = 'First sentence. Second one! Third here? Fourth final.'
      const chunks = chunkBySentence(text, { maxChars: 30, overlap: 0 })
      expect(chunks.length).toBeGreaterThan(1)
      assertOffsetInvariant(text, chunks)
      assertContiguousIndices(chunks)
    })

    it('keeps a single short sentence as one chunk', () => {
      const chunks = chunkBySentence('Just one sentence.', { maxChars: 100 })
      expect(chunks).toHaveLength(1)
      expect(chunks[0].content).toBe('Just one sentence.')
    })

    it('realises overlap by carrying trailing sentences forward', () => {
      const text = 'Aaaa. Bbbb. Cccc. Dddd. Eeee.'
      const noOverlap = chunkBySentence(text, { maxChars: 12, overlap: 0 })
      const withOverlap = chunkBySentence(text, { maxChars: 12, overlap: 6 })
      // Overlap should not reduce the chunk count and should still be valid.
      expect(withOverlap.length).toBeGreaterThanOrEqual(noOverlap.length)
      assertOffsetInvariant(text, withOverlap)
    })
  })

  describe('chunkText dispatch', () => {
    it('defaults to the paragraph strategy', () => {
      expect(DEFAULT_CHUNK_CONFIG.strategy).toBe('paragraph')
      const text = 'Alpha.\n\nBeta.'
      expect(chunkText(text)).toEqual(chunkByParagraph(text))
    })

    it('routes to fixed when asked', () => {
      const text = 'abcdefghij'
      expect(chunkText(text, { strategy: 'fixed', maxChars: 4, overlap: 0 })).toEqual(
        chunkFixed(text, { maxChars: 4, overlap: 0 }),
      )
    })
  })

  describe('chunkCsv', () => {
    it('prepends the header to each row group and tracks data-row offsets', () => {
      const csv = 'id,name\n1,alice\n2,bob\n3,carol'
      const chunks = chunkCsv(csv, { maxChars: 20, overlap: 0 })
      expect(chunks.length).toBeGreaterThan(1)
      for (const c of chunks) {
        expect(c.content.startsWith('id,name')).toBe(true)
        expect(c.metadata?.csvHeader).toBe(true)
      }
    })

    it('emits header-only when there are no data rows', () => {
      const chunks = chunkCsv('a,b,c', { maxChars: 100 })
      expect(chunks).toHaveLength(1)
      expect(chunks[0].content).toBe('a,b,c')
    })

    it('returns [] for empty input', () => {
      expect(chunkCsv('', {})).toEqual([])
    })
  })

  describe('chunkDocument type routing', () => {
    it('routes CSV mime to row-based chunking', () => {
      const csv = 'h1,h2\n1,2\n3,4'
      const chunks = chunkDocument(csv, 'text/csv', { maxChars: 100 })
      expect(chunks[0].content.startsWith('h1,h2')).toBe(true)
    })

    it('pretty-prints JSON before chunking', () => {
      const json = '{"a":1,"b":[1,2,3]}'
      const chunks = chunkDocument(json, 'application/json', { maxChars: 1000 })
      // Pretty-printed JSON spans multiple lines.
      expect(chunks[0].content).toContain('\n')
    })

    it('chunks plain text directly', () => {
      const text = 'Hello world.\n\nSecond paragraph.'
      const chunks = chunkDocument(text, 'text/plain', { maxChars: 1000 })
      assertOffsetInvariant(text, chunks)
    })
  })
})
