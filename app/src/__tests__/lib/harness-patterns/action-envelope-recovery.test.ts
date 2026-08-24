/**
 * Brace-less action envelopes — the fourth instance of one failure class.
 *
 * Captured live in `.harness-logs/baml-validation.json`: `sandbox-session-loop`,
 * `ActorController`, attempt 3 of 6. The actor wrote a COMPLETE and correct
 * action — reasoning, tool, a properly escaped `tool_args` object, a second call
 * in `additional_calls`, a status and `is_final: false` — as brace-less
 * `key: value` lines instead of the JSON object `ctx.output_format` asks for,
 * because the few-shot section of its own prompt demonstrated exactly that shape.
 *
 * 372 output tokens against `AnthropicSonnet5`'s 32768 cap, and a non-empty
 * response: neither existing retry trigger matched, so the `BamlValidationError`
 * propagated, aborted the whole actorCritic loop with three attempts still in
 * budget, and the user got an apology for a turn that was right.
 *
 * The prompt fix (`ActorFewShots` / `LoopFewShots` now render the JSON object)
 * removes the cause; the coercion asserted here is the recovery for any model
 * that drifts anyway. Both halves are pinned: the envelope shape of the rendered
 * few-shots lives in `controller-history-format.test.ts`.
 *
 * Hermetic: `baml_client` + MCP are mocked; the "collector" is a plain object
 * shaped like `Collector.last` (the adapters only read `.last`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockListTools } from '../../mocks/mcp'
import type { Collector } from '@boundaryml/baml'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  listTools: mockListTools(['sandbox_write', 'sandbox_bash', 'read_neo4j_cypher', 'Return']),
}))

const mockLoopController = vi.fn()
const mockActorController = vi.fn()

vi.mock('../../../../baml_client', () => ({
  b: {
    LoopController: mockLoopController,
    ActorController: mockActorController,
  },
}))

/**
 * The response, byte for byte, from the captured session. `String.raw` keeps the
 * `\n` sequences inside `content` as the two characters the model actually
 * emitted — reproducing them as real newlines would test a different bug.
 */
const CAPTURED_RAW = String.raw`reasoning: Previous attempt failed likely due to quoting issues in bash -c with escaped quotes. I'll write a script file instead and run it, avoiding complex escaping.
tool_name: sandbox_write
tool_args: {"path":"/work/inspect_xlsx.py","content":"import openpyxl\n\npath = '/work/in/dtsc_ai_transition_incentive_model_sme_v2.xlsx'\nwb = openpyxl.load_workbook(path, data_only=True)\nfor sheet in wb.sheetnames:\n    ws = wb[sheet]\n    print('Sheet:', sheet)\n    for row in ws.iter_rows(min_row=1, max_row=1, values_only=True):\n        print('  Columns:', row)\n"}
additional_calls:
  - tool_name: sandbox_bash
    tool_args: {"command":"python3 /work/inspect_xlsx.py"}
status: Reading the spreadsheet's column headers using a Python script.
is_final: false`

/** Collector reporting the captured call: 372 output tokens, nowhere near the
 *  32768 cap, so nothing here can be mistaken for truncation. */
const capturedCollector = (rawLlmResponse = CAPTURED_RAW): Collector =>
  ({
    last: {
      usage: { inputTokens: 554, outputTokens: 372, cachedInputTokens: 3058 },
      calls: [{ selected: true, provider: 'anthropic', clientName: 'AnthropicSonnet5' }],
      rawLlmResponse,
    },
  }) as unknown as Collector

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.USE_MIXED_CHAINS
})

// ============================================================================
// The coercion itself
// ============================================================================

describe('coerceControllerActionText', () => {
  it('recovers every field of the captured response', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    const action = coerceControllerActionText(CAPTURED_RAW)

    expect(action).not.toBeNull()
    expect(action?.tool_name).toBe('sandbox_write')
    expect(action?.status).toBe("Reading the spreadsheet's column headers using a Python script.")
    expect(action?.is_final).toBe(false)
    expect(action?.reasoning).toContain('quoting issues')

    // `tool_args` comes back as a string of valid JSON — the contract's type —
    // with the inlined script intact, newline escapes and all.
    const args = JSON.parse(action?.tool_args ?? '') as { path: string; content: string }
    expect(args.path).toBe('/work/inspect_xlsx.py')
    expect(args.content).toContain('import openpyxl')
    expect(args.content).toContain('\n') // real newlines, decoded from the \n escapes
  })

  it('recovers the YAML-ish additional_calls list — dropping it would lose a call', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    const action = coerceControllerActionText(CAPTURED_RAW)

    // The batch is `sequential` for this agent: the second call RUNS the script
    // the first one writes. A recovery that silently kept only the write would
    // report success for half the work.
    expect(action?.additional_calls).toEqual([
      { tool_name: 'sandbox_bash', tool_args: '{"command":"python3 /work/inspect_xlsx.py"}' },
    ])
  })

  it('abandons the recovery when additional_calls is present but unreadable', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // Second entry has no tool_args: executing the batch would drop it.
    expect(
      coerceControllerActionText(
        [
          'tool_name: sandbox_write',
          'tool_args: {"path":"/work/a.py","content":"x"}',
          'additional_calls:',
          '  - tool_name: sandbox_bash',
          '    tool_args: {"command":"python3 /work/a.py"}',
          '  - tool_name: sandbox_bash',
        ].join('\n'),
      ),
    ).toBeNull()
  })

  it('reads a JSON-array additional_calls too', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    const action = coerceControllerActionText(
      [
        'reasoning: two independent lookups',
        'tool_name: read_neo4j_cypher',
        'tool_args: {"query":"MATCH (n) RETURN n"}',
        'additional_calls: [{"tool_name": "sandbox_bash", "tool_args": "{\\"command\\":\\"ls\\"}"}]',
      ].join('\n'),
    )
    expect(action?.additional_calls).toEqual([
      { tool_name: 'sandbox_bash', tool_args: '{"command":"ls"}' },
    ])
  })

  it('serialises an array entry whose tool_args came as an object, not a string', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // `tool_args` is typed `string` (its CONTENT is JSON), and a model writing
    // the array form tends to drop the quoting one level down too.
    const action = coerceControllerActionText(
      [
        'tool_name: sandbox_write',
        'tool_args: {"path":"/work/a.py","content":"x"}',
        'additional_calls: [{"tool_name": "sandbox_bash", "tool_args": {"command": "ls"}}]',
      ].join('\n'),
    )
    expect(action?.additional_calls).toEqual([
      { tool_name: 'sandbox_bash', tool_args: '{"command":"ls"}' },
    ])
  })

  it('declines a balanced-but-relaxed JSON array rather than guessing at the batch', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // Unquoted keys. The repo repairs relaxed JSON for a single `tool_args`
    // payload, where a wrong guess costs one rejected call; guessing at a LIST
    // of calls could mis-target or reorder them, so this declines instead.
    expect(
      coerceControllerActionText(
        [
          'tool_name: sandbox_write',
          'tool_args: {"path":"/work/a.py","content":"x"}',
          'additional_calls: [{tool_name: sandbox_bash, tool_args: {}}]',
        ].join('\n'),
      ),
    ).toBeNull()
  })

  it('leaves a non-object tool_args exactly as written', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // An array is not the object shape the contract asks for. Passing it
    // through verbatim keeps the loops' `Invalid tool_args JSON` feedback
    // pointing at what the model actually wrote.
    const action = coerceControllerActionText('tool_name: sandbox_bash\ntool_args: ["ls", "-la"]')
    expect(action?.tool_args).toBe('["ls", "-la"]')
  })

  it('keeps a prose tool_args verbatim for the terminal Return turn', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // simpleLoop checks for `Return` BEFORE it parses args, so the answer must
    // survive untouched — this is the turn that carries the user's reply.
    const action = coerceControllerActionText(
      'reasoning: nothing left to look up\n' +
        'tool_name: Return\n' +
        'tool_args: The workbook has three sheets: Inputs, Model, Summary.\n' +
        'is_final: true',
    )
    expect(action?.tool_name).toBe('Return')
    expect(action?.tool_args).toBe('The workbook has three sheets: Inputs, Model, Summary.')
    expect(action?.is_final).toBe(true)
  })

  it('accepts the quoted form the few-shot section renders', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    const action = coerceControllerActionText(
      'reasoning: "single bash call"\ntool_name: "sandbox_bash"\ntool_args: "{\\"command\\":\\"ls\\"}"',
    )
    expect(action?.reasoning).toBe('single bash call')
    expect(action?.tool_name).toBe('sandbox_bash')
    expect(action?.tool_args).toBe('{"command":"ls"}')
  })

  it('is not a parse-anything pass: prose, truncation and junk all decline', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // Truncated mid-JSON: the trailing fields are GONE, so this must keep going
    // to the truncation-retry branch rather than being half-recovered here.
    expect(coerceControllerActionText('{"reasoning": "truncated mid-way')).toBeNull()
    expect(coerceControllerActionText('reasoning: I should call sandbox_write next.')).toBeNull()
    // A tool name is an identifier, not a sentence — prose that happens to use
    // the field names is not an action.
    expect(
      coerceControllerActionText(
        'tool_name: I will use the sandbox_write tool\ntool_args: {"path":"/work/a"}',
      ),
    ).toBeNull()
    expect(coerceControllerActionText('')).toBeNull()
    expect(coerceControllerActionText(undefined)).toBeNull()
  })

  it('a field name on its own line INSIDE tool_args is skipped, not read as a field', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // A raw newline inside a JSON string is common in inlined scripts, and it
    // can put `status:` at column 0 in the middle of the payload. Bracket
    // matching owns the literal's extent, so the impostor is skipped and the
    // real trailing field still wins.
    const action = coerceControllerActionText(
      'tool_name: sandbox_write\ntool_args: {"content":"line1\nstatus: not a field"}\nstatus: Writing',
    )
    expect(action?.status).toBe('Writing')
    expect(action?.tool_name).toBe('sandbox_write')
  })

  it('reads an explicitly empty additional_calls as no batch', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    for (const empty of ['null', '[]', '']) {
      const action = coerceControllerActionText(
        `tool_name: sandbox_bash\ntool_args: {"command":"ls"}\nadditional_calls: ${empty}`,
      )
      expect(action?.tool_name).toBe('sandbox_bash')
      expect(action?.additional_calls).toBeUndefined()
    }
  })

  it('declines every unreadable additional_calls shape rather than shortening the batch', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    const head = 'tool_name: sandbox_write\ntool_args: {"path":"/work/a.py","content":"x"}\n'
    const shapes = [
      'additional_calls: [{"tool_name": "sandbox_bash", "tool_args": ', // cut-off array
      'additional_calls: [{"tool_args": "{}"}]', // entry with no tool_name
      'additional_calls: -', // bullets but no entries
      'additional_calls:\n  - tool_args: {"command":"ls"}', // entry with no tool_name
      'additional_calls:\n  - tool_name: run this for me please\n    tool_args: {}', // prose name
    ]
    for (const shape of shapes) expect(coerceControllerActionText(head + shape)).toBeNull()
  })

  it('unquotes a value whose own quotes the model did not escape', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // `"he said "hi""` is not parseable JSON; stripping the outer pair beats
    // handing the loop a status with stray quote characters.
    const action = coerceControllerActionText(
      'tool_name: sandbox_bash\ntool_args: {"command":"ls"}\nstatus: "he said "hi""',
    )
    expect(action?.status).toBe('he said "hi"')
  })

  it('a status: line inside tool_args is not mistaken for the status field', async () => {
    const { coerceControllerActionText } =
      await import('../../../lib/harness-patterns/controller-action')
    // The literal's extent is found by bracket matching, not by "next key wins".
    const action = coerceControllerActionText(
      'tool_name: sandbox_write\n' +
        'tool_args: {"path":"/work/s.py","content":"print(1)"}\n' +
        'status: Writing the helper',
    )
    expect(action?.status).toBe('Writing the helper')
    expect(JSON.parse(action?.tool_args ?? '')).toEqual({
      path: '/work/s.py',
      content: 'print(1)',
    })
  })
})

// ============================================================================
// Through the adapters — the seam the loop actually calls
// ============================================================================

describe('ActorController recovers instead of aborting the loop', () => {
  it('yields the captured action with NO retry', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockActorController.mockRejectedValueOnce(
      new BamlValidationError(
        'prompt',
        CAPTURED_RAW,
        'Failed to find any ControllerAction @stream.not_null in 3 items',
        'Failed while parsing required fields: missing=3, unparsed=0',
      ),
    )

    const actor = createActorControllerAdapter({
      toolNames: ['sandbox_write', 'sandbox_bash'],
      contextPrefix: 'You have a sandbox.',
    })
    const { action } = await actor(
      'ingest the attached spreadsheet',
      'ingest the attached spreadsheet',
      [],
      [],
      capturedCollector(),
      3,
      6,
      'sequential',
    )

    expect(action.tool_name).toBe('sandbox_write')
    expect(action.additional_calls).toHaveLength(1)
    // The action was already correct: re-asking would spend a round-trip to
    // re-derive it, on the very prompt that produced the drift.
    expect(mockActorController).toHaveBeenCalledTimes(1)
  })

  it('recovers from the collector when the error carries no raw_output', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockActorController.mockRejectedValueOnce(
      new BamlValidationError('prompt', '', 'missing=3', 'missing=3'),
    )

    const actor = createActorControllerAdapter({ toolNames: ['sandbox_write', 'sandbox_bash'] })
    const { action } = await actor('x', 'x', [], [], capturedCollector(), 3, 6)
    expect(action.tool_name).toBe('sandbox_write')
  })

  it('leaves a genuine truncation on the truncation-retry path', async () => {
    const { createActorControllerAdapter, TRUNCATION_RETRY_GUIDANCE } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')
    const { mockFinalAction } = await import('../../mocks/baml')

    const cutOff = String.raw`reasoning: writing the report
tool_name: sandbox_write
tool_args: {"path":"/work/out/report.md","content":"# Report

The first sec`
    mockActorController
      .mockRejectedValueOnce(new BamlValidationError('prompt', cutOff, 'missing=3', 'missing=3'))
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const actor = createActorControllerAdapter({ toolNames: ['sandbox_write'] })
    const cappedCollector = {
      last: {
        usage: { inputTokens: 554, outputTokens: 32_768, cachedInputTokens: 0 },
        calls: [{ selected: true, provider: 'anthropic', clientName: 'AnthropicSonnet5' }],
        rawLlmResponse: cutOff,
      },
    } as unknown as Collector

    await actor('x', 'x', [], [], cappedCollector, 1, 6)
    // The unbalanced `tool_args` literal declines coercion, so the cap-hit
    // branch still owns this failure and still says WHY it failed.
    expect(mockActorController).toHaveBeenCalledTimes(2)
    expect(String(mockActorController.mock.calls[1][4])).toContain(TRUNCATION_RETRY_GUIDANCE)
  })

  it('recovers when the truncation RETRY drifts to the wrong envelope', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    // Call 1 was genuinely cut off, so the corrective retry fires; call 2 comes
    // back complete but brace-less. Before this, the second failure threw and
    // the loop died anyway — having paid for both round-trips.
    const cutOff = String.raw`reasoning: writing the report
tool_name: sandbox_write
tool_args: {"path":"/work/out/report.md","content":"# Report\n\nThe first sec`
    mockActorController
      .mockRejectedValueOnce(new BamlValidationError('prompt', cutOff, 'missing=3', 'missing=3'))
      .mockRejectedValueOnce(
        new BamlValidationError('prompt', CAPTURED_RAW, 'missing=3', 'missing=3'),
      )

    const actor = createActorControllerAdapter({ toolNames: ['sandbox_write', 'sandbox_bash'] })
    const cappedCollector = {
      last: {
        usage: { inputTokens: 554, outputTokens: 32_768, cachedInputTokens: 0 },
        calls: [{ selected: true, provider: 'anthropic', clientName: 'AnthropicSonnet5' }],
        rawLlmResponse: cutOff,
      },
    } as unknown as Collector

    const { action } = await actor('x', 'x', [], [], cappedCollector, 1, 6)
    expect(action.tool_name).toBe('sandbox_write')
    expect(mockActorController).toHaveBeenCalledTimes(2)
  })
})

describe('LoopController recovers the same way', () => {
  it('yields the action with no retry', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    const raw = [
      'reasoning: substring search over concepts',
      'tool_name: read_neo4j_cypher',
      'tool_args: {"query":"MATCH (c:Concept) RETURN c.name LIMIT 20"}',
      'status: Querying the graph',
      'is_final: false',
    ].join('\n')

    mockLoopController.mockRejectedValueOnce(
      new BamlValidationError('prompt', raw, 'missing=3', 'missing=3'),
    )

    const controller = createLoopControllerAdapter(['read_neo4j_cypher', 'Return'])
    const { action } = await controller(
      'find graph concepts',
      'find graph concepts',
      '[]',
      0,
      undefined,
      capturedCollector(raw),
    )

    expect(action.tool_name).toBe('read_neo4j_cypher')
    expect(action.status).toBe('Querying the graph')
    expect(mockLoopController).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// #232 must not regress: an UNRECOVERABLE failure still carries the response
// ============================================================================

describe('the raw response still reaches the error when recovery declines', () => {
  it('ActorController wraps it as LLMCallError with rawOutput intact', async () => {
    const { createActorControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    // Prose naming a tool and a JSON blob, with no field labels at all — the
    // shape #232 exists for. Nothing to coerce, so it must propagate WITH the
    // evidence rather than quietly.
    const prose = 'sandbox_write\n\n{"path":"/work/parse_pdf.py","content":"import pymupdf"}'
    mockActorController.mockRejectedValue(
      new BamlValidationError('prompt', prose, 'missing reasoning', 'missing reasoning'),
    )

    const actor = createActorControllerAdapter({ toolNames: ['sandbox_write'] })
    const err = await actor('x', 'x', [], [], capturedCollector(prose), 1, 6).catch((e) => e)

    expect(err).toBeInstanceOf(LLMCallError)
    expect((err as InstanceType<typeof LLMCallError>).llmCall.rawOutput).toBe(prose)
  })

  it('LoopController does the same', async () => {
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    const prose = 'I think we should query neo4j next.'
    mockLoopController.mockRejectedValue(
      new BamlValidationError('prompt', prose, 'missing reasoning', 'missing reasoning'),
    )

    const controller = createLoopControllerAdapter(['read_neo4j_cypher'])
    const err = await controller('q', 'i', '[]', 0, undefined, capturedCollector(prose)).catch(
      (e) => e,
    )

    expect(err).toBeInstanceOf(LLMCallError)
    expect((err as InstanceType<typeof LLMCallError>).llmCall.rawOutput).toBe(prose)
  })
})
