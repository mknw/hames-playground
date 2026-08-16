/**
 * Router — cross-turn intent + route choice, live eval (#53)
 *
 * The INTENT FORMULATION rules in `baml_src/router.baml` are a prompt, so the
 * only honest check of them is a real call. These cases hit `b.Router` through
 * `routeMessageOp` with the multi-turn fixtures from #53 and assert the
 * returned `intent` stands on its own.
 *
 * The second suite covers what the first cannot: the INTENT FORMULATION block
 * was added to the SYSTEM role of EVERY router call, so it can shift route
 * selection and `needs_tool` on messages that have no history at all. Those
 * cases assert the classification itself, single-turn, so this file works as a
 * before/after gate on any further prompt edit.
 *
 * SKIPPED BY DEFAULT — they cost tokens and need `ANTHROPIC_API_KEY`. Run with:
 *
 *   RUN_EVALS=1 pnpm test:run src/__tests__/lib/harness-patterns/router-intent-eval.test.ts
 *
 * The deterministic half (history plumbing + prompt-content guards) lives in
 * `router-context.test.ts` and runs on every CI job.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const ROUTES = [
  { name: 'web_search', description: 'Web lookups and information retrieval' },
  { name: 'neo4j', description: 'Database queries and graph operations' },
  { name: 'code_mode', description: 'Multi-tool script composition' },
]

interface Case {
  name: string
  history: Array<{ role: string; content: string }>
  message: string
  /** Referent the expanded intent must have pulled out of the history. */
  mustMention: RegExp
}

const CASES: Case[] = [
  {
    name: '"try again" after a failed search',
    history: [
      { role: 'user', content: 'search the web for SolidJS resources' },
      { role: 'assistant', content: 'Rate limited by the provider — no results returned.' },
    ],
    message: 'try again',
    mustMention: /solid/i,
  },
  {
    name: '"the second one" after a list',
    history: [
      { role: 'user', content: 'find papers about graph embeddings' },
      {
        role: 'assistant',
        content: '1. GraphSAGE, 2. node2vec, 3. DeepWalk — three well-cited papers.',
      },
    ],
    message: 'summarise the second one',
    mustMention: /node2vec/i,
  },
  {
    name: '"now in TypeScript"',
    history: [
      { role: 'user', content: 'write a Python script that reverses a linked list' },
      { role: 'assistant', content: 'Here is the Python version: …' },
    ],
    message: 'now in TypeScript',
    mustMention: /linked list/i,
  },
]

// `describe.runIf` keeps the suite visible-but-skipped in a normal run.
// Compared against '1', not truthiness: `RUN_EVALS=0` is a non-empty string,
// so a truthiness check spends real Anthropic calls for someone who just
// explicitly asked for them to be OFF.
const RUN_EVALS = process.env.RUN_EVALS === '1'

describe.runIf(RUN_EVALS)('router intent synthesis (live)', () => {
  it.each(CASES)(
    'expands $name into a self-contained intent',
    async (c) => {
      const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

      const result = await routeMessageOp(c.message, c.history, ROUTES)

      // Never the bare back-reference on its own …
      expect(result.intent.trim().toLowerCase()).not.toBe(c.message.toLowerCase())
      // … and it names the thing being referred back to.
      expect(result.intent).toMatch(c.mustMention)
    },
    60_000,
  )

  it('leaves an already self-contained message alone', async () => {
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

    const result = await routeMessageOp('how many nodes are in the graph?', [], ROUTES)

    // No history to expand from — the intent must still be about the graph and
    // must not invent context the user never gave.
    expect(result.intent).toMatch(/node|graph/i)
  }, 60_000)
})

interface RouteCase {
  name: string
  message: string
  /** Expected route name, or null for "answer directly, no tool". */
  route: string | null
  needsTool: boolean
}

// Single-turn, no history: exactly the calls the INTENT FORMULATION block
// changed without changing any assertion in the repo. One case per route plus
// the no-tool case, because the regression to fear is directional — a prompt
// block about restating the request nudging a greeting into "needs a tool".
const ROUTE_CASES: RouteCase[] = [
  {
    name: 'a bare greeting needs no tool at all',
    message: 'hey there!',
    route: null,
    needsTool: false,
  },
  {
    name: 'a graph question routes to neo4j',
    message: 'how many Concept nodes are in the graph?',
    route: 'neo4j',
    needsTool: true,
  },
  {
    name: 'a current-events question routes to web_search',
    message: 'what did SolidStart ship in its most recent release?',
    route: 'web_search',
    needsTool: true,
  },
  {
    name: 'a multi-tool composition routes to code_mode',
    message:
      'write and run a script that pulls every Concept from the graph and looks each one up on the web',
    route: 'code_mode',
    needsTool: true,
  },
]

describe.runIf(RUN_EVALS)('router route choice (live)', () => {
  it.each(ROUTE_CASES)(
    'classifies $name',
    async (c) => {
      const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

      const result = await routeMessageOp(c.message, [], ROUTES)

      expect(result.tool_call_needed).toBe(c.needsTool)
      expect(result.tool_name).toBe(c.route)
      if (!c.needsTool) {
        // No tool means the router itself answers — an empty response would
        // leave the user with nothing.
        expect(result.response_text.trim().length).toBeGreaterThan(0)
      }
    },
    60_000,
  )
})
