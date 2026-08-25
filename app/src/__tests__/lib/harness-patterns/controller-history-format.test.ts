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

/** Every rendered text block, system and messages alike, unescaped. */
function textBlocks(body: Body): string[] {
  const out: string[] = []
  for (const s of (body.system ?? []) as Array<{ text?: string }>) if (s?.text) out.push(s.text)
  for (const m of body.messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    for (const blk of blocks) if (blk.text) out.push(blk.text)
  }
  return out
}

/** The EXAMPLES section, from its heading to the end of the block it lives in.
 *  The actor renders it into the static system head; the loop renders it into
 *  the agent-static tier-1 user message. Either way it is ONE block, which is
 *  what makes it separable from `ctx.output_format`. */
function examplesSection(body: Body): string {
  const block = textBlocks(body).find((t) => t.includes('EXAMPLES (illustrative'))
  expect(block, 'the rendered prompt has no EXAMPLES section').toBeTruthy()
  return (block as string).slice((block as string).indexOf('EXAMPLES (illustrative'))
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

  it('few-shots demonstrate the same JSON envelope the history does', async () => {
    // The example's SHAPE, not just its field names. A few-shot rendered as
    // brace-less `reasoning:` / `tool_name:` / `tool_args:` lines got copied
    // line for line into a response: complete, correct, and unparseable
    // (`.harness-logs/baml-validation.json` — `sandbox-session-loop`, 372 output
    // tokens against a 32768 cap, so neither truncation nor an empty
    // completion). The model also invented a YAML `additional_calls:` bullet
    // list, a field the old form demonstrated nowhere. BAML's jsonish parser
    // found the embedded `tool_args` objects instead and tried each as a
    // ControllerAction — "in 3 items", each `missing=3` — and the throw killed
    // the loop with three attempts still in budget.
    //
    // `tool_args` is a string whose CONTENT is JSON, so its inner quotes stay
    // escaped inside the envelope: the earlier bare rendering demonstrated
    // `tool_args: {"query":...}` against the turn log's
    // `"tool_args": "{\"query\":...}"` — one field, two incompatible encodings
    // in one prompt. Both properties are asserted here by PARSING the example.
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
      // Scoped to the EXAMPLES section: it sits in the system block for the
      // actor and in the tier-1 user block for the loop, and `ctx.output_format`
      // — which legitimately renders `reasoning: string` as a schema line — is
      // always a different block, so the negative assertions below stay honest.
      const section = examplesSection(body)
      const line = section
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('{'))
      expect(line, 'no JSON-object example found in the rendered prompt').toBeTruthy()

      const parsed = JSON.parse(line as string) as Record<string, unknown>
      // A COMPLETE action: `status` is optional (#144) and legitimately absent,
      // exactly as it is on the terminal Return turn.
      expect(parsed.reasoning).toBe('substring search')
      expect(parsed.tool_name).toBe('search')
      expect(parsed.tool_args).toBe(args) // quoted + escaped, byte-for-byte
      expect(parsed.is_final).toBe(false)

      // The brace-less form must not come back in any of its three fields.
      expect(section).not.toMatch(/^\s*reasoning: /m)
      expect(section).not.toMatch(/^\s*tool_name: /m)
      expect(section).not.toMatch(/^\s*tool_args: /m)
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

  it('the output format tells BOTH models what an absent value means', async () => {
    // `ctx.output_format` was the only shape description present on the failing
    // call, and it said only when the value is TRUE. It now states the default —
    // and it must say so in both prompts, because one ControllerAction class
    // serves both patterns.
    const loop = await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, null)
    const actor = await b.request.ActorController(
      'x',
      'x',
      TOOLS,
      ATTEMPTS as never,
      null,
      null,
      3,
      5,
    )
    for (const req of [loop, actor]) {
      expect(allText(req.body.json() as Body)).toContain('an absent value is read as false')
    }
  })

  it("the shared description does not tie is_final to simpleLoop's Return", async () => {
    // One class, two patterns with different terminal shapes: simpleLoop
    // finishes with `tool_name: 'Return'`, while the actor has no Return at all
    // (the allowlist rejects it) and sets is_final only to summon the critic,
    // which owns the exit. A description naming `Return` renders into the
    // ACTOR's output format too and makes its one critic trigger unsatisfiable,
    // so the terminal shape belongs to each prompt's own spine and the shared
    // field description stays pattern-neutral.
    const actor = await b.request.ActorController(
      'x',
      'x',
      TOOLS,
      ATTEMPTS as never,
      null,
      null,
      3,
      5,
    )
    const raw = allText(actor.body.json() as Body)
    const start = raw.indexOf('Set to true on the turn')
    expect(start).toBeGreaterThan(-1)
    const END = 'the loop continues.'
    const description = raw.slice(start, raw.indexOf(END, start) + END.length)
    expect(description).not.toContain('Return')

    // simpleLoop's own spine still carries the Return-specific instruction, so
    // nothing was lost by taking it out of the shared description.
    const loop = await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, null)
    const loopRaw = allText(loop.body.json() as Body)
    expect(loopRaw).toContain('set tool_name to')
    expect(loopRaw).toContain('set is_final to true')
  })
})

/**
 * SA-C1 (prompt half) — the critic's reason has to be VISIBLE, and the
 * imperative that references it must not fire without it.
 *
 * `ActorAttemptLog` has always carried a `CRITIC FEEDBACK` block, but the
 * adapters hardcoded `feedback: undefined`, so it was dead code — while
 * `ActorClosing` rendered "You MUST address the critic's feedback" on every
 * call that had any attempt history at all. One prompt, an unsatisfiable
 * instruction and nothing to satisfy it with.
 */
describe('the critic feedback channel', () => {
  const REASON = 'the script wrote the file but never ran it'
  const REJECTED = [
    {
      n: 1,
      action: {
        reasoning: 'write it',
        tool_name: 'write_file',
        tool_args: '{"path":"x.py"}',
        status: 'Writing',
        is_final: true,
      },
      result: 'written',
      feedback: REASON,
    },
  ]
  const UNJUDGED = [{ ...REJECTED[0], feedback: undefined }]

  async function actorText(attempts: unknown[]): Promise<string> {
    const req = await b.request.ActorController(
      'x',
      'x',
      TOOLS,
      attempts as never,
      null,
      null,
      2,
      5,
    )
    const body = req.body.json() as Body
    // Unescaped: the blocks are rendered text, not JSON-quoted instructions.
    const msgs = body.messages.flatMap((m) =>
      typeof m.content === 'string' ? [m.content] : m.content.map((blk) => blk.text ?? ''),
    )
    return [JSON.stringify(body.system ?? ''), ...msgs].join('\n')
  }

  it('renders the reason beside the attempt it judged', async () => {
    expect(await actorText(REJECTED)).toContain(`CRITIC FEEDBACK: ${REASON}`)
  })

  it('demands the actor address it only when there is one to address', async () => {
    expect(await actorText(REJECTED)).toMatch(/MUST address the CRITIC FEEDBACK/)
    // An attempt the critic never judged (cadence skip, or a tool that failed
    // before the critic ran) carries no feedback — so no imperative.
    const unjudged = await actorText(UNJUDGED)
    expect(unjudged).not.toMatch(/MUST address/)
    // The half that never depended on feedback survives.
    expect(unjudged).toContain('Do not repeat failed approaches.')
  })

  it('says nothing about feedback on the first attempt', async () => {
    const first = await actorText([])
    expect(first).not.toMatch(/MUST address/)
    expect(first).not.toMatch(/Do not repeat failed approaches/)
  })

  it('the shared tool_name description does not tell the actor to call Return', async () => {
    // SA-M3, same class as the is_final case above: one ControllerAction serves
    // both patterns, and the actor's allowlist REJECTS 'Return' — so a shared
    // description naming it spends an attempt on "Tool not allowed".
    const raw = allText(
      (
        await b.request.ActorController('x', 'x', TOOLS, ATTEMPTS as never, null, null, 3, 5)
      ).body.json() as Body,
    )
    const start = raw.indexOf('Name of the tool to call')
    expect(start).toBeGreaterThan(-1)
    const END = 'when they describe it.'
    const description = raw.slice(start, raw.indexOf(END, start) + END.length)
    expect(description).not.toContain('Return')

    // simpleLoop's own spine still names it, so nothing was lost.
    const loop = allText(
      (
        await b.request.LoopController('x', 'x', TOOLS, TURNS as never, null, null, null)
      ).body.json() as Body,
    )
    expect(loop).toContain('Use \\"Return\\" when you have enough information.')
  })
})

/**
 * The multi-call batch — the fourth instance of "disagreeing demonstrations are
 * defects", and the one where nothing disagreed because nothing demonstrated.
 *
 * `additional_calls` was described in prose by `LoopMultiCalls`/`ActorMultiCalls`
 * and in `ctx.output_format`, and shown nowhere. The capture behind #248
 * (`.harness-logs/baml-validation.json`, `sandbox-session-loop` attempt 3 — a
 * `sequential` sandbox agent) is a model reaching for exactly the batch the
 * section advertises, write-then-run, and INVENTING a YAML `additional_calls:`
 * bullet list to say it in — dragging the whole envelope brace-less along with
 * it. 372 output tokens against a 32768 cap, so neither the empty-response nor
 * the truncation retry matched, and the throw ended the loop with three attempts
 * still in budget.
 *
 * Each mode branch now ends in ONE demonstrated action. These assertions are the
 * guard: the demonstration must PARSE as a complete ControllerAction (including
 * `additional_calls` entries whose `tool_args` parse as JSON in their own right),
 * it must match its mode's semantics, and it must be absent entirely when the
 * mode is null — the branch is what gates it, so an agent with `off` sees nothing.
 */
describe('the multi-call batch demonstration', () => {
  /** The MULTIPLE CALLS section, from its heading to the end of its block. The
   *  loop renders it into the agent-static tier-1 user message, the actor into
   *  the static system head; either way it is one block, which keeps these
   *  assertions clear of `ctx.output_format`'s own `tool_args: string` line. */
  function multiCallSection(body: Body): string | null {
    const HEAD = 'MULTIPLE CALLS PER TURN'
    const block = textBlocks(body).find((t) => t.includes(HEAD))
    return block ? block.slice(block.indexOf(HEAD)) : null
  }

  async function loopSection(mode: string | null): Promise<string | null> {
    const req = await b.request.LoopController('x', 'x', TOOLS, [] as never, null, null, null, mode)
    return multiCallSection(req.body.json() as Body)
  }

  async function actorSection(mode: string | null): Promise<string | null> {
    const req = await b.request.ActorController(
      'x',
      'x',
      TOOLS,
      [] as never,
      null,
      null,
      1,
      3,
      mode,
    )
    return multiCallSection(req.body.json() as Body)
  }

  /** Parses the demonstrated action out of a rendered section — as JSON, never
   *  by substring match, so a shape the model could not copy fails here first. */
  function demonstratedAction(section: string | null): {
    reasoning: string
    tool_name: string
    tool_args: string
    additional_calls: Array<{ tool_name: string; tool_args: string }>
    status?: string
    is_final?: boolean
  } {
    expect(section, 'the rendered prompt has no MULTIPLE CALLS section').toBeTruthy()
    const line = (section as string)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{'))
    expect(line, 'no JSON-object demonstration found in the MULTIPLE CALLS section').toBeTruthy()
    return JSON.parse(line as string)
  }

  const RENDER = {
    LoopController: loopSection,
    ActorController: actorSection,
  } as const

  for (const [fn, render] of Object.entries(RENDER)) {
    for (const mode of ['parallel', 'sequential'] as const) {
      it(`${fn}/${mode}: the demonstration parses as a complete batched action`, async () => {
        const action = demonstratedAction(await render(mode))

        // The envelope every other demonstration in these prompts renders.
        expect(Object.keys(action).sort()).toEqual(
          ['reasoning', 'tool_name', 'tool_args', 'additional_calls', 'status', 'is_final'].sort(),
        )
        expect(typeof action.reasoning).toBe('string')
        expect(typeof action.tool_name).toBe('string')
        expect(typeof action.status).toBe('string')
        // A batch is never the terminal action: the loop breaks before pushing a
        // final one, and the actor's own spine says a script merely written is
        // not done.
        expect(action.is_final).toBe(false)

        // `tool_args` is a STRING whose CONTENT is JSON — the encoding the turn
        // log and the few-shots use. Bare, it would demonstrate a second,
        // incompatible encoding of one field in one prompt (#144).
        expect(typeof action.tool_args).toBe('string')
        expect(JSON.parse(action.tool_args)).toBeTypeOf('object')

        // Every additional call carries tool_name/tool_args and nothing else,
        // with tool_args under the same contract as the top-level one.
        expect(Array.isArray(action.additional_calls)).toBe(true)
        expect(action.additional_calls.length).toBeGreaterThan(0)
        for (const call of action.additional_calls) {
          expect(Object.keys(call).sort()).toEqual(['tool_args', 'tool_name'])
          expect(typeof call.tool_name).toBe('string')
          expect(typeof call.tool_args).toBe('string')
          expect(JSON.parse(call.tool_args)).toBeTypeOf('object')
        }
        // Consistent with the cap the same section states two lines above it.
        expect(1 + action.additional_calls.length).toBeLessThanOrEqual(4)
      })

      it(`${fn}/${mode}: the section shows no brace-less field lines`, async () => {
        const section = (await render(mode)) as string
        expect(section).toBeTruthy()
        // The captured shape, in every part it was written in: labelled action
        // fields, plus the invented YAML list and its bullets.
        expect(section).not.toMatch(/^\s*reasoning: /m)
        expect(section).not.toMatch(/^\s*tool_name: /m)
        expect(section).not.toMatch(/^\s*tool_args: /m)
        expect(section).not.toMatch(/^\s*additional_calls:/m)
        expect(section).not.toMatch(/^\s*-\s+tool_name: /m)
        expect(section).not.toMatch(/^\s*is_final: /m)
      })
    }

    it(`${fn}: no demonstration at all when the mode is null`, async () => {
      // 'off' renders the section empty, so the batch shape never reaches an
      // agent that cannot use it — which is why the demonstration belongs in
      // this mode-gated section rather than in the few-shots.
      expect(await render(null)).toBeNull()
    })

    it(`${fn}/parallel: the demonstrated calls are independent lookups`, async () => {
      const action = demonstratedAction(await render('parallel'))
      const names = [action.tool_name, ...action.additional_calls.map((c) => c.tool_name)]
      // Concurrent execution means no call may depend on another's side effects,
      // so a mutating tool has no business in this branch's example.
      for (const name of names) expect(name).not.toMatch(/write|edit|bash|command/)
      // …and no later call may name a value the first call produces.
      const firstArgs = Object.values(JSON.parse(action.tool_args) as Record<string, unknown>)
      for (const call of action.additional_calls) {
        for (const value of firstArgs) {
          if (typeof value === 'string' && value.length > 2) {
            expect(call.tool_args).not.toContain(value)
          }
        }
      }
    })

    it(`${fn}/sequential: the demonstrated calls chain through a side effect`, async () => {
      const action = demonstratedAction(await render('sequential'))
      // The captured case, verbatim in shape: write a file, then run that file.
      // A later call sees earlier calls' side effects but never their output, so
      // the dependency has to be on the PATH, not on a result.
      const written = JSON.parse(action.tool_args) as { path?: string; content?: string }
      expect(written.path, 'the first sequential call should write a file').toBeTruthy()
      expect(written.content).toBeTruthy()
      const follow = action.additional_calls.map((c) => c.tool_args).join(' ')
      expect(follow).toContain(written.path as string)
    })
  }
})
