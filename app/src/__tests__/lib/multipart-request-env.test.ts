import { describe, it, expect } from 'vitest'

/**
 * Pins the multipart-request environment the unit suite runs in.
 *
 * `parseUploadRequest` and the agents route read uploads through
 * `Request.prototype.formData()`, which is Node's undici implementation. Its
 * parser constructs file entries with `new File(...)` resolved from the GLOBAL
 * scope, while its own brand check (`webidl.is.File`) is captured when undici
 * first loads. Vitest's jsdom environment swaps `globalThis.File` for jsdom's
 * File after that capture, so without the parse-scoped swap in
 * `src/__tests__/setup.ts` every multipart request carrying a file part throws
 * an AssertionError inside the parse on Node 24 (undici 7 resolves `File` per
 * call; undici 6 on Node 22 captured it before the swap). This test runs the
 * round-trip through the real parser — if the environment loses Node's `File`
 * again, it fails here first, at the seam the upload services actually use.
 */
describe('multipart Request.formData() in the unit environment', () => {
  const BOUNDARY = '----envpin42'
  const body =
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="sessionId"\r\n' +
    '\r\n' +
    'session-1\r\n' +
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="sheet.csv"\r\n' +
    'Content-Type: text/csv\r\n' +
    '\r\n' +
    'col1,col2\r\n' +
    `--${BOUNDARY}--\r\n`

  function multipartRequest(): Request {
    return new Request('http://x/upload', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
      body,
    })
  }

  it('parses a file part with its name, type and content readable', async () => {
    const form = await multipartRequest().formData()
    const file = form.get('file') as File
    expect(file.name).toBe('sheet.csv')
    expect(file.type).toBe('text/csv')
    expect(await file.text()).toBe('col1,col2')
    expect(form.get('sessionId')).toBe('session-1')
  })

  it("constructs file entries as Node's undici File, not the realm's", async () => {
    const { File: NodeFile } = await import('node:buffer')
    const form = await multipartRequest().formData()
    expect(form.get('file') instanceof NodeFile).toBe(true)
  })
})
