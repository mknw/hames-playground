/**
 * The shipped injection-guard coverage, as an inventory rather than a sample.
 *
 * `injection-guard-wiring.test.ts` asserts that the three guarded agents are
 * guarded. This file asks the complementary question — **what is NOT** — and
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

// ============================================================================
// Harness
// ============================================================================

const toolSets = {
  neo4j: ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema'],
  web: ['search', 'fetch', 'fetch_content'],
  context7: ['resolve-library-id', 'get-library-docs'],
  filesystem: ['read_text_file', 'write_file'],
  memory: ['search_nodes', 'read_graph'],
  all: [] as string[],
}
toolSets.all = [
  ...toolSets.neo4j,
  ...toolSets.web,
  ...toolSets.context7,
  ...toolSets.filesystem,
  ...toolSets.memory,
]

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: mockCallTool({ responses: {} }),
  listTools: mockListTools(toolSets.all),
}))

vi.mock('../../../../lib/harness-patterns/tools.server', async (importOriginal) => {
  // `inferServer` stays REAL — the guard resolves declared namespaces through
  // it, so stubbing it would make the inventory meaningless.
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

const AGENTS_DIR = join(process.cwd(), 'src/lib/harness-client/agents')

/** Every agent module and the `AgentConfig` it exports. */
const AGENT_MODULES = [
  { file: 'search.server.ts', exportName: 'searchAgent' },
  { file: 'general.server.ts', exportName: 'generalAgent' },
  { file: 'sandbox-session.server.ts', exportName: 'sandboxSessionAgent' },
  { file: 'flavoured-sandbox.server.ts', exportName: 'flavouredSandboxAgent' },
  { file: 'retriever-agent.server.ts', exportName: 'retrieverAgent' },
  { file: 'microsoft-365.server.ts', exportName: 'microsoft365Agent' },
] as const

/** Static import map — `import()` of a template literal cannot be analysed by
 *  Vite, so the modules are named explicitly. */
const LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  'search.server.ts': () => import('../../../../lib/harness-client/agents/search.server'),
  'general.server.ts': () => import('../../../../lib/harness-client/agents/general.server'),
  'sandbox-session.server.ts': () =>
    import('../../../../lib/harness-client/agents/sandbox-session.server'),
  'flavoured-sandbox.server.ts': () =>
    import('../../../../lib/harness-client/agents/flavoured-sandbox.server'),
  'retriever-agent.server.ts': () =>
    import('../../../../lib/harness-client/agents/retriever-agent.server'),
  'microsoft-365.server.ts': () =>
    import('../../../../lib/harness-client/agents/microsoft-365.server'),
}

async function patternsOf(file: string, exportName: string): Promise<Pattern[]> {
  const mod = await LOADERS[file]()
  const agent = mod[exportName] as { createPatterns: (s: string) => Promise<Pattern[]> }
  return agent.createPatterns('inventory-session')
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
      .filter((f) => /:\s*AgentConfig\s*=/.test(readFileSync(join(AGENTS_DIR, f), 'utf8')))
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
    const registered = [...registry.matchAll(/registerAgent\((\w+)\)/g)].map((m) => m[1]).sort()
    expect(registered).toEqual(
      [
        'searchAgent',
        'generalAgent',
        'sandboxSessionAgent',
        'flavouredSandboxAgent',
        'retrieverAgent',
        'microsoft365Agent',
      ].sort(),
    )
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

describe('per-agent guard coverage (pinned — a wiring change must update this)', () => {
  it('search — the web route is guarded; the neo4j route is our own graph', async () => {
    expect(inventory(await patternsOf('search.server.ts', 'searchAgent'))).toEqual([
      'router-* [router] UNGUARDED',
      'routes-* [routes] UNGUARDED',
      // The neo4j route: deliberately trusted, it reads the graph we wrote.
      'withReferences-* [withReferences] UNGUARDED',
      'neo4j-query [simpleLoop] UNGUARDED',
      // The web route, and everything under it.
      'withReferences-* [withReferences] guarded:web',
      'web-search [simpleLoop] guarded:web',
      'response-synth [compactExecution] UNGUARDED',
    ])
  })

  it('microsoft-365 — the whole graph loop is guarded', async () => {
    expect(inventory(await patternsOf('microsoft-365.server.ts', 'microsoft365Agent'))).toEqual([
      'microsoft-365 [simpleLoop] guarded:graph',
      'response-synth [compactExecution] UNGUARDED',
    ])
  })

  it('retriever — one guard over all three routes, covering web + the stash', async () => {
    expect(inventory(await patternsOf('retriever-agent.server.ts', 'retrieverAgent'))).toEqual([
      'router-* [router] UNGUARDED',
      'routes-* [routes] guarded:web+retriever',
      'retriever [retriever] guarded:web+retriever',
      'withReferences-* [withReferences] guarded:web+retriever',
      // Inside the guard's SCOPE, but `neo4j` is not one of its declared
      // namespaces, so `isUntrusted('read_neo4j_cypher')` is false and nothing
      // is sanitized on this route. "Inside the scope" and "protected" are
      // different properties — this row is the one place that distinction is
      // visible, so read `guarded:` as the declared namespace list, not as a
      // promise about every tool underneath.
      'neo4j-query [simpleLoop] guarded:web+retriever',
      'withReferences-* [withReferences] guarded:web+retriever',
      'web-search [simpleLoop] guarded:web+retriever',
      'response-synth [compactExecution] UNGUARDED',
    ])
  })
})

describe('agents with NO guard anywhere (pinned gaps)', () => {
  it('documents current behavior: general has no guard, and its loop holds tools.all', async () => {
    // The largest gap in the repo, and a known one (#206 is the seam). The
    // `execute` loop is handed `tools.all` — web fetch, filesystem reads,
    // context7 docs, the memory graph — so every untrusted source the other
    // agents guard individually reaches this controller raw. Left unwired
    // deliberately (a sibling lane owns the seam), not by oversight.
    const rows = inventory(await patternsOf('general.server.ts', 'generalAgent'))
    expect(rows).toEqual([
      'plan [planner] UNGUARDED',
      'execute [simpleLoop] UNGUARDED',
      'response-synth [compactExecution] UNGUARDED',
    ])
    expect(rows.every((r) => r.endsWith('UNGUARDED'))).toBe(true)
    // …and the tool list it is built from spans every namespace we treat as
    // untrusted elsewhere.
    expect(toolSets.all).toEqual(expect.arrayContaining(['fetch', 'read_text_file']))
  })

  it('documents current behavior: sandbox-session has no guard, though in-VM results pass callTool', async () => {
    // The SPEC states the chokepoint covers "all three transports (gateway,
    // app-side, sandbox in-VM)". So a sandbox turn that fetches a page and
    // prints it returns attacker-authored text through `callTool` — the guard
    // WOULD see it — but this agent declares no namespaces, so nothing is
    // sanitized. Sandbox network egress is listed out of scope (#116); the
    // content coming BACK from the sandbox into the actor's turn log is not
    // covered by that exemption, and is not covered by a guard either.
    const rows = inventory(await patternsOf('sandbox-session.server.ts', 'sandboxSessionAgent'))
    expect(rows).toEqual([
      'sandbox-session-intent [compactIntent] UNGUARDED',
      // `withSandbox` and the `actorCritic` it wraps share a patternId, so both
      // appear — the wrapper row is what a `withInjectionGuard` row would sit
      // next to if one were ever added here.
      'sandbox-session-loop [withSandbox] UNGUARDED',
      'sandbox-session-loop [actorCritic] UNGUARDED',
      'sandbox-session-synth [compactExecution] UNGUARDED',
    ])
  })

  it('documents current behavior: flavoured-sandbox has no guard on any of its four routes', async () => {
    const rows = inventory(await patternsOf('flavoured-sandbox.server.ts', 'flavouredSandboxAgent'))
    expect(rows).toEqual([
      'router-* [router] UNGUARDED',
      'routes-* [routes] UNGUARDED',
      'flavour-basic-loop [withSandbox] UNGUARDED',
      'flavour-basic-loop [actorCritic] UNGUARDED',
      'flavour-image-loop [withSandbox] UNGUARDED',
      'flavour-image-loop [actorCritic] UNGUARDED',
      'flavour-data-loop [withSandbox] UNGUARDED',
      'flavour-data-loop [actorCritic] UNGUARDED',
      'flavour-office-loop [withSandbox] UNGUARDED',
      'flavour-office-loop [actorCritic] UNGUARDED',
      'flavoured-sandbox-synth [compactExecution] UNGUARDED',
    ])
    // The `office` and `data` flavours exist to PARSE user-supplied documents
    // (#78) — the delivery vehicle the guard's own threat model names first.
    expect(rows.filter((r) => r.includes('[actorCritic]'))).toHaveLength(4)
  })
})

// ============================================================================
// Roll-up
// ============================================================================

describe('roll-up across every agent', () => {
  it('pins the guarded / unguarded split (3 of 6 agents carry a guard)', async () => {
    const guarded: string[] = []
    const unguarded: string[] = []
    for (const { file, exportName } of AGENT_MODULES) {
      const rows = inventory(await patternsOf(file, exportName))
      ;(rows.some((r) => r.includes('guarded:')) ? guarded : unguarded).push(file)
    }
    expect(guarded.sort()).toEqual(
      ['search.server.ts', 'retriever-agent.server.ts', 'microsoft-365.server.ts'].sort(),
    )
    expect(unguarded.sort()).toEqual(
      ['general.server.ts', 'sandbox-session.server.ts', 'flavoured-sandbox.server.ts'].sort(),
    )
  })

  it('documents current behavior: no agent enables the optional LLM screen', async () => {
    // `screen` is off everywhere, so the semantic layer is currently dead code
    // in production — which is worth knowing before reading the screen-gate
    // findings in `injection-guard-assumptions.test.ts` as a live exposure.
    // They describe what happens the moment an agent turns it on.
    for (const { file } of AGENT_MODULES) {
      const src = readFileSync(join(AGENTS_DIR, file), 'utf8')
      expect(src).not.toMatch(/\bscreen\s*:/)
    }
  })

  it('documents current behavior: no agent overrides spotlight or disables a rule', async () => {
    // Every guarded agent takes the defaults: `spotlight: 'on-detection'`, the
    // full corpus. So the per-leaf fencing and the false-positive costs
    // measured in the assumptions suite are what production actually pays.
    for (const { file } of AGENT_MODULES) {
      const src = readFileSync(join(AGENTS_DIR, file), 'utf8')
      expect(src).not.toMatch(/\bspotlight\s*:/)
      expect(src).not.toMatch(/\bdisableRules\s*:/)
    }
  })
})
