/**
 * Document → Markdown conversion client tests.
 *
 * Pure-function coverage for the response parser + MIME allowlist, and the
 * `convertToMarkdown` HTTP call driven by an injected fake `fetch` (no socket).
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  convertToMarkdown,
  extractMarkdown,
  isConvertible,
  conversionEnabled,
  docConvertUrl,
} from '../../stash/doc-convert.server'

/** A real `Response`: the client reads `res.body` under a byte cap (#475 F3),
 *  so a stub with only `json()` no longer reaches it. */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return ok
    ? new Response(JSON.stringify(body), { status })
    : new Response(null, { status: status === 200 ? 500 : status })
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
    for (const m of [
      'text/plain',
      'text/markdown',
      'application/json',
      'image/png',
      'application/zip',
    ]) {
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
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://doc-convert:8000/extract',
    )
  })

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(null, false, 500))
    await expect(convertToMarkdown(b64, 'a.pdf', 'application/pdf', fetchFn)).rejects.toThrow(
      /HTTP 500/,
    )
  })

  it('throws when the sidecar returns no content', async () => {
    const fetchFn = vi.fn(async () => fakeResponse([{ content: '' }]))
    await expect(convertToMarkdown(b64, 'a.pdf', 'application/pdf', fetchFn)).rejects.toThrow(
      /no content/,
    )
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

/**
 * #475 F3 (amendment A7): the response is bounded WHILE it is read.
 *
 * MUTATION (a): go back to `await res.json()` → "a 300 MiB body" goes red
 * (it reads all 300 MiB before anything refuses it).
 * MUTATION (b): clear the timer before reading the body → "a body that stalls"
 * goes red (the late body is accepted).
 */
describe('convertToMarkdown bounds the response while reading it (#475 F3)', () => {
  const b64 = Buffer.from('raw pdf bytes').toString('base64')
  const MiB = 1024 * 1024

  /** A 300 MiB body produced lazily, counting what the client actually pulls. */
  function hugeBody() {
    const chunk = new Uint8Array(MiB).fill(0x20)
    const state = { pulled: 0, cancelled: false }
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.pulled >= 300 * MiB) return controller.close()
          state.pulled += chunk.byteLength
          controller.enqueue(chunk)
        },
        cancel() {
          state.cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    return { state, response: new Response(stream, { status: 200 }) }
  }

  it('a 300 MiB body is rejected after reading at most the cap', async () => {
    const { state, response } = hugeBody()
    const cap = 8 * MiB
    await expect(
      convertToMarkdown(b64, 'a.pdf', 'application/pdf', async () => response, undefined, cap),
    ).rejects.toThrow(/exceeds/)
    expect(state.pulled).toBeLessThanOrEqual(cap + MiB)
    expect(state.cancelled).toBe(true)
  })

  it('a body that stalls past the timer is rejected', async () => {
    process.env.DOC_CONVERT_TIMEOUT_MS = '200'
    vi.resetModules()
    const fresh = await import('../../stash/doc-convert.server')
    delete process.env.DOC_CONVERT_TIMEOUT_MS
    // Headers at once; the body only after 1.5 s — seven times the timer.
    const stalled = vi.fn(async (_url: string, init: RequestInit) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('[{"content":"late"}]'))
            controller.close()
          }, 1500)
          // What a real fetch does: the request signal errors the body too.
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            controller.error(new DOMException('This operation was aborted', 'AbortError'))
          })
        },
      })
      return new Response(stream, { status: 200 })
    })
    const started = Date.now()
    await expect(
      fresh.convertToMarkdown(b64, 'a.pdf', 'application/pdf', stalled as unknown as typeof fetch),
    ).rejects.toThrow(/abort|timed out/i)
    expect(Date.now() - started).toBeLessThan(1400)
  })

  it('the timer holds even when a fetchFn does not tie its body to the signal', async () => {
    process.env.DOC_CONVERT_TIMEOUT_MS = '200'
    vi.resetModules()
    const fresh = await import('../../stash/doc-convert.server')
    delete process.env.DOC_CONVERT_TIMEOUT_MS
    const deaf = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            try {
              controller.enqueue(new TextEncoder().encode('[{"content":"late"}]'))
              controller.close()
            } catch {
              /* already cancelled */
            }
          }, 1500)
        },
      })
      return new Response(stream, { status: 200 })
    })
    await expect(
      fresh.convertToMarkdown(b64, 'a.pdf', 'application/pdf', deaf as unknown as typeof fetch),
    ).rejects.toThrow(/timed out/)
  })

  it('a response with no body is no content', async () => {
    const empty = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(convertToMarkdown(b64, 'a.pdf', 'application/pdf', empty)).rejects.toThrow()
  })
})
