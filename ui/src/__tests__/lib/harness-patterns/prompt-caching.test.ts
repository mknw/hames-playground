/**
 * Prompt-caching render checks (#122) — offline, no network.
 *
 * Uses BAML's request builder (`b.request.*`) to render the exact Anthropic
 * HTTP body and asserts the cache-stability invariants the controller
 * templates (simpleLoop.baml / actorCritic.baml) must uphold.
 *
 * VARIANTS UNDER TEST (#122 A/B — the live bench decides the winner):
 *  - ActorControllerV2 (actorCritic_v2.baml): cookbook Example-3 shape — one
 *    breakpoint on the system block + one rolling breakpoint on the last
 *    PERSISTENT block (USER REQUEST on call 1, newest attempt result after).
 *    Asserted here. Production still calls ActorController (V1) — the
 *    user-authored experimental arm, measured by the live bench only and
 *    deliberately NOT shape-asserted by tests.
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

// V2 is the bench arm this suite asserts. Production's ActorController (V1,
// actorCritic.baml) is the user-authored experimental arm: measured by the
// live bench (src/__tests__/bench/), deliberately not shape-asserted here.
describe('ActorControllerV2 prompt-caching layout', () => {
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
    const req = await b.request.ActorControllerV2(
      'do the thing', 'do the thing', TOOLS, attempts as never,
      'ENABLED SERVERS: neo4j', undefined, attempts.length + 1, 3)
    return req.body.json() as Body
  }

  /** V2's static marker rides the top-level `system` param, not messages[]. */
  function systemBlocks(body: Body): Block[] {
    return (body.system ?? []) as Block[]
  }

  it('static requirements live in the system param and carry the static marker', async () => {
    const body = await renderActor(ATTEMPTS)
    const sys = systemBlocks(body)
    expect(sys).toHaveLength(1)
    expect(sys[0].text).toContain('AVAILABLE TOOLS')
    expect(sys[0].cache_control?.type).toBe('ephemeral')
    // run-static content stays in messages[] and is NOT separately marked
    const [intentBlk] = blocks(body)
    expect(intentBlk.text).toContain('USER INTENT:')
    expect(intentBlk.text).toContain('ENABLED SERVERS') // context rides the intent block
    expect(intentBlk.cache_control).toBeUndefined()
    expect(sys[0].text).not.toContain('ENABLED SERVERS')
  })

  it('two markers on every call: system + last persistent block', async () => {
    const counts = await Promise.all(
      [0, 1, 2].map(async (n) => {
        const body = await renderActor(ATTEMPTS.slice(0, n))
        const inSystem = systemBlocks(body).filter((blk) => blk.cache_control).length
        return inSystem + breakpoints(body).length
      }))
    expect(counts).toEqual([2, 2, 2])
  })

  it('the rolling marker sits on USER REQUEST at call 1, then moves to the newest result', async () => {
    // call 1: no attempts yet — the request block is the last persistent block
    const first = await renderActor([])
    expect(breakpoints(first)).toHaveLength(1)
    expect(breakpoints(first)[0].text).toContain('USER REQUEST')
    // call 3: marker moved onto the newest result; request no longer marked
    const third = await renderActor(ATTEMPTS)
    expect(breakpoints(third)).toHaveLength(1)
    expect(breakpoints(third)[0].text).toContain('Attempt 2 result:')
    expect(blocks(third).find((blk) => blk.text?.includes('USER REQUEST'))?.cache_control).toBeUndefined()
  })

  it('assistant/user attempt pairs; older results unmarked (covered by prefix matching)', async () => {
    const body = await renderActor(ATTEMPTS)
    const all = blocks(body)
    const a1 = all.find((blk) => blk.role === 'assistant')
    expect(a1?.text).toContain('Attempt 1 action:')
    const r1 = all.find((blk) => blk.text?.includes('Attempt 1 result:'))
    const r2 = all.find((blk) => blk.text?.includes('Attempt 2 result:'))
    expect(r1?.role).toBe('user')
    expect(r1?.cache_control).toBeUndefined()
    expect(r2?.cache_control?.type).toBe('ephemeral')
    // critic feedback rides the result block of its attempt
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

  it('marked prefix is byte-identical across attempts', async () => {
    const b0 = await renderActor([])
    const b1 = await renderActor(ATTEMPTS.slice(0, 1))
    const b2 = await renderActor(ATTEMPTS)
    // system block (the static marker's prefix) never changes
    expect(systemBlocks(b1)[0].text).toBe(systemBlocks(b0)[0].text)
    expect(systemBlocks(b2)[0].text).toBe(systemBlocks(b0)[0].text)
    // run-static intent/context/request block never changes
    expect(blocks(b1)[0].text).toBe(blocks(b0)[0].text)
    expect(blocks(b2)[0].text).toBe(blocks(b0)[0].text)
    // attempt-1 pair identical once attempt 2 is appended (append-only history)
    const pick = (body: Body, needle: string) => blocks(body).find((blk) => blk.text?.includes(needle))?.text
    expect(pick(b2, 'Attempt 1 action:')).toBe(pick(b1, 'Attempt 1 action:'))
    expect(pick(b2, 'Attempt 1 result:')).toBe(pick(b1, 'Attempt 1 result:'))
  })
})

// ---------------------------------------------------------------------------
// V3 ≡ V2 (#122 DX refactor): ActorControllerV3 is ActorControllerV2 decomposed
// into template_strings. The refactor is ONLY legitimate while the rendered
// request stays byte-identical — same blocks, same text, same cache_control.
// This is the proof; if a section edit in actorCritic_v3.baml breaks it, the
// cache behavior changed and the two no longer share cache entries.
// ---------------------------------------------------------------------------
describe('ActorControllerV3 renders byte-identical requests to V2', () => {
  const FEW_SHOTS = [
    { user: 'count the nodes', reasoning: 'plain count', tool: 'read_neo4j_cypher', args: '{"query":"MATCH (n) RETURN count(n)"}' },
  ]
  // Branch coverage: reasoning present/empty, feedback present/absent,
  // success/error results, tools with/without args_schema.
  const RICH_ATTEMPTS = [
    { n: 1, action: { reasoning: 'try a script', tool_name: 'code-mode', tool_args: '{"script":"return 1"}', status: 'success', is_final: false }, result: 'got 1', error: null, feedback: 'not sufficient' },
    { n: 2, action: { reasoning: '', tool_name: 'code-mode', tool_args: '{"script":"return 2"}', status: 'error', is_final: false }, result: '', error: 'boom', feedback: null },
    { n: 3, action: { reasoning: 'retry smaller', tool_name: 'code-mode', tool_args: '{"script":"return 3"}', status: 'success', is_final: false }, result: 'got 3', error: null, feedback: null },
  ]

  const CASES: Array<[string, unknown[], string | undefined, unknown[] | undefined]> = [
    ['no attempts, context, no few-shots', [], 'ENABLED SERVERS: neo4j', undefined],
    ['no attempts, no context, few-shots', [], undefined, FEW_SHOTS],
    ['1 attempt', RICH_ATTEMPTS.slice(0, 1), 'ENABLED SERVERS: neo4j', FEW_SHOTS],
    ['2 attempts (error branch)', RICH_ATTEMPTS.slice(0, 2), 'ENABLED SERVERS: neo4j', FEW_SHOTS],
    ['3 attempts', RICH_ATTEMPTS, 'ENABLED SERVERS: neo4j', FEW_SHOTS],
  ]

  it.each(CASES)('%s', async (_label, attempts, context, fewShots) => {
    const args = ['do the thing', 'do the thing', TOOLS, attempts, context, fewShots, attempts.length + 1, 3]
    type Render = (...a: unknown[]) => Promise<{ body: { json(): unknown } }>
    const v2 = (await (b.request.ActorControllerV2 as never as Render)(...args)).body.json()
    const v3 = (await (b.request.ActorControllerV3 as never as Render)(...args)).body.json()
    expect(JSON.stringify(v3)).toBe(JSON.stringify(v2))
  })
})

// ---------------------------------------------------------------------------
// Template-string twins (#122 DX pass): LoopControllerV2 ≡ LoopController and
// ActorControllerV4 ≡ ActorController (the production V1 scheme). Same rule
// as V3 ≡ V2: the refactor is only legitimate while the rendered request is
// byte-identical — blocks, text, and cache_control alike. Passing also proves
// the {# … #} section comments in the twins contribute zero bytes.
// ---------------------------------------------------------------------------
type Render = (...a: unknown[]) => Promise<{ body: { json(): unknown } }>

describe('LoopControllerV2 renders byte-identical requests to LoopController', () => {
  const FEW_SHOTS = [
    { user: 'count the nodes', reasoning: 'plain count', tool: 'read_neo4j_cypher', args: '{"query":"MATCH (n) RETURN count(n)"}' },
  ]
  const CASES: Array<[string, unknown[], string | undefined, unknown[] | undefined, unknown[] | undefined]> = [
    ['no turns, context + refs + few-shots', [], 'GRAPH SCHEMA: (Person)', REFS, FEW_SHOTS],
    ['no turns, bare (no context/refs/few-shots)', [], undefined, undefined, undefined],
    ['1 turn', [TURN_1], 'GRAPH SCHEMA: (Person)', REFS, undefined],
    ['3 turns (expansion + error branches)', [TURN_1, TURN_2, TURN_3], 'GRAPH SCHEMA: (Person)', REFS, FEW_SHOTS],
  ]
  it.each(CASES)('%s', async (_label, turns, context, refs, fewShots) => {
    const args = ['find nodes', 'find nodes', TOOLS, turns, context, refs, fewShots]
    const prod = (await (b.request.LoopController as never as Render)(...args)).body.json()
    const twin = (await (b.request.LoopControllerV2 as never as Render)(...args)).body.json()
    expect(JSON.stringify(twin)).toBe(JSON.stringify(prod))
  })
})

describe('ActorControllerV4 renders byte-identical requests to ActorController', () => {
  const FEW_SHOTS = [
    { user: 'do it', reasoning: 'directly', tool: 'code-mode', args: '{"script":"return 1"}' },
  ]
  const RICH = [
    { n: 1, action: { reasoning: 'try a script', tool_name: 'code-mode', tool_args: '{"s":1}', status: 'success', is_final: false }, result: 'got 1', error: null, feedback: 'not sufficient' },
    { n: 2, action: { reasoning: '', tool_name: 'code-mode', tool_args: '{"s":2}', status: 'error', is_final: false }, result: '', error: 'boom', feedback: null },
    { n: 3, action: { reasoning: 'smaller', tool_name: 'code-mode', tool_args: '{"s":3}', status: 'success', is_final: false }, result: 'got 3', error: null, feedback: null },
  ]
  const CASES: Array<[string, unknown[], string | undefined, unknown[] | undefined]> = [
    ['call 1 (request marker fires), context + few-shots', [], 'ENABLED SERVERS: neo4j', FEW_SHOTS],
    ['call 1, bare', [], undefined, undefined],
    ['call 2 (rolling marker on newest result)', RICH.slice(0, 1), 'ENABLED SERVERS: neo4j', FEW_SHOTS],
    ['call 3 (error + feedback branches)', RICH.slice(0, 2), 'ENABLED SERVERS: neo4j', undefined],
    ['call 4 (full history)', RICH, 'ENABLED SERVERS: neo4j', FEW_SHOTS],
  ]
  it.each(CASES)('%s', async (_label, attempts, context, fewShots) => {
    const args = ['do the thing', 'do the thing', TOOLS, attempts, context, fewShots, attempts.length + 1, 4]
    const prod = (await (b.request.ActorController as never as Render)(...args)).body.json()
    const twin = (await (b.request.ActorControllerV4 as never as Render)(...args)).body.json()
    expect(JSON.stringify(twin)).toBe(JSON.stringify(prod))
  })
})

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
    expect(text).toContain('Args: {"x":"int"}\n\nThe critic evaluates')
    expect(text).not.toMatch(/\S- tool_\d/)
    expect(text).not.toContain('} \n') // the old trailing space after schemas
  })
})
