/** Layer 1: real promotion/store/ingest/retrieval/reference plumbing; fake wires. */
import '../../../mocks/namespace-catalog'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createContext,
  createEventView,
  createScope,
  retriever,
  simpleLoop,
  withReferences,
  withRunFrame,
  withInjectionGuard,
  type ControllerFn,
  type ToolResultEventData,
} from '@hames-ai/harness-patterns'
import {
  storeDocument,
  getDocument,
  listDocuments,
  setDocumentFlags,
  type CallTool,
} from '@hames-ai/harness-patterns/stash/document-store.server'
import { decodeMeta } from '@hames-ai/harness-patterns/stash/vector-store.server'
import {
  ingestStashDocument,
  searchDocuments,
} from '@hames-ai/harness-patterns/stash/document-ingest.server'
import { createRedisBackend } from '@hames-ai/harness-patterns/retriever/redis-backend.server'
import {
  configureWorkspaceStore,
  __resetWorkspaceStoreForTests,
} from '@hames-ai/sandbox/workspace-store'
import { promoteOutputs } from '@hames-ai/sandbox/work-artifacts.server'
import type { McpTransport } from '@hames-ai/sandbox/types'
import { withInfoDocumentReferences } from '@hames-ai/agents/agents/info-document-references.server'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import type { SelectorFn } from '@hames-ai/harness-patterns/types'
import type { AgentDeps } from '@hames-ai/agents'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
const composed = vi.hoisted(() => ({
  routes: {} as Record<
    string,
    { pattern: import('@hames-ai/harness-patterns').ConfiguredPattern<Record<string, unknown>> }
  >,
  controller: vi.fn<ControllerFn>(),
}))
vi.mock('@hames-ai/harness-patterns', async (original) => {
  const actual = await original<typeof import('@hames-ai/harness-patterns')>()
  return {
    ...actual,
    Tools: async () => ({
      all: ['graph_me', 'search', 'read_neo4j_cypher'],
      graph: ['graph_me'],
      web: ['search'],
      neo4j: ['read_neo4j_cypher'],
    }),
    callTool: async () => ({ success: true, data: {} }),
    decisionLoop: (...args: Parameters<typeof actual.decisionLoop>) => {
      composed.routes = args[0]
      return actual.decisionLoop(...args)
    },
  }
})
vi.mock('@hames-ai/harness-baml', () => ({
  bamlPatterns: () => ({
    selector: vi.fn(),
    planner: () => vi.fn(),
    synthesize: vi.fn(),
    retrieveQuery: vi.fn(),
  }),
  createLoopControllerAdapter: () => composed.controller,
  createActorControllerAdapter: () => vi.fn(),
  createCriticAdapter: () => vi.fn(),
  createDecideAdapter: () => vi.fn(),
  createInjectionScreen: () => vi.fn(),
}))
import { generalNextAgent } from '@hames-ai/agents/agents/general-next.server'

async function corpus() {
  const json = new Map<string, unknown>()
  const hashes = new Map<string, Record<string, unknown>>()
  const ids = new Set<string>()
  const callTool: CallTool = async (name, args) => {
    let data: unknown = 'OK'
    switch (name) {
      case 'json_set':
        json.set(String(args.name), JSON.parse(String(args.value)))
        break
      case 'json_get':
        data = [json.get(String(args.name)) ?? null]
        break
      case 'sadd':
        ids.add(String(args.value))
        break
      case 'smembers':
        data = [...ids]
        break
      case 'create_vector_index_hash':
        break
      case 'set_vector_in_hash':
        hashes.set(String(args.name), {})
        break
      case 'hset':
        hashes.get(String(args.name))![String(args.key)] = args.value
        break
      case 'vector_search_hash':
        data = [...hashes.values()].map((h) => ({ ...h, score: 0.1 }))
        break
      default:
        throw new Error(`Unexpected Redis call: ${name}`)
    }
    return { success: true, data }
  }
  configureWorkspaceStore({
    list: (s) => listDocuments(s, callTool),
    get: (s, id) => getDocument(s, id, callTool),
    store: (input) => storeDocument(input, callTool),
    guessMimeType: () => 'text/plain',
    isTextMime: () => true,
  })
  const secret = 'PROMOTED-PRIVATE-BODY'
  const transport = {
    callTool: async (name: string) => ({
      success: true,
      data:
        name === 'sandbox_bash'
          ? {
              stdout: `${createHash('sha256').update(secret).digest('hex')}  ./nested/any-name.txt`,
              stderr: '',
              exit_code: 0,
            }
          : secret,
    }),
  } as unknown as McpTransport
  expect(await promoteOutputs(transport, 's', new Map())).toEqual({
    promoted: ['any-name.txt'],
    skipped: [],
  })
  const metas = await listDocuments('s', callTool)
  const promoted = (await getDocument('s', metas[0].id, callTool))!
  expect(promoted.provenance).toBe('sandbox-output')
  expect(metas[0].provenance).toBe('sandbox-output')
  // Same filename is intentionally used for both origins.
  const upload = await storeDocument(
    {
      sessionId: 's',
      id: 'upload',
      filename: 'any-name.txt',
      mimeType: 'text/plain',
      content: 'UPLOADED-PUBLIC-BODY',
    },
    callTool,
  )
  expect(upload.provenance).toBeUndefined()
  const embedFn = async (texts: string[]) => ({
    provider: 'local' as const,
    model: 'fake',
    dimensions: 2,
    vectors: texts.map(() => [1, 2]),
  })
  for (const id of [promoted.id, upload.id])
    expect(await ingestStashDocument('s', id, { callTool, embedFn })).not.toBeNull()
  expect((await setDocumentFlags('s', promoted.id, { hidden: false }, callTool))?.provenance).toBe(
    'sandbox-output',
  )
  expect(
    [...hashes.values()].map((h) => decodeMeta(h.meta)).find((h) => h.doc_id === promoted.id)
      ?.provenance,
  ).toBe('sandbox-output')
  const backend = createRedisBackend('s', {
    ensureIngested: false,
    searchFn: (session, query, opts) =>
      searchDocuments(session, query, {
        ...opts,
        callTool,
        embedOneFn: async () => ({
          provider: 'local',
          model: 'fake',
          dimensions: 2,
          vector: [1, 2],
        }),
      }),
  })
  const hits = await backend.search({ text: 'question' }, { k: 5 })
  expect(hits.find((h) => h.docId === promoted.id)?.provenance).toBe('sandbox-output')
  expect(hits.find((h) => h.docId === upload.id)?.provenance).toBeUndefined()
  return { backend, promoted }
}
afterEach(() => __resetWorkspaceStoreForTests())

describe('R1 flow 4', () => {
  it.each([false, true])(
    'filters previews and full expansion, later turn=%s',
    async (laterTurn) => {
      const { backend, promoted } = await corpus()
      const ctx = createContext('find the documents', {})
      const retrieval = retriever({
        backends: [backend],
        rewrite: async () => ({ value: '' }),
        patternId: 'retriever',
      })
      if (laterTurn) {
        const earlier = await withRunFrame({}, () =>
          retrieval.fn(createScope('retriever', {}), createEventView(ctx)),
        )
        ctx.events.push(...earlier.events)
        ctx.events.push({
          id: 'next-user',
          type: 'user_message',
          patternId: 'user',
          ts: Math.max(...ctx.events.map((event) => event.ts)) + 1,
          data: { content: 'follow up' },
        })
      }
      const retrieved = await withRunFrame({}, () =>
        withInjectionGuard({ tools: ['retriever'], spotlight: 'always' })(retrieval).fn(
          createScope('retriever', {}),
          createEventView(ctx),
        ),
      )
      expect(JSON.stringify(retrieved)).toContain('PROMOTED-PRIVATE-BODY')
      expect(JSON.stringify(retrieved)).toContain('sandbox-output')
      const event = retrieved.events.find((e) => e.type === 'tool_result')!
      ;(event.data as ToolResultEventData).summary = 'PROMOTED-PRIVATE-BODY'
      ctx.events.push(...retrieved.events)
      const controller = composed.controller
        .mockReset()
        .mockResolvedValueOnce({
          action: {
            reasoning: 'read reference',
            tool_name: 'expandPreviousResult',
            tool_args: `ref:${event.id}`,
            is_final: false,
          },
        })
        .mockResolvedValueOnce({
          action: { reasoning: 'done', tool_name: 'Return', tool_args: 'done', is_final: true },
        })
      await generalNextAgent.createPatterns('s', {
        toolNamespaces: mcpNamespace,
        withSandbox: () => (pattern) => pattern,
        createRedisBackend: () => backend,
      } satisfies AgentDeps)
      const info = composed.routes['info-retrieval'].pattern
      const result = await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
        info.fn(createScope('info', {}), createEventView(ctx, { fromLast: false })),
      )
      expect(result.events.filter((e) => e.type === 'error')).toEqual([])
      const prompts = JSON.stringify(controller.mock.calls)
      expect(prompts).not.toContain('PROMOTED-PRIVATE-BODY')
      expect(prompts).not.toContain(promoted.id)
      expect(prompts).toContain('UPLOADED-PUBLIC-BODY')
      expect(prompts).toContain(laterTurn ? 'follow up' : 'find the documents')
      const expanded = result.events.find(
        (e) =>
          e.type === 'tool_result' &&
          (e.data as ToolResultEventData).tool === 'expandPreviousResult',
      )!
      expect(expanded.data).toMatchObject({ success: true })
      expect(JSON.stringify(expanded.data)).toContain('UPLOADED-PUBLIC-BODY')
      expect(JSON.stringify(expanded.data)).not.toContain('PROMOTED-PRIVATE-BODY')
      expect(
        JSON.stringify(result.events.filter((e) => e.type === 'reference_attached')),
      ).not.toContain('PROMOTED-PRIVATE-BODY')
      expect(JSON.stringify(event.data)).toContain('PROMOTED-PRIVATE-BODY')
    },
  )
  it('keeps promoted references excluded when the real private host rewrites their tag value', async () => {
    const { createWebPseudonymiser } =
      await import('../../../../lib/harness-client/web-pseudonymiser.server')
    const { shapeMessages } = await import('@hames-ai/connectors/graph/graph-tools.server')
    const pseudonymiseForWeb = createWebPseudonymiser({ directory: 'none' })
    const identity = shapeMessages({
      value: [
        {
          from: {
            emailAddress: { name: 'Sandbox Output', address: 'sandbox.output@outside.test' },
          },
        },
      ],
    })
    const filter = await pseudonymiseForWeb([identity], 'find documents')
    expect(filter.redact(filter.apply({ provenance: 'sandbox-output' })).provenance).not.toBe(
      'sandbox-output',
    )
    const { backend } = await corpus()
    const ctx = createContext('find documents', {})
    const retrieval = retriever({
      backends: [backend],
      rewrite: async () => ({ value: '' }),
      patternId: 'retriever',
    })
    const retrieved = await withRunFrame({}, () =>
      retrieval.fn(createScope('retriever', {}), createEventView(ctx)),
    )
    const event = retrieved.events.find((e) => e.type === 'tool_result')!
    ctx.events.push(...retrieved.events, {
      id: 'identity',
      type: 'tool_result',
      patternId: 'doc',
      ts: Date.now(),
      data: { tool: 'graph_mail_recent', success: true, result: identity },
    })
    const controller = composed.controller
      .mockReset()
      .mockResolvedValueOnce({
        action: {
          reasoning: 'expand',
          tool_name: 'expandPreviousResult',
          tool_args: `ref:${event.id}`,
          is_final: false,
        },
      })
      .mockResolvedValueOnce({
        action: { reasoning: 'done', tool_name: 'Return', tool_args: 'done', is_final: true },
      })
    await generalNextAgent.createPatterns('s', {
      toolNamespaces: mcpNamespace,
      withSandbox: () => (pattern) => pattern,
      createRedisBackend: () => backend,
      pseudonymiseForWeb,
    } satisfies AgentDeps)
    const result = await withRunFrame({ inference: { tier: 'self_deployed' } }, () =>
      composed.routes['info-retrieval'].pattern.fn(
        createScope('info', {}),
        createEventView(ctx, { fromLast: false }),
      ),
    )
    expect(result.events.filter((e) => e.type === 'error')).toEqual([])
    expect(JSON.stringify(controller.mock.calls)).toContain('UPLOADED-PUBLIC-BODY')
    expect(JSON.stringify(controller.mock.calls)).not.toContain('PROMOTED-PRIVATE-BODY')
  })

  it('removes all-promoted candidates and refuses explicit expansion', async () => {
    const { backend } = await corpus()
    const hits = await backend.search({ text: 'question' }, { k: 5 })
    const ctx = createContext('question', {})
    const retrieval = retriever({
      backends: [{ ...backend, search: async () => hits.filter((h) => h.provenance) }],
      rewrite: async () => ({ value: '' }),
      patternId: 'retriever',
    })
    const retrieved = await withRunFrame({}, () =>
      withInjectionGuard({ tools: ['retriever'], spotlight: 'always' })(retrieval).fn(
        createScope('retriever', {}),
        createEventView(ctx),
      ),
    )
    ctx.events.push(...retrieved.events)
    const event = retrieved.events.find((e) => e.type === 'tool_result')!
    const controller = composed.controller
      .mockReset()
      .mockResolvedValueOnce({
        action: {
          reasoning: 'try excluded id',
          tool_name: 'expandPreviousResult',
          tool_args: `ref:${event.id}`,
          is_final: false,
        },
      })
      .mockResolvedValueOnce({
        action: { reasoning: 'done', tool_name: 'Return', tool_args: 'done', is_final: true },
      })
    const selector = vi.fn<SelectorFn>()
    const info = withInfoDocumentReferences(
      withReferences(simpleLoop(controller, [], { patternId: 'info', rememberPriorTurns: false }), {
        selector,
        source: ['retriever'],
        patternId: 'info',
        viewConfig: { fromLast: false },
      }),
    )
    const result = await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
      info.fn(createScope('info', {}), createEventView(ctx, { fromLast: false })),
    )
    expect(result.events.filter((e) => e.type === 'error')).toEqual([])
    expect(selector).not.toHaveBeenCalled()
    expect(controller.mock.calls[0][0].priorResults ?? []).toEqual([])
    const expanded = result.events.find(
      (e) =>
        e.type === 'tool_result' && (e.data as ToolResultEventData).tool === 'expandPreviousResult',
    )!
    expect(expanded.data).toMatchObject({ success: false })
    expect(JSON.stringify(controller.mock.calls)).not.toContain('PROMOTED-PRIVATE-BODY')
  })
})
