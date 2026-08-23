/**
 * Tool repository (Neo4j-backed CodedTool store).
 *
 * The driver is mocked, so what is actually under test is the module's own
 * contract around Cypher: which parameters it binds, how it unwraps a record
 * into a `CodedTool`, what it does with an empty result set, how it coerces
 * Neo4j's Integer-like return values to booleans — and, in every case, that
 * the session is closed even when the query throws.
 *
 * #226 C3 pins: every CRUD operation requires an authenticated user and
 * scopes its query by `owner`, so an unauthenticated browser is rejected
 * before the driver is touched and user A's queries can never match user B's
 * nodes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sessionRun = vi.fn()
const sessionClose = vi.fn().mockResolvedValue(undefined)
const driverSession = vi.fn(() => ({ run: sessionRun, close: sessionClose }))

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

const getAuthenticatedUser = vi.fn(async () => ({ id: 'user-a' }))
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))

/** A driver record: `.get(field)` over a fixed map. */
const record = (fields: Record<string, unknown>) => ({
  get: (field: string) => fields[field],
})

const TOOL = {
  name: 'word-count',
  description: 'counts words',
  script: 'return input.split(" ").length',
  inputSchema: null,
  createdAt: '2026-08-16T00:00:00Z',
  updatedAt: null,
  usageCount: 3,
}

/** The single Cypher string passed to the most recent `session.run`. */
const lastCypher = () => String(sessionRun.mock.calls.at(-1)![0])
const lastParams = () => sessionRun.mock.calls.at(-1)![1]

beforeEach(() => {
  vi.clearAllMocks()
  sessionClose.mockResolvedValue(undefined)
  getAuthenticatedUser.mockResolvedValue({ id: 'user-a' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('auth gate (#226 C3)', () => {
  // The dev bypass is off here (vitest runs with DEV=true but no
  // VITE_DEV_BYPASS_AUTH), so every operation goes through
  // getAuthenticatedUser and an unauthenticated caller is rejected
  // before any driver session is opened.
  it('rejects an unauthenticated caller on every CRUD operation', async () => {
    getAuthenticatedUser.mockRejectedValue(
      new Error('Authentication required: No user found in session.'),
    )
    const repo = await import('../../../lib/tool-config/repository.server')

    await expect(repo.getCodedTools()).rejects.toThrow('Authentication required')
    await expect(repo.getCodedToolsForPlanner()).rejects.toThrow('Authentication required')
    await expect(repo.getCodedTool('x')).rejects.toThrow('Authentication required')
    await expect(repo.codedToolExists('x')).rejects.toThrow('Authentication required')
    await expect(repo.saveCodedTool({ name: 'n', description: 'd', script: 's' })).rejects.toThrow(
      'Authentication required',
    )
    await expect(repo.deleteCodedTool('x')).rejects.toThrow('Authentication required')

    expect(driverSession).not.toHaveBeenCalled()
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it("scopes by the CALLER's id — user B's queries can never match user A's nodes", async () => {
    getAuthenticatedUser.mockResolvedValue({ id: 'user-b' })
    const repo = await import('../../../lib/tool-config/repository.server')

    sessionRun.mockResolvedValueOnce({ records: [] })
    await repo.getCodedTools()
    expect(lastParams()).toEqual({ owner: 'user-b' })

    sessionRun.mockResolvedValueOnce({ records: [record({ deleted: 0 })] })
    await repo.deleteCodedTool('word-count')
    expect(lastCypher()).toContain('MATCH (t:CodedTool {owner: $owner, name: $name})')
    expect(lastParams()).toEqual({ owner: 'user-b', name: 'word-count' })
  })
})

describe('initializeToolRepository', () => {
  it('creates the owner+name index idempotently and closes the session', async () => {
    sessionRun.mockResolvedValueOnce({ records: [] })
    const { initializeToolRepository } = await import('../../../lib/tool-config/repository.server')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await initializeToolRepository()

    expect(lastCypher()).toContain('CREATE INDEX coded_tool_owner_name IF NOT EXISTS')
    expect(lastCypher()).toContain('(t.owner, t.name)')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('rethrows an index failure after closing the session', async () => {
    sessionRun.mockRejectedValueOnce(new Error('neo4j down'))
    const { initializeToolRepository } = await import('../../../lib/tool-config/repository.server')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(initializeToolRepository()).rejects.toThrow('neo4j down')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('saveCodedTool', () => {
  it('binds the tool fields plus the owner and returns the saved node', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ tool: TOOL })] })
    const { saveCodedTool } = await import('../../../lib/tool-config/repository.server')

    const saved = await saveCodedTool({
      name: 'word-count',
      description: 'counts words',
      script: 'return 1',
      inputSchema: '{"type":"object"}',
    })

    expect(saved).toEqual(TOOL)
    expect(lastCypher()).toContain('MERGE (t:CodedTool {owner: $owner, name: $name})')
    expect(lastParams()).toEqual({
      owner: 'user-a',
      name: 'word-count',
      description: 'counts words',
      script: 'return 1',
      inputSchema: '{"type":"object"}',
    })
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('binds a null inputSchema when none is supplied', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ tool: TOOL })] })
    const { saveCodedTool } = await import('../../../lib/tool-config/repository.server')

    await saveCodedTool({ name: 'n', description: 'd', script: 's' })

    expect((lastParams() as { inputSchema: unknown }).inputSchema).toBeNull()
  })

  it('throws when the MERGE returns no row', async () => {
    sessionRun.mockResolvedValueOnce({ records: [] })
    const { saveCodedTool } = await import('../../../lib/tool-config/repository.server')

    await expect(saveCodedTool({ name: 'n', description: 'd', script: 's' })).rejects.toThrow(
      'Failed to save coded tool',
    )
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('getCodedTools', () => {
  it('unwraps every record and preserves the query order', async () => {
    const second = { ...TOOL, name: 'other', usageCount: 1 }
    sessionRun.mockResolvedValueOnce({
      records: [record({ tool: TOOL }), record({ tool: second })],
    })
    const { getCodedTools } = await import('../../../lib/tool-config/repository.server')

    const tools = await getCodedTools()

    expect(tools.map((t) => t.name)).toEqual(['word-count', 'other'])
    expect(lastCypher()).toContain('MATCH (t:CodedTool {owner: $owner})')
    expect(lastCypher()).toContain('ORDER BY t.usageCount DESC')
  })

  it('returns an empty array when nothing is stored', async () => {
    sessionRun.mockResolvedValueOnce({ records: [] })
    const { getCodedTools } = await import('../../../lib/tool-config/repository.server')

    await expect(getCodedTools()).resolves.toEqual([])
  })
})

describe('getCodedToolsForPlanner', () => {
  it('projects to name/description only, owner-scoped, capped for prompt context', async () => {
    sessionRun.mockResolvedValueOnce({
      records: [record({ name: 'word-count', description: 'counts words' })],
    })
    const { getCodedToolsForPlanner } = await import('../../../lib/tool-config/repository.server')

    const refs = await getCodedToolsForPlanner()

    expect(refs).toEqual([{ name: 'word-count', description: 'counts words' }])
    expect(lastCypher()).toContain('MATCH (t:CodedTool {owner: $owner})')
    expect(lastCypher()).toContain('LIMIT 20')
  })
})

describe('getCodedTool', () => {
  it('returns the tool and bumps its usage count in the same query', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ tool: TOOL })] })
    const { getCodedTool } = await import('../../../lib/tool-config/repository.server')

    const tool = await getCodedTool('word-count')

    expect(tool).toEqual(TOOL)
    expect(lastParams()).toEqual({ owner: 'user-a', name: 'word-count' })
    expect(lastCypher()).toContain('SET t.usageCount = COALESCE(t.usageCount, 0) + 1')
  })

  it('returns null for an unknown name', async () => {
    sessionRun.mockResolvedValueOnce({ records: [] })
    const { getCodedTool } = await import('../../../lib/tool-config/repository.server')

    await expect(getCodedTool('missing')).resolves.toBeNull()
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('deleteCodedTool', () => {
  it('reports true when the driver returns a neo4j Integer > 0', async () => {
    sessionRun.mockResolvedValueOnce({
      records: [record({ deleted: { toNumber: () => 1 } })],
    })
    const { deleteCodedTool } = await import('../../../lib/tool-config/repository.server')

    await expect(deleteCodedTool('word-count')).resolves.toBe(true)
    expect(lastParams()).toEqual({ owner: 'user-a', name: 'word-count' })
  })

  it('reports false when the Integer count is zero (nothing matched)', async () => {
    sessionRun.mockResolvedValueOnce({
      records: [record({ deleted: { toNumber: () => 0 } })],
    })
    const { deleteCodedTool } = await import('../../../lib/tool-config/repository.server')

    await expect(deleteCodedTool('missing')).resolves.toBe(false)
  })

  it('handles a plain-number count (driver configured with disableLosslessIntegers)', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ deleted: 2 })] })
    const { deleteCodedTool } = await import('../../../lib/tool-config/repository.server')

    await expect(deleteCodedTool('word-count')).resolves.toBe(true)
  })
})

describe('codedToolExists', () => {
  it('passes the driver boolean straight through', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ exists: true })] })
    const { codedToolExists } = await import('../../../lib/tool-config/repository.server')

    await expect(codedToolExists('word-count')).resolves.toBe(true)

    sessionRun.mockResolvedValueOnce({ records: [record({ exists: false })] })
    await expect(codedToolExists('missing')).resolves.toBe(false)
    expect(lastParams()).toEqual({ owner: 'user-a', name: 'missing' })
  })

  it('closes the session even when the query throws', async () => {
    sessionRun.mockRejectedValueOnce(new Error('boom'))
    const { codedToolExists } = await import('../../../lib/tool-config/repository.server')

    await expect(codedToolExists('x')).rejects.toThrow('boom')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})
