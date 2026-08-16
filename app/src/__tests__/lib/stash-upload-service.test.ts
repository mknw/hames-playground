/**
 * Upload Service Tests (Issue #6 upload path)
 *
 * Covers MIME guessing and request parsing (JSON + multipart) for
 * `POST /api/stash/upload`.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  guessMimeType,
  isTextMime,
  parseUploadRequest,
} from '../../lib/stash/upload-service.server'

describe('upload-service (Issue #6)', () => {
  describe('guessMimeType', () => {
    it('maps known extensions', () => {
      expect(guessMimeType('a.md')).toBe('text/markdown')
      expect(guessMimeType('data.json')).toBe('application/json')
      expect(guessMimeType('table.csv')).toBe('text/csv')
    })
    it('defaults to text/plain for unknown or missing extensions', () => {
      expect(guessMimeType('README')).toBe('text/plain')
      expect(guessMimeType('archive.weird')).toBe('text/plain')
      expect(guessMimeType('trailing.')).toBe('text/plain')
    })
    it('maps audio extensions (agent trigger recordings)', () => {
      expect(guessMimeType('memo.m4a')).toBe('audio/mp4')
      expect(guessMimeType('memo.mp3')).toBe('audio/mpeg')
      expect(guessMimeType('memo.wav')).toBe('audio/wav')
      expect(guessMimeType('memo.caf')).toBe('audio/x-caf')
    })
  })

  describe('audio is treated as binary (base64)', () => {
    it('classifies audio mimetypes as non-text', () => {
      expect(isTextMime('audio/mp4')).toBe(false)
      expect(isTextMime('audio/mpeg')).toBe(false)
      expect(isTextMime('audio/wav')).toBe(false)
    })
    it('base64-encodes an audio recording (multipart, with content-type)', async () => {
      const BOUNDARY = '----audioboundary'
      const body =
        `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="sessionId"\r\n\r\nrun-1\r\n` +
        `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="voice.m4a"\r\n` +
        `Content-Type: audio/mp4\r\n\r\n` +
        `\x00\x01\x02binaryish\r\n` +
        `--${BOUNDARY}--\r\n`
      const req = new Request('http://x/api/stash/upload', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
        body,
      })
      const input = await parseUploadRequest(req)
      expect(input.mimeType).toBe('audio/mp4')
      expect(input.encoding).toBe('base64')
    })
  })

  describe('parseUploadRequest — JSON', () => {
    it('parses a JSON body', async () => {
      const req = new Request('http://x/api/stash/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 's1',
          filename: 'doc.md',
          content: '# hi',
        }),
      })
      const input = await parseUploadRequest(req)
      expect(input).toMatchObject({
        sessionId: 's1',
        filename: 'doc.md',
        mimeType: 'text/markdown',
        content: '# hi',
      })
    })

    it('infers a default filename + mime when omitted', async () => {
      const req = new Request('http://x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', content: 'plain' }),
      })
      const input = await parseUploadRequest(req)
      expect(input.filename).toBe('upload.txt')
      expect(input.mimeType).toBe('text/plain')
    })

    it('throws when content is missing', async () => {
      const req = new Request('http://x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1' }),
      })
      await expect(parseUploadRequest(req)).rejects.toThrow(/content/i)
    })

    it('throws on non-JSON body when content-type is JSON', async () => {
      const req = new Request('http://x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      await expect(parseUploadRequest(req)).rejects.toThrow(/JSON|multipart/i)
    })
  })

  describe('parseUploadRequest — multipart', () => {
    // Build a raw multipart body so part headers (filename / Content-Type) are
    // parsed faithfully — round-tripping a jsdom File through undici's FormData
    // serialization drops those, which is a test-realm artifact, not our code.
    const BOUNDARY = '----testboundary1234'
    function multipart(
      parts: Array<
        | { name: string; value: string }
        | { name: string; filename: string; type?: string; content: string }
      >,
    ): Request {
      const body =
        parts
          .map((p) => {
            if ('filename' in p) {
              return (
                `--${BOUNDARY}\r\n` +
                `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
                (p.type ? `Content-Type: ${p.type}\r\n` : '') +
                `\r\n${p.content}\r\n`
              )
            }
            return (
              `--${BOUNDARY}\r\n` +
              `Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`
            )
          })
          .join('') + `--${BOUNDARY}--\r\n`
      return new Request('http://x/api/stash/upload', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
        body,
      })
    }

    it('parses a file field and uses its name/type', async () => {
      const req = multipart([
        { name: 'sessionId', value: 's2' },
        { name: 'file', filename: 'sheet.csv', type: 'text/csv', content: 'col1,col2\n1,2' },
      ])
      const input = await parseUploadRequest(req)
      expect(input.sessionId).toBe('s2')
      expect(input.filename).toBe('sheet.csv')
      expect(input.mimeType).toBe('text/csv')
      expect(input.content).toBe('col1,col2\n1,2')
    })

    it('throws when no file field is present', async () => {
      const req = multipart([{ name: 'sessionId', value: 's2' }])
      await expect(parseUploadRequest(req)).rejects.toThrow(/file/i)
    })

    it('base64-encodes a binary file and sets encoding (#89)', async () => {
      const req = multipart([
        { name: 'sessionId', value: 's2' },
        { name: 'file', filename: 'doc.pdf', type: 'application/pdf', content: '%PDF-1.4 fake' },
      ])
      const input = await parseUploadRequest(req)
      expect(input.mimeType).toBe('application/pdf')
      expect(input.encoding).toBe('base64')
      expect(Buffer.from(input.content, 'base64').toString('utf8')).toBe('%PDF-1.4 fake')
    })
  })

  describe('isTextMime / binary JSON (#89)', () => {
    it('classifies text vs binary mimetypes', () => {
      expect(isTextMime('text/csv')).toBe(true)
      expect(isTextMime('application/json')).toBe(true)
      expect(isTextMime('application/ld+json')).toBe(true)
      expect(isTextMime('application/pdf')).toBe(false)
      expect(isTextMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false)
      expect(isTextMime('image/png')).toBe(false)
    })

    it('passes through encoding=base64 on the JSON path', async () => {
      const b64 = Buffer.from([1, 2, 3, 255]).toString('base64')
      const req = new Request('http://x/api/stash/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 's1',
          filename: 'x.bin',
          mimeType: 'application/octet-stream',
          content: b64,
          encoding: 'base64',
        }),
      })
      const input = await parseUploadRequest(req)
      expect(input.encoding).toBe('base64')
      expect(input.content).toBe(b64)
    })
  })
})
