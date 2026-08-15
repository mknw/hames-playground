/**
 * Controller history format — the assistant turns in a controller prompt must
 * demonstrate the SAME shape the controller is asked to produce.
 *
 * Why this suite exists: `LoopController` / `ActorController` render past turns
 * as real ASSISTANT messages, i.e. as the model's own prior output. Continuing
 * the form of its previous messages is a stronger prior for a model than a
 * trailing format instruction, so when history was rendered as prose
 * (`Reasoning:` / `Call:` / `Args:`) the prompt held N demonstrations of one
 * vocabulary against one request for another. Observed live: a complete, correct
 * action emitted as prose, failing BAML with all five required fields "missing"
 * — 412 output tokens against a 32768 cap, so not a truncation. Because the
 * demonstrations accumulate one per turn while the instruction stays a single
 * line, deep loops are the most exposed.
 *
 * These assertions are the guard: every assistant block must parse as a
 * complete ControllerAction, and the legacy prose labels must not come back.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { normalizeControllerAction } from '../../../lib/harness-patterns/controller-action'

// b.request builds the HTTP body without sending; it still resolves the client,
// which needs the env var to exist.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'offline-render-test'

type Block = { type: string; text?: string }
type Msg = { role: string; content: Block[] | string }
type Body = { system?: unknown; messages: Msg[] }

let b: typeof import('../../../../baml_client').b

beforeAll(async () => {
  b = (await import('../../../../baml_client')).b
})

const TOOLS = [{ name: 'search', description: 'Search files', args_schema: '{"query":"string"}' }]

/** Args that would break naive string interpolation: quotes, backslash, newline. */
const NASTY_ARGS = '{"query":"say \\"hi\\"","path":"C:\\\\tmp","note":"line1\nline2"}'

const TURNS = [
  {
    n: 0,
    reasoning: 'search broadly first',
    status: 'Searching files',
    tool_call: { tool: 'search', args: '{"query":"budget"}' },
    tool_result: { tool: 'search', success: true, result: '3 hits' },
  },
  // No reasoning, no status — a turn serialized before those fields existed.
  {
    n: 1,
    tool_call: { tool: 'search', args: NASTY_ARGS },
    tool_result: { tool: 'search', success: true, result: '1 hit' },
  },
  // No tool_call at all — must still render a parseable action.
  {
    n: 2,
    reasoning: 'nothing to call',
    status: 'Thinking',
    tool_result: { tool: 'search', success: false, result: '', error: 'timeout' },
  },
]

const ATTEMPTS = [
  {
    n: 1,
    action: {
      reasoning: 'write the script',
      tool_name: 'write_file',
      tool_args: NASTY_ARGS,
      status: 'Writing',
      is_final: false,
    },
    result: 'written',
  },
  // is_final=true legitimately appears in actor history: the critic verifies and
  // can reject, so the loop continues after it.
  {
    n: 2,
    action: {
      reasoning: 'done',
      tool_name: 'run',
      tool_args: '{"cmd":"python x.py"}',
      status: 'Running',
      is_final: true,
    },
    result: 'ok',
    feedback: 'not verified yet — check the output',
  },
]

const ACTION_KEYS = ['reasoning', 'tool_name', 'tool_args', 'status', 'is_final'] as const

function assistantTexts(body: Body): string[] {
  const out: string[] = []
  for (const m of body.messages) {
    if (m.role !== 'assistant') continue
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    for (const blk of blocks) if (blk.text?.trim()) out.push(blk.text.trim())
  }
  return out
}

function allText(body: Body): string {
  return JSON.stringify(body)
}

describe('controller history renders as ControllerAction JSON', () => {
  it('LoopController: every assistant turn parses as a complete action', async () => {
    const req = await b.request.LoopController(
      'find the budget',
      'find the budget',
      TOOLS,
      TURNS as never,
      null,
      null,
      null,
    )
    const body = req.body.json() as Body
    const texts = assistantTexts(body)

    expect(texts).toHaveLength(TURNS.length)
    for (const text of texts) {
      const parsed = JSON.parse(text) as Record<string, unknown>
      expect(Object.keys(parsed).sort()).toEqual([...ACTION_KEYS].sort())
      expect(typeof parsed.reasoning).toBe('string')
      expect(typeof parsed.tool_name).toBe('string')
      expect(typeof parsed.tool_args).toBe('string')
      expect(typeof parsed.status).toBe('string')
      expect(typeof parsed.is_final).toBe('boolean')
    }
  })

  it('LoopController: tool_args survives quotes, backslashes and newlines intact', async () => {
    const req = await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, null)
    const body = req.body.json() as Body
    const args = assistantTexts(body).map((t) => (JSON.parse(t) as { tool_args: string }).tool_args)
    // Round-trips byte-for-byte: the escaping is done by the JSON serializer,
    // so a tool_args value cannot break out of its own string.
    expect(args).toContain(NASTY_ARGS)
  })

  it('LoopController: a completed turn is never advertised as final', async () => {
    // The loop breaks BEFORE recording a final action, so history is non-final
    // by construction; rendering `true` here would teach the model to end early.
    const req = await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, null)
    const body = req.body.json() as Body
    for (const text of assistantTexts(body)) {
      expect((JSON.parse(text) as { is_final: boolean }).is_final).toBe(false)
    }
  })

  it('ActorController: every attempt parses, and is_final comes from the data', async () => {
    const req = await b.request.ActorController(
      'build it',
      'build it',
      TOOLS,
      ATTEMPTS as never,
      null,
      null,
      3,
      5,
    )
    const body = req.body.json() as Body
    const parsed = assistantTexts(body).map((t) => JSON.parse(t) as Record<string, unknown>)

    expect(parsed).toHaveLength(ATTEMPTS.length)
    for (const p of parsed) expect(Object.keys(p).sort()).toEqual([...ACTION_KEYS].sort())
    // The critic rejected attempt 2 despite is_final — history must say so
    // rather than flattening it to false.
    expect(parsed.map((p) => p.is_final)).toEqual([false, true])
  })

  it('the legacy prose vocabulary is gone from both prompts', async () => {
    const loop = (
      await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, [
        { user: 'find X', reasoning: 'search', tool: 'search', args: '{"query":"X"}' },
      ])
    ).body.json() as Body
    const actor = (
      await b.request.ActorController(
        'x',
        'x',
        TOOLS,
        ATTEMPTS as never,
        null,
        [{ user: 'build X', reasoning: 'write', tool: 'write_file', args: '{}' }],
        3,
        5,
      )
    ).body.json() as Body

    for (const body of [loop, actor]) {
      const text = allText(body)
      // Prose action labels. `Call:`/`Args:`/`Tool:` were three different names
      // for fields the schema calls tool_name/tool_args.
      expect(text).not.toMatch(/Turn \d+ action:/)
      expect(text).not.toMatch(/Attempt \d+ action:/)
      expect(text).not.toMatch(/\\nCall: /)
      expect(text).not.toMatch(/\\nArgs: /)
      expect(text).not.toMatch(/\\n {4}Tool: /)
      // Result blocks keep their prose labels — they are environment messages,
      // not demonstrations of the model's output contract.
      expect(text).toMatch(/Turn \d+ result:|Attempt \d+ result:/)
    }
  })

  it('few-shots encode tool_args the same way the history does', async () => {
    // `tool_args` is a string whose CONTENT is JSON, so its inner quotes are
    // escaped. Rendered bare, a few-shot demonstrated `tool_args: {"query":...}`
    // while the assistant turn log demonstrated `"tool_args": "{\"query\":...}"`
    // — one field, two incompatible encodings, both in the same prompt. Live
    // failure: an action that opened escaped and closed bare
    // (`"{\"query\": \"MATCH ... LIMIT 20"}"`), terminating the string early and
    // failing BAML with status/is_final "missing" at 495 output tokens against a
    // 32768 cap — neither truncation nor an empty completion, so no retry branch
    // caught it and the loop lost two good turns of results.
    const args =
      '{"query":"MATCH (c:Concept) WHERE toLower(c.name) CONTAINS toLower($n)","params":{"n":"graph"}}'
    const fewShot = {
      user: 'find graph concepts',
      reasoning: 'substring search',
      tool: 'search',
      args,
    }

    const loop = (
      await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, [fewShot])
    ).body.json() as Body
    const actor = (
      await b.request.ActorController('x', 'x', TOOLS, ATTEMPTS as never, null, [fewShot], 3, 5)
    ).body.json() as Body

    for (const body of [loop, actor]) {
      const text = allText(body)
      // The example is present as a QUOTED, ESCAPED string — the exact form the
      // model must reproduce. `allText` is itself JSON, hence the doubling.
      expect(text).toContain(`tool_args: ${JSON.stringify(JSON.stringify(args)).slice(1, -1)}`)
      // ...and never as a bare object, which is what taught the wrong encoding.
      expect(text).not.toContain('tool_args: {')
    }
  })

  it('the turn counter agrees with the history it follows', async () => {
    // History is 0-indexed (`Turn 0 result`), so with N completed turns the ask
    // is for turn N. The previous `N + 1` skipped a number, inviting the model
    // to infer a turn it had never seen.
    const req = await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, null)
    const text = allText(req.body.json() as Body)
    expect(text).toContain(`Turn ${TURNS.length}. Decide the next action.`)
    expect(text).not.toContain(`Turn ${TURNS.length + 1}. Decide the next action.`)
  })
})

/**
 * The terminal action — the one shape the turn log can never demonstrate.
 *
 * `LoopTurnLog` renders `is_final` as a literal false because the loop breaks
 * BEFORE pushing a final action, so every example the model sees is a non-final
 * turn whose `status` describes a tool call it is about to make. The action that
 * ENDS the loop — and carries the answer — is undemonstrated by construction.
 *
 * Live consequence: a Return action with a 900-character composed answer, valid
 * JSON and 33 correctly-placed escapes, omitted `status` (no tool call, nothing
 * in progress) and failed with missing=1. The answer was discarded and the user
 * got "I hit a snag putting together the final summary."
 */
describe('the terminal Return action', () => {
  // Trimmed from the live failure; the omission of `status` is verbatim.
  const RETURNED_WITHOUT_STATUS = JSON.stringify({
    reasoning: 'No results for TraceFrom. I should report this rather than force a match.',
    tool_name: 'Return',
    tool_args:
      'I searched your OneDrive and all accessible SharePoint sites but found no\n\nfiles for a "TraceFrom" project. Did you mean "TraceForm" or "TReC"?',
    is_final: true,
  })

  it('parses when the model omits status', () => {
    // `status` is decorative — nothing reads it for control flow, and both UI
    // consumers already guard for absence. Required, it threw away a finished
    // answer over a field the system never needed.
    const action = b.parse.LoopController(RETURNED_WITHOUT_STATUS)
    expect(action.tool_name).toBe('Return')
    expect(action.is_final).toBe(true)
    expect(action.tool_args).toContain('TraceForm')
    expect(action.status ?? null).toBeNull()
  })

  it('still accepts a status when the model supplies one', () => {
    // Optional must not mean discouraged: non-final turns drive the progress UI.
    const action = b.parse.LoopController(
      JSON.stringify({
        reasoning: 'r',
        tool_name: 'search',
        tool_args: '{"query":"x"}',
        status: 'Searching files',
        is_final: false,
      }),
    )
    expect(action.status).toBe('Searching files')
  })

  it('the prompt describes the terminal shape, since history cannot', async () => {
    const req = await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, null)
    // Read the system blocks unescaped — `allText` is JSON, where every quote
    // in the instruction is backslashed and the phrasing is unmatchable.
    const body = req.body.json() as Body & { system?: Array<{ text?: string }> }
    const system = (body.system ?? []).map((s) => s.text ?? '').join('\n')

    // Names the three things a final turn must get right, and licenses the
    // omission rather than leaving the model to guess.
    expect(system).toMatch(/tool_name to "Return"/)
    expect(system).toMatch(/is_final to true/)
    expect(system).toMatch(/status.{0,40}omitted/)
  })
})

/**
 * The omitted `is_final` — third instance of the same class (#159).
 *
 * The failing call had nothing wrong with it: `AnthropicSonnet5NoThink`, 135
 * output tokens against a 32768 cap (so not truncation), one attempt (so no
 * retry branch matched), valid JSON, a real tool and correct args — and no
 * `is_final`. It was turn 0 of a fresh loop for an agent that passes no
 * few-shots, so `turns` was empty and `ctx.output_format` was the ONLY
 * description of the action shape in the whole prompt. BAML rejected the
 * response with missing=1, simpleLoop broke out of the loop, and the user got
 * an apology instead of the answer.
 *
 * `is_final` is `bool?` now, defaulting to false, and both patterns normalise
 * an absent value before anything reads it. Absence cannot terminate a loop:
 * `tool_name === 'Return'` remains the independent terminal signal.
 */
describe('an action that omits is_final', () => {
  // Verbatim from the failing call (issue #159).
  const OMITTED_IS_FINAL = JSON.stringify({
    reasoning:
      'I need to find what Denis Budin shared with the signed-in user. The graph_files_shared tool with shared_by filter is exactly for this.',
    tool_name: 'graph_files_shared',
    tool_args: '{"shared_by": "Denis Budin"}',
    status: 'Checking what Denis Budin has shared with you...',
  })

  it('LoopController parses it instead of discarding the turn', () => {
    const action = b.parse.LoopController(OMITTED_IS_FINAL)
    expect(action.tool_name).toBe('graph_files_shared')
    expect(JSON.parse(action.tool_args)).toEqual({ shared_by: 'Denis Budin' })
    expect(action.status).toBe('Checking what Denis Budin has shared with you...')
    // Absent in the response — the pattern, not the parser, supplies the default.
    expect(action.is_final ?? null).toBeNull()
  })

  it('normalisation defaults it to false, leaving the rest untouched', () => {
    const action = normalizeControllerAction(b.parse.LoopController(OMITTED_IS_FINAL))
    expect(action.is_final).toBe(false)
    expect(action.tool_name).toBe('graph_files_shared')
    expect(action.status).toBe('Checking what Denis Budin has shared with you...')
  })

  it('the normalised turn executes rather than terminating the loop', () => {
    const action = normalizeControllerAction(b.parse.LoopController(OMITTED_IS_FINAL))
    // simpleLoop.server.ts: `if (action.is_final || action.tool_name === 'Return')`.
    expect(action.is_final || action.tool_name === 'Return').toBe(false)
    // actorCritic.server.ts: `action.is_final === true` triggers the critic.
    // An omission must not read as "the actor says it's done".
    expect(action.is_final === true).toBe(false)
  })

  it('ActorController has the same exposure and the same defaulting', () => {
    // Both functions return the one `ControllerAction` class, so the actor can
    // omit the field for the same reason — fixed symmetrically.
    const action = normalizeControllerAction(b.parse.ActorController(OMITTED_IS_FINAL))
    expect(action.tool_name).toBe('graph_files_shared')
    expect(action.is_final).toBe(false)
  })

  it('an explicit value is never overwritten', () => {
    for (const is_final of [true, false]) {
      const parsed = b.parse.LoopController(
        JSON.stringify({ reasoning: 'r', tool_name: 'Return', tool_args: 'done', is_final }),
      )
      expect(normalizeControllerAction(parsed).is_final).toBe(is_final)
    }
  })

  it('the actor attempt log renders a boolean, never null', async () => {
    // Attempts are recorded from normalised actions, so this is a second line
    // of defence: history is the model's own prior output, and `null` there
    // would demonstrate a third value for a boolean field.
    const attempts = [
      { n: 1, action: { reasoning: 'r', tool_name: 'run', tool_args: '{}' }, result: 'ok' },
    ]
    const req = await b.request.ActorController(
      'x',
      'x',
      TOOLS,
      attempts as never,
      null,
      null,
      3,
      5,
    )
    const texts = assistantTexts(req.body.json() as Body)
    expect(texts).toHaveLength(1)
    expect((JSON.parse(texts[0]) as { is_final: unknown }).is_final).toBe(false)
  })

  it('the output format tells the model what an absent value means', async () => {
    // `ctx.output_format` was the only shape description present on the failing
    // call, and it said only when the value is TRUE. It now states the default.
    const req = await b.request.LoopController('x', 'x', TOOLS, [] as never, null, null, null)
    const text = allText(req.body.json() as Body)
    expect(text).toMatch(/an absent value is read as false/)
  })
})
