/**
 * parseUploadRequest — intake parsing. Focus: the `agentId` field (client hint
 * that lets the auto-ingest gate resolve the harness before the session is
 * persisted) is parsed from both the multipart and JSON paths.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { parseUploadRequest } from '../../lib/stash/upload-service.server'

const jsonReq = (body: unknown) =>
  new Request('http://x/api/stash/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('parseUploadRequest — agentId', () => {
  it('JSON: parses agentId alongside the doc input', async () => {
    const out = await parseUploadRequest(
      jsonReq({ sessionId: 's1', filename: 'a.md', content: 'hi', agentId: 'retriever' }),
    )
    expect(out.sessionId).toBe('s1')
    expect(out.content).toBe('hi')
    expect(out.agentId).toBe('retriever')
  })

  it('JSON: omits agentId when absent or blank', async () => {
    expect((await parseUploadRequest(jsonReq({ sessionId: 's1', content: 'hi' }))).agentId).toBeUndefined()
    expect(
      (await parseUploadRequest(jsonReq({ sessionId: 's1', content: 'hi', agentId: '  ' }))).agentId,
    ).toBeUndefined()
  })

  it('multipart: parses agentId + file', async () => {
    const form = new FormData()
    form.set('sessionId', 's1')
    form.set('agentId', 'retriever')
    form.set('file', new Blob(['# Doc\n\nbody'], { type: 'text/markdown' }), 'a.md')
    const out = await parseUploadRequest(new Request('http://x/api/stash/upload', { method: 'POST', body: form }))
    expect(out.agentId).toBe('retriever')
    expect(out.sessionId).toBe('s1')
    expect(out.content).toContain('body')
  })
})
