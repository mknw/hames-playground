/**
 * Document → Markdown conversion client tests.
 *
 * Pure-function coverage for the response parser + MIME allowlist, and the
 * `convertToMarkdown` HTTP call driven by an injected fake `fetch` (no socket).
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  convertToMarkdown,
  extractMarkdown,
  isConvertible,
  conversionEnabled,
  docConvertUrl,
} from '../../lib/doc-convert.server'

/** Minimal Response-shaped stub so we don't depend on a global Response ctor. */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

describe('isConvertible', () => {
  it('accepts docx/odt/pptx/pdf (and legacy variants), case-insensitively', () => {
    for (const m of [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
    ]) {
      expect(isConvertible(m)).toBe(true)
      expect(isConvertible(`  ${m.toUpperCase()}  `)).toBe(true)
    }
  })

  it('rejects text and non-office binaries (stored, not converted)', () => {
    for (const m of ['text/plain', 'text/markdown', 'application/json', 'image/png', 'application/zip']) {
      expect(isConvertible(m)).toBe(false)
    }
  })
})

describe('conversionEnabled', () => {
  afterEach(() => {
    delete process.env.STASH_CONVERT_DOCS
  })
  it('is true only when STASH_CONVERT_DOCS === "1"', () => {
    delete process.env.STASH_CONVERT_DOCS
    expect(conversionEnabled()).toBe(false)
    process.env.STASH_CONVERT_DOCS = '0'
    expect(conversionEnabled()).toBe(false)
    process.env.STASH_CONVERT_DOCS = '1'
    expect(conversionEnabled()).toBe(true)
  })
})

describe('extractMarkdown', () => {
  it('reads a bare array [{content}] (kreuzberg 4.x shape)', () => {
    expect(extractMarkdown([{ content: '# A\n\nbody' }])).toBe('# A\n\nbody')
  })
  it('reads a wrapped {results:[{content}]} (xberg shape)', () => {
    expect(extractMarkdown({ results: [{ content: '# B' }] })).toBe('# B')
  })
  it('falls back to text / markdown field names', () => {
    expect(extractMarkdown([{ text: 'plain body' }])).toBe('plain body')
    expect(extractMarkdown([{ markdown: '# C' }])).toBe('# C')
  })
  it('returns null for empty / malformed shapes', () => {
    expect(extractMarkdown([])).toBeNull()
    expect(extractMarkdown({})).toBeNull()
    expect(extractMarkdown(null)).toBeNull()
    expect(extractMarkdown([{ content: 123 }])).toBeNull() // non-string
  })
})

describe('convertToMarkdown', () => {
  const b64 = Buffer.from('raw pdf bytes').toString('base64')
  afterEach(() => {
    delete process.env.DOC_CONVERT_URL
  })

  it('POSTs multipart files+config to /extract and returns the markdown', async () => {
    const fetchFn = vi.fn(async () => fakeResponse([{ content: '# Title\n\nBody.' }]))
    const md = await convertToMarkdown(b64, 'report.pdf', 'application/pdf', fetchFn)

    expect(md).toBe('# Title\n\nBody.')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:8000/extract')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(String(form.get('config'))).toContain('markdown') // requests markdown output
    expect(form.get('files')).toBeTruthy()
  })

  it('honours DOC_CONVERT_URL', async () => {
    process.env.DOC_CONVERT_URL = 'http://doc-convert:8000'
    const fetchFn = vi.fn(async () => fakeResponse([{ content: '# x' }]))
    await convertToMarkdown(b64, 'a.pdf', 'application/pdf', fetchFn)
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('http://doc-convert:8000/extract')
  })

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(null, false, 500))
    await expect(convertToMarkdown(b64, 'a.pdf', 'application/pdf', fetchFn)).rejects.toThrow(/HTTP 500/)
  })

  it('throws when the sidecar returns no content', async () => {
    const fetchFn = vi.fn(async () => fakeResponse([{ content: '' }]))
    await expect(convertToMarkdown(b64, 'a.pdf', 'application/pdf', fetchFn)).rejects.toThrow(/no content/)
  })
})

describe('docConvertUrl', () => {
  afterEach(() => {
    delete process.env.DOC_CONVERT_URL
  })
  it('defaults to localhost:8000, overridable via env', () => {
    delete process.env.DOC_CONVERT_URL
    expect(docConvertUrl()).toBe('http://localhost:8000')
    process.env.DOC_CONVERT_URL = 'http://doc-convert:8000'
    expect(docConvertUrl()).toBe('http://doc-convert:8000')
  })
})
