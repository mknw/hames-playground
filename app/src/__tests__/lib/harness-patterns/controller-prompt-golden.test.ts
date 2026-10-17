/**
 * #625 S2: exact HTTP request bodies captured BEFORE extracting the templates,
 * from origin/main at 502008c97155bd8cbf3c5a8a3b27f54c281d45a8 (BAML 0.224.0).
 * Only b.request is used: it renders offline and opens no connection.
 *
 * Each original runs on its declared chain, both Anthropic leaves (including
 * the fallback), and Verda's OpenAI-generic wire. Compare the raw body text,
 * without parsing, sorting, flattening content parts or normalising whitespace:
 * roles, cache breakpoints, JSON escaping and output schemas are all bytes here.
 * The fixtures are historical evidence; do not regenerate them from a refactor.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  Attempt,
  FewShot,
  LoopTurn,
  ToolDescription,
} from '@hames-ai/harness-baml/baml_client/types'

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/v1',
  VERDA_INFERENCE_API_KEY: 'offline-render-test',
}

let b: typeof import('@hames-ai/harness-baml/baml_client').b
beforeAll(async () => {
  b = (await import('@hames-ai/harness-baml/baml_client')).b
})

const TOOLS: ToolDescription[] = [
  { name: 'search', description: 'Search files', args_schema: '{"query":"string"}' },
  { name: 'inspect', description: 'Inspect a result', args_schema: '{"id":"string"}' },
]
const FEW_SHOTS: FewShot[] = [
  {
    user: 'Find the "sample" file',
    reasoning: 'Search first.\nThen inspect.',
    tool: 'search',
    args: '{"query":"say \\"hi\\"","path":"C:\\\\tmp"}',
  },
]
const TURNS: LoopTurn[] = [
  {
    n: 0,
    reasoning: 'Search broadly first',
    status: 'Searching',
    tool_call: { tool: 'search', args: '{"query":"sample"}' },
    additional_calls: [{ tool_name: 'inspect', tool_args: '{"id":"r0"}' }],
    tool_result: { tool: 'search', success: true, result: 'Two synthetic rows' },
    expansions: [{ ref_id: 'r0', content: 'Expanded synthetic result' }],
  },
  {
    n: 1,
    tool_call: { tool: 'search', args: '{"query":"retry"}' },
    tool_result: { tool: 'search', success: false, result: '', error: 'timeout' },
  },
  { n: 2, reasoning: 'No call recorded' },
]
const ATTEMPTS: Attempt[] = [
  {
    n: 1,
    action: {
      reasoning: 'Search and inspect independently',
      tool_name: 'search',
      tool_args: '{"query":"sample"}',
      additional_calls: [{ tool_name: 'inspect', tool_args: '{"id":"r0"}' }],
      status: 'Searching',
      is_final: false,
    },
    result: 'Two synthetic rows',
    feedback: 'Inspect the matching row',
  },
  {
    n: 2,
    action: { reasoning: '', tool_name: 'inspect', tool_args: '{"id":"r0"}' },
    result: '',
    error: 'timeout',
  },
  {
    n: 3,
    action: { reasoning: 'Done', tool_name: 'inspect', tool_args: '{}', is_final: true },
    result: 'Synthetic result',
  },
]

type Options = { client: string; env: typeof ENV }
type Render = (opts: Options) => Promise<{ body: { text(): string } }>
const CASES: Record<string, Record<string, Render>> = {
  LoopController: {
    // No optional sections, default summary style, no history.
    first: (o) =>
      b.request.LoopController('q', 'i', TOOLS, [], null, null, null, null, null, null, o),
    // Both populated and legacy history, rolling markers, expansions, errors,
    // batch calls, escaped few-shots, prior results, and a separate plan.
    parallel: (o) =>
      b.request.LoopController(
        'Find the "sample"\nfile',
        'Find the sample',
        TOOLS,
        TURNS,
        'CONTEXT\nSynthetic schema',
        [{ ref_id: 'r0', tool: 'search', summary: 'Previous synthetic result' }],
        FEW_SHOTS,
        'parallel',
        'PLAN\n1. Search\n2. Inspect',
        'answer',
        o,
      ),
    sequential: (o) =>
      b.request.LoopController(
        'q',
        'i',
        TOOLS,
        TURNS.slice(0, 1),
        '',
        [],
        [],
        'sequential',
        '',
        'summary',
        o,
      ),
  },
  ActorController: {
    first: (o) => b.request.ActorController('q', 'i', TOOLS, [], null, null, 1, 5, null, o),
    noBudget: (o) => b.request.ActorController('q', 'i', [], [], '', [], null, null, null, o),
    parallel: (o) =>
      b.request.ActorController(
        'q',
        'i',
        TOOLS,
        ATTEMPTS,
        'CONTEXT\nSynthetic schema',
        FEW_SHOTS,
        4,
        5,
        'parallel',
        o,
      ),
    sequential: (o) =>
      b.request.ActorController(
        'q',
        'i',
        TOOLS,
        ATTEMPTS.slice(1, 2),
        '',
        [],
        3,
        8,
        'sequential',
        o,
      ),
  },
  Planner: {
    first: (o) => b.request.Planner('q', 'i', TOOLS, null, o),
    context: (o) =>
      b.request.Planner(
        'Find the "sample"\nfile',
        'Find the sample',
        TOOLS,
        'CONTEXT\nSynthetic schema',
        o,
      ),
  },
}

const CLIENTS: Record<string, string[]> = {
  LoopController: [
    'ControllerAnthropic',
    'AnthropicSonnet5NoThink',
    'AnthropicSonnet46NoThink',
    'VerdaQwen',
  ],
  ActorController: ['ActorAnthropic', 'AnthropicSonnet5', 'AnthropicSonnet46', 'VerdaQwen'],
  Planner: ['PlannerAnthropic', 'AnthropicSonnet5', 'AnthropicSonnet46', 'VerdaQwen'],
}

const GOLDENS = JSON.parse(
  readFileSync(
    path.resolve(
      process.cwd(),
      'src/__tests__/lib/harness-patterns/fixtures/controller-prompts-625-s2.json',
    ),
    'utf8',
  ),
) as Record<string, string>
const RENDERS = Object.entries(CASES).flatMap(([fn, cases]) =>
  Object.entries(cases).flatMap(([scenario, render]) =>
    CLIENTS[fn].map((client) => ({ name: `${fn}/${scenario}/${client}`, render, client })),
  ),
)

describe('#625 S2 thinking-off originals match their pre-refactor request bytes', () => {
  it.each(RENDERS)('$name', async ({ name, render, client }) => {
    const body = (await render({ client, env: ENV })).body.text()
    expect(body).toBe(GOLDENS[name])
  })
})
