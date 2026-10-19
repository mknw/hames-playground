/** #507 office-data retry exhaustion (live pass 3, scenarios 09/10): the real office
 * actorCritic is driven through the eval's synthetic sandbox with the three request
 * shapes the live reports leave as the only candidates for the rejections — a
 * script written with `sandbox_write` and then run by name, an exploratory read,
 * and a script that never names the files — and the actor must be TOLD why each
 * was refused, so its next attempt can differ. The live reports hold no events
 * (checks and per-function call counts only), so the sequence is reconstructed,
 * not recorded; whether the 27B then converges is measured only by a live run. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import '../../mocks/namespace-catalog'
import '../../../lib/inference/config.server'
import {
  amendRunFrame,
  harness,
  withRunFrame,
  type ConfiguredPattern,
  type ContextEvent,
} from '@hames-ai/harness-patterns'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import {
  SANDBOX_FILE_TOOLS,
  createSyntheticSandbox,
} from '../../../lib/eval-support/synthetic-sandbox'
import type {
  ConversationScenario,
  ConversationTrace,
} from '../../../lib/eval-support/conversation'
import { sandboxArgs } from '../../../lib/eval-support/tool-arguments'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => ({
      tools: ['graph_me', 'graph_mail_recent'].map((name) => ({
        name,
        description: `desc of ${name}`,
        inputSchema: {},
      })),
    }))
    callTool = vi.fn()
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

// Scenario 10's own request and predicate (src/ may not import evals/, so
// the last test pins that the scenario file still says this).
const csv = {
  messages: [
    'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
  ],
  expectedArgs: { sandbox_bash: sandboxArgs(['lantern-sales.csv', 'lantern-totals.csv']) },
  artifacts: ['lantern-totals.csv'],
} as unknown as ConversationScenario

const SALES = '/work/in/lantern-sales.csv'
const TOTALS = '/work/out/lantern-totals.csv'
const SCRIPT = `import csv\nrows = list(csv.DictReader(open('${SALES}')))\nwriter = csv.writer(open('${TOTALS}', 'w'))`
const BASH = {
  name: 'sandbox_bash',
  description: 'Run a shell command inside the sandbox via `bash -lc`.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
}
const act = (tool_name: string, args: object, extra?: object) => ({
  reasoning: 'r',
  tool_name,
  tool_args: JSON.stringify(args),
  status: 'working',
  is_final: false,
  ...extra,
})
// One attempt each: the demonstrated write-then-run batch (the command names no
// file), an exploratory read, a one-liner that names only the input, then a
// request the scenario accepts.
const SEQUENCE = [
  act(
    'sandbox_write',
    { path: '/work/totals.py', content: SCRIPT },
    {
      additional_calls: [
        {
          tool_name: 'sandbox_bash',
          tool_args: JSON.stringify({ command: 'python3 /work/totals.py' }),
        },
      ],
    },
  ),
  act('sandbox_bash', { command: `head ${SALES}` }),
  act('sandbox_bash', { command: `python3 -c "print(open('${SALES}').read())"` }),
  act(
    'sandbox_bash',
    { command: `python3 -c "print(open('${SALES}').read(), '${TOTALS}')"` },
    { is_final: true },
  ),
]

interface Seen {
  error?: string
  result?: unknown
}
const seen: Seen[][] = []
let events: ContextEvent[] = []
const trace: ConversationTrace = {
  turns: [],
  tools: [],
  artifacts: [],
  indexed: [],
  retrievals: [],
}

const deps = (sandbox: ReturnType<typeof createSyntheticSandbox>): AgentDeps => ({
  toolNamespaces: mcpNamespace,
  withSandbox: () => (pattern) => ({
    ...pattern,
    children: [pattern],
    fn: (scope, view) => amendRunFrame({ transports: [sandbox] }, () => pattern.fn(scope, view)),
  }),
  createRedisBackend: () => ({ name: 'redis', type: 'vector', search: async () => [] }),
  pseudonymiseForWeb: async () => ({
    apply: (v) => v,
    redact: <T>(v: T): T => v,
    checkLiterals: () => {},
    observe: () => {},
    check: () => {},
  }),
})
const walk = (ps: ConfiguredPattern<AgentData>[]): ConfiguredPattern<AgentData>[] =>
  ps.flatMap((p) => [p, ...walk(p.children ?? [])])

beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-replay-test')
  vi.stubEnv('USE_VERDA_INFERENCE', '0')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  let call = 0
  vi.spyOn(b, 'ActorController').mockImplementation((async (...args: unknown[]) => {
    seen.push((args[3] as Seen[]).map((a) => ({ error: a.error, result: a.result })))
    return SEQUENCE[call++]
  }) as never)
  vi.spyOn(b, 'Critic').mockImplementation((async () => ({
    is_sufficient: true,
    explanation: 'ok',
  })) as never)
  const documents = new Map([
    ['lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n'],
    ['lantern-notes.md', 'Lantern notes'],
  ])
  const sandbox = createSyntheticSandbox({
    scenario: () => csv,
    trace: () => trace,
    turn: () => 0,
    documents,
    written: new Map(),
    descriptions: [BASH, ...SANDBOX_FILE_TOOLS],
  })
  const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
  const patterns = await generalNextAgent.createPatterns('synthetic-session', deps(sandbox))
  const office = walk(patterns).find((p) => p.name === 'actorCritic')!
  const result = await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
    harness(office)(csv.messages[0]),
  )
  events = result.context.events
})

describe('office actor against the synthetic sandbox', () => {
  it('accepts the demonstrated sandbox_write, so only the unnamed command is refused', () => {
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results.map((e) => (e.data as { tool: string }).tool).slice(0, 2)).toEqual([
      'sandbox_write',
      'sandbox_bash',
    ])
    expect(results.slice(0, 2).map((e) => (e.data as { success: boolean }).success)).toEqual([
      true,
      false,
    ])
    expect(JSON.stringify(events)).not.toContain('Tool not allowed')
  })

  it('tells the actor which rule each refused request broke, on its next attempt', () => {
    expect(seen).toHaveLength(4)
    const reason = (attempt: number) => JSON.stringify(seen[attempt].at(-1))
    expect(reason(1)).toContain('not named: lantern-sales.csv, lantern-totals.csv')
    expect(reason(2)).toContain('must run python3, cat, pandoc')
    expect(reason(2)).toContain('not named: lantern-totals.csv')
    expect(reason(3)).toContain('not named: lantern-totals.csv')
    expect(reason(3)).not.toContain('must run python3')
  })

  it('ends on the first accepted request, judged by the critic, with the failures traced', () => {
    expect(trace.tools.map((t) => [t.name, t.success])).toEqual([
      ['sandbox_write', true],
      ['sandbox_bash', false],
      ['sandbox_bash', false],
      ['sandbox_bash', false],
      ['sandbox_bash', true],
    ])
    expect(events.some((e) => e.type === 'critic_result')).toBe(true)
    expect(
      events.some((e) => e.type === 'error' && JSON.stringify(e.data).includes('Max retries')),
    ).toBe(false)
  })
})

it('advertises only tools the production sandbox exposes', () => {
  const production = new Set(V0_IN_VM_SERVERS.flatMap((s) => Object.values(s.tools)))
  const driver = readFileSync(resolve('evals/general-next/driver.ts'), 'utf8')
  const declared = [...driver.matchAll(/^ {2}(sandbox_[a-z]+): 'sandbox',$/gm)].map((m) => m[1])
  expect(declared.sort()).toEqual(['sandbox_bash', 'sandbox_list', 'sandbox_read', 'sandbox_write'])
  expect(driver).toContain('createSyntheticSandbox({')
  for (const name of [...declared, ...SANDBOX_FILE_TOOLS.map((t) => t.name)])
    expect(production.has(name), name).toBe(true)
})

it('replays the request and predicate of scenario 10 as it is written', () => {
  const source = readFileSync(resolve('evals/general-next/scenarios/10-csv-analysis.ts'), 'utf8')
  expect(source).toContain(csv.messages[0])
  expect(source).toContain("sandboxArgs(['lantern-sales.csv', 'lantern-totals.csv'])")
  expect(source).toContain("artifacts: ['lantern-totals.csv']")
})
