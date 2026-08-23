/**
 * server-catalog — behaviour against the YAML config sources.
 *
 * The sibling `server-catalog.test.ts` runs against the repo's real committed
 * configs. This file mocks `node:fs` instead, so the config *content* is an
 * input to the test: missing files, an unparseable catalog, a server that is
 * catalogued but not enabled, a server that is enabled but not live, and the
 * master-catalog search preview. Each case re-imports the module (`resetModules`)
 * because the parsed catalogs are cached for the process lifetime.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const files = vi.hoisted(() => new Map<string, string>())

/** Counts reads per config file so the caching claims can be checked. */
const reads = vi.hoisted(() => new Map<string, number>())

const fsStub = vi.hoisted(() => ({
  existsSync: (p: string) => [...files.keys()].some((name) => String(p).endsWith(name)),
  readFileSync: (p: string) => {
    const hit = [...files.entries()].find(([name]) => String(p).endsWith(name))
    if (!hit) throw new Error(`ENOENT ${p}`)
    reads.set(hit[0], (reads.get(hit[0]) ?? 0) + 1)
    return hit[1]
  },
}))

vi.mock('node:fs', () => ({ ...fsStub, default: fsStub }))

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const listTools = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({ listTools }))

const CATALOG = `
name: kg-agent
registry:
  neo4j-cypher:
    title: Neo4j Cypher
    tools:
      - name: read_neo4j_cypher
      - name: write_neo4j_cypher
    secrets:
      - name: neo4j.password
  memory:
    title: Memory
    tools:
      - name: create_entities
  disabled-server:
    title: Never Enabled
    tools:
      - name: some_tool
`

const MCP_CONFIG = `
neo4j-cypher:
  enabled: true
memory:
  enabled: true
disabled-server:
  enabled: false
`

/** Fresh module instance with the given config files present on "disk". */
async function loadCatalogModule(contents: Record<string, string>) {
  files.clear()
  reads.clear()
  for (const [name, body] of Object.entries(contents)) files.set(name, body)
  vi.resetModules()
  return import('../../../lib/tool-config/server-catalog.server')
}

beforeEach(() => {
  listTools
    .mockReset()
    .mockResolvedValue([
      { name: 'read_neo4j_cypher' },
      { name: 'create_entities' },
      { name: 'code-mode' },
      { name: 'mcp-find' },
      { name: 'mcp-add' },
      { name: 'mcp-exec' },
    ])
})

describe('getServerCatalog — config sources', () => {
  it('lists only servers that are both catalogued and enabled', async () => {
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    const keys = (await getServerCatalog()).map((s) => s.key)

    expect(keys).toEqual(['memory', 'neo4j-cypher']) // sorted, disabled one dropped
  })

  it('flags secret-gated servers and carries the declared secret names', async () => {
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    const byKey = Object.fromEntries((await getServerCatalog()).map((s) => [s.key, s]))

    expect(byKey['neo4j-cypher'].secretGated).toBe(true)
    expect(byKey['neo4j-cypher'].secrets).toEqual(['neo4j.password'])
    expect(byKey['memory'].secretGated).toBe(false)
  })

  it('omits the gateway meta-tools from every server', async () => {
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    const allTools = (await getServerCatalog()).flatMap((s) => s.tools.map((t) => t.name))

    for (const meta of ['code-mode', 'mcp-find', 'mcp-add', 'mcp-exec']) {
      expect(allTools).not.toContain(meta)
    }
  })

  it('drops a meta-tool that a catalog server declares as its own', async () => {
    // The case above cannot see the skip at all: `assign()` sends the
    // meta-tools to inferred buckets ('code', 'mcp-find', …) that are not
    // catalog keys, so they fall out of the result whether the skip runs or
    // not. A *declared* meta-tool takes the highest-priority assignment path
    // straight into an enabled server, which is the only fixture in which the
    // skip is load-bearing.
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': `
registry:
  memory:
    title: Memory
    tools:
      - name: create_entities
      - name: code-mode
      - name: mcp-find
      - name: mcp-add
      - name: mcp-exec
`,
      'mcp-config.yaml': 'memory:\n  enabled: true\n',
    })

    const [memory] = await getServerCatalog()

    expect(memory.tools.map((t) => t.name)).toEqual(['create_entities'])
  })

  it('falls back to a server’s declared tools when the gateway is unreachable', async () => {
    listTools.mockRejectedValue(new Error('gateway down'))
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    const byKey = Object.fromEntries((await getServerCatalog()).map((s) => [s.key, s]))

    expect(byKey['neo4j-cypher'].tools.map((t) => t.name)).toEqual([
      'read_neo4j_cypher',
      'write_neo4j_cypher',
    ])
  })

  it('falls back to declared tools for an enabled server with no live tools', async () => {
    listTools.mockResolvedValue([{ name: 'read_neo4j_cypher' }])
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    const byKey = Object.fromEntries((await getServerCatalog()).map((s) => [s.key, s]))

    expect(byKey['memory'].tools.map((t) => t.name)).toEqual(['create_entities'])
  })

  it('returns nothing when no catalog file can be located', async () => {
    const { getServerCatalog } = await loadCatalogModule({ 'mcp-config.yaml': MCP_CONFIG })

    await expect(getServerCatalog()).resolves.toEqual([])
  })

  // sf-M4. The parse result is cached for the process lifetime, so one bad file
  // means an empty Tools panel until the next restart. Degrading is fine;
  // degrading without a word in the log is not.
  it('degrades to nothing when the catalog YAML is unparseable, and says so', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': 'registry:\n  - [unbalanced',
      'mcp-config.yaml': MCP_CONFIG,
    })

    await expect(getServerCatalog()).resolves.toEqual([])
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('custom-catalog.yaml could not be parsed'),
      expect.anything(),
    )
    // The consequence, not just the cause.
    expect(err.mock.calls[0][0]).toContain('rest of this process')
    err.mockRestore()
  })

  it('reports an unparseable mcp-config the same way (sf-M4)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getServerCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': 'neo4j-cypher:\n  - [unbalanced',
    })

    await expect(getServerCatalog()).resolves.toEqual([])
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('mcp-config.yaml could not be parsed'),
      expect.anything(),
    )
    err.mockRestore()
  })

  it('treats every server as disabled when mcp-config is missing', async () => {
    const { getServerCatalog } = await loadCatalogModule({ 'custom-catalog.yaml': CATALOG })

    await expect(getServerCatalog()).resolves.toEqual([])
  })

  it('skips non-object registry entries (top-level scalars like `name`)', async () => {
    const { getServerCatalog } = await loadCatalogModule({
      // No `registry:` key — the whole doc is treated as the registry, so the
      // `name` scalar must not become a server.
      'custom-catalog.yaml': 'name: kg-agent\nmemory:\n  title: Memory\n',
      'mcp-config.yaml': 'memory:\n  enabled: true\nname:\n  enabled: true\n',
    })

    expect((await getServerCatalog()).map((s) => s.key)).toEqual(['memory'])
  })
})

describe('serverForTool', () => {
  it('resolves a tool to the real gateway server name', async () => {
    const { serverForTool } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    await expect(serverForTool('read_neo4j_cypher')).resolves.toBe('neo4j-cypher')
    await expect(serverForTool('create_entities')).resolves.toBe('memory')
  })

  it('returns undefined for a tool no enabled server owns', async () => {
    const { serverForTool } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    await expect(serverForTool('some_tool')).resolves.toBeUndefined() // disabled server
    await expect(serverForTool('not_a_tool')).resolves.toBeUndefined()
  })
})

describe('searchMasterCatalog', () => {
  const MASTER = `
registry:
  slack:
    title: Slack
  slack-admin:
    title: Slack Admin
  memory:
    title: Memory
`

  it('matches master-catalog servers by substring, excluding enabled ones', async () => {
    const { searchMasterCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
      'catalog.yaml': MASTER,
    })

    // `memory` matches the query but is already enabled, so it is filtered out.
    await expect(searchMasterCatalog('m')).resolves.toEqual({
      matches: ['slack-admin'],
      total: 1,
    })
  })

  it('is case-insensitive and trims the query', async () => {
    const { searchMasterCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
      'catalog.yaml': MASTER,
    })

    await expect(searchMasterCatalog('  SLACK ')).resolves.toEqual({
      matches: ['slack', 'slack-admin'],
      total: 2,
    })
  })

  it('parses the ~1.3k-server master catalog once per process, not per search', async () => {
    const { searchMasterCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
      'catalog.yaml': MASTER,
    })

    await searchMasterCatalog('slack')
    const second = await searchMasterCatalog('slack')

    expect(reads.get('catalog.yaml')).toBe(1)
    expect(second.matches).toEqual(['slack', 'slack-admin'])
  })

  it('returns nothing for a blank query rather than the whole catalog', async () => {
    const { searchMasterCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
      'catalog.yaml': MASTER,
    })

    await expect(searchMasterCatalog('   ')).resolves.toEqual({ matches: [], total: 0 })
  })

  it('caps the preview at 20 matches while reporting the true total', async () => {
    const many = ['registry:']
      .concat(Array.from({ length: 25 }, (_, i) => `  srv-${i}:\n    title: S${i}`))
      .join('\n')
    const { searchMasterCatalog } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
      'catalog.yaml': many,
    })

    const res = await searchMasterCatalog('srv-')

    expect(res.total).toBe(25)
    expect(res.matches).toHaveLength(20)
  })

  it('finds nothing when the master catalog is absent or unparseable', async () => {
    const missing = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })
    await expect(missing.searchMasterCatalog('slack')).resolves.toEqual({
      matches: [],
      total: 0,
    })

    const broken = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
      'catalog.yaml': 'registry:\n  - [unbalanced',
    })
    await expect(broken.searchMasterCatalog('slack')).resolves.toEqual({
      matches: [],
      total: 0,
    })
  })
})

describe('getPresetTools', () => {
  it('expands only the preset servers, deduped', async () => {
    const { getPresetTools } = await loadCatalogModule({
      'custom-catalog.yaml': CATALOG,
      'mcp-config.yaml': MCP_CONFIG,
    })

    const preset = await getPresetTools()

    expect(preset).toContain('read_neo4j_cypher') // neo4j-cypher ∈ preset
    expect(preset).not.toContain('create_entities') // memory ∉ preset
    expect(new Set(preset).size).toBe(preset.length)
  })
})
