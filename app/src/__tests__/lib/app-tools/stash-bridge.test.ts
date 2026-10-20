import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
/**
 * The app's Data Stash bridge for `graph_file_ingest` (#420).
 *
 * The tool used to fire the index run and forget it, so an embedder that was
 * not running reached the server log and nothing else: the agent was told
 * `ingesting: true`, the person was told the file was copied, and neither
 * learned that it could not be searched. The bridge in `app-tools/index.server`
 * now reports how the run ENDED. Connectors replace recorded engine details
 * with fixed model-facing feedback; the panel keeps its recorded reason.
 *
 * Driven through the composed registry, so what is asserted is the bridge as
 * the shipped tool reaches it: Graph and the two stash modules are stubbed,
 * everything between them is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const graphFetch = vi.hoisted(() =>
  vi.fn(async (_userId: string, path: string) =>
    path.endsWith('/content')
      ? Buffer.from('quarterly notes').toString('base64')
      : { name: 'notes.md', file: { mimeType: 'text/markdown' }, size: 15, webUrl: null },
  ),
)

vi.mock('../../../lib/auth/graph-token.server', () => ({
  GraphAuthRequiredError: class GraphAuthRequiredError extends Error {},
  GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
  DEFAULT_GRAPH_SCOPES: ['User.Read'],
  graphFetch,
}))

const ingestStashDocument = vi.fn<(sessionId: string, docId: string) => Promise<unknown>>()
vi.mock('@hames-ai/harness-patterns/stash/document-ingest.server', () => ({
  ingestStashDocument: (sessionId: string, docId: string) => ingestStashDocument(sessionId, docId),
}))

const getDocument = vi.fn<(sessionId: string, docId: string) => Promise<unknown>>()
vi.mock('@hames-ai/harness-patterns/stash/document-store.server', () => ({
  MAX_CONTENT_BYTES: 5 * 1024 * 1024,
  storeDocument: async () => ({ id: 'doc-1', size: 15 }),
  getDocument: (sessionId: string, docId: string) => getDocument(sessionId, docId),
}))

import { runWithRequestContext } from '../../../lib/harness-client/request-user.server'
import { runAppTool } from '../../../lib/app-tools/index.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

const ingestWithoutFrame = () =>
  runWithRequestContext({ userId: 'oid-1', sessionId: 'sess-1' }, () =>
    runAppTool('graph_file_ingest', { item_id: '01ABC' }),
  )

const ingest = () => withRunFrame({ inference: { tier: 'self_deployed' } }, ingestWithoutFrame)

beforeEach(() => {
  vi.stubEnv('INFERENCE_TIERS', 'private')
  vi.stubEnv('EMBEDDINGS_PROVIDER', 'local')
  graphFetch.mockClear()
  ingestStashDocument.mockReset()
  getDocument.mockReset()
})

describe('graph_file_ingest through the app bridge (#420)', () => {
  it('reports a run that indexed as searchable, without re-reading the document', async () => {
    ingestStashDocument.mockResolvedValue({ docId: 'doc-1', chunks: 1 })

    const res = await ingest()

    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ ingesting: true, indexStatus: 'indexed' })
    expect(ingestStashDocument).toHaveBeenCalledWith('sess-1', 'doc-1')
    // The read-back is the failure path's alone.
    expect(getDocument).not.toHaveBeenCalled()
  })

  // Mutation: return `{ status: 'failed' }` without reading the document back
  // → `indexError` is the generic "no reason" and the chip's reason is lost.
  it('classifies a failed run without exposing the recorded engine reason', async () => {
    ingestStashDocument.mockResolvedValue(null)
    getDocument.mockResolvedValue({
      id: 'doc-1',
      ingestStatus: 'failed',
      ingestError:
        'Embedding request to local failed: fetch failed (is llama-server --embedding running at http://localhost:8090/v1?)',
    })

    const res = await ingest()

    // Stored — the copy worked, so this is not a failed tool call.
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({
      indexStatus: 'failed',
      indexError:
        'Document indexing failed; the copy is stored but not searchable. Tell the user; do not retry this turn.',
    })
  })

  // A run that failed but could not write its status (the store still says
  // 'pending', and holds no reason). The tool reports any non-indexed outcome
  // as failed on its own (`graph-file-ingest.test.ts`), so what this pins is
  // the bridge's half: it says the reason is missing rather than inventing one.
  it('classifies a failed run even when no reason was recorded', async () => {
    ingestStashDocument.mockResolvedValue(null)
    getDocument.mockResolvedValue({ id: 'doc-1', ingestStatus: 'pending' })

    const res = await ingest()

    expect(res.data).toMatchObject({
      indexStatus: 'failed',
      indexError:
        'Document indexing failed; the copy is stored but not searchable. Tell the user; do not retry this turn.',
    })
  })

  it('classifies failure when the document vanished before read-back', async () => {
    ingestStashDocument.mockResolvedValue(null)
    getDocument.mockResolvedValue(null)

    const res = await ingest()

    expect(res.data).toMatchObject({
      indexStatus: 'failed',
      indexError:
        'Document indexing failed; the copy is stored but not searchable. Tell the user; do not retry this turn.',
    })
  })
})

// P4 decision 3: these exercise the REAL host predicate via the registered tool.
// Mutations: raw tier !== 'anthropic'; activeInferenceTier() fallback; drop the
// privateInferenceOnly conjunction; drop the executor policy/embedding checks.
describe('P4 fail-closed ingestion policy', () => {
  it.each([undefined, {}, { tier: 'unknown-tier' }, { tier: 'anthropic' }])(
    'refuses raw inference slot %j, even with a private deployment default',
    async (inference) => {
      vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '1')
      const result =
        inference === undefined
          ? await ingestWithoutFrame()
          : await withRunFrame({ inference }, ingestWithoutFrame)
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('private inference on a private-only deployment'),
      })
      expect(graphFetch).not.toHaveBeenCalled()
      expect(ingestStashDocument).not.toHaveBeenCalled()
    },
  )

  it('allows exactly the private raw tier on a private-only deployment', async () => {
    ingestStashDocument.mockResolvedValue({ docId: 'doc-1', chunks: 1 })
    expect(await ingest()).toMatchObject({ success: true, data: { indexStatus: 'indexed' } })
    expect(graphFetch).toHaveBeenCalledTimes(2)
  })

  it('refuses ingestion on a deployment that allows Anthropic, even on a private run', async () => {
    vi.stubEnv('INFERENCE_TIERS', '')
    vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '1')
    expect(await ingest()).toMatchObject({
      success: false,
      error: expect.stringContaining('private inference on a private-only deployment'),
    })
    expect(graphFetch).not.toHaveBeenCalled()
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  it('refuses an external embedding service before Graph or stash I/O', async () => {
    vi.stubEnv('EMBEDDINGS_PROVIDER', 'openrouter')
    expect(await ingest()).toMatchObject({
      success: false,
      error: expect.stringContaining('external embedding service'),
    })
    expect(graphFetch).not.toHaveBeenCalled()
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })
})

it.each(['PRIVATE', 'private,anthropic', 'typo', 'anthropic'])(
  'classifies invalid deployment policy %s',
  async (setting) => {
    vi.stubEnv('INFERENCE_TIERS', setting)
    expect(await ingest()).toMatchObject({
      success: false,
      error: expect.stringContaining('configuration refusal'),
    })
    expect(graphFetch).not.toHaveBeenCalled()
  },
)

it('P4: only the app composition supplies the production ingest predicate', () => {
  const root = path.resolve(import.meta.dirname, '../../../../..')
  function suppliers(dir: string): string[] {
    return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      if (['node_modules', '__tests__', 'baml_client'].includes(entry.name)) return []
      const relative = path.join(dir, entry.name)
      if (entry.isDirectory()) return suppliers(relative)
      return relative.endsWith('.ts') &&
        /fileIngestAllowed\s*[:,]/.test(
          readFileSync(path.join(root, relative), 'utf8').replace(
            /fileIngestAllowed:\s*\(\)\s*=>\s*boolean/g,
            '',
          ),
        )
        ? [relative]
        : []
    })
  }
  expect([...suppliers('app/src'), ...suppliers('packages')]).toEqual([
    'app/src/lib/app-tools/index.server.ts',
  ])
})
