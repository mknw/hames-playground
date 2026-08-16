/**
 * Prompt-caching render checks (#122) — offline, no network.
 *
 * Uses BAML's request builder (`b.request.*`) to render the exact Anthropic
 * HTTP body and asserts the cache-stability invariants the controller
 * templates (simpleLoop.baml / actorCritic.baml) must uphold.
 *
 * FUNCTIONS UNDER TEST (post-A/B; both are template_string compositions):
 *  - ActorController: request marker on call 1 (attempt_n gate) + one rolling
 *    marker on the newest attempt result; no system-block marker. Scheme
 *    settled by the live bench (~89% cached input, ~64% cost reduction).
 *  - LoopController (scheme B): 2 static tier markers + 2 rolling markers.
 *
 * NOTE ON SHAPE: BAML merges consecutive same-role prompt messages into ONE
 * API message with multiple `text` content blocks, and `cache_control` rides
 * the individual BLOCK (Anthropic's native breakpoint granularity). So the
 * stable tiers + the volatile tail can share one `user` message; the
 * invariants below are therefore asserted per-block. Two further wire facts,
 * both verified by render: markers ARE forwarded on the top-level `system`
 * param, and mid-conversation `_.role("system")` is coerced to `user`
 * (messages[] has no system role).
 *
 * Invariants asserted for both schemes:
 *  1. Breakpoint budget: ≤4 cache_control markers per request (Anthropic max).
 *  2. Placement: static markers unconditional (a marker is BOTH a read and a
 *     write point, so it must be re-declared every call); rolling markers on
 *     the last result block(s); the final tail block is NEVER marked.
 *  3. Byte-stability: marked prefix blocks are identical across iterations —
 *     anything else silently voids the cache.
 *  4. History renders as a real conversation: past actions are ASSISTANT
 *     messages, results are environment messages, chronologically interleaved.
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

async function renderLoop(turns: unknown[]): Promise<Body> {
  const req = await b.request.LoopController(
    'find nodes about X', 'find nodes about X',
    TOOLS, turns as never, 'GRAPH SCHEMA:\n(Person)-[:KNOWS]->(Person)', REFS, undefined,
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
    // tier-2: run-static (intent, instructions, refs + expansion affordance)
    expect(tier2.cache_control?.type).toBe("ephemeral")
    expect(tier2.text).toContain("INTENT:")
    expect(tier2.text).toContain('INSTRUCTIONS')
    expect(tier2.text).toContain('expandPreviousResult')
    expect(tier2.text).toContain('[ref:ev_1] search: Found 3 nodes about X')
    // volatile tail: turn counter + output format, never cached
    expect(tail.cache_control).toBeUndefined()
    // 0-indexed, matching the `n` the first turn is recorded under.
    expect(tail.text).toContain('Turn 0. Decide the next action.')
  })

  it('history renders as chronological assistant/user pairs', async () => {
    const body = await renderLoop([TURN_1, TURN_2, TURN_3])
    const roles = body.messages.map((m) => m.role)
    // [user(tiers), A1, U(r1), A2, U(r2), A3, U(r3 + tail)]
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'])

    const all = blocks(body)
    const a1 = all.find((blk) => blk.role === 'assistant')
    // Assistant turns replay the recorded action as ControllerAction JSON — the
    // shape the controller is asked to emit. See controller-history-format.test.ts.
    expect(JSON.parse(a1?.text ?? '{}')).toMatchObject({ tool_name: 'get_neo4j_schema' })
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
    expect(bps[1].text).toContain("INTENT:")               // tier-2
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
      'q', 'q', TOOLS, [TURN_1, TURN_2] as never, undefined, annotated, undefined)
    const body = req.body.json() as Body
    const full = JSON.stringify(body.messages)
    expect(full).not.toContain('expanded in turn 2')
    // the frozen summary is still there
    expect(full).toContain('[ref:ev_1] search: Found 3 nodes about X')
  })
})

// V1 scheme (settled by the live A/B bench) is now THE production scheme, so
// it is shape-asserted here: request marker on call 1 only, one rolling
// marker on the newest attempt result, NO system-block marker (cross-run
// static-head reuse is a still-open decision).
describe('ActorController prompt-caching layout (production scheme)', () => {
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
      'ENABLED SERVERS: neo4j', undefined, attempts.length + 1, 3)
    return req.body.json() as Body
  }

  function systemBlocks(body: Body): Block[] {
    return (body.system ?? []) as Block[]
  }

  it('exactly one marker per call: USER REQUEST on call 1, newest result after', async () => {
    const first = await renderActor([])
    expect(systemBlocks(first).some((blk) => blk.cache_control)).toBe(false) // no system marker in this scheme
    expect(breakpoints(first)).toHaveLength(1)
    expect(breakpoints(first)[0].text).toContain('USER REQUEST')

    const third = await renderActor(ATTEMPTS)
    expect(systemBlocks(third).some((blk) => blk.cache_control)).toBe(false)
    expect(breakpoints(third)).toHaveLength(1)
    expect(breakpoints(third)[0].text).toContain('Attempt 2 result:')
    expect(blocks(third).find((blk) => blk.text?.includes('USER REQUEST'))?.cache_control).toBeUndefined()
  })

  it('assistant/user attempt pairs; feedback rides its attempt result', async () => {
    const body = await renderActor(ATTEMPTS)
    const all = blocks(body)
    const a1 = all.find((blk) => blk.role === 'assistant')
    // Attempts replay as ControllerAction JSON, matching the requested shape.
    expect(JSON.parse(a1?.text ?? '{}')).toMatchObject({ tool_name: 'code-mode' })
    const r1 = all.find((blk) => blk.text?.includes('Attempt 1 result:'))
    expect(r1?.role).toBe('user') // authored as system, coerced on the wire
    expect(r1?.cache_control).toBeUndefined()
    expect(r1?.text).toContain('CRITIC FEEDBACK: not sufficient')
  })

  it('per-attempt BUDGET renders in the uncached volatile tail only', async () => {
    const body = await renderActor(ATTEMPTS)
    const all = blocks(body)
    const budgeted = all.filter((blk) => blk.text?.includes('BUDGET:'))
    expect(budgeted).toHaveLength(1)
    expect(budgeted[0].text).toContain('BUDGET: Attempt 3 of 3')
    expect(budgeted[0].cache_control).toBeUndefined()
    expect(all[all.length - 1]).toBe(budgeted[0])
  })

  it('marked prefix is byte-identical across attempts', async () => {
    const b0 = await renderActor([])
    const b1 = await renderActor(ATTEMPTS.slice(0, 1))
    const b2 = await renderActor(ATTEMPTS)
    expect(systemBlocks(b1)[0].text).toBe(systemBlocks(b0)[0].text)
    expect(systemBlocks(b2)[0].text).toBe(systemBlocks(b0)[0].text)
    // intent/context block and request block never change (compare text only —
    // the request block's marker legitimately differs between call 1 and 2+)
    expect(blocks(b1)[0].text).toBe(blocks(b0)[0].text)
    expect(blocks(b2)[0].text).toBe(blocks(b0)[0].text)
    const pick = (body: Body, needle: string) => blocks(body).find((blk) => blk.text?.includes(needle))?.text
    expect(pick(b2, 'USER REQUEST')).toBe(pick(b0, 'USER REQUEST'))
    expect(pick(b2, 'Attempt 1 action:')).toBe(pick(b1, 'Attempt 1 action:'))
    expect(pick(b2, 'Attempt 1 result:')).toBe(pick(b1, 'Attempt 1 result:'))
  })
})

type Render = (...a: unknown[]) => Promise<{ body: { json(): unknown } }>

// ---------------------------------------------------------------------------
// Tool-catalog separation (#122 whitespace pass). Regression for the
// inlining bug where a template line ending in a statement tag lost its
// newline and tool entries ran together ("…Args: {…}- next_tool"). Verified
// against the PROCESSED string, per review: every entry is blank-line
// separated, and the catalog is cleanly separated from the next section.
// ---------------------------------------------------------------------------
describe('tool catalog renders blank-line-separated entries (processed string)', () => {
  // Adjacent tools WITH and WITHOUT args_schema — the bug's trigger shape.
  const MIXED_TOOLS = [
    { name: 'tool_1', description: 'first tool', args_schema: '{"q":"string"}' },
    { name: 'tool_2', description: 'second tool' },
    { name: 'tool_3', description: 'third tool', args_schema: '{"x":"int"}' },
  ]

  it('LoopController: entries separated; Return entry not glued to the last tool', async () => {
    const req = await (b.request.LoopController as never as Render)('q', 'q', MIXED_TOOLS, [], 'CTX', undefined, undefined)
    const text = (blocks(req.body.json() as Body)[0].text ?? '')
    expect(text).toContain('- tool_1: first tool\n  Args: {"q":"string"}\n\n- tool_2: second tool')
    expect(text).toContain('- tool_2: second tool\n\n- tool_3: third tool')
    expect(text).toContain('Args: {"x":"int"}\n\n- Return:')
    expect(text).not.toMatch(/\S- tool_\d/) // nothing glued to an entry dash
  })

  it('ActorController: entries separated; critic paragraph not glued to the last tool', async () => {
    const req = await (b.request.ActorController as never as Render)('q', 'q', MIXED_TOOLS, [], 'CTX', undefined, 1, 3)
    const body = req.body.json() as Body
    const text = ((body.system as Block[] | undefined)?.[0]?.text ?? '')
    expect(text).toContain('- tool_1: first tool\n  Args: {"q":"string"}\n\n- tool_2: second tool')
    expect(text).toContain('Args: {"x":"int"}\n\nA critic decides')
    expect(text).not.toMatch(/\S- tool_\d/)
    expect(text).not.toContain('} \n') // the old trailing space after schemas
  })
})

// ---------------------------------------------------------------------------
// Multi-call turns (additional_calls). Three prompt modes gated by the
// agent-static `multi_call_mode` param: "parallel" | "sequential" | absent.
// Invariants: the affordance lives INSIDE the existing cached regions (tier-1
// for the loop, system block for the actor) without adding markers; absent
// mode renders byte-identical to the pre-feature layout; batch turns replay
// `additional_calls` in the assistant JSON in schema field order.
// ---------------------------------------------------------------------------
describe('multi-call affordance + batch turn rendering', () => {
  const BATCH_TURN = {
    n: 1,
    reasoning: 'two independent lookups',
    status: 'running both queries',
    tool_call: { tool: 'read_neo4j_cypher', args: '{"query":"MATCH (n) RETURN n"}' },
    additional_calls: [
      { tool_name: 'get_neo4j_schema', tool_args: '{}' },
      { tool_name: 'read_neo4j_cypher', tool_args: '{"query":"MATCH (m) RETURN m"}' },
    ],
    tool_result: {
      tool: 'read_neo4j_cypher',
      success: true,
      result: '{"1":{"tool":"read_neo4j_cypher","result":"rows"},"2":{"tool":"get_neo4j_schema","result":"(Person)"},"3":{"tool":"read_neo4j_cypher","__error":"timeout"}}',
    },
  }

  async function renderLoopMode(turns: unknown[], mode?: string): Promise<Body> {
    const req = await b.request.LoopController(
      'find nodes about X', 'find nodes about X',
      TOOLS, turns as never, 'GRAPH SCHEMA:\n(Person)-[:KNOWS]->(Person)', REFS, undefined, mode,
    )
    return req.body.json() as Body
  }

  it('parallel/sequential modes render mode-specific tier-1 guidance; absent mode renders none', async () => {
    const parallel = blocks(await renderLoopMode([], 'parallel'))[0]
    expect(parallel.text).toContain('MULTIPLE CALLS PER TURN')
    expect(parallel.text).toContain('CONCURRENTLY')
    expect(parallel.text).not.toContain('IN ORDER')

    const sequential = blocks(await renderLoopMode([], 'sequential'))[0]
    expect(sequential.text).toContain('MULTIPLE CALLS PER TURN')
    expect(sequential.text).toContain('IN ORDER')
    expect(sequential.text).toContain('the rest of the batch is\nskipped')
    expect(sequential.text).not.toContain('CONCURRENTLY')

    const absent = blocks(await renderLoopMode([]))[0]
    expect(absent.text).not.toContain('MULTIPLE CALLS PER TURN')
  })

  it('affordance adds no markers and stays byte-stable across iterations', async () => {
    const b0 = await renderLoopMode([], 'parallel')
    const b3 = await renderLoopMode([TURN_1, TURN_2, TURN_3], 'parallel')
    expect(blocks(b0)).toHaveLength(3)          // tier-1, tier-2, tail — unchanged
    expect(breakpoints(b0)).toHaveLength(2)     // two tier markers on iteration 1
    expect(breakpoints(b3)).toHaveLength(4)     // + two rolling markers later
    expect(blocks(b3)[0].text).toBe(blocks(b0)[0].text) // tier-1 byte-stable
  })

  it('batch turns replay additional_calls in the assistant JSON, in schema field order', async () => {
    const body = await renderLoopMode([BATCH_TURN], 'parallel')
    const a1 = blocks(body).find((blk) => blk.role === 'assistant')
    const parsed = JSON.parse(a1?.text ?? '{}')
    expect(parsed.additional_calls).toEqual([
      { tool_name: 'get_neo4j_schema', tool_args: '{}' },
      { tool_name: 'read_neo4j_cypher', tool_args: '{"query":"MATCH (m) RETURN m"}' },
    ])
    // Key order mirrors ControllerAction's field order — the shape the model
    // is asked to emit (exact-replay invariant).
    expect(Object.keys(parsed)).toEqual(
      ['reasoning', 'tool_name', 'tool_args', 'additional_calls', 'status', 'is_final'])
    // the combined keyed result renders in the turn's result block as-is
    const r1 = blocks(body).find((blk) => blk.text?.includes('Turn 1 result:'))
    expect(r1?.text).toContain('"__error":"timeout"')
  })

  it('singular turns render byte-identically with and without a mode (no additional_calls key)', async () => {
    const withMode = await renderLoopMode([TURN_1], 'parallel')
    const without = await renderLoopMode([TURN_1])
    const pick = (body: Body) => blocks(body).find((blk) => blk.role === 'assistant')?.text
    expect(pick(withMode)).toBe(pick(without))
    expect(pick(withMode)).not.toContain('additional_calls')
  })

  it('ActorController: affordance sits in the system block without adding a marker; batch attempts replay', async () => {
    const BATCH_ATTEMPT = {
      n: 1,
      action: {
        reasoning: 'write then run',
        tool_name: 'sandbox_write',
        tool_args: '{"path":"a.py","content":"print(1)"}',
        additional_calls: [{ tool_name: 'sandbox_bash', tool_args: '{"cmd":"python a.py"}' }],
        status: 'success',
        is_final: false,
      },
      result: '{"1":{"tool":"sandbox_write","result":"ok"},"2":{"tool":"sandbox_bash","result":"1"}}',
      error: null,
      feedback: null,
    }
    const req = await (b.request.ActorController as never as Render)(
      'q', 'q', TOOLS, [BATCH_ATTEMPT], 'CTX', undefined, 2, 3, 'sequential')
    const body = req.body.json() as Body
    const sys = ((body.system as Block[] | undefined) ?? [])
    expect(sys[0]?.text).toContain('MULTIPLE CALLS PER TURN')
    expect(sys[0]?.text).toContain('IN ORDER')
    expect(sys.some((blk) => blk.cache_control)).toBe(false) // still no system marker
    expect(breakpoints(body)).toHaveLength(1)                // rolling marker only
    const a1 = blocks(body).find((blk) => blk.role === 'assistant')
    const parsed = JSON.parse(a1?.text ?? '{}')
    expect(parsed.additional_calls).toEqual([{ tool_name: 'sandbox_bash', tool_args: '{"cmd":"python a.py"}' }])
    expect(Object.keys(parsed)).toEqual(
      ['reasoning', 'tool_name', 'tool_args', 'additional_calls', 'status', 'is_final'])
  })

  it('Critic renders batch attempts with per-call lines', async () => {
    const attempts = [{
      n: 1,
      action: {
        reasoning: 'batching',
        tool_name: 'read_neo4j_cypher',
        tool_args: '{"query":"MATCH (n) RETURN n"}',
        additional_calls: [{ tool_name: 'get_neo4j_schema', tool_args: '{}' }],
        status: 'running',
        is_final: false,
      },
      result: '{"1":{"result":"rows"},"2":{"result":"(Person)"}}',
      error: null, feedback: null,
    }]
    const req = await (b.request.Critic as never as Render)('intent', attempts)
    const body = req.body.json() as Body
    const full = JSON.stringify(body)
    expect(full).toContain('Also called (same attempt): get_neo4j_schema({})')
  })
})
