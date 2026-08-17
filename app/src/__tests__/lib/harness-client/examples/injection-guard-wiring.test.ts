/**
 * The shipped trust boundary, in one place.
 *
 * Which agents treat which namespaces as untrusted is a security decision, so
 * it gets a test rather than only a comment: this file is the map a reviewer
 * reads to see what is protected and — just as important — what deliberately is
 * not. A guard silently dropped from an agent during a refactor fails here.
 *
 * The wrapper is config-transparent, so its presence is observable only through
 * `name` / `children`; the guard's *config* is not on the pattern (deliberately
 * — see withInjectionGuard.server.ts), so these assertions check the wrapping
 * and the per-agent behaviour tests cover the namespaces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'

const toolSets = {
  neo4j: ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema'],
  web: ['search', 'fetch', 'fetch_content'],
  github: ['search_code', 'search_repositories', 'get_issue'],
  context7: ['resolve-library-id', 'get-library-docs'],
  all: [] as string[],
}
toolSets.all = [...toolSets.neo4j, ...toolSets.web, ...toolSets.github, ...toolSets.context7]

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: mockCallTool({
    responses: { get_neo4j_schema: { nodes: ['Person'], relationships: [] } },
  }),
  listTools: mockListTools(toolSets.all),
}))

vi.mock('../../../../lib/harness-patterns/tools.server', async (importOriginal) => {
  // `inferServer` is REAL — the guard resolves namespaces through it, so a
  // stubbed version would make these assertions meaningless.
  const actual =
    await importOriginal<typeof import('../../../../lib/harness-patterns/tools.server')>()
  return { ...actual, Tools: vi.fn(async () => toolSets) }
})

interface Pattern {
  name: string
  config: { patternId?: string }
  children?: Pattern[]
  injectionGuard?: { namespaces: string[]; tools: string[] }
}

/** Find the guard wrapper at the top level of a chain, or undefined. */
function guardOf(patterns: Pattern[]): Pattern | undefined {
  return patterns.find((p) => p.name.startsWith('withInjectionGuard'))
}

/** Every guard in a chain, top level or one level down (inside `routes`). */
function allGuards(patterns: Pattern[]): Pattern[] {
  return patterns
    .flatMap((p) => [p, ...(p.children ?? [])])
    .filter((p) => p.name.startsWith('withInjectionGuard'))
}

beforeEach(() => vi.clearAllMocks())

describe('agents that consume untrusted content are guarded', () => {
  it('default: the web route is guarded, the neo4j route is not', async () => {
    const { defaultAgent } = await import('../../../../lib/harness-client/examples/default.server')
    const patterns = (await defaultAgent.createPatterns('s')) as Pattern[]

    // The guard sits INSIDE routes, on the web route only — the chain itself is
    // router → routes → compactExecution, unchanged.
    expect(patterns.map((p) => p.name.replace(/\(.*/, ''))).toEqual([
      'router',
      'routes',
      'compactExecution',
    ])

    const guards = allGuards(patterns)
    // Exactly one route is guarded: web. Neo4j is our own data.
    expect(guards).toHaveLength(1)
    expect(guards[0].injectionGuard).toEqual({ namespaces: ['web'], tools: [] })
  })

  it('microsoft-365: the graph loop is guarded', async () => {
    const { microsoft365Agent } =
      await import('../../../../lib/harness-client/examples/microsoft-365.server')
    const patterns = (await microsoft365Agent.createPatterns('s')) as Pattern[]
    const guard = guardOf(patterns)
    expect(guard).toBeDefined()
    expect(guard!.children?.[0].config.patternId).toBe('microsoft-365')
    expect(guard!.injectionGuard).toEqual({ namespaces: ['graph'], tools: [] })
  })

  it('multi-source-research: all three search branches are guarded at once', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/examples/multi-source-research.server')
    const patterns = (await multiSourceResearchAgent.createPatterns('s')) as Pattern[]
    const guard = guardOf(patterns)
    expect(guard).toBeDefined()
    // Guarding the `parallel` covers web + github + context7 in one place; the
    // ALS scope reaches every branch.
    expect(guard!.config.patternId).toBe('parallel-research')
    expect(guard!.children?.[0].name).toContain('parallel')
    expect(guard!.injectionGuard).toEqual({
      namespaces: ['web', 'github', 'context7'],
      tools: [],
    })
  })

  it('retriever: routes is guarded, covering both web and the stash', async () => {
    const { retrieverAgent } =
      await import('../../../../lib/harness-client/examples/retriever-agent.server')
    const patterns = (await retrieverAgent.createPatterns('s')) as Pattern[]
    const guard = guardOf(patterns)
    expect(guard).toBeDefined()
    expect(guard!.children?.[0].name).toBe('routes(retriever|neo4j|web_search)')
    // `retriever` MUST be listed: stash chunks bypass callTool, so the
    // retriever's write-time sanitize only engages when this names it.
    expect(guard!.injectionGuard).toEqual({
      namespaces: ['web', 'retriever'],
      tools: [],
    })
  })
})

describe('agents deliberately NOT guarded (yet)', () => {
  it('general: left to the sibling general-agent lane (#206) to wire at its seam', async () => {
    const { generalAgent } = await import('../../../../lib/harness-client/examples/general.server')
    const patterns = (await generalAgent.createPatterns('s')) as Pattern[]
    expect(guardOf(patterns)).toBeUndefined()
  })

  it('code-mode: an actorCritic over scripts, out of scope for this change', async () => {
    // Not a claim that code-mode is safe — a claim that this PR did not touch
    // it. Its threat model (a script the actor wrote, run against every tool)
    // is a different piece of work.
    const { codeModeAgent } =
      await import('../../../../lib/harness-client/examples/code-mode.server')
    const patterns = (await codeModeAgent.createPatterns('s')) as Pattern[]
    expect(guardOf(patterns)).toBeUndefined()
  })
})
