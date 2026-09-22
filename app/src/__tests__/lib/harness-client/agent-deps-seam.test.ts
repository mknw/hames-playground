/**
 * The AgentDeps seam (#225 PR-2) — modeled on the runtime-config seam pin
 * (PR #342, `harness-patterns/runtime-config-seam.test.ts`).
 *
 * Before the extraction, the agent factories imported the app's catalog,
 * enricher, backend factory and sandbox wrapper DIRECTLY: one module graph, so
 * "the composition root's wiring reaches the factory" was true BY CONSTRUCTION
 * and needed no test. The move makes it true by RESOLUTION instead — the app
 * builds ONE `AgentDeps` bag (`agentDeps()` in `session.server.ts`), the
 * overlay in `registry.server.ts` wraps each moved definition's
 * `(sessionId, deps)` factory to supply it, and the package factory reads only
 * what it is handed. Those are the same values only as long as the overlay
 * passes THE composition root's bag; if a refactor ever makes the overlay
 * build a second, local bag — or a package factory silently fall back to a
 * default when a supplier is missing — every pattern still builds, the
 * capability it was wired with silently disappears, and NOTHING errors. The
 * same silent-loss class the runtime-config pin exists for.
 *
 * Mutation-checked (the dual-instance failure, verbatim):
 *   - building a SECOND bag inside the overlay (dropping the app's backend
 *     factory, keeping the catalog) leaves the rest of the unit suite green
 *     (4 479 passed) and turns the first two tests here RED;
 *   - dropping a supplier from the composition-root bag itself turns all
 *     three RED with the rest still green.
 * A package-side silent default is unreachable with a well-formed bag (the
 * factories read only what they are handed, and missing REQUIRED suppliers
 * throw loudly rather than degrade) — stated here so the pin's limits are on
 * the record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockFinalAction } from '../../mocks/baml'
import { mockCallTool, mockListTools } from '../../mocks/mcp'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const callToolMock = mockCallTool({
  responses: { get_neo4j_schema: { Concept: ['name'] } },
})

vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(['read_neo4j_cypher', 'get_neo4j_schema', 'search', 'fetch']),
}))

vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    Router: vi.fn(async () => ({ intent: 'x', needs_tool: false, route: 'user', response: '' })),
    LoopController: vi.fn(async () => mockFinalAction()),
    Synthesize: vi.fn(async () => 'ok'),
    RetrieveQuery: vi.fn(async () => 'q'),
  },
}))

// The app-side suppliers the real `agentDeps()` closes over, mocked one level
// out so the pin can observe them being HANDED to the package factory.
const createRedisBackend = vi.fn(() => ({
  name: 'redis',
  type: 'vector' as const,
  search: async () => [],
}))
// The config parameter is declared so `mock.calls[0][0]` is typed: the tenant
// assertion below reads the bag the adapter built, not just that it was called.
const withSandbox = vi.fn((_config: { tenantId?: unknown }) => (p: unknown) => p)
const enrichNeo4jResult = vi.fn()

vi.mock('@hames-ai/harness-patterns/retriever', () => ({ createRedisBackend }))
vi.mock('@hames-ai/sandbox', () => ({ withSandbox }))
vi.mock('../../../lib/harness-client/neo4j-enricher.server', () => ({ enrichNeo4jResult }))
vi.mock('../../../lib/db/conversations.server', () => ({
  loadConversation: vi.fn(),
  saveConversation: vi.fn(),
  deleteConversation: vi.fn(),
  deriveTitle: vi.fn(),
  updateConversationTitle: vi.fn(),
}))

// The REAL Tools, spied so the pin can read the resolver the factory handed
// it — the app's catalog FUNCTION IDENTITY, not just some resolver.
const toolsSpy = vi.spyOn(await import('@hames-ai/harness-patterns/tools.server'), 'Tools')

// The real overlay path: registry.server.ts registers the moved definitions,
// each wrapped to supply `agentDeps()`.
const { getAgent } = await import('../../../lib/harness-client/registry.server')
const { agentDeps } = await import('../../../lib/harness-client/session.server')
const { mcpNamespace } = await import('@hames-ai/connectors/mcp-catalog')

interface Pattern {
  name: string
  config: { patternId?: string }
  capabilities?: { retrievalBackends?: readonly string[] }
  children?: Pattern[]
}

function findPattern(patterns: Pattern[], patternId: string): Pattern | undefined {
  for (const p of patterns) {
    if (p.config.patternId === patternId) return p
    const hit = findPattern(p.children ?? [], patternId)
    if (hit) return hit
  }
  return undefined
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the bag the composition root supplies is the bag the moved factories read', () => {
  it('the app catalog reaches Tools() by identity, through the overlay', async () => {
    const agent = getAgent('retriever')
    expect(agent).toBeDefined()
    await agent!.createPatterns('seam-sess')

    // The resolver the factory passed is THE app's catalog function — not a
    // lookalike a second bag might have built.
    expect(toolsSpy).toHaveBeenCalledWith({ namespaces: mcpNamespace })
  })

  it('the app suppliers reach the factory — the registered wrapper closes over agentDeps()', async () => {
    const agent = getAgent('retriever')
    const patterns = (await agent!.createPatterns('seam-sess-2')) as unknown as Pattern[]

    // The backend in the built retriever pattern is the one the APP-side
    // factory produced — the whole reason the bag exists. The retriever
    // pattern declares the backends' names (not the objects) as a typed
    // capability for introspection, so the readout is the name list; the call
    // assertion above is the identity check.
    expect(createRedisBackend).toHaveBeenCalledWith('seam-sess-2')
    const retrieverPattern = findPattern(patterns, 'retriever')
    expect(retrieverPattern).toBeDefined()
    expect(retrieverPattern!.capabilities?.retrievalBackends).toEqual(['redis'])
  })

  it('the bag the entry points take is the same composition-root bag', () => {
    const bag = agentDeps()
    expect(bag.toolNamespaces).toBe(mcpNamespace)
    expect(bag.createRedisBackend).toBe(createRedisBackend)
    expect(bag.enrichNeo4jResult).toBe(enrichNeo4jResult)
    // `withSandbox` rides the app adapter (the narrowing onto the app's own
    // config type), so its identity is the adapter's — asserted by delegation:
    expect(typeof bag.withSandbox).toBe('function')
    bag.withSandbox!({ id: 'x' })(undefined as never)
    expect(withSandbox).toHaveBeenCalledWith(expect.objectContaining({ id: 'x' }))
  })

  // The agent-path tenant source (docs/plan/sandbox.md → "Tenant identity
  // seam"): Lane A shipped `WithSandboxConfig.tenantId` and left this producer
  // unwired, so until now every agent-path boot ran on the 'default' tenant —
  // i.e. on the SHARED /cache volume that #348 is about.
  it('supplies the tenant as a RESOLVER, read per run from the request scope', async () => {
    const { runWithRequestContext } =
      await import('../../../lib/harness-client/request-user.server')
    const bag = agentDeps()
    bag.withSandbox!({ id: 'x', sessionId: 's' })(undefined as never)
    const config = withSandbox.mock.calls[0][0]

    // A function, not a string. A string would be read at pattern-BUILD time
    // and frozen onto a conversation whose patterns are cached for its life.
    expect(typeof config.tenantId).toBe('function')
    const resolve = config.tenantId as () => string | undefined

    // Outside a request there is no user, which the package turns into the
    // verbatim-name 'default' tenant.
    expect(resolve()).toBeUndefined()
    // Inside one it is the authenticated owner, every time it is asked.
    await runWithRequestContext({ userId: 'owner-1', sessionId: 's' }, async () => {
      expect(resolve()).toBe('owner-1')
    })
    await runWithRequestContext({ userId: 'owner-2', sessionId: 's' }, async () => {
      expect(resolve()).toBe('owner-2')
    })
  })
})
