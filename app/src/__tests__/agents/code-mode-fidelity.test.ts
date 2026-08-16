/**
 * Code Mode Agent — refinement themes (synth fidelity, critic provenance,
 * script-hygiene guidance). See the `code-mode-refinement` lane.
 *
 * Captured failure (.harness-logs/context-verywell.json): a code-mode script
 * returned 3 nodes with web summaries; one page 403'd. The synth DROPPED the
 * real `verywellmind.com` URL and FABRICATED `schema.org` / `neo4j docs` links
 * that never appeared in the tool result.
 *
 * Two behavioral guards here:
 *  1. (Theme 3) the output-shape / script-hygiene guidance reaches the actor
 *     prompt (search/fetch return TEXT, never JSON.parse; keep the URL on a
 *     failed fetch).
 *  2. (Theme 1) the real URLs — including the 403'd one — are present in the
 *     `turns` the synthesizer receives, so the prompt's FIDELITY rule has the
 *     genuine links to cite instead of inventing substitutes.
 *
 * Plus prompt-content guards that the FIDELITY / PROVENANCE / TRUTHFULNESS
 * rules stay on the committed BAML templates.
 *
 * Isolated from code-mode.test.ts (mirrors code-mode-catalog.test.ts) so this
 * file can mock getServerCatalog's deps without disturbing that file's queues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { mockAction, mockCriticResult } from '../mocks/baml'
import { mockCallTool, mockListTools } from '../mocks/mcp'

const META = ['mcp-find', 'mcp-add', 'code-mode', 'mcp-exec']
const NEO4J = ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema']
const mockToolSets = { code: [...META], all: [...META] }

// Mirrors the shape of .harness-logs/context-verywell.json's winning turn:
// one URL fetched fine, one 403'd (URL still present), one with no URL.
const VERYWELL_PAYLOAD = {
  _source: { tool: 'read_neo4j_cypher', server: 'neo4j-cypher' },
  summaries: [
    {
      url: 'https://redis.io/tutorials/what-is-redis/',
      node: 'Redis',
      degree: 17,
      summary: 'What is Redis? In-memory data structure store used as a database, cache, and message broker.',
    },
    {
      url: 'https://www.verywellmind.com/what-is-a-schema-2795873',
      node: 'Schema',
      degree: 12,
      summary: "Error: Could not access the webpage (Client error '403 Forbidden' for url 'https://www.verywellmind.com/what-is-a-schema-2795873')",
    },
    {
      url: null,
      node: 'Animal',
      degree: 10,
      summary: 'No results were found for your search query.',
    },
  ],
}

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const callToolMock = mockCallTool({
  responses: {
    'code-mode': { tool_name: 'code-mode-neo4j_web_analysis' },
    'code-mode-neo4j_web_analysis': VERYWELL_PAYLOAD,
  },
})

vi.mock('../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools([...NEO4J, ...META]),
}))

const actorController = vi.fn()
const critic = vi.fn()
const router = vi.fn()
const synthesize = vi.fn()

vi.mock('../../../baml_client', () => ({
  b: {
    LoopController: vi.fn(),
    ActorController: actorController,
    Critic: critic,
    Router: router,
    Synthesize: synthesize,
    ResultDescribe: vi.fn(async () => ''),
  },
}))

vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = { rawLlmResponse: 'raw', usage: { inputTokens: 10, outputTokens: 5 }, calls: [{ httpRequest: { body: {} } }] }
    constructor(_name?: string) {}
  }
  class BamlValidationError extends Error {}
  return { Collector: MockCollector, BamlValidationError }
})

vi.mock('../../lib/harness-patterns/tools.server', () => ({
  Tools: vi.fn(async () => mockToolSets),
  ToolsFrom: vi.fn(() => mockToolSets),
  inferServer: (n: string) => n,
}))

vi.mock('../../lib/harness-client/session.server', () => ({
  loadSession: vi.fn(async () => null),
}))
vi.mock('../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: vi.fn(() => null),
  runWithUserId: (_uid: string, fn: () => Promise<unknown>) => fn(),
  getRequestSessionId: vi.fn(() => null),
  runWithRequestContext: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}))

describe('code-mode agent — synth fidelity + script-hygiene guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    router.mockResolvedValue({ intent: 'query the neo4j db', needs_tool: true, route: 'code_mode', response: '' })
    // One actor turn: invoke a code-mode-* tool that returns the payload.
    // Matches dynamicToolPattern /^code-mode-/ so the loop dispatches it.
    actorController.mockResolvedValue(
      mockAction({
        reasoning: 'Run the analysis script against neo4j-cypher + web_search.',
        tool_name: 'code-mode-neo4j_web_analysis',
        tool_args: JSON.stringify({ script: 'return out;' }),
      }),
    )
    critic.mockResolvedValue(mockCriticResult({ is_sufficient: true }))
    synthesize.mockResolvedValue('done')
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('folds the output-shape / script-hygiene guidance into the actor context (Theme 3)', async () => {
    const { codeModeAgent } = await import('../../lib/harness-client/examples/code-mode.server')
    const { harness } = await import('../../lib/harness-patterns/harness.server')

    const patterns = await codeModeAgent.createPatterns('test-session')
    const agent = harness(...patterns)
    await agent('Fetch the 3 most connected nodes in the neo4j db and summarize web pages.')

    expect(actorController).toHaveBeenCalled()
    // ActorController(user_message, intent, tools, attempts, context, …) → ctx is arg[4].
    const context = actorController.mock.calls[0][4] as string
    // search/fetch return text, not JSON — the recurring JSON.parse turn-burner.
    expect(context).toContain('JSON.parse')
    expect(context).toContain('TEXT')
    // Keep the URL on a failed fetch — the bridge to synth fidelity.
    expect(context).toContain('fetch_content')
  })

  it('passes the real URLs (incl. the 403\'d one) into the synthesizer turns (Theme 1)', async () => {
    const { codeModeAgent } = await import('../../lib/harness-client/examples/code-mode.server')
    const { harness } = await import('../../lib/harness-patterns/harness.server')

    const patterns = await codeModeAgent.createPatterns('test-session')
    const agent = harness(...patterns)
    await agent('Fetch the 3 most connected nodes in the neo4j db, summarize each, and link the page.')

    // Synthesize(userMessage, intent, turns, hasError, errorMessage) → turns is arg[2].
    expect(synthesize).toHaveBeenCalledTimes(1)
    const turnsArg = synthesize.mock.calls[0][2] as unknown[]
    const turnsJson = JSON.stringify(turnsArg)

    // The fetched page's URL is in view.
    expect(turnsJson).toContain('https://redis.io/tutorials/what-is-redis/')
    // The 403'd page's ORIGINAL URL is still in view — the synth must cite it
    // (with a "couldn't fetch" note), not drop it or substitute a link.
    expect(turnsJson).toContain('https://www.verywellmind.com/what-is-a-schema-2795873')
    expect(turnsJson).toContain('403')
    // Provenance the critic checks is present too.
    expect(turnsJson).toContain('neo4j-cypher')
  })
})

// ---------------------------------------------------------------------------
// Prompt-content guards: the refinement rules must stay on the committed BAML
// templates. process.cwd() is the `app/` dir, so baml_src is one level up
// (mirrors server-catalog.server.ts / baml-adapters.server.ts path resolution).
// ---------------------------------------------------------------------------

function readBamlSrc(file: string): string {
  const candidates = [
    path.resolve(process.cwd(), '..', 'baml_src', file),
    path.resolve(process.cwd(), 'baml_src', file),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`baml_src/${file} not found (cwd=${process.cwd()})`)
  return readFileSync(found, 'utf8')
}

describe('code-mode refinement — BAML prompt guardrails', () => {
  it('Synthesize carries the FIDELITY block (cite-only-real-URLs, keep URL on fetch fail)', () => {
    const src = readBamlSrc('synthesizer.baml')
    expect(src).toContain('FIDELITY')
    expect(src).toContain('verbatim')
    // Never invent/substitute links; keep the original URL on a failed fetch.
    expect(src).toMatch(/never invent|do NOT replace|substitute/i)
    expect(src).toMatch(/could not be fetched|couldn't be fetched|403/i)
  })

  it('Critic consumes _source provenance and accepts truthful-empty results', () => {
    const src = readBamlSrc('actorCritic.baml')
    expect(src).toContain('_source')
    expect(src).toContain('PROVENANCE')
    expect(src).toContain('TRUTHFULNESS')
    // Steers on degenerate results rather than being a pedantic gate.
    expect(src).toMatch(/pedantic/i)
  })
})
