/**
 * Agent Harness Tests
 *
 * Tests for the exported agent harness.
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
vi.mock('@hames-ai/harness-patterns/tools.server', async (importOriginal) => ({
  // The egress gate names its outgoing tools at construction (slice 10).
  inferServer: (await importOriginal<typeof import('@hames-ai/harness-patterns/tools.server')>())
    .inferServer,
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

  it('general-next has a valid definition and pattern chain', async () => {
    const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
    validateAgentConfig(generalNextAgent)
    expect(generalNextAgent.id).toBe('general-next')
    expect(generalNextAgent.usesSandbox).toBe(true)
    const patterns = await validatePatterns(generalNextAgent)
    expect(patterns.some((p) => p.name.includes('decisionLoop'))).toBe(true)
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
    // Non-vacuous: the exported agent contains the office sandbox.
    expect(verdicts['general-next']).toEqual({ declared: true, built: true })
  })

  it('the only exported definition is general-next', async () => {
    expect((await allDefinitions()).map((d) => d.id)).toEqual(['general-next'])
  })
})
