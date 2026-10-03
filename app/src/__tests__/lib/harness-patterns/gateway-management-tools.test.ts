// The composition root registers the harness client seam (tier policy, model
// tables); the planner adapter below runs through it as a production turn does.
import '../../../lib/inference/config.server'
/**
 * The Docker MCP gateway's own management tools never reach an agent (#412,
 * #420).
 *
 * With its `dynamic-tools` feature on, the gateway adds six tools of its own to
 * the catalog it lists: `mcp-find`, `mcp-add`, `mcp-remove`, `code-mode`,
 * `mcp-exec` and `mcp-config-set`. Both captured failures came from them: a
 * controller that "added" a server and then guessed tool names through
 * `mcp-exec`, and a planner that read `mcp-exec` as a shell.
 *
 * Two layers keep them out. `docker-config.json` turns the feature off at the
 * gateway (pinned in `compose-gateway-dynamic-tools.test.ts`). This file pins
 * the app-side layer: `listTools()`, the one door every gateway catalog read
 * goes through, drops them. So `Tools()` (every agent's `tools.all` and each
 * namespace, i.e. every loop's allowlist) and the adapters' description cache
 * (the planner's and the controllers' catalog) never see them, even when the
 * gateway does list them.
 *
 * Only the MCP SDK is mocked. `listTools`, `Tools`, the namespace catalog and
 * the planner adapter are the real modules, so removing the filter turns this
 * file red rather than a stub of it.
 *
 * Two things that must SURVIVE the filter, each with its own case: the in-VM
 * sandbox tools (`sandbox_*`, a scoped transport that never goes through the
 * gateway) and the gateway's `rust-mcp-filesystem` server, which is an
 * ordinary catalog server (the host-side `filesystem` namespace).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { SANDBOX_TOOL_PREFIX, V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockListTools = vi.fn()

class MockClient {
  connect = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  callTool = vi.fn()
  listTools = mockListTools
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const mockPlanner = vi.fn()
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: { Planner: (...args: unknown[]) => mockPlanner(...args) },
}))

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

/**
 * The six the live gateway registers (`docker compose logs mcp-gateway`:
 * "Adding internal tools (dynamic-tools feature enabled)"), written out here
 * rather than imported, so dropping one from the filter turns this red.
 */
const LIVE_MANAGEMENT_TOOLS = [
  'mcp-find',
  'mcp-add',
  'mcp-remove',
  'code-mode',
  'mcp-exec',
  'mcp-config-set',
]

/** The same feature's other tools at the pinned build: two need profiles, one
 *  needs an embeddings client, two are defined but unregistered, and
 *  `code-mode` names every script tool it builds `code-mode-<name>`. */
const OTHER_MANAGEMENT_TOOLS = [
  'mcp-create-profile',
  'mcp-activate-profile',
  'find-tools',
  'mcp-registry-import',
  'mcp-catalog',
  'code-mode-convert_docx',
]

const MANAGEMENT_TOOLS = [...LIVE_MANAGEMENT_TOOLS, ...OTHER_MANAGEMENT_TOOLS]

/** The gateway's `rust-mcp-filesystem` server, read from the catalog the
 *  gateway is started with, so this follows the catalog when it changes. */
const FILESYSTEM_TOOLS: string[] = (() => {
  const catalog = parseDocument(
    readFileSync(path.join(REPO, 'configs/custom-catalog.yaml'), 'utf8'),
  ).toJS() as { registry: Record<string, { tools: { name: string }[] }> }
  return catalog.registry['rust-mcp-filesystem'].tools.map((t) => t.name)
})()

/** The in-VM sandbox surface, as `V0_IN_VM_SERVERS` exposes it. */
const SANDBOX_TOOLS = V0_IN_VM_SERVERS.flatMap((s) => Object.values(s.tools))

/** Ordinary server tools from the other catalog servers. */
const SERVER_TOOLS = [
  'get_neo4j_schema',
  'read_neo4j_cypher',
  'write_neo4j_cypher',
  'fetch',
  'search',
  'resolve-library-id',
  'get-library-docs',
  'read_graph',
  'create_entities',
  ...FILESYSTEM_TOOLS,
]

/** What the gateway lists with the feature on: its management tools mixed in
 *  among the server tools, the way the live listing interleaves them. */
function gatewayListing(names: string[]) {
  return { tools: names.map((name) => ({ name, description: `${name} tool`, inputSchema: {} })) }
}

const WITH_MANAGEMENT = [
  ...SERVER_TOOLS.slice(0, 4),
  ...LIVE_MANAGEMENT_TOOLS,
  ...SERVER_TOOLS.slice(4),
  ...OTHER_MANAGEMENT_TOOLS,
]

beforeEach(() => {
  vi.clearAllMocks()
  mockListTools.mockResolvedValue(gatewayListing(WITH_MANAGEMENT))
  mockPlanner.mockResolvedValue({ reasoning: 'r', plan: '1. Query.', n_steps: 1 })
})

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('gateway management tools', () => {
  it('are dropped from listTools, and every server tool is kept in order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    const names = (await listTools()).map((t) => t.name)

    for (const name of MANAGEMENT_TOOLS) expect(names, name).not.toContain(name)
    expect(names).toEqual(SERVER_TOOLS)
  })

  it('are dropped on the pool-rebuild path as well', async () => {
    // `listTools` has a second success path: both attempts on the leased
    // connection fail, the pool is emptied, and one more read answers.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mockListTools
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockRejectedValueOnce(new Error('connection closed'))
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    const names = (await listTools()).map((t) => t.name)

    expect(mockListTools).toHaveBeenCalledTimes(3)
    expect(names).toEqual(SERVER_TOOLS)
  })

  it('reach no agent tool list: not tools.all, and not any namespace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Tools } = await import('@hames-ai/harness-patterns/tools.server')

    const tools = await Tools({ namespaces: mcpNamespace })

    // `tools.all` is what `general` hands its planner and its loop; a
    // namespace is what a routed agent hands one loop. Every one is checked.
    const lists = Object.entries(tools) as [string, string[]][]
    expect(lists.length).toBeGreaterThan(1)
    for (const [namespace, list] of lists) {
      for (const name of MANAGEMENT_TOOLS)
        expect(list, `${namespace} has ${name}`).not.toContain(name)
    }
    // The heuristic would have bucketed them under `mcp` and `code`.
    expect(tools).not.toHaveProperty('mcp')
    expect(tools).not.toHaveProperty('code')
  })

  it("are not in the planner's catalog, even when an allowlist names them", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Tools } = await import('@hames-ai/harness-patterns/tools.server')
    const { createPlannerAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')

    const tools = await Tools({ namespaces: mcpNamespace })
    // `general` builds its planner from `tools.all` (general.server.ts). The
    // second call names the tools outright: the catalog still has no entry
    // for them, so the planner cannot be shown one.
    const asGeneral = await createPlannerAdapter(tools.all)('convert my file', 'convert')
    const named = await createPlannerAdapter([...tools.all, ...MANAGEMENT_TOOLS])('m', 'i')

    for (const call of mockPlanner.mock.calls) {
      const shown = (call[2] as { name: string }[]).map((t) => t.name)
      for (const name of MANAGEMENT_TOOLS) expect(shown, name).not.toContain(name)
      expect(shown).toEqual(SERVER_TOOLS)
    }
    expect(asGeneral.toolCount).toBe(SERVER_TOOLS.length)
    expect(named.toolCount).toBe(SERVER_TOOLS.length)
  })

  it('leave the rust-mcp-filesystem server in place, as the filesystem namespace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Tools } = await import('@hames-ai/harness-patterns/tools.server')

    const tools = await Tools({ namespaces: mcpNamespace })

    expect(FILESYSTEM_TOOLS.length).toBeGreaterThan(0)
    expect(tools.filesystem).toEqual(FILESYSTEM_TOOLS)
    for (const name of FILESYSTEM_TOOLS) expect(tools.all).toContain(name)
  })

  it('leave every sandbox_* name alone, even one the gateway itself listed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(SANDBOX_TOOLS.length).toBeGreaterThan(0)
    for (const name of SANDBOX_TOOLS) expect(name.startsWith(SANDBOX_TOOL_PREFIX)).toBe(true)
    // The gateway never serves these. Listing them there anyway shows the
    // filter's own match does not reach them, whichever path they come by.
    mockListTools.mockResolvedValue(gatewayListing([...WITH_MANAGEMENT, ...SANDBOX_TOOLS]))
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    const names = (await listTools()).map((t) => t.name)

    expect(names).toEqual([...SERVER_TOOLS, ...SANDBOX_TOOLS])
  })

  it('leave the in-VM sandbox transport on the planner catalog beside the filtered gateway', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const { createPlannerAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')

    // The real path: `withSandbox` supplies the in-VM servers as a SCOPED
    // transport on the run frame, which `listTools` never reads.
    const sandbox = {
      id: 'sandbox:test',
      ownsTool: (name: string) => SANDBOX_TOOLS.includes(name),
      callTool: async () => ({ success: true, data: null }),
      listTools: async () =>
        SANDBOX_TOOLS.map((name) => ({ name, description: `${name} tool`, inputSchema: {} })),
    }

    await withRunFrame({ transports: [sandbox] }, () =>
      createPlannerAdapter([...SERVER_TOOLS, ...MANAGEMENT_TOOLS])('m', 'i'),
    )

    const shown = (mockPlanner.mock.calls[0][2] as { name: string }[]).map((t) => t.name)
    expect(shown).toEqual([...SANDBOX_TOOLS, ...SERVER_TOOLS])
  })

  it('warn once that the gateway-side switch is off, naming what was dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    await listTools()
    await listTools()

    const drops = warn.mock.calls.filter((c) => String(c[0]).includes('management tools'))
    expect(drops).toHaveLength(1)
    for (const name of MANAGEMENT_TOOLS) expect(drops[0][0]).toContain(name)
    expect(drops[0][0]).toContain('"dynamic-tools": "disabled"')
  })

  it('warn about nothing when the gateway lists none of them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockListTools.mockResolvedValue(gatewayListing(SERVER_TOOLS))
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    expect((await listTools()).map((t) => t.name)).toEqual(SERVER_TOOLS)
    expect(warn).not.toHaveBeenCalled()
  })
})
