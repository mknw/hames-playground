/**
 * Loop-driven prompt-caching checks (#122) — offline, no network.
 *
 * The sibling `prompt-caching.test.ts` renders templates from hand-built
 * fixtures: it proves the template is right GIVEN inputs. This file closes the
 * other half — it drives the REAL `simpleLoop` / `actorCritic` patterns
 * through the REAL BAML adapters, and renders whatever the loop actually
 * produces at each iteration via `b.request.*` (the HTTP body is built but
 * never sent).
 *
 * That matters because the failure mode this feature dies of is not a bad
 * template — it is the loop mutating something inside the cached prefix
 * between iterations (a re-serialized turn list, a re-annotated ref, a
 * trimToFit drop). A fixture can never catch that; only replaying the loop's
 * own output can.
 *
 * THE CENTRAL ASSERTION is `expectMarkedPrefixReused`: everything up to and
 * including call N-1's LAST marker must reappear byte-identical, in the same
 * order, at the head of call N. That is exactly Anthropic's cache-hit
 * precondition (prefix match up to a breakpoint) — if it holds, the read hits;
 * if any byte differs, the read silently misses and we pay 1.25× instead.
 *
 * Also records the per-call marker counts for the two schemes under A/B
 * (ActorController: 1 marker; LoopController scheme B: up to 4) so a
 * regression in either shows up as a diff here rather than on the bill.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockCallTool, mockListTools, fixtures } from '../../mocks/mcp'

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'offline-render-test'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: mockCallTool({
    responses: {
      read_neo4j_cypher: fixtures.neo4j.queryResult,
      'code-mode': { result: 'Script executed successfully' },
      Return: { response: 'Done' },
    },
  }),
  listTools: mockListTools(['read_neo4j_cypher', 'code-mode', 'Return']),
}))

type Block = { type: string; text?: string; cache_control?: { type: string } }
type Msg = { role: string; content: Block[] | string }
type Body = { system?: Block[]; messages: Msg[] }
/** A block plus its wire role, in render order. `system` param blocks first. */
type WireBlock = { role: string; text: string; marked: boolean }

/** Captured wire bodies, one per LLM call the loop made, in order. */
const captured: Body[] = []

/** Flatten a body to an ordered block list: system param first, then messages. */
function wireBlocks(body: Body): WireBlock[] {
  const sys = (body.system ?? []).map((blk) => ({
    role: 'system',
    text: blk.text ?? '',
    marked: !!blk.cache_control,
  }))
  const msgs = body.messages.flatMap((m) =>
    (Array.isArray(m.content) ? m.content : []).map((blk) => ({
      role: m.role,
      text: blk.text ?? '',
      marked: !!blk.cache_control,
    })),
  )
  return [...sys, ...msgs]
}

function markerCount(body: Body): number {
  return wireBlocks(body).filter((blk) => blk.marked).length
}

/**
 * Assert call N re-reads what call N-1 wrote: every block up to and including
 * the previous call's LAST marker must reappear byte-identical, same order,
 * at the head of this call.
 */
function expectMarkedPrefixReused(prev: Body, next: Body, label: string): void {
  const prevBlocks = wireBlocks(prev)
  const nextBlocks = wireBlocks(next)
  const lastMarked = prevBlocks.map((blk) => blk.marked).lastIndexOf(true)
  expect(lastMarked, `${label}: previous call had no marker at all`).toBeGreaterThanOrEqual(0)

  const cachedPrefix = prevBlocks.slice(0, lastMarked + 1)
  expect(
    nextBlocks.length,
    `${label}: next call is shorter than the cached prefix`,
  ).toBeGreaterThanOrEqual(cachedPrefix.length)

  cachedPrefix.forEach((blk, i) => {
    expect(nextBlocks[i].role, `${label}: role drift at prefix block ${i}`).toBe(blk.role)
    expect(
      nextBlocks[i].text,
      `${label}: BYTE DRIFT at prefix block ${i} — cache read would MISS`,
    ).toBe(blk.text)
  })
}

/** Everything after the final marker is free to change — that's the point. */
function tailAfterLastMarker(body: Body): WireBlock[] {
  const all = wireBlocks(body)
  return all.slice(all.map((blk) => blk.marked).lastIndexOf(true) + 1)
}

async function loadHarness() {
  const actual =
    await vi.importActual<typeof import('../../../../baml_client')>('../../../../baml_client')

  // Intercept the two controller calls: render the real HTTP body (never
  // sent), record it, and hand the loop a scripted action so it keeps going.
  let loopCall = 0
  let actorCall = 0
  const loopScript = [
    {
      reasoning: 'query the graph',
      tool_name: 'read_neo4j_cypher',
      tool_args: '{"query":"MATCH (n) RETURN n"}',
      status: 'working',
      is_final: false,
    },
    {
      reasoning: 'query again',
      tool_name: 'read_neo4j_cypher',
      tool_args: '{"query":"MATCH (m) RETURN m"}',
      status: 'working',
      is_final: false,
    },
    {
      reasoning: 'done',
      tool_name: 'Return',
      tool_args: 'Here is the answer',
      status: 'done',
      is_final: true,
    },
  ]
  const actorScript = [
    {
      reasoning: 'first script',
      tool_name: 'code-mode',
      tool_args: '{"script":"return 1"}',
      status: 'working',
      is_final: false,
    },
    {
      reasoning: 'second script',
      tool_name: 'code-mode',
      tool_args: '{"script":"return 2"}',
      status: 'working',
      is_final: false,
    },
    {
      reasoning: 'third script',
      tool_name: 'code-mode',
      tool_args: '{"script":"return 3"}',
      status: 'working',
      is_final: false,
    },
  ]

  vi.doMock('../../../../baml_client', () => ({
    b: {
      request: actual.b.request,
      LoopController: async (...args: unknown[]) => {
        const req = await (
          actual.b.request.LoopController as (
            ...a: unknown[]
          ) => Promise<{ body: { json(): unknown } }>
        )(...args)
        captured.push(req.body.json() as Body)
        return loopScript[Math.min(loopCall++, loopScript.length - 1)]
      },
      ActorController: async (...args: unknown[]) => {
        const req = await (
          actual.b.request.ActorController as (
            ...a: unknown[]
          ) => Promise<{ body: { json(): unknown } }>
        )(...args)
        captured.push(req.body.json() as Body)
        return actorScript[Math.min(actorCall++, actorScript.length - 1)]
      },
      // Critic drives actorCritic's exit; not part of the caching work.
      Critic: async () => ({
        is_sufficient: actorCall >= 3,
        explanation: 'keep going',
        suggested_approach: actorCall >= 3 ? null : 'try another angle',
      }),
    },
  }))

  const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
  const { actorCritic } = await import('../../../lib/harness-patterns/patterns/actorCritic.server')
  const { createLoopControllerAdapter, createActorControllerAdapter, createCriticAdapter } =
    await import('../../../lib/harness-patterns/baml-adapters.server')
  const { createScope } = await import('../../../lib/harness-patterns/context.server')
  const { createEventView } = await import('../../../lib/harness-patterns/patterns')
  return {
    simpleLoop,
    actorCritic,
    createLoopControllerAdapter,
    createActorControllerAdapter,
    createCriticAdapter,
    createScope,
    createEventView,
  }
}

function mockContext(input: string) {
  return {
    sessionId: 'cache-test',
    createdAt: Date.now(),
    events: [
      {
        type: 'user_message' as const,
        ts: Date.now(),
        patternId: 'harness',
        data: { content: input },
      },
    ],
    status: 'running' as const,
    data: {},
    input,
  }
}

beforeEach(() => {
  captured.length = 0
  vi.clearAllMocks()
  vi.resetModules()
})

describe('simpleLoop (scheme B) — real loop, rendered per turn', () => {
  async function runLoop() {
    const h = await loadHarness()
    const controller = h.createLoopControllerAdapter(
      ['read_neo4j_cypher', 'Return'],
      'GRAPH SCHEMA: (Person)',
    )
    const pattern = h.simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'cache-loop',
      maxTurns: 5,
    })
    const scope = h.createScope('cache-loop', { intent: 'list the people' })
    await pattern.fn(scope, h.createEventView(mockContext('list the people')))
    return captured.slice()
  }

  it('drives 3 real iterations and renders each one', async () => {
    const bodies = await runLoop()
    expect(bodies).toHaveLength(3)
    // history really did grow turn over turn
    const turnCounts = bodies.map(
      (b) => wireBlocks(b).filter((blk) => /^Turn \d+ result:/m.test(blk.text)).length,
    )
    expect(turnCounts).toEqual([0, 1, 2])
  })

  it('each iteration re-reads the previous call’s marked prefix byte-for-byte', async () => {
    const bodies = await runLoop()
    for (let i = 1; i < bodies.length; i++) {
      expectMarkedPrefixReused(bodies[i - 1], bodies[i], `turn ${i} -> ${i + 1}`)
    }
  })

  it('marker budget holds every turn (scheme B: 2 static + up to 2 rolling)', async () => {
    const bodies = await runLoop()
    const counts = bodies.map(markerCount)
    expect(counts).toEqual([2, 3, 4])
    expect(Math.max(...counts)).toBeLessThanOrEqual(4)
  })

  it('only the volatile tail changes after the last marker', async () => {
    const bodies = await runLoop()
    // the tail is the turn counter + output format, and it DOES change
    const tails = bodies.map((b) =>
      tailAfterLastMarker(b)
        .map((blk) => blk.text)
        .join('\n'),
    )
    // 0-indexed: iteration 1 has no completed turns and asks for turn 0.
    expect(tails[0]).toContain('Turn 0. Decide the next action.')
    expect(tails[1]).toContain('Turn 1. Decide the next action.')
    expect(tails[0]).not.toBe(tails[1])
  })
})

describe('simpleLoop with an upstream plan (#27) — the plan stays out of tier 1', () => {
  const PLAN = {
    reasoning: 'The graph already holds the concepts.',
    plan: '1. Query the graph for Concept nodes.\n2. Search the web for gaps.',
    n_steps: 2,
  }

  async function runPlannedLoop() {
    const h = await loadHarness()
    const controller = h.createLoopControllerAdapter(
      ['read_neo4j_cypher', 'Return'],
      'GRAPH SCHEMA: (Person)',
    )
    const pattern = h.simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'cache-loop',
      maxTurns: 5,
    })
    const scope = h.createScope('cache-loop', { intent: 'list the people', plan: PLAN })
    await pattern.fn(scope, h.createEventView(mockContext('list the people')))
    return captured.slice()
  }

  /** Blocks up to and including the FIRST marker — the tier-1 prefix, which is
   *  agent-static (tool catalog + schema) and must not vary per question. */
  function tier1(body: Body): string {
    const blocks = wireBlocks(body)
    const firstMarker = blocks.map((blk) => blk.marked).indexOf(true)
    return blocks
      .slice(0, firstMarker + 1)
      .map((blk) => blk.text)
      .join('\n')
  }

  it('renders the plan after the tier-1 marker, never inside it', async () => {
    const bodies = await runPlannedLoop()
    expect(bodies.length).toBeGreaterThan(0)

    for (const [i, body] of bodies.entries()) {
      const head = tier1(body)
      // The catalog and the schema are what tier 1 is for …
      expect(head, `call ${i} tier 1`).toContain('AVAILABLE TOOLS')
      expect(head, `call ${i} tier 1`).toContain('GRAPH SCHEMA:')
      // … and the per-question plan is not.
      expect(head, `call ${i} tier 1`).not.toContain('PLAN (from previous step')
      // It is still in the prompt, just further down.
      const whole = wireBlocks(body)
        .map((blk) => blk.text)
        .join('\n')
      expect(whole, `call ${i}`).toContain('1. Query the graph for Concept nodes.')
    }
  })

  it('keeps the same tier-1 prefix a planless run would produce', async () => {
    const planned = await runPlannedLoop()
    captured.length = 0
    vi.resetModules()
    const h = await loadHarness()
    const controller = h.createLoopControllerAdapter(
      ['read_neo4j_cypher', 'Return'],
      'GRAPH SCHEMA: (Person)',
    )
    const pattern = h.simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'cache-loop',
      maxTurns: 5,
    })
    const scope = h.createScope('cache-loop', { intent: 'list the people' })
    await pattern.fn(scope, h.createEventView(mockContext('list the people')))
    const planless = captured.slice()

    // Byte-identical agent-static prefix: two different questions against the
    // same agent still share the tool-catalog cache entry.
    expect(tier1(planned[0])).toBe(tier1(planless[0]))
  })

  it('still re-reads the previous call’s marked prefix on every turn', async () => {
    const bodies = await runPlannedLoop()
    for (let i = 1; i < bodies.length; i++) {
      expectMarkedPrefixReused(bodies[i - 1], bodies[i], `planned turn ${i} -> ${i + 1}`)
    }
  })
})

describe('actorCritic → ActorController — real loop, rendered per attempt', () => {
  async function runActor() {
    const h = await loadHarness()
    const actor = h.createActorControllerAdapter({
      toolNames: ['code-mode'],
      contextPrefix: 'ENABLED SERVERS: neo4j',
    })
    const pattern = h.actorCritic(actor, h.createCriticAdapter(), ['code-mode'], {
      patternId: 'cache-actor',
      maxRetries: 3,
    })
    const scope = h.createScope('cache-actor', { intent: 'compute the thing' })
    await pattern.fn(scope, h.createEventView(mockContext('compute the thing')))
    return captured.slice()
  }

  it('drives multiple real attempts and renders each one', async () => {
    const bodies = await runActor()
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    const attemptCounts = bodies.map(
      (b) => wireBlocks(b).filter((blk) => /^Attempt \d+ result:/m.test(blk.text)).length,
    )
    expect(attemptCounts[0]).toBe(0)
    expect(attemptCounts[1]).toBe(1)
  })

  it('each attempt re-reads the previous call’s marked prefix byte-for-byte', async () => {
    const bodies = await runActor()
    for (let i = 1; i < bodies.length; i++) {
      expectMarkedPrefixReused(bodies[i - 1], bodies[i], `attempt ${i} -> ${i + 1}`)
    }
  })

  it('marker budget holds every attempt (production: 1 marker per call)', async () => {
    const bodies = await runActor()
    const counts = bodies.map(markerCount)
    counts.forEach((c) => expect(c).toBe(1))
  })

  it('the rolling marker sits on USER REQUEST at call 1, then moves to the newest result', async () => {
    const bodies = await runActor()
    const lastMarkedText = (body: Body) => {
      const all = wireBlocks(body)
      return all[all.map((blk) => blk.marked).lastIndexOf(true)].text
    }
    expect(lastMarkedText(bodies[0])).toContain('USER REQUEST')
    expect(lastMarkedText(bodies[1])).toContain('Attempt 1 result:')
  })
})
