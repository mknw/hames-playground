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
      'find the budget', 'find the budget', TOOLS, TURNS as never, null, null, null,
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
    const req = await b.request.LoopController(
      'x', 'x', TOOLS, TURNS as never, null, null, null,
    )
    const body = req.body.json() as Body
    const args = assistantTexts(body).map((t) => (JSON.parse(t) as { tool_args: string }).tool_args)
    // Round-trips byte-for-byte: the escaping is done by the JSON serializer,
    // so a tool_args value cannot break out of its own string.
    expect(args).toContain(NASTY_ARGS)
  })

  it('LoopController: a completed turn is never advertised as final', async () => {
    // The loop breaks BEFORE recording a final action, so history is non-final
    // by construction; rendering `true` here would teach the model to end early.
    const req = await b.request.LoopController(
      'x', 'x', TOOLS, TURNS as never, null, null, null,
    )
    const body = req.body.json() as Body
    for (const text of assistantTexts(body)) {
      expect((JSON.parse(text) as { is_final: boolean }).is_final).toBe(false)
    }
  })

  it('ActorController: every attempt parses, and is_final comes from the data', async () => {
    const req = await b.request.ActorController(
      'build it', 'build it', TOOLS, ATTEMPTS as never, null, null, 3, 5,
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
    const loop = (await b.request.LoopController(
      'x', 'x', TOOLS, TURNS as never, null, null,
      [{ user: 'find X', reasoning: 'search', tool: 'search', args: '{"query":"X"}' }],
    )).body.json() as Body
    const actor = (await b.request.ActorController(
      'x', 'x', TOOLS, ATTEMPTS as never, null,
      [{ user: 'build X', reasoning: 'write', tool: 'write_file', args: '{}' }], 3, 5,
    )).body.json() as Body

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

  it('the turn counter agrees with the history it follows', async () => {
    // History is 0-indexed (`Turn 0 result`), so with N completed turns the ask
    // is for turn N. The previous `N + 1` skipped a number, inviting the model
    // to infer a turn it had never seen.
    const req = await b.request.LoopController(
      'x', 'x', TOOLS, TURNS as never, null, null, null,
    )
    const text = allText(req.body.json() as Body)
    expect(text).toContain(`Turn ${TURNS.length}. Decide the next action.`)
    expect(text).not.toContain(`Turn ${TURNS.length + 1}. Decide the next action.`)
  })
})
