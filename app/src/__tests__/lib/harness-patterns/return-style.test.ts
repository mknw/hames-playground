/**
 * `returnStyle` (#149) — what the terminal `Return` carries, and who authors
 * the user-facing answer. Offline, no network.
 *
 * The change is prompt-level and therefore invisible to control-flow tests: the
 * loop still exits on `Return`, still writes no `data.response`, and the only
 * thing that moved is one sentence of static guidance. So the guards here are
 * (a) RENDER guards — the real Anthropic HTTP body, built by `b.request.*` and
 * never sent, must carry the summary wording by DEFAULT and the pre-#149
 * wording only under `returnStyle: 'answer'`; and (b) an AUTHOR guard — for a
 * representative `simpleLoop → compactExecution` chain, the assistant-visible
 * response must still come from `Synthesize`, and the loop's Return prose must
 * still reach its prompt nowhere. Note WHY it doesn't: the terminal iteration
 * IS handed to `Synthesize` (compactExecution fabricates a `tool_result` for
 * it, result `null`), and `compact-execution.baml` renders
 * `tool_result.tool` / `.result` only — never the `tool_call.args` the prose
 * lands in. That single omission is what makes the summary default safe.
 *
 * If someone re-widens the Return guidance, or starts rendering the Return
 * prose into the compactExecution prompt, one of these fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockCallTool, mockListTools, fixtures } from '../../mocks/mcp'
import type { SimpleLoopData } from '../../../lib/harness-patterns/patterns/simpleLoop.server'
import type { CompactExecutionData } from '../../../lib/harness-patterns/types'

/** The session-data shape a real agent uses (see `SessionData`): the union of
 *  what each pattern in the chain reads, plus the index signature `harness()`
 *  requires. */
interface TestData extends SimpleLoopData, CompactExecutionData {
  [key: string]: unknown
}

// b.request builds the HTTP body without sending; it still resolves the
// client, which needs the env var to exist.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'offline-render-test'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: mockCallTool({
    responses: { read_neo4j_cypher: fixtures.neo4j.queryResult },
  }),
  listTools: mockListTools(['read_neo4j_cypher', 'Return']),
}))

type Block = { type: string; text?: string; cache_control?: { type: string } }
type Msg = { role: string; content: Block[] | string }
type Body = { system?: Block[]; messages: Msg[] }

const TOOLS = [
  {
    name: 'read_neo4j_cypher',
    description: 'Run a read-only Cypher query',
    args_schema: '{"query":"string"}',
  },
]

/** The static head: the `system` param blocks, where the terminal-action
 *  guidance lives (mid-conversation `_.role("system")` is coerced to `user`,
 *  but a LEADING one is forwarded on the top-level `system` param). */
function systemText(body: Body): string {
  return (body.system ?? []).map((blk) => blk.text ?? '').join('\n')
}

function userBlocks(body: Body): Block[] {
  return body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
}

/** Everything the model reads, static head included. */
function wholePrompt(body: Body): string {
  return [systemText(body), ...userBlocks(body).map((blk) => blk.text ?? '')].join('\n')
}

const SUMMARY_SENTENCE = 'BRIEF completion summary in tool_args'
const ANSWER_SENTENCE = 'put the complete answer in tool_args as'

describe('LoopController prompt — terminal-action guidance (#149)', () => {
  /** Render the real request body for one `return_style` value. `undefined` is
   *  the important case: a bare `b.LoopController.bind(b)` controller, or any
   *  caller predating #149, passes nothing and must still get the default. */
  async function render(returnStyle?: string): Promise<Body> {
    const { b } = await import('../../../../baml_client')
    const req = await b.request.LoopController(
      'list the people',
      'list the people',
      TOOLS,
      [],
      'GRAPH SCHEMA:\n(Person)',
      undefined,
      undefined,
      undefined,
      undefined,
      returnStyle,
    )
    return req.body.json() as Body
  }

  it('defaults to the summary wording when no style is passed', async () => {
    const body = await render()
    expect(systemText(body)).toContain(SUMMARY_SENTENCE)
    expect(wholePrompt(body)).not.toContain(ANSWER_SENTENCE)
  })

  it("'summary' renders the same guidance as the default", async () => {
    expect(systemText(await render('summary'))).toBe(systemText(await render()))
  })

  // "verbatim" of the SYSTEM block only: the tier-1 catalog line tightened from
  // "final answer or summary" to "final answer" under this style.
  it("'answer' restores the pre-#149 guidance, and only that", async () => {
    const body = await render('answer')
    expect(systemText(body)).toContain(ANSWER_SENTENCE)
    expect(wholePrompt(body)).not.toContain(SUMMARY_SENTENCE)
  })

  it('the tool catalog advertises Return consistently with the style', async () => {
    const summaryTier1 = userBlocks(await render())[0].text ?? ''
    const answerTier1 = userBlocks(await render('answer'))[0].text ?? ''
    expect(summaryTier1).toContain('- Return: Signal task completion (tool_args = brief completion')
    expect(answerTier1).toContain('- Return: Signal task completion (tool_args = final answer)')
  })

  it('the guidance stays in the cacheable head — never in the volatile tail', async () => {
    const blocks = userBlocks(await render())
    // The tail is the last block: "Turn N. Decide the next action." + the
    // output format. It is never cache-marked, so guidance there would be
    // re-sent at full price every turn.
    const tail = blocks[blocks.length - 1]
    expect(tail.text).toContain('Decide the next action')
    expect(tail.cache_control).toBeUndefined()
    expect(tail.text).not.toContain('completion summary')
    // ...and the block that DOES carry it is the marked static head.
    expect(systemText(await render())).toContain(SUMMARY_SENTENCE)
  })
})

// ---------------------------------------------------------------------------
// The wiring: config → adapter → prompt, driven through the REAL simpleLoop.
// ---------------------------------------------------------------------------

const captured: Body[] = []
const SYNTH_ANSWER = 'The synthesizer wrote this.'
const RETURN_PROSE = 'LOOP-PROSE-SENTINEL: three people, all in Brussels.'

/** Load the real patterns with `b` stubbed: each controller/synth call renders
 *  the real HTTP body (never sent), records it, and returns a scripted value. */
async function loadHarness() {
  const actual =
    await vi.importActual<typeof import('../../../../baml_client')>('../../../../baml_client')

  const loopScript = [
    {
      reasoning: 'query the graph',
      tool_name: 'read_neo4j_cypher',
      tool_args: '{"query":"MATCH (n) RETURN n"}',
      status: 'working',
      is_final: false,
    },
    {
      reasoning: 'done',
      tool_name: 'Return',
      tool_args: RETURN_PROSE,
      status: 'done',
      is_final: true,
    },
  ]
  let loopCall = 0

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
      Synthesize: async (...args: unknown[]) => {
        const req = await (
          actual.b.request.Synthesize as (...a: unknown[]) => Promise<{ body: { json(): unknown } }>
        )(...args)
        captured.push(req.body.json() as Body)
        return SYNTH_ANSWER
      },
    },
  }))

  const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
  const { compactExecution } =
    await import('../../../lib/harness-patterns/patterns/compactExecution.server')
  const { harness } = await import('../../../lib/harness-patterns/harness.server')
  const { createLoopControllerAdapter } =
    await import('../../../lib/harness-patterns/baml-adapters.server')
  return { simpleLoop, compactExecution, harness, createLoopControllerAdapter }
}

type Harness = Awaited<ReturnType<typeof loadHarness>>

function makeLoop(h: Harness, returnStyle?: 'summary' | 'answer') {
  return h.simpleLoop<TestData>(
    h.createLoopControllerAdapter(['read_neo4j_cypher'], 'GRAPH SCHEMA: (Person)'),
    ['read_neo4j_cypher'],
    { patternId: 'return-style-loop', maxTurns: 4, ...(returnStyle ? { returnStyle } : {}) },
  )
}

/** A representative agent: one loop, one compactExecution — the shape every
 *  registered simpleLoop agent has (microsoft-365 is exactly this). */
async function runAgent(returnStyle?: 'summary' | 'answer') {
  const h = await loadHarness()
  const synth = h.compactExecution<TestData>({ mode: 'thread', patternId: 'response-synth' })
  return h.harness(makeLoop(h, returnStyle), synth)('list the people')
}

beforeEach(() => {
  captured.length = 0
  vi.clearAllMocks()
  vi.resetModules()
})

describe('simpleLoop wiring — the default reaches the wire (#149)', () => {
  it('a loop with NO returnStyle config sends the summary guidance every turn', async () => {
    await runAgent()
    const loopBodies = captured.filter((b) => systemText(b).includes('accomplishes tasks'))
    expect(loopBodies.length).toBeGreaterThanOrEqual(2)
    for (const body of loopBodies) {
      expect(systemText(body)).toContain(SUMMARY_SENTENCE)
      expect(wholePrompt(body)).not.toContain(ANSWER_SENTENCE)
    }
  })

  it("returnStyle: 'answer' opts a loop back into composing the full answer", async () => {
    await runAgent('answer')
    const loopBodies = captured.filter((b) => systemText(b).includes('accomplishes tasks'))
    expect(loopBodies.length).toBeGreaterThanOrEqual(2)
    for (const body of loopBodies) {
      expect(systemText(body)).toContain(ANSWER_SENTENCE)
    }
  })
})

describe('compactExecution stays the sole author (#149)', () => {
  it('the assistant-visible response is the synthesizer’s, not the Return prose', async () => {
    const result = await runAgent()
    expect(result.response).toBe(SYNTH_ANSWER)

    const finalMessages = result.context.events.filter(
      (e) => e.type === 'assistant_message' && (e.data as { final?: boolean }).final,
    )
    expect(finalMessages).toHaveLength(1)
    expect((finalMessages[0].data as { content: string }).content).toBe(SYNTH_ANSWER)
  })

  it('the Return prose reaches the Synthesize prompt nowhere', async () => {
    await runAgent()
    // The terminal action IS handed to compactExecution, and its turn DOES pass
    // the `{% if turn.tool_result %}` gate — compactExecution fabricates a
    // result (`null`) for it, so it renders as `Tool: Return / Result: null`.
    // The prose survives nowhere purely because compact-execution.baml never
    // renders `tool_call.args`. Rendering them (#149 §2) would revive the
    // double-composition this issue removed, and this is the assertion that
    // would catch it.
    const synthBodies = captured.filter((b) => systemText(b).includes('user-friendly response'))
    expect(synthBodies).toHaveLength(1)
    expect(wholePrompt(synthBodies[0])).not.toContain('LOOP-PROSE-SENTINEL')
    // ...while the tool result it composes FROM is there.
    expect(wholePrompt(synthBodies[0])).toContain('read_neo4j_cypher')
  })

  it('the loop ALONE writes no data.response — passthrough is not built (Option B)', async () => {
    // Asserted on a chain with NO compactExecution, deliberately: run the two
    // together and the synth overwrites `response`/`synthesizedResponse`
    // whatever the loop put there, so a passthrough wired into the loop would
    // pass unnoticed. Here the loop is the only writer there is.
    const h = await loadHarness()
    const result = await h.harness(makeLoop(h))('list the people')
    expect((result.context.data as { response?: string }).response).toBeUndefined()
    expect(result.response).toBe('')
    // ...and the terminal action was still committed, so nothing was lost.
    expect(
      (result.context.data as { lastAction?: { tool_args?: string } }).lastAction?.tool_args,
    ).toBe(RETURN_PROSE)
  })

  it('the compactExecution is the writer of data.response', async () => {
    const result = await runAgent()
    const data = result.context.data as { response?: string; synthesizedResponse?: string }
    expect(data.response).toBe(SYNTH_ANSWER)
    expect(data.synthesizedResponse).toBe(SYNTH_ANSWER)
  })
})
