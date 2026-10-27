/** #507 office-data retry exhaustion (live pass 3, scenarios 09/10): the real office
 * actorCritic is driven through the eval's synthetic sandbox with the request shapes the
 * live reports leave as the candidates for the rejections — the prompt's own
 * write-then-run batch, an exploratory read, and a command that only names the files.
 * The transport answers as a shell does and never states a scenario's rule; the critic
 * sees the stdout a real run prints. The live reports hold no events (checks and
 * per-function call counts only), so the sequences are reconstructed, not recorded;
 * whether the 27B then converges, and why scenario 10 exhausted AFTER an accepted
 * request, is measured only by a live run. */
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

// The two scenarios' own requests and predicates (src/ may not import evals/, so the
// last tests pin that the scenario files still say this).
const csv = {
  messages: [
    'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
  ],
  expectedArgs: { sandbox_bash: sandboxArgs('lantern-totals.csv', 'lantern-sales.csv') },
  artifacts: ['lantern-totals.csv'],
  sandboxRun: {
    stdout: 'North,47\nSouth,19\nTotal,66',
    files: { 'lantern-totals.csv': 'region,revenue\nNorth,47\nSouth,19\nTotal,66\n' },
  },
} as unknown as ConversationScenario
const summary = {
  messages: [
    'I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.',
  ],
  expectedArgs: { sandbox_bash: sandboxArgs('lantern-summary.docx') },
  artifacts: ['lantern-summary.docx'],
} as unknown as ConversationScenario

const analysis = {
  messages: [
    'Find the Lantern launch email in my inbox. Use its checklist and the uploaded lantern-notes.md and lantern-sales.csv to prepare lantern-launch-analysis.md, index it for this chat, and offer to answer questions.',
  ],
  expectedArgs: {
    sandbox_bash: sandboxArgs(
      'lantern-launch-analysis.md',
      'lantern-notes.md',
      'lantern-sales.csv',
    ),
  },
  artifacts: ['lantern-launch-analysis.md'],
} as unknown as ConversationScenario

const SALES = '/work/in/lantern-sales.csv'
const TOTALS = '/work/out/lantern-totals.csv'
const TOTALS_PY = `import csv\nrows = list(csv.DictReader(open('${SALES}')))\nwriter = csv.writer(open('${TOTALS}', 'w'))`
// The notes arrive through the read-documents handoff, so a correct script embeds them.
const SUMMARY_PY =
  "from docx import Document\nd = Document()\nd.add_paragraph('Lantern release date: 2030-04-12.')\nd.save('/work/out/lantern-summary.docx')"
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
const writeThenRun = (path: string, content: string, run: string) =>
  act(
    'sandbox_write',
    { path, content },
    {
      is_final: true,
      additional_calls: [
        { tool_name: 'sandbox_bash', tool_args: JSON.stringify({ command: run }) },
      ],
    },
  )

interface Seen {
  error?: string
  result?: unknown
}
interface Replay {
  events: ContextEvent[]
  trace: ConversationTrace
  seen: Seen[][]
  critic: string[]
}
let queue: unknown[] = []
let seen: Seen[][] = []
let critic: string[] = []

const deps = (sandbox: ReturnType<typeof createSyntheticSandbox>): AgentDeps => ({
  toolNamespaces: mcpNamespace,
  withSandbox: () => (pattern) => ({
    ...pattern,
    children: [pattern],
    fn: (scope, view) => amendRunFrame({ transports: [sandbox] }, () => pattern.fn(scope, view)),
  }),
  createRedisBackend: () => ({ name: 'redis', type: 'vector', search: async () => [] }),
  guards: {
    pseudonymiseForWeb: async () => ({
      apply: (v) => v,
      redact: <T>(v: T): T => v,
      checkLiterals: () => {},
      observe: () => {},
      check: () => {},
    }),
  },
})
const walk = (ps: ConfiguredPattern<AgentData>[]): ConfiguredPattern<AgentData>[] =>
  ps.flatMap((p) => [p, ...walk(p.children ?? [])])

beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-replay-test')
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '0')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  let call = 0
  vi.spyOn(b, 'ActorController').mockImplementation((async (...args: unknown[]) => {
    seen.push((args[3] as Seen[]).map((a) => ({ error: a.error, result: a.result })))
    return queue[call++]
  }) as never)
  // A critic that judges by what it is shown: done only once the run printed the totals
  // (scenario 10) or saved the document (scenario 09).
  vi.spyOn(b, 'Critic').mockImplementation((async (...args: unknown[]) => {
    const shown = JSON.stringify(args)
    critic.push(shown)
    return {
      is_sufficient: /Total,66|Saved \/work\/out\/lantern-(?:summary|launch-analysis)/.test(shown),
      explanation: 'judged',
    }
  }) as never)
  const reset = () => {
    call = 0
  }
  replayReset = reset
})
let replayReset = () => {}

async function replay(scenario: ConversationScenario, sequence: unknown[]): Promise<Replay> {
  queue = sequence
  seen = []
  critic = []
  replayReset()
  const trace: ConversationTrace = {
    turns: [],
    tools: [],
    artifacts: [],
    indexed: [],
    retrievals: [],
  }
  const sandbox = createSyntheticSandbox({
    scenario: () => scenario,
    trace: () => trace,
    turn: () => 0,
    documents: new Map([
      ['lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n'],
      ['lantern-notes.md', 'Lantern notes'],
    ]),
    descriptions: [BASH, ...SANDBOX_FILE_TOOLS],
  })
  const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
  const patterns = await generalNextAgent.createPatterns('synthetic-session', deps(sandbox))
  const office = walk(patterns).find((p) => p.name === 'actorCritic')!
  const result = await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
    harness(office)(scenario.messages[0]),
  )
  return { events: result.context.events, trace, seen: [...seen], critic: [...critic] }
}

const flags = (t: ConversationTrace) => t.tools.map((x) => [x.name, x.success, x.valid])
const exhausted = (e: ContextEvent[]) =>
  e.some((x) => x.type === 'error' && JSON.stringify(x.data).includes('Max retries'))

describe('scenario 10 (office actor, synthetic sandbox)', () => {
  let r: Replay
  beforeAll(async () => {
    r = await replay(csv, [
      act('sandbox_bash', { command: `head ${SALES}` }),
      act('sandbox_bash', { command: 'echo lantern-sales.csv lantern-totals.csv | cat' }),
      writeThenRun('/work/totals.py', TOTALS_PY, 'python3 /work/totals.py'),
    ])
  })

  it('accepts the prompt’s own write-then-run, whose command names no file', () => {
    expect(flags(r.trace)).toEqual([
      ['sandbox_bash', true, false],
      ['sandbox_bash', true, false],
      ['sandbox_write', true, undefined],
      ['sandbox_bash', true, true],
    ])
    expect(r.trace.artifacts).toEqual(['lantern-totals.csv'])
    expect(JSON.stringify(r.events)).not.toContain('Tool not allowed')
    expect(exhausted(r.events)).toBe(false)
  })

  it('lets an exploratory read succeed with the file’s text and record nothing', () => {
    expect(JSON.stringify(r.seen[1].at(-1))).toContain('region,revenue')
  })

  it('keeps a command that only names the files from being accepted, and never says why', () => {
    // `echo <names> | cat` ran and left nothing: the result is a shell's, with no rule in it.
    const shown = JSON.stringify(r.seen[2].at(-1))
    expect(shown).toMatch(/exit_code\\*":0/)
    expect(shown).not.toMatch(/must run|not named|python3, cat|predicate|synthetic/i)
    expect(r.trace.artifacts).toHaveLength(1)
  })

  it('hands the critic the stdout a real run prints, with no disclaimer', () => {
    const last = r.critic.at(-1)!
    expect(last).toContain('North,47')
    expect(last).toContain('Total,66')
    expect(last).not.toMatch(/not executed|No generated code/i)
    expect(r.critic.slice(0, -1).every((c) => !c.includes('Total,66'))).toBe(true)
  })
})

describe('scenario 09 (office actor, synthetic sandbox)', () => {
  it('accepts a script that embeds the handed-off notes and saves the document', async () => {
    const r = await replay(summary, [
      writeThenRun('/work/summary.py', SUMMARY_PY, 'python3 /work/summary.py'),
    ])
    expect(SUMMARY_PY).not.toContain('lantern-notes.md')
    expect(flags(r.trace)).toEqual([
      ['sandbox_write', true, undefined],
      ['sandbox_bash', true, true],
    ])
    expect(r.trace.artifacts).toEqual(['lantern-summary.docx'])
    expect(r.critic.at(-1)).toContain('Saved /work/out/lantern-summary.docx')
    expect(exhausted(r.events)).toBe(false)
  })
})

// RECORDED in live run 2 (the console log keeps the actor's prompts, the report keeps the
// first sandbox_bash of a failed grade). The sandbox does not run Python, so a script's own
// stdout stays unmodelled; what a shell prints for read-only inspection is modelled.
const RECORDED_INSPECTION = `ls -la /work/in && head -20 ${SALES}`
const RECORDED_PRINT_ONLY =
  "python3 - <<'PY'\nimport csv\nrows = list(csv.DictReader(open('/work/in/lantern-sales.csv')))\ntotal = sum(int(r['revenue']) for r in rows)\nby_region = {r['region']: int(r['revenue']) for r in rows}\nnotes = open('/work/in/lantern-notes.md').read().strip()\nprint('total', total, by_region)\nprint(notes)\nPY"
const ANALYSIS_PY =
  "python3 - <<'PY'\nimport csv\nrows = list(csv.DictReader(open('/work/in/lantern-sales.csv')))\nnotes = open('/work/in/lantern-notes.md').read().strip()\nopen('/work/out/lantern-launch-analysis.md', 'w').write(f'# Launch analysis\\n\\n{notes}\\n{len(rows)} regions\\n')\nprint('/work/out/lantern-launch-analysis.md')\nPY"

describe('scenario 10, attempt 1 as recorded: an exploratory compound read', () => {
  // MUTATION: make `inspect` return undefined for a command containing `&&` (the old rule).
  it('prints the listing and the head of the input, as a shell does, and records nothing', async () => {
    const r = await replay(csv, [
      act('sandbox_bash', { command: RECORDED_INSPECTION }),
      writeThenRun('/work/totals.py', TOTALS_PY, 'python3 /work/totals.py'),
    ])
    const shown = JSON.stringify(r.seen[1].at(-1))
    expect(shown).toContain('lantern-sales.csv')
    expect(shown).toContain('region,revenue')
    expect(shown).toMatch(/exit_code\\*":0/)
    expect(r.trace.tools[0]).toMatchObject({ name: 'sandbox_bash', success: true, valid: false })
    expect(r.trace.artifacts).toEqual(['lantern-totals.csv'])
  })
})

describe('scenario 17 as recorded: a computation that prints and saves nothing', () => {
  // MUTATIONS: sandboxArgs accepts a command naming SOME of its files (`every` -> `some`);
  // the transport records an artifact for a command that never names the output.
  it('is not a deliverable: no file is written, so none would be promoted in production', async () => {
    expect(RECORDED_PRINT_ONLY).not.toContain('/work/out')
    expect(RECORDED_PRINT_ONLY).not.toContain('lantern-launch-analysis.md')
    const r = await replay(analysis, [
      act('sandbox_bash', { command: RECORDED_PRINT_ONLY }),
      act('sandbox_bash', { command: ANALYSIS_PY }, { is_final: true }),
    ])
    expect(flags(r.trace)).toEqual([
      ['sandbox_bash', true, false],
      ['sandbox_bash', true, true],
    ])
    expect(r.trace.artifacts).toEqual(['lantern-launch-analysis.md'])
    expect(r.trace.indexed).toEqual(['lantern-launch-analysis.md'])
    expect(r.critic.at(-1)).toContain('Saved /work/out/lantern-launch-analysis.md')
    expect(exhausted(r.events)).toBe(false)
  })

  it('leaves the artifact unrecorded when the print-only run is the last request', async () => {
    const r = await replay(analysis, [
      act('sandbox_bash', { command: RECORDED_PRINT_ONLY }, { is_final: true }),
    ])
    expect(r.trace.artifacts).toEqual([])
    expect(r.trace.indexed).toEqual([])
  })
})

describe('the synthetic sandbox as a transport', () => {
  const make = (scenario = csv) => {
    const trace: ConversationTrace = {
      turns: [],
      tools: [],
      artifacts: [],
      indexed: [],
      retrievals: [],
    }
    const documents = new Map([
      ['lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n'],
      ['lantern-notes.md', 'Lantern notes'],
    ])
    let current = trace
    const t = createSyntheticSandbox({
      scenario: () => scenario,
      trace: () => current,
      turn: () => 0,
      documents,
      descriptions: [BASH, ...SANDBOX_FILE_TOOLS],
    })
    return {
      call: (name: string, args: Record<string, unknown>) => t.callTool(name, args),
      trace,
      newRun: () => {
        current = { turns: [], tools: [], artifacts: [], indexed: [], retrievals: [] }
      },
    }
  }

  it('reads inputs and what was written, and fails on what does not exist', async () => {
    const { call } = make()
    expect((await call('sandbox_read', { path: SALES })).data).toContain('North,47')
    expect((await call('sandbox_read', { path: '/work/nope.txt' })).success).toBe(false)
    await call('sandbox_write', { path: '/work/a.py', content: 'print(1)' })
    expect((await call('sandbox_read', { path: '/work/a.py' })).data).toBe('print(1)')
  })

  it('lists directories as [FILE]/[DIR] lines, inputs and outputs apart', async () => {
    const { call } = make()
    await call('sandbox_write', { path: '/work/a.py', content: 'x' })
    const root = (await call('sandbox_list', { path: '/work' })).data as string
    expect(root.split('\n')).toEqual(
      expect.arrayContaining(['[DIR] in', '[DIR] out', '[FILE] a.py']),
    )
    expect(
      ((await call('sandbox_list', { path: '/work/in' })).data as string).split('\n').sort(),
    ).toEqual(['[FILE] lantern-notes.md', '[FILE] lantern-sales.csv'])
    await call('sandbox_bash', { command: `python3 -c "print('${SALES}', '${TOTALS}')"` })
    expect((await call('sandbox_list', { path: '/work/in' })).data).not.toContain(
      'lantern-totals.csv',
    )
    expect((await call('sandbox_list', { path: '/work/out' })).data).toBe(
      '[FILE] lantern-totals.csv',
    )
  })

  it('serves a produced artifact its own content from /work/out, not the notes', async () => {
    const { call } = make()
    await call('sandbox_bash', { command: `python3 -c "print('${SALES}', '${TOTALS}')"` })
    expect((await call('sandbox_read', { path: TOTALS })).data).toContain('Total,66')
    expect((await call('sandbox_read', { path: '/work/in/lantern-totals.csv' })).success).toBe(
      false,
    )
  })

  it('refuses paths outside /work and traversal out of it', async () => {
    const { call } = make()
    for (const path of ['/etc/passwd', '/work/../etc/passwd', '/work/in/../../etc/passwd']) {
      expect((await call('sandbox_read', { path })).success, path).toBe(false)
      expect((await call('sandbox_write', { path, content: 'x' })).success, path).toBe(false)
      expect((await call('sandbox_list', { path })).success, path).toBe(false)
    }
  })

  it('runs read-only commands joined by && or ; as a shell would', async () => {
    const { call, trace } = make()
    const out = async (command: string) => (await call('sandbox_bash', { command })).data as never
    const both = (await out(`ls /work/in && head -n 1 ${SALES}`)) as { stdout: string }
    expect(both.stdout.split('\n').sort()).toEqual(
      ['lantern-notes.md', 'lantern-sales.csv', 'region,revenue'].sort(),
    )
    expect(both.stdout.endsWith('region,revenue')).toBe(true)
    expect(((await out(`head -1 ${SALES}`)) as { stdout: string }).stdout).toBe('region,revenue')
    expect(((await out(`head -n2 ${SALES}`)) as { stdout: string }).stdout).toBe(
      'region,revenue\nNorth,47',
    )
    // `&&` stops at the first failure; `;` carries on.
    const stopped = (await out('cat /work/nope && ls /work/in')) as {
      stdout: string
      stderr: string
      exit_code: number
    }
    expect(stopped.stdout).toBe('')
    expect(stopped.stderr).toContain('No such file or directory')
    expect(stopped.exit_code).toBe(1)
    const carried = (await out('cat /work/nope ; ls /work/in')) as {
      stdout: string
      exit_code: number
    }
    expect(carried.stdout).toContain('lantern-sales.csv')
    expect(carried.exit_code).toBe(0)
    // Nothing read-only is recorded as a deliverable, but pipes ARE inspection: what the
    // real container prints, the model prints (`cat f | wc -l` → `3\n`, calibrated).
    expect(trace.artifacts).toEqual([])
    expect(await out(`cat ${SALES} | wc -l`)).toMatchObject({
      stdout: '3\n',
      stderr: '',
      exit_code: 0,
    })
    // The interpreter stage runs and is judged; the modelled `ls` still prints.
    expect(((await out(`ls /work/in && python3 -c "print(1)"`)) as { stdout: string }).stdout).toBe(
      'lantern-notes.md\nlantern-sales.csv\n',
    )
  })

  // F1: the reviewed compound split swallowed the executor as `head` operands,
  // changing scenario 10's grade. MUTATION: remove |\n from inspect's split.
  it.each([`ls /work/in && head -3 ${SALES}`, `head -3 ${SALES}`])(
    'grades the executor after a newline following %s as a request',
    async (inspection) => {
      const { call, trace } = make()
      await call('sandbox_write', { path: '/work/totals.py', content: TOTALS_PY })
      const command = `${inspection}\npython3 /work/totals.py`
      expect((await call('sandbox_bash', { command })).success).toBe(true)
      expect(trace.tools.at(-1)).toMatchObject({
        name: 'sandbox_bash',
        args: { command },
        valid: true,
      })
      expect(trace.artifacts).toEqual(['lantern-totals.csv'])
    },
  )

  // MUTATIONS: remove |\n from the split; restore the unconditional empty-part refusal.
  it.each(['\n', ';'])('runs inspections separated or terminated by %j', async (separator) => {
    const { call, trace } = make()
    const listed = ['lantern-notes.md', 'lantern-sales.csv']
    const both = await call('sandbox_bash', {
      command: `ls /work/in${separator}head -n 1 ${SALES}`,
    })
    expect(both.data).toMatchObject({
      stdout: `${listed.join('\n')}\nregion,revenue`,
      exit_code: 0,
    })
    expect((await call('sandbox_bash', { command: `ls /work/in${separator}` })).data).toMatchObject(
      {
        stdout: `${listed.join('\n')}\n`,
        exit_code: 0,
      },
    )
    // A newline, like `;`, continues after a failure and returns the last exit code.
    expect(
      (await call('sandbox_bash', { command: `cat /work/nope${separator}ls /work/in` })).data,
    ).toMatchObject({ stdout: `${listed.join('\n')}\n`, exit_code: 0 })
    expect(trace.artifacts).toEqual([])
  })

  // MUTATION: allow every empty part, including an initial part or a missing && operand.
  it.each(['; ls /work/in', 'ls /work/in &&', 'ls /work/in && ; ls /work/in'])(
    'leaves an incomplete inspection to the request path: %s',
    async (command) => {
      const { call, trace } = make()
      expect((await call('sandbox_bash', { command })).data).toMatchObject({
        stdout: '',
        stderr: '',
        exit_code: 0,
      })
      expect(trace.artifacts).toEqual([])
    },
  )

  it('edits and searches what was written', async () => {
    const { call } = make()
    await call('sandbox_write', { path: '/work/a.py', content: 'x = 1\ny = 2' })
    expect(
      (
        await call('sandbox_edit', {
          path: '/work/a.py',
          edits: [{ oldText: 'y = 2', newText: 'y = 3' }],
        })
      ).success,
    ).toBe(true)
    expect((await call('sandbox_read', { path: '/work/a.py' })).data).toBe('x = 1\ny = 3')
    expect(
      (
        await call('sandbox_edit', {
          path: '/work/a.py',
          edits: [{ oldText: 'zzz', newText: 'q' }],
        })
      ).success,
    ).toBe(false)
    expect((await call('sandbox_search', { path: '/work', query: 'y = 3' })).data).toBe(
      '/work/a.py:2: y = 3',
    )
    expect((await call('sandbox_search', { path: '/work/in', query: 'North' })).data).toContain(
      'lantern-sales.csv:2: North,47',
    )
  })

  // R6DIAG row 14: run 6's script transcribed notes it had read with `sandbox_read` — the
  // executor held the input's content, so the run is a computation, not a silent no-op.
  // MUTATION: stop passing `readThisTurn()` at the two predicate call sites in
  // synthetic-sandbox.ts — both tests here go red.
  it('credits an input the executor read through sandbox_read earlier in the same turn', async () => {
    const { call, trace } = make(analysis)
    expect((await call('sandbox_read', { path: '/work/in/lantern-notes.md' })).success).toBe(true)
    // The script names the CSV it reads and the output it writes — but never the notes.
    const script =
      "rows = open('/work/in/lantern-sales.csv').read()\nopen('/work/out/lantern-launch-analysis.md', 'w').write(rows)\n"
    await call('sandbox_write', { path: '/work/run.py', content: script })
    expect((await call('sandbox_bash', { command: 'python3 /work/run.py' })).success).toBe(true)
    expect(trace.tools.at(-1)).toMatchObject({ name: 'sandbox_bash', success: true, valid: true })
    expect(trace.artifacts).toEqual(['lantern-launch-analysis.md'])
  })

  it('refuses the same script when nothing read the un-named input either', async () => {
    const { call, trace } = make(analysis)
    const script =
      "rows = open('/work/in/lantern-sales.csv').read()\nopen('/work/out/lantern-launch-analysis.md', 'w').write(rows)\n"
    await call('sandbox_write', { path: '/work/run.py', content: script })
    expect((await call('sandbox_bash', { command: 'python3 /work/run.py' })).success).toBe(true)
    expect(trace.tools.at(-1)).toMatchObject({ name: 'sandbox_bash', success: true, valid: false })
    expect(trace.artifacts).toEqual([])
  })

  it('drops the actor’s written files when a new run starts', async () => {
    const { call, newRun } = make()
    await call('sandbox_write', { path: '/work/a.py', content: 'x' })
    newRun()
    expect((await call('sandbox_read', { path: '/work/a.py' })).success).toBe(false)
  })

  it('answers like a shell: a missing script is an exit-2 error, an unknown file a cat error', async () => {
    const { call } = make()
    const missing = await call('sandbox_bash', { command: 'python3 /work/gone.py' })
    expect(missing.success).toBe(false)
    expect(JSON.stringify(missing.data)).toContain("can't open file '/work/gone.py'")
    expect(
      JSON.stringify((await call('sandbox_bash', { command: 'cat /work/in/x.csv' })).data),
    ).toContain('No such file or directory')
  })
})

it('exposes exactly the tools the production sandbox does', () => {
  const production = V0_IN_VM_SERVERS.flatMap((s) => Object.values(s.tools)).sort()
  const driver = readFileSync(resolve('evals/general-next/driver.ts'), 'utf8')
  const declared = [...driver.matchAll(/^ {2}(sandbox_[a-z]+): 'sandbox',$/gm)].map((m) => m[1])
  expect(declared.sort()).toEqual(production)
  expect([...SANDBOX_FILE_TOOLS.map((t) => t.name), 'sandbox_bash'].sort()).toEqual(production)
  expect(driver).toContain('createSyntheticSandbox({')
})

it('replays the requests and predicates of scenarios 14 and 17 as they are written', () => {
  const read = (f: string) => readFileSync(resolve(`evals/general-next/scenarios/${f}`), 'utf8')
  const seventeen = read('17-mail-analysis-follow-up.ts')
  expect(seventeen).toContain(analysis.messages[0])
  expect(seventeen.replace(/\s+/g, ' ')).toContain(
    "sandboxArgs( 'lantern-launch-analysis.md', 'lantern-notes.md', 'lantern-sales.csv', )",
  )
  expect(seventeen).toContain("artifacts: ['lantern-launch-analysis.md']")
})

it('replays the requests and predicates of scenarios 09 and 10 as they are written', () => {
  const read = (f: string) => readFileSync(resolve(`evals/general-next/scenarios/${f}`), 'utf8')
  const ten = read('10-csv-analysis.ts')
  expect(ten).toContain(csv.messages[0])
  expect(ten).toContain("sandboxArgs('lantern-totals.csv', 'lantern-sales.csv')")
  expect(ten).toContain("artifacts: ['lantern-totals.csv']")
  expect(ten).toContain("stdout: 'North,47\\nSouth,19\\nTotal,66'")
  const nine = read('09-upload-summary.ts')
  expect(nine).toContain(summary.messages[0])
  expect(nine).toContain("sandboxArgs('lantern-summary.docx')")
  expect(nine).toContain("artifacts: ['lantern-summary.docx']")
})
