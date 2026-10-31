/**
 * The shipped injection-guard coverage, as an inventory rather than a sample.
 *
 * `general-next.test.ts` asserts the active agent is guarded. This file asks the complementary question — **what is NOT** — and
 * pins the answer for every agent in the repo, guarded or not, registered or
 * not. It is deliberately a snapshot-shaped test: any change to the wiring fails
 * it, so a guard added, a guard dropped, a route moved out from under a guard,
 * or a brand-new agent all surface as a diff a reviewer has to look at.
 *
 * That cuts both ways on purpose. A coverage REGRESSION fails here, and so does
 * a coverage IMPROVEMENT — the table is the place the decision is recorded, so
 * updating it is part of making the change, not an annoyance on the way.
 *
 * Everything is derived by walking `ConfiguredPattern.children` (which every
 * wrapper exposes for exactly this kind of static introspection) and reading
 * `ConfiguredPattern.injectionGuard`. No agent is executed.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'
// The definitions moved into @hames-ai/agents (#225 PR-2); the inventory walks
// them from the package. `testAgentDeps` supplies the injected app-side bag
// the factories now take — the fake sandbox wrapper mirrors the real one's
// introspection shape, so the pinned inventory rows are unchanged.
import { testAgentDeps } from './test-deps'

// ============================================================================
// Harness
// ============================================================================

const toolSets = {
  neo4j: ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema'],
  web: ['search', 'fetch', 'fetch_content'],
  context7: ['resolve-library-id', 'get-library-docs'],
  filesystem: ['read_text_file', 'write_file'],
  graph: ['graph_me', 'graph_mail_recent'],
  all: [] as string[],
}
toolSets.all = [
  ...toolSets.neo4j,
  ...toolSets.web,
  ...toolSets.context7,
  ...toolSets.filesystem,
  ...toolSets.graph,
]

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: mockCallTool({ responses: {} }),
  listTools: mockListTools(toolSets.all),
}))

vi.mock('@hames-ai/harness-patterns/tools.server', async (importOriginal) => {
  // `inferServer` stays REAL — the guard resolves declared namespaces through
  // it, so stubbing it would make the inventory meaningless.
  const actual = await importOriginal<typeof import('@hames-ai/harness-patterns/tools.server')>()
  return { ...actual, Tools: vi.fn(async () => toolSets) }
})

interface Pattern {
  name: string
  config: { patternId?: string }
  children?: Pattern[]
  injectionGuard?: { namespaces: string[]; tools: string[] }
}

/** Bare pattern kind: `withInjectionGuard(withReferences(simpleLoop))` → the
 *  outermost wrapper name only, with its argument list dropped. */
function kind(p: Pattern): string {
  return p.name.replace(/\(.*$/, '')
}

/**
 * An agent that did not name a pattern gets an auto id of `${kind}-${6 random
 * chars}`, so that tail is masked to keep the pinned table stable across runs.
 * Only masked when the prefix IS the pattern kind — an authored id like
 * `web-search` or `doc-lookup` also ends in six characters and must survive.
 */
function stableId(p: Pattern): string {
  const id = p.config?.patternId
  if (!id) return `(${p.name})`
  const auto = new RegExp(`^${kind(p)}-[a-z0-9]{6}$`)
  if (kind(p) === 'withEgressGate' && /^withReferences-[a-z0-9]{6}$/.test(id))
    return 'withReferences-*'
  return auto.test(id) ? `${kind(p)}-*` : id
}

/**
 * One row per pattern in the (possibly nested) graph, in walk order, recording
 * whether it sits inside a `withInjectionGuard` scope and which namespaces that
 * scope declares untrusted.
 *
 * `enclosing` accumulates down the tree because the guard is an ALS wrapper: a
 * pattern nested at any depth under one is inside its scope.
 */
function inventory(patterns: Pattern[]): string[] {
  const rows: string[] = []
  const walk = (p: Pattern, enclosing: string[]) => {
    const own = p.injectionGuard
    const scope = own
      ? [...enclosing, ...own.namespaces, ...own.tools.map((t) => `tool:${t}`)]
      : enclosing
    // The wrapper and the pattern it wraps share a patternId, so only the
    // wrapped pattern is listed — otherwise every guarded agent shows a
    // duplicate row.
    if (kind(p) !== 'withInjectionGuard') {
      rows.push(
        `${stableId(p)} [${kind(p)}] ${scope.length > 0 ? `guarded:${scope.join('+')}` : 'UNGUARDED'}`,
      )
    }
    for (const c of p.children ?? []) walk(c, scope)
  }
  for (const p of patterns) walk(p, [])
  return rows
}

const AGENTS_DIR = join(process.cwd(), '../packages/agents/agents')

/** Every agent module and the `AgentDefinition` it exports. */
const AGENT_MODULES = [{ file: 'general-next.server.ts', exportName: 'generalNextAgent' }] as const

/** Static import map — `import()` of a template literal cannot be analysed by
 *  Vite, so the modules are named explicitly. */
const LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  'general-next.server.ts': () => import('@hames-ai/agents/agents/general-next.server'),
}

async function patternsOf(file: string, exportName: string): Promise<Pattern[]> {
  const mod = await LOADERS[file]()
  const agent = mod[exportName] as {
    createPatterns: (s: string, deps: unknown) => Promise<Pattern[]>
  }
  return agent.createPatterns('inventory-session', testAgentDeps)
}

/**
 * Import every agent module BEFORE any test measures anything (#280).
 *
 * `patternsOf` dynamically imports an agent, and an agent pulls in
 * harness-patterns and the generated BAML client — a module graph large enough
 * that vitest's first transform of it took over five seconds on a loaded machine.
 * Whichever `it` happened to import a module first therefore paid that inside its
 * own 5s budget and failed, while passing in isolation: `search — the web route is
 * guarded` and `microsoft-365 — the whole graph loop is guarded` both did, in a
 * full-suite run, on a tree where nothing had changed. That is a one-time cost
 * billed to an assertion, not a defect.
 *
 * Widening the per-test timeout would have hidden it and made the next case that
 * got genuinely slow indistinguishable from a regression. The imports are paid
 * here instead, once, against a hook timeout that says what it is for — after
 * which every test below measures `createPatterns` and the inventory, which is
 * what each of them is about.
 */
beforeAll(async () => {
  await Promise.all(Object.values(LOADERS).map((load) => load()))
}, 120_000)

beforeEach(() => vi.clearAllMocks())

// ============================================================================
// The table has to cover every agent that exists
// ============================================================================

describe('the inventory is complete', () => {
  it('every module in agents/ that exports an AgentConfig is in the table', () => {
    // A new agent lands here before anyone has thought about its trust
    // boundary. That is the point: this test fails on the commit that adds it,
    // and the fix is to add a row saying guarded or not, and why.
    const declared = readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.server.ts'))
      .filter((f) => /:\s*AgentDefinition\s*=/.test(readFileSync(join(AGENTS_DIR, f), 'utf8')))
      .sort()
    expect(declared).toEqual(AGENT_MODULES.map((m) => m.file).sort())
  })

  it('records which agents the registry actually registers', () => {
    // Read as source rather than imported: `registry.server.ts` pulls the
    // session/DB layer, which an inventory test has no business booting.
    const registry = readFileSync(
      join(process.cwd(), 'src/lib/harness-client/registry.server.ts'),
      'utf8',
    )
    const registered = [...registry.matchAll(/overlay\((\w+),/g)].map((m) => m[1]).sort()
    expect(registered).toEqual(['generalNextAgent'])
    // Every module in `agents/` is now registered: the last unregistered one
    // (`multi-source-research`) was deleted with the GitHub MCP server it was
    // the final consumer of (owner decision 2026-08-25). An agent that ships on
    // disk but not in the registry is a trust boundary nobody reviews, so the
    // two lists being equal is the property worth pinning.
    expect(registered).toEqual(AGENT_MODULES.map((m) => m.exportName).sort())
  })
})

// ============================================================================
// The pinned inventory
// ============================================================================

describe('roll-up across every agent', () => {
  it('the only exported agent has guard coverage', async () => {
    const rows = inventory(await patternsOf('general-next.server.ts', 'generalNextAgent'))
    expect(rows.some((row) => row.includes('guarded:'))).toBe(true)
  })

  it('only general-next enables the optional LLM screen', async () => {
    // The candidate is the first screen opt-in; the other agents keep their
    // existing policy. Its semantic layer is part of the S3 composition pins.
    for (const { file } of AGENT_MODULES) {
      const src = readFileSync(join(AGENTS_DIR, file), 'utf8')
      expect(/\bscreen\s*:/.test(src)).toBe(file === 'general-next.server.ts')
    }
  })

  it('only general-next overrides spotlight; no agent disables a rule', async () => {
    // The candidate takes S-c's always spotlight; the other agents keep
    // on-detection. Every agent retains the full deterministic corpus.
    for (const { file } of AGENT_MODULES) {
      const src = readFileSync(join(AGENTS_DIR, file), 'utf8')
      expect(/\bspotlight\s*:/.test(src)).toBe(file === 'general-next.server.ts')
      expect(src).not.toMatch(/\bdisableRules\s*:/)
    }
  })
})
