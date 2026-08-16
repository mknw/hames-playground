/**
 * Tool repository (Neo4j-backed CodedTool store).
 *
 * The driver is mocked, so what is actually under test is the module's own
 * contract around Cypher: which parameters it binds, how it unwraps a record
 * into a `CodedTool`, what it does with an empty result set, how it coerces
 * Neo4j's Integer-like return values to booleans — and, in every case, that
 * the session is closed even when the query throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sessionRun = vi.fn()
const sessionClose = vi.fn().mockResolvedValue(undefined)
const driverSession = vi.fn(() => ({ run: sessionRun, close: sessionClose }))

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
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
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('initializeToolRepository', () => {
  it('creates the name index idempotently and closes the session', async () => {
    sessionRun.mockResolvedValueOnce({ records: [] })
    const { initializeToolRepository } = await import('../../../lib/tool-config/repository.server')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await initializeToolRepository()

    expect(lastCypher()).toContain('CREATE INDEX coded_tool_name IF NOT EXISTS')
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
  it('binds the tool fields and returns the saved node', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ tool: TOOL })] })
    const { saveCodedTool } = await import('../../../lib/tool-config/repository.server')

    const saved = await saveCodedTool({
      name: 'word-count',
      description: 'counts words',
      script: 'return 1',
      inputSchema: '{"type":"object"}',
    })

    expect(saved).toEqual(TOOL)
    expect(lastCypher()).toContain('MERGE (t:CodedTool {name: $name})')
    expect(lastParams()).toEqual({
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
    expect(lastCypher()).toContain('ORDER BY t.usageCount DESC')
  })

  it('returns an empty array when nothing is stored', async () => {
    sessionRun.mockResolvedValueOnce({ records: [] })
    const { getCodedTools } = await import('../../../lib/tool-config/repository.server')

    await expect(getCodedTools()).resolves.toEqual([])
  })
})

describe('getCodedToolsForPlanner', () => {
  it('projects to name/description only, capped for prompt context', async () => {
    sessionRun.mockResolvedValueOnce({
      records: [record({ name: 'word-count', description: 'counts words' })],
    })
    const { getCodedToolsForPlanner } = await import('../../../lib/tool-config/repository.server')

    const refs = await getCodedToolsForPlanner()

    expect(refs).toEqual([{ name: 'word-count', description: 'counts words' }])
    expect(lastCypher()).toContain('LIMIT 20')
  })
})

describe('getCodedTool', () => {
  it('returns the tool and bumps its usage count in the same query', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ tool: TOOL })] })
    const { getCodedTool } = await import('../../../lib/tool-config/repository.server')

    const tool = await getCodedTool('word-count')

    expect(tool).toEqual(TOOL)
    expect(lastParams()).toEqual({ name: 'word-count' })
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
    expect(lastParams()).toEqual({ name: 'word-count' })
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
  })

  it('closes the session even when the query throws', async () => {
    sessionRun.mockRejectedValueOnce(new Error('boom'))
    const { codedToolExists } = await import('../../../lib/tool-config/repository.server')

    await expect(codedToolExists('x')).rejects.toThrow('boom')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('server-function wrappers', () => {
  it('fetchCodedTools delegates to getCodedTools', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ tool: TOOL })] })
    const { fetchCodedTools } = await import('../../../lib/tool-config/repository.server')

    await expect(fetchCodedTools()).resolves.toEqual([TOOL])
    expect(lastCypher()).toContain('MATCH (t:CodedTool)')
  })

  it('fetchCodedToolsForPlanner delegates to the planner projection', async () => {
    sessionRun.mockResolvedValueOnce({
      records: [record({ name: 'n', description: 'd' })],
    })
    const { fetchCodedToolsForPlanner } = await import('../../../lib/tool-config/repository.server')

    await expect(fetchCodedToolsForPlanner()).resolves.toEqual([{ name: 'n', description: 'd' }])
    expect(lastCypher()).toContain('LIMIT 20')
  })

  it('saveCodedToolServer delegates to saveCodedTool', async () => {
    sessionRun.mockResolvedValueOnce({ records: [record({ tool: TOOL })] })
    const { saveCodedToolServer } = await import('../../../lib/tool-config/repository.server')

    await expect(
      saveCodedToolServer({ name: 'word-count', description: 'counts words', script: 's' }),
    ).resolves.toEqual(TOOL)
    expect(lastCypher()).toContain('MERGE (t:CodedTool {name: $name})')
  })

  it('deleteCodedToolServer delegates to deleteCodedTool', async () => {
    sessionRun.mockResolvedValueOnce({
      records: [record({ deleted: { toNumber: () => 1 } })],
    })
    const { deleteCodedToolServer } = await import('../../../lib/tool-config/repository.server')

    await expect(deleteCodedToolServer('word-count')).resolves.toBe(true)
    expect(lastCypher()).toContain('DELETE t')
  })
})
