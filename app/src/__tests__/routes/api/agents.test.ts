/**
 * POST /api/agents/:id — auth, validation, and the fire-and-forget contract.
 *
 * The harness run + persistence are mocked; this asserts the route's HTTP
 * behaviour (404/401/400/202), that it seeds the action row and kicks off the
 * background run, and that recording storage is best-effort (a failure there
 * still yields 202).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

type Trigger = {
  transcribedCommand: string
  shortDescription: string
  recordingDocId?: string
}

const getAgent = vi.fn<(id: string) => { id: string } | undefined>()
vi.mock('../../../lib/harness-client/registry.server', () => ({ getAgent }))

const resolveActionUser = vi.fn<(secret: string | null) => string | null>()
vi.mock('../../../lib/auth/action-tokens.server', () => ({
  resolveActionUser,
  // Real-ish bearer extraction so header parsing is exercised end to end.
  bearerSecret: (h: string | null) => {
    if (!h) return null
    const m = /^Bearer\s+(.+)$/i.exec(h.trim())
    return m ? m[1].trim() : null
  },
}))

const seedActionRow =
  vi.fn<(runId: string, userId: string, agentId: string, trigger: Trigger) => Promise<void>>(
    async () => {},
  )
const runAgentInBackground =
  vi.fn<(runId: string, userId: string, message: string, agentId: string, trigger: Trigger) => Promise<void>>(
    async () => {},
  )
vi.mock('../../../lib/harness-client/action-runner.server', () => ({
  seedActionRow,
  runAgentInBackground,
}))

const storeDocument =
  vi.fn<(input: { sessionId: string; filename: string; mimeType: string; content: string; encoding: string }) => Promise<{ id: string }>>(
    async () => ({ id: 'doc-1' }),
  )
vi.mock('../../../lib/document-store.server', () => ({ storeDocument }))

vi.mock('../../../lib/stash/upload-service.server', () => ({
  guessMimeType: (f: string) => (f.endsWith('.m4a') ? 'audio/mp4' : 'text/plain'),
}))

vi.mock('../../../lib/session-id', () => ({ newSessionId: () => 'run-fixed' }))

const { POST } = await import('../../../routes/api/agents/[id]')

const BOUNDARY = '----routeboundary'
function multipartRequest(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; type?: string; content: string }
  >,
  headers: Record<string, string> = {},
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
  return new Request('http://x/api/agents/default', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      ...headers,
    },
    body,
  })
}

// Minimal APIEvent shim — the route only touches params + request.
function evt(id: string, request: Request) {
  return { params: { id }, request } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  getAgent.mockReturnValue({ id: 'default' })
  resolveActionUser.mockReturnValue('user-1')
  storeDocument.mockResolvedValue({ id: 'doc-1' })
})

describe('POST /api/agents/:id', () => {
  it('404s an unknown agent before auth', async () => {
    getAgent.mockReturnValue(undefined)
    const res = await POST(evt('nope', multipartRequest([], { Authorization: 'Bearer s' })))
    expect(res.status).toBe(404)
    expect(resolveActionUser).not.toHaveBeenCalled()
  })

  it('401s a missing or unknown Bearer secret', async () => {
    resolveActionUser.mockReturnValue(null)
    const res = await POST(
      evt('default', multipartRequest([{ name: 'transcribed_command', value: 'hi' }])),
    )
    expect(res.status).toBe(401)
    expect(seedActionRow).not.toHaveBeenCalled()
  })

  it('400s when transcribed_command is missing', async () => {
    const res = await POST(
      evt(
        'default',
        multipartRequest([{ name: 'short_description', value: 'x' }], {
          Authorization: 'Bearer s',
        }),
      ),
    )
    expect(res.status).toBe(400)
    expect(seedActionRow).not.toHaveBeenCalled()
  })

  it('202s, stores the recording, seeds the row, and fires the run', async () => {
    const res = await POST(
      evt(
        'default',
        multipartRequest(
          [
            { name: 'transcribed_command', value: 'add a node' },
            { name: 'short_description', value: 'Apollo' },
            { name: 'original_recording', filename: 'memo.m4a', type: 'audio/mp4', content: 'BYTES' },
          ],
          { Authorization: 'Bearer s' },
        ),
      ),
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ run_id: 'run-fixed' })

    // Recording stored in the Data Stash under the run id, as base64 binary.
    expect(storeDocument).toHaveBeenCalledTimes(1)
    expect(storeDocument.mock.calls[0][0]).toMatchObject({
      sessionId: 'run-fixed',
      filename: 'memo.m4a',
      mimeType: 'audio/mp4',
      encoding: 'base64',
    })

    // Row seeded with the trigger provenance (incl. recording doc id).
    expect(seedActionRow).toHaveBeenCalledTimes(1)
    const [runId, userId, agentId, trigger] = seedActionRow.mock.calls[0]
    expect(runId).toBe('run-fixed')
    expect(userId).toBe('user-1')
    expect(agentId).toBe('default')
    expect(trigger).toMatchObject({
      transcribedCommand: 'add a node',
      shortDescription: 'Apollo',
      recordingDocId: 'doc-1',
    })

    // Background run kicked off with the command.
    expect(runAgentInBackground).toHaveBeenCalledTimes(1)
    expect(runAgentInBackground.mock.calls[0][2]).toBe('add a node')
  })

  it('still 202s when recording storage fails (best-effort provenance)', async () => {
    storeDocument.mockRejectedValue(new Error('redis down'))
    const res = await POST(
      evt(
        'default',
        multipartRequest(
          [
            { name: 'transcribed_command', value: 'cmd' },
            { name: 'original_recording', filename: 'memo.m4a', type: 'audio/mp4', content: 'B' },
          ],
          { Authorization: 'Bearer s' },
        ),
      ),
    )
    expect(res.status).toBe(202)
    // Row still seeded, but without a recording doc id.
    const trigger = seedActionRow.mock.calls[0][3]
    expect(trigger.recordingDocId).toBeUndefined()
    expect(runAgentInBackground).toHaveBeenCalledTimes(1)
  })

  it('works without a recording (text-only trigger)', async () => {
    const res = await POST(
      evt(
        'default',
        multipartRequest([{ name: 'transcribed_command', value: 'cmd' }], {
          Authorization: 'Bearer s',
        }),
      ),
    )
    expect(res.status).toBe(202)
    expect(storeDocument).not.toHaveBeenCalled()
    expect(seedActionRow).toHaveBeenCalledTimes(1)
  })
})
