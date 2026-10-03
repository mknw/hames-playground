/**
 * Agent Harness Tests
 *
 * Tests for all agent harnesses in the agents directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentDefinition, AgentDeps } from '@hames-ai/agents'
import { testAgentDeps } from './test-deps'
import { mockFinalAction, mockCriticResult } from '../../../mocks/baml'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'

// ============================================================================
// Mock Setup
// ============================================================================

const mockToolSets = {
  neo4j: ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema', 'Return'],
  web: ['search', 'fetch', 'fetch_content', 'Return'],
  memory: [
    'create_entities',
    'create_relations',
    'add_observations',
    'delete_entities',
    'delete_relations',
    'delete_observations',
    'open_nodes',
    'search_nodes',
    'read_graph',
    'Return',
  ],
  context7: ['resolve-library-id', 'get-library-docs', 'Return'],
  filesystem: [
    'read_text_file',
    'write_file',
    'edit_file',
    'list_directory',
    'directory_tree',
    'search_files',
    'search_files_content',
    'Return',
  ],
  redis: [
    'get',
    'set',
    'hset',
    'hget',
    'expire',
    'json_get',
    'json_set',
    'vector_search_hash',
    'Return',
  ],
  all: [] as string[],
}

mockToolSets.all = [
  ...new Set([
    ...mockToolSets.neo4j,
    ...mockToolSets.web,
    ...mockToolSets.memory,
    ...mockToolSets.context7,
    ...mockToolSets.filesystem,
    ...mockToolSets.redis,
  ]),
]

// Mock assert.server for all harness files
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Create mocks that we can access and modify
const callToolMock = mockCallTool({
  responses: {
    get_neo4j_schema: { nodes: ['Person'], relationships: ['KNOWS'] },
    read_graph: { entities: [], relations: [] },
    json_get: { data: 'cached value' },
    hset: 'OK',
    expire: true,
    vector_search_hash: [],
  },
})

// Mock MCP client
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(mockToolSets.all),
}))

// Mock BAML client
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    LoopController: vi.fn(async () => mockFinalAction()),
    ActorController: vi.fn(async () => mockFinalAction()),
    Critic: vi.fn(async () => mockCriticResult()),
    Router: vi.fn(async () => ({
      intent: 'test',
      needs_tool: true,
      route: 'neo4j',
      response: '',
    })),
    Synthesize: vi.fn(async () => 'Synthesized response'),
  },
}))

// Mock Collector — must be a real class so `new Collector()` works
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 100, outputTokens: 50 },
      calls: [{ httpRequest: { body: {} } }],
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

// Mock Tools function
vi.mock('@hames-ai/harness-patterns/tools.server', () => ({
  Tools: vi.fn(async () => mockToolSets),
  ToolsFrom: vi.fn(async () => mockToolSets),
}))

// ============================================================================
// Helper Functions
// ============================================================================

// The moved definitions are `AgentDefinition`s now (the app's `AgentConfig`
// adds `icon`/`accent` at the overlay — validated in registry.test.ts).
interface AgentConfig {
  id: string
  name: string
  description: string
  welcome: string
  servers: string[]
  createPatterns: (sessionId: string, deps: AgentDeps) => Promise<unknown[]>
}

function validateAgentConfig(config: AgentConfig) {
  expect(config.id).toBeDefined()
  expect(config.id).toMatch(/^[a-z0-9-]+$/)
  expect(config.name).toBeDefined()
  expect(config.name.length).toBeGreaterThan(0)
  expect(config.description).toBeDefined()
  // Every agent greets in its own words: an empty conversation renders
  // `welcome` (ChatMessages' empty state), and until 2026-08-27 they all shared
  // one "your knowledge assistant" paragraph. TypeScript makes the field
  // mandatory; this is what makes an EMPTY one — the shape a stub or a
  // copy-paste leaves behind — fail too.
  expect(config.welcome.trim().length).toBeGreaterThan(0)
  // Two plain sentences, per the field's contract. A description-length blob
  // would be read as a wall of text at the exact moment the user has not yet
  // decided to type anything.
  expect(config.welcome.length).toBeLessThanOrEqual(280)
  // `icon` / `accent` moved with the overlay (#225 PR-2): they are app UI
  // fields, supplied per registration in registry.server.ts — the
  // accent-family check lives in registry.test.ts now.
  expect(config.servers).toBeInstanceOf(Array)
  expect(config.createPatterns).toBeDefined()
  expect(typeof config.createPatterns).toBe('function')
}

interface Pattern {
  name: string
  fn: (scope: unknown, view: unknown) => Promise<unknown>
  config: { patternId?: string }
}

async function validatePatterns(config: AgentConfig): Promise<Pattern[]> {
  const patterns = (await config.createPatterns('test-session', testAgentDeps)) as Pattern[]

  expect(patterns).toBeInstanceOf(Array)
  expect(patterns.length).toBeGreaterThan(0)

  const patternIds = new Set<string>()

  for (const pattern of patterns) {
    expect(pattern.name).toBeDefined()
    expect(pattern.fn).toBeDefined()
    expect(pattern.config).toBeDefined()
    expect(pattern.config.patternId).toBeDefined()

    // Check for unique pattern IDs
    expect(patternIds.has(pattern.config.patternId!)).toBe(false)
    patternIds.add(pattern.config.patternId!)
  }

  return patterns
}

// ============================================================================
// Tests
// ============================================================================

describe('Agent Harnesses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.resetModules()
  })

  describe('searchAgent', () => {
    it('should have valid config', async () => {
      const { searchAgent } = await import('@hames-ai/agents/agents/search.server')
      validateAgentConfig(searchAgent)
      expect(searchAgent.id).toBe('search')
      expect(searchAgent.servers).toContain('neo4j-cypher')
    })

    it('should create valid patterns', async () => {
      const { searchAgent } = await import('@hames-ai/agents/agents/search.server')
      const patterns = await validatePatterns(searchAgent)

      // Should have router and compactExecution
      const patternNames = patterns.map((p) => p.name)
      expect(patternNames).toContain('router')
      expect(patternNames).toContain('compactExecution')
    })

    it('should have unique pattern IDs', async () => {
      const { searchAgent } = await import('@hames-ai/agents/agents/search.server')
      const patterns = (await searchAgent.createPatterns(
        'test-session',
        testAgentDeps,
      )) as Pattern[]
      const ids = patterns.map((p) => p.config.patternId)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })

  describe('generalAgent', () => {
    it('should have valid config', async () => {
      const { generalAgent } = await import('@hames-ai/agents/agents/general.server')
      validateAgentConfig(generalAgent)
      expect(generalAgent.id).toBe('general')
      expect(generalAgent.servers).toContain('neo4j-cypher')
    })

    it('should create a planner → simpleLoop → compactExecution chain', async () => {
      const { generalAgent } = await import('@hames-ai/agents/agents/general.server')
      const patterns = await validatePatterns(generalAgent)

      expect(patterns.map((p) => p.name)).toEqual(['planner', 'simpleLoop', 'compactExecution'])
    })
  })

  // 2026-10-03: ONE sandbox agent (owner decision). `sandbox-session` and
  // `flavoured-sandbox` were consolidated into it; the registry maps both old
  // ids here (registry.test.ts).
  describe('sandboxAgent', () => {
    it('should have valid config, and declare its sandbox', async () => {
      const { sandboxAgent } = await import('@hames-ai/agents/agents/sandbox.server')
      validateAgentConfig(sandboxAgent)
      expect(sandboxAgent.id).toBe('sandbox')
      expect(sandboxAgent.usesSandbox).toBe(true)
    })

    it('routes each message to one of exactly three flavours: basic, data, office', async () => {
      const { sandboxAgent } = await import('@hames-ai/agents/agents/sandbox.server')
      const patterns = await validatePatterns(sandboxAgent)

      expect(patterns.map((p) => p.name)).toEqual([
        'router',
        // The routes name embeds the route keys, in order.
        'routes(basic|data|office)',
        'compactExecution',
      ])
    })

    // What each route runs in. `basic` is today's plain session box: the bare
    // conversation id is the attachment key the PtyManager acquires for the
    // Shell, so the agent and the Shell share it. The flavours get a box each,
    // and every route shares the one durable session workspace (#243).
    it('runs basic in the session’s own box and each flavour in its own, over one workspace', async () => {
      const { sandboxAgent } = await import('@hames-ai/agents/agents/sandbox.server')
      const attached: unknown[] = []
      await sandboxAgent.createPatterns('test-session', {
        ...testAgentDeps,
        withSandbox: (config) => {
          attached.push(config)
          return testAgentDeps.withSandbox!(config)
        },
      })

      expect(attached).toEqual([
        {
          id: 'test-session',
          sessionId: 'test-session',
          rootfs: 'base',
          egress: 'mcp-only',
          syncWorkspace: true,
        },
        {
          id: 'test-session:data',
          sessionId: 'test-session',
          rootfs: 'data',
          egress: 'mcp-only',
          syncWorkspace: true,
        },
        {
          id: 'test-session:office',
          sessionId: 'test-session',
          rootfs: 'office',
          egress: 'mcp-only',
          syncWorkspace: true,
        },
      ])
    })

    it('exposes the durable-workspace capability (persistent flavours use syncWorkspace)', async () => {
      const { sandboxAgent } = await import('@hames-ai/agents/agents/sandbox.server')
      const { harnessUsesSyncWorkspace } = await import('@hames-ai/harness-patterns')
      const patterns = await sandboxAgent.createPatterns('test-session', testAgentDeps)
      expect(
        harnessUsesSyncWorkspace(patterns as Parameters<typeof harnessUsesSyncWorkspace>[0]),
      ).toBe(true)
    })

    // #243 follow-up. `harnessUsesSyncWorkspace` above is an ANY check, so it
    // stayed true while `basic` — then the one route with no attachment id,
    // hence no durable workspace at all — silently ran in a container without
    // /work/in. A turn the router sent there could not see a file ingested on
    // another flavour's turn (.harness-logs/243.json). The invariant is
    // per-route: EVERY flavour shares the session workspace.
    it('gives EVERY flavour route the durable session workspace, not just some', async () => {
      const { sandboxAgent } = await import('@hames-ai/agents/agents/sandbox.server')
      const patterns = await sandboxAgent.createPatterns('test-session', testAgentDeps)

      const routesPattern = patterns.find((p) => p.name.startsWith('routes('))!
      expect(routesPattern.children).toBeDefined()
      expect(routesPattern.children!.length).toBe(3)
      for (const route of routesPattern.children!) {
        expect(route.name).toContain('withSandbox')
        // `withSandbox` declares the capability only when `id` + `syncWorkspace`
        // are BOTH set — i.e. only when hydrate/promote will actually run.
        expect(route.capabilities?.workspaceSync).toBe(true)
      }
    })

    it('refuses to build without the host’s sandbox wrapper, rather than run on the host', async () => {
      const { sandboxAgent } = await import('@hames-ai/agents/agents/sandbox.server')
      const { withSandbox: _omitted, ...noSandbox } = testAgentDeps
      await expect(sandboxAgent.createPatterns('test-session', noSandbox)).rejects.toThrow(
        /requires deps\.withSandbox/,
      )
    })
  })
})

// ============================================================================
// Cross-Agent Tests
// ============================================================================

interface SandboxProbe {
  name: string
  children?: SandboxProbe[]
}

/** Every `AgentDefinition` the package's server barrel exports — the barrel,
 *  not a hand-kept list, so a new agent is covered the day it is exported. */
async function allDefinitions(): Promise<AgentDefinition[]> {
  const barrel = (await import('@hames-ai/agents/agents')) as Record<string, unknown>
  return Object.values(barrel).filter(
    (v): v is AgentDefinition =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as AgentDefinition).id === 'string' &&
      typeof (v as AgentDefinition).createPatterns === 'function',
  )
}

describe('Agent Consistency', () => {
  it('all agents should have unique IDs', async () => {
    const ids = (await allDefinitions()).map((d) => d.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // The support panel greys its Sandbox tab out for an agent whose definition
  // does not declare `usesSandbox` (owner decision 2026-10-03). The flag is a
  // declaration because the truth — a `withSandbox` somewhere in the built
  // graph — costs a whole `createPatterns` to read. This is what keeps the two
  // in step: every definition the package exports is built and walked, so a
  // new sandbox agent that forgets the flag (a tab greyed out over a working
  // sandbox) or a flag left on an agent that lost its sandbox fails here.
  it('declares usesSandbox exactly when its built pattern graph contains a sandbox', async () => {
    const hasSandbox = (nodes: SandboxProbe[]): boolean =>
      nodes.some((n) => n.name.startsWith('withSandbox(') || hasSandbox(n.children ?? []))

    const verdicts: Record<string, { declared: boolean; built: boolean }> = {}
    for (const def of await allDefinitions()) {
      const built = (await def.createPatterns('test-session', testAgentDeps)) as SandboxProbe[]
      verdicts[def.id] = { declared: def.usesSandbox === true, built: hasSandbox(built) }
    }

    for (const [id, v] of Object.entries(verdicts)) {
      expect(v.declared, `${id}: usesSandbox disagrees with its pattern graph`).toBe(v.built)
    }
    // Non-vacuous: the walk does find the one sandbox agent there is.
    expect(verdicts.sandbox).toEqual({ declared: true, built: true })
  })

  it('all agents should contain compactExecution pattern', async () => {
    const { searchAgent } = await import('@hames-ai/agents/agents/search.server')
    const { generalAgent } = await import('@hames-ai/agents/agents/general.server')

    const agents = [searchAgent, generalAgent]

    for (const config of agents) {
      const patterns = (await config.createPatterns('test-session', testAgentDeps)) as Pattern[]
      // All agents should contain a compactExecution pattern somewhere in the chain
      const hasCompactExecution = patterns.some((p) => p.name === 'compactExecution')
      expect(hasCompactExecution).toBe(true)
    }
  })
})

/**
 * SA-M1 — a compactExecution's `viewConfig` must not hide the user's question.
 *
 * `ViewConfig`'s pattern scope is IMPLICIT: declare `eventTypes` and nothing
 * else and you silently get `fromLast` — the immediately preceding pattern
 * only. The user's message is tracked at the harness level (patternId
 * 'harness'), so it was filtered out and `Synthesize` ran with an empty
 * USER MESSAGE: the answer-writer had the tool results but not the question.
 * `general.server.ts` is the shape the others now follow.
 */
describe('compactExecution view scope — the user message must survive', () => {
  interface Node {
    name: string
    config: { patternId?: string; viewConfig?: Record<string, unknown> }
    children?: Node[]
  }

  /** Depth-first walk — the synth can sit inside routes(chain(...)). */
  function findSynth(nodes: Node[]): Node | undefined {
    for (const n of nodes) {
      if (n.name === 'compactExecution') return n
      const inner = n.children ? findSynth(n.children) : undefined
      if (inner) return inner
    }
    return undefined
  }

  async function synthOf(agentId: 'sandbox'): Promise<Node> {
    // Static import: a template-literal specifier defeats Vite's analysis.
    const agent = (await import('@hames-ai/agents/agents/sandbox.server')).sandboxAgent
    const patterns = (await agent.createPatterns(
      'test-session',
      testAgentDeps,
    )) as unknown as Node[]
    const synth = findSynth(patterns)
    expect(synth, `no compactExecution found in ${agentId}`).toBeDefined()
    return synth!
  }

  /** The question, as the harness records it, plus one loop event beside it. */
  function ctxWith(loopPatternId: string) {
    return {
      sessionId: 'sess',
      createdAt: 1,
      events: [
        { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'why is it slow?' } },
        { type: 'pattern_enter', ts: 2, patternId: loopPatternId, data: {} },
        {
          type: 'tool_result',
          ts: 3,
          patternId: loopPatternId,
          data: { tool: 'run', success: true, result: 'ok' },
        },
      ] as never,
      status: 'running' as const,
      data: {},
      input: 'why is it slow?',
    }
  }

  // The consolidated agent's synth declares no viewConfig at all, so it reads
  // the unscoped default — which is exactly what keeps the harness-level
  // question in view. A viewConfig added later without 'harness' in its
  // pattern scope turns this red.
  it('sandbox: the synth still sees the question', async () => {
    const loopId = 'flavour-basic-loop'
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const synth = await synthOf('sandbox')

    // Mirrors compactExecution's own read: `view.fromAll().ofType('user_message')`.
    const view = createEventView(ctxWith(loopId), synth.config.viewConfig, synth.config.patternId)
    const msg = view.fromAll().ofType('user_message').last(1).get()[0]

    expect((msg?.data as { content?: string })?.content).toBe('why is it slow?')
    // ...and the loop's own events are still in scope, or there is nothing to
    // synthesize from.
    expect(view.fromAll().ofType('tool_result').count()).toBe(1)
  })
})
