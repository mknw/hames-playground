/**
 * Reading the roster back out of the graph.
 *
 * Three properties matter and none of them is obvious from the query text:
 * the read is READ-mode, it is ordered by an immutable key (because placeholder
 * numbering is roster-positional), and it selects no property that is not an
 * identity literal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

type Row = Record<string, unknown>
const queue: Row[][] = []
const sessionRun = vi.fn(async (..._args: unknown[]) => ({
  records: (queue.shift() ?? []).map((row) => ({ get: (k: string) => row[k] })),
}))
const sessionClose = vi.fn(async () => undefined)
const driverSession = vi.fn((_opts?: unknown) => ({ run: sessionRun, close: sessionClose }))
vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

const mod = () => import('../../../lib/org-graph/roster-source.server')

beforeEach(() => {
  vi.clearAllMocks()
  queue.length = 0
})

describe('loadDirectoryRoster', () => {
  it('returns displayName/mail pairs', async () => {
    const { loadDirectoryRoster } = await mod()
    queue.push([
      { displayName: 'Jan Van Damme', mail: 'jan@dtsc.test' },
      { displayName: 'Sofie Maes', mail: 'sofie@dtsc.test' },
    ])

    await expect(loadDirectoryRoster()).resolves.toEqual([
      { displayName: 'Jan Van Damme', mail: 'jan@dtsc.test' },
      { displayName: 'Sofie Maes', mail: 'sofie@dtsc.test' },
    ])
  })

  it('opens a READ-mode session and issues no write clause', async () => {
    const { loadDirectoryRoster } = await mod()
    queue.push([])
    await loadDirectoryRoster()

    expect(driverSession).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAccessMode: 'READ' }),
    )
    expect(String(sessionRun.mock.calls[0][0])).not.toMatch(
      /\b(CREATE|MERGE|SET|DELETE|REMOVE|DETACH)\b/i,
    )
  })

  it('orders by entraId, not by a mutable property', async () => {
    // buildTable numbers placeholders positionally, so an unordered read would
    // renumber the same directory on every call — and ordering on displayName
    // would renumber it whenever somebody married or changed a spelling.
    const { loadDirectoryRoster } = await mod()
    queue.push([])
    await loadDirectoryRoster()

    const cypher = String(sessionRun.mock.calls[0][0])
    expect(cypher).toContain('ORDER BY m.entraId')
    expect(cypher).not.toMatch(/ORDER BY m\.(displayName|mail)/)
  })

  it('selects only the two identity literals', async () => {
    const { loadDirectoryRoster } = await mod()
    queue.push([])
    await loadDirectoryRoster()

    const cypher = String(sessionRun.mock.calls[0][0])
    expect(cypher).not.toContain('department')
    expect(cypher).not.toContain('jobTitle')
  })

  it('skips members the ontology could not fully populate', async () => {
    const { loadDirectoryRoster } = await mod()
    queue.push([])
    await loadDirectoryRoster()
    expect(String(sessionRun.mock.calls[0][0])).toContain('m.displayName IS NOT NULL')
  })

  it('closes the session when the read throws', async () => {
    const { loadDirectoryRoster } = await mod()
    sessionRun.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(loadDirectoryRoster()).rejects.toThrow('neo4j down')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})
