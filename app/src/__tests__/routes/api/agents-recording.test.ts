/**
 * POST /api/agents/:id — the recording half of the trigger (#106).
 *
 * `agents.test.ts` drives the same route over a real multipart body; these
 * cases hand the route a pre-parsed FormData instead, because undici's
 * multipart parser trips over jsdom's Blob/File globals under this test
 * environment and every file-carrying case would 400 for reasons that have
 * nothing to do with the route. Same public surface, no parser in the way:
 * what a file part turns into in the Data Stash, and how a nameless or
 * type-less blob is labelled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const getAgent = vi.fn<(id: string) => { id: string } | undefined>()
vi.mock('../../../lib/harness-client/registry.server', () => ({ getAgent }))

vi.mock('../../../lib/auth/action-tokens.server', () => ({
  resolveActionUser: () => 'user-1',
  bearerSecret: () => 'secret',
}))

const seedActionRow = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
const runAgentInBackground = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('../../../lib/harness-client/action-runner.server', () => ({
  seedActionRow,
  runAgentInBackground,
}))

const storeDocument = vi.fn<(input: Record<string, unknown>) => Promise<{ id: string }>>()
vi.mock('../../../lib/document-store.server', () => ({ storeDocument }))

vi.mock('../../../lib/stash/upload-service.server', () => ({
  guessMimeType: (f: string) => (f.endsWith('.m4a') ? 'audio/mp4' : 'application/octet-stream'),
}))

vi.mock('../../../lib/session-id', () => ({ newSessionId: () => 'run-fixed' }))

const { POST } = await import('../../../routes/api/agents/[id]')

/** A blob part the route can read, independent of any multipart parser. */
function filePart(content: string, name: string, type: string) {
  return {
    name,
    type,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  }
}

/** APIEvent shim whose request hands back an already-parsed form. */
function evt(fields: Record<string, unknown>, id = 'default') {
  const form = new Map(Object.entries(fields))
  return {
    params: { id },
    request: {
      headers: new Headers({ authorization: 'Bearer secret' }),
      formData: async () => ({ get: (k: string) => form.get(k) ?? null }),
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  getAgent.mockReturnValue({ id: 'default' })
  storeDocument.mockResolvedValue({ id: 'doc-1' })
})

describe('POST /api/agents/:id — recording provenance', () => {
  it('stores the recording as base64 under the run id and links it to the row', async () => {
    const res = await POST(
      evt({
        transcribed_command: '  add a node  ',
        short_description: ' Apollo ',
        original_recording: filePart('BYTES', 'memo.m4a', 'audio/mp4'),
      }),
    )

    expect(res.status).toBe(202)
    // `recording_stored` reports the audio's fate to the caller — a device that
    // may be about to delete its own copy (sf-L9).
    expect(await res.json()).toEqual({ run_id: 'run-fixed', recording_stored: true })
    expect(storeDocument).toHaveBeenCalledWith({
      sessionId: 'run-fixed',
      filename: 'memo.m4a',
      mimeType: 'audio/mp4',
      content: Buffer.from('BYTES').toString('base64'),
      encoding: 'base64',
    })
    expect(seedActionRow.mock.calls[0][3]).toEqual({
      // Whitespace is trimmed off both text fields.
      transcribedCommand: 'add a node',
      shortDescription: 'Apollo',
      recordingDocId: 'doc-1',
      recordingFilename: 'memo.m4a',
      recordingMimeType: 'audio/mp4',
    })
    // The run is kicked off with the same trigger, and never awaited.
    expect(runAgentInBackground.mock.calls[0].slice(0, 4)).toEqual([
      'run-fixed',
      'user-1',
      'add a node',
      'default',
    ])
  })

  it('falls back to a generic name and a guessed type for an unlabelled blob', async () => {
    await POST(
      evt({
        transcribed_command: 'cmd',
        original_recording: filePart('B', '', ''),
      }),
    )
    expect(storeDocument.mock.calls[0][0]).toMatchObject({
      filename: 'recording',
      mimeType: 'application/octet-stream',
    })
  })

  it('still 202s when the Data Stash write fails — provenance is best-effort', async () => {
    storeDocument.mockRejectedValue(new Error('redis down'))
    const res = await POST(
      evt({
        transcribed_command: 'cmd',
        original_recording: filePart('B', 'memo.m4a', 'audio/mp4'),
      }),
    )

    expect(res.status).toBe(202)
    expect(seedActionRow.mock.calls[0][3]).toEqual({
      transcribedCommand: 'cmd',
      shortDescription: '',
    })
    expect(runAgentInBackground).toHaveBeenCalledTimes(1)
  })

  it('ignores a text field sent under the recording name', async () => {
    await POST(evt({ transcribed_command: 'cmd', original_recording: 'not-a-file' }))
    expect(storeDocument).not.toHaveBeenCalled()
    expect(seedActionRow.mock.calls[0][3]).toEqual({
      transcribedCommand: 'cmd',
      shortDescription: '',
    })
  })

  it('500s without starting a run when the action row cannot be seeded', async () => {
    seedActionRow.mockRejectedValue(new Error('postgres down'))
    const res = await POST(evt({ transcribed_command: 'cmd' }))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create action' })
    expect(runAgentInBackground).not.toHaveBeenCalled()
  })
})
