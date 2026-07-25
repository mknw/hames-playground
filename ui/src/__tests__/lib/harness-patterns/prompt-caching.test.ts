/**
 * Prompt-caching render checks (#122) — offline, no network.
 *
 * Uses BAML's request builder (`b.request.*`) to render the exact Anthropic
 * HTTP body and asserts the cache-stability invariants the controller
 * templates (simpleLoop.baml / actorCritic.baml) must uphold.
 *
 * NOTE ON SHAPE: BAML merges consecutive same-role prompt messages into ONE
 * API message with multiple `text` content blocks, and `cache_control` rides
 * the individual BLOCK (Anthropic's native breakpoint granularity). So the
 * two stable tiers + the volatile tail can share one `user` message; the
 * invariants below are therefore asserted per-block:
 *
 *  1. Breakpoint budget: ≤4 cache_control blocks per request (Anthropic max).
 *  2. Placement: tier-1 (agent-static) + tier-2 (run-static) blocks are
 *     checkpointed; rolling checkpoints sit on the last two turn-result
 *     blocks only; the final tail block is NEVER checkpointed.
 *  3. Byte-stability: tier blocks and already-rendered history blocks are
 *     identical across loop iterations — anything else silently voids the
 *     cache prefix.
 *  4. History renders as a real conversation: past actions are ASSISTANT
 *     messages, results are user messages, chronologically interleaved.
 *  5. The refs list stays frozen (no "(expanded in turn N)" mutation);
 *     expanded content arrives in the result block of the expanding turn.
 *
 * If a template edit breaks one of these, caching silently degrades to a
 * 1.25× input-cost premium with zero reads — these assertions are the guard.
 */
import { describe, it, expect, beforeAll } from 'vitest'

// b.request builds the HTTP body without sending; it still resolves the
// client, which needs the env var to exist.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'offline-render-test'

type Block = { type: string; text?: string; cache_control?: { type: string } }
type Msg = { role: string; content: Block[] | string }
type Body = { system?: unknown; messages: Msg[] }
type RoledBlock = Block & { role: string }

let b: typeof import('../../../../baml_client').b

beforeAll(async () => {
  b = (await import('../../../../baml_client')).b
})

const TOOLS = [
  { name: 'read_neo4j_cypher', description: 'Run a read-only Cypher query', args_schema: '{"query":"string"}' },
  { name: 'get_neo4j_schema', description: 'Fetch the graph schema' },
]
const REFS = [
  { ref_id: 'ev_1', tool: 'search', summary: 'Found 3 nodes about X' },
  { ref_id: 'ev_2', tool: 'fetch', summary: 'Page content about Y' },
]
const TURN_1 = {
  n: 1,
  reasoning: 'inspect the schema first',
  tool_call: { tool: 'get_neo4j_schema', args: '{}' },
  tool_result: { tool: 'get_neo4j_schema', success: true, result: '(Person)-[:KNOWS]->(Person)' },
}
const TURN_2 = {
  n: 2,
  tool_call: { tool: 'expandPreviousResult', args: 'ref:ev_1' },
  tool_result: { tool: 'expandPreviousResult', success: true, result: 'full node data' },
  expansions: [{ ref_id: 'ev_1', content: 'full content of the X nodes' }],
}
const TURN_3 = {
  n: 3,
  tool_call: { tool: 'read_neo4j_cypher', args: '{"query":"MATCH (n) RETURN n"}' },
  tool_result: { tool: 'read_neo4j_cypher', success: false, result: '', error: 'timeout' },
}
const HASH = 'abc123def456'

async function renderLoop(turns: unknown[]): Promise<Body> {
  const req = await b.request.LoopController(
    'find nodes about X', 'find nodes about X',
    TOOLS, turns as never, 'GRAPH SCHEMA:\n(Person)-[:KNOWS]->(Person)', REFS, undefined, HASH,
  )
  return req.body.json() as Body
}

/** All content blocks flattened, each tagged with its message's role. */
function blocks(body: Body): RoledBlock[] {
  return body.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.map((blk) => ({ ...blk, role: m.role })) : [])
}

function breakpoints(body: Body): RoledBlock[] {
  return blocks(body).filter((blk) => blk.cache_control)
}

describe('LoopController prompt-caching layout', () => {
  it('iteration 1 (no turns): two tier checkpoints, tail uncached, no assistant turns', async () => {
    const body = await renderLoop([])
    const all = blocks(body)
    expect(all).toHaveLength(3) // tier-1, tier-2, tail
    expect(all.every((blk) => blk.role === 'user')).toBe(true)

    const [tier1, tier2, tail] = all
    // tier-1: agent-static sections only
    expect(tier1.cache_control?.type).toBe('ephemeral')
    expect(tier1.text).toContain('AVAILABLE TOOLS')
    expect(tier1.text).toContain('CONTEXT')
    expect(tier1.text).not.toContain('INSTRUCTIONS')
    expect(tier1.text).not.toContain('ref:ev_1')
    // tier-2: run-static (hash, intent, instructions, refs + expansion affordance)
    expect(tier2.cache_control?.type).toBe('ephemeral')
    expect(tier2.text).toContain(`[input-hash ${HASH}`)
    expect(tier2.text).toContain('INSTRUCTIONS')
    expect(tier2.text).toContain('expandPreviousResult')
    expect(tier2.text).toContain('[ref:ev_1] search: Found 3 nodes about X')
    // volatile tail: turn counter + output format, never cached
    expect(tail.cache_control).toBeUndefined()
    expect(tail.text).toContain('Turn 1. Decide the next action.')
  })

  it('history renders as chronological assistant/user pairs', async () => {
    const body = await renderLoop([TURN_1, TURN_2, TURN_3])
    const roles = body.messages.map((m) => m.role)
    // [user(tiers), A1, U(r1), A2, U(r2), A3, U(r3 + tail)]
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'])

    const all = blocks(body)
    const a1 = all.find((blk) => blk.role === 'assistant')
    expect(a1?.text).toContain('Turn 1 action:')
    expect(a1?.text).toContain('Call: get_neo4j_schema')
    const r1 = all.find((blk) => blk.text?.includes('Turn 1 result:'))
    expect(r1?.role).toBe('user')
    expect(r1?.text).toContain('(Person)-[:KNOWS]->(Person)')
    // expansion content lands in the result block of the turn that expanded it
    const r2 = all.find((blk) => blk.text?.includes('Turn 2 result:'))
    expect(r2?.text).toContain('full content of the X nodes')
    // error turn carries the retry guidance
    const r3 = all.find((blk) => blk.text?.includes('Turn 3 result:'))
    expect(r3?.text).toContain('ERROR: timeout')
  })

  it('respects the 4-breakpoint budget: tiers + rolling on last two results', async () => {
    const body = await renderLoop([TURN_1, TURN_2, TURN_3])
    const bps = breakpoints(body)
    expect(bps).toHaveLength(4)
    expect(bps[0].text).toContain('AVAILABLE TOOLS')          // tier-1
    expect(bps[1].text).toContain(`[input-hash ${HASH}`)      // tier-2
    expect(bps[2].text).toContain('Turn 2 result:')           // rolling (second-to-last)
    expect(bps[3].text).toContain('Turn 3 result:')           // rolling (last)
    // turn 1's result is no longer checkpointed; the tail block never is
    const all = blocks(body)
    expect(all.find((blk) => blk.text?.includes('Turn 1 result:'))?.cache_control).toBeUndefined()
    expect(all[all.length - 1].text).toContain('Decide the next action')
    expect(all[all.length - 1].cache_control).toBeUndefined()
  })

  it('tier and history blocks are byte-identical across iterations (cache prefix holds)', async () => {
    const b0 = await renderLoop([])
    const b1 = await renderLoop([TURN_1])
    const b3 = await renderLoop([TURN_1, TURN_2, TURN_3])
    const [t1of0, t2of0] = blocks(b0)
    const [t1of1, t2of1] = blocks(b1)
    const [t1of3, t2of3] = blocks(b3)
    expect(t1of1.text).toBe(t1of0.text)
    expect(t1of3.text).toBe(t1of0.text)
    expect(t2of1.text).toBe(t2of0.text)
    expect(t2of3.text).toBe(t2of0.text)
    // turn-1 action/result blocks identical between renders (append-only history)
    const pick = (body: Body, needle: string) => blocks(body).find((blk) => blk.text?.includes(needle))?.text
    expect(pick(b3, 'Turn 1 action:')).toBe(pick(b1, 'Turn 1 action:'))
    expect(pick(b3, 'Turn 1 result:')).toBe(pick(b1, 'Turn 1 result:'))
    // system prompt identical
    expect(JSON.stringify(b3.system)).toBe(JSON.stringify(b0.system))
  })

  it('never renders expansion annotations into the stable refs list', async () => {
    // refs annotated as already-expanded (adapter still computes this field)
    const annotated = [
      { ref_id: 'ev_1', tool: 'search', summary: 'Found 3 nodes about X', expanded_in_turn: 2 },
      { ref_id: 'ev_2', tool: 'fetch', summary: 'Page content about Y', expanded_in_turn: null },
    ]
    const req = await b.request.LoopController(
      'q', 'q', TOOLS, [TURN_1, TURN_2] as never, undefined, annotated, undefined, HASH)
    const body = req.body.json() as Body
    const full = JSON.stringify(body.messages)
    expect(full).not.toContain('expanded in turn 2')
    // the frozen summary is still there
    expect(full).toContain('[ref:ev_1] search: Found 3 nodes about X')
  })
})

describe('ActorController prompt-caching layout', () => {
  const ATTEMPTS = [
    {
      n: 1,
      action: { reasoning: 'try a script', tool_name: 'code-mode', tool_args: '{"script":"return 1"}', status: 'success', is_final: false },
      result: 'got 1', error: null, feedback: 'not sufficient, need 2',
    },
    {
      n: 2,
      action: { reasoning: '', tool_name: 'code-mode', tool_args: '{"script":"return 2"}', status: 'error', is_final: false },
      result: '', error: 'boom', feedback: null,
    },
  ]

  async function renderActor(attempts: unknown[]): Promise<Body> {
    const req = await b.request.ActorController(
      'do the thing', 'do the thing', TOOLS, attempts as never,
      'ENABLED SERVERS: neo4j', undefined, attempts.length + 1, 3, HASH)
    return req.body.json() as Body
  }

  it('two tiers + assistant/user attempt pairs, ≤4 breakpoints', async () => {
    const body = await renderActor(ATTEMPTS)
    expect(breakpoints(body).length).toBeLessThanOrEqual(4)
    const roles = body.messages.map((m) => m.role)
    // [user(tiers), A1, U(r1), A2, U(r2 + tail)]
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])

    const [tier1, tier2] = blocks(body)
    // context is per-invocation (contextProvider) → tier-2, NOT tier-1
    expect(tier1.text).toContain('AVAILABLE TOOLS')
    expect(tier1.text).not.toContain('ENABLED SERVERS')
    expect(tier2.text).toContain('ENABLED SERVERS')
    expect(tier2.text).toContain(`[input-hash ${HASH}`)
    // critic feedback rides the result (user) block of its attempt
    const r1 = blocks(body).find((blk) => blk.text?.includes('Attempt 1 result:'))
    expect(r1?.role).toBe('user')
    expect(r1?.text).toContain('CRITIC FEEDBACK: not sufficient')
  })

  it('per-attempt BUDGET renders in the uncached volatile tail only', async () => {
    const body = await renderActor(ATTEMPTS)
    const all = blocks(body)
    const budgeted = all.filter((blk) => blk.text?.includes('BUDGET:'))
    expect(budgeted).toHaveLength(1)
    expect(budgeted[0].text).toContain('BUDGET: Attempt 3 of 3')
    expect(budgeted[0].cache_control).toBeUndefined()
    expect(all[all.length - 1]).toBe(budgeted[0]) // it IS the tail block
  })

  it('tier blocks are byte-identical across attempts', async () => {
    const b0 = await renderActor([])
    const b2 = await renderActor(ATTEMPTS)
    const [t1of0, t2of0] = blocks(b0)
    const [t1of2, t2of2] = blocks(b2)
    expect(t1of2.text).toBe(t1of0.text)
    expect(t2of2.text).toBe(t2of0.text)
  })
})
