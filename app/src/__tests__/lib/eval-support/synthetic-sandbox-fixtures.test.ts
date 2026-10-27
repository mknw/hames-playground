/** The five run-3 failing sandbox scenarios as regression fixtures (owner ruling
 * 2026-10-25: the synthetic sandbox's credited-vocabulary whitelist was the defect —
 * `ls -la /work/in && echo '---' && head …`, pipelines and plain `echo` returned empty
 * stdout where the real container prints, and the candidate read the dead-looking box
 * as closed, cycled exploration and exhausted its retries).
 *
 * Every command below is verbatim from the capture
 * `evals/reports/2026-10-24T21-25-58-561Z-general-next-capture.json` (the run-3
 * controllerCalls of the scenario named in each fixture). The producing run that ends
 * each sequence is the shape the widened interface contract has to credit: an executor
 * (or a redirected writer) leaving the scenario's declared artifact. The scenario
 * predicates (`grade`) must pass on these sequences; on the pre-fix code the same
 * sequences read as a closed box — empty stdout for `echo` chains — and the grade
 * failed on the very rows asserted here. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// `conversation-checks` reads the production O21 address extractor, whose module
// self-asserts server-only; this suite runs under jsdom, so the assert is mocked
// exactly as the sibling fixture tests do.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
import '../../mocks/namespace-catalog'
import {
  SANDBOX_FILE_TOOLS,
  createSyntheticSandbox,
} from '../../../lib/eval-support/synthetic-sandbox'
import { grade } from '../../../lib/eval-support/conversation-checks'
import type {
  ConversationScenario,
  ConversationTrace,
} from '../../../lib/eval-support/conversation'
import { mailArgs, sandboxArgs, writtenContains } from '../../../lib/eval-support/tool-arguments'

const read = (file: string) => readFileSync(resolve(`evals/general-next/scenarios/${file}`), 'utf8')

// The scenario objects as written, pinned to their sources (src/ may not import evals/).
const pin = (source: string, snippet: string) =>
  expect(source.replace(/\s+/g, ' ')).toContain(snippet.replace(/\s+/g, ' '))
pin(read('10-csv-analysis.ts'), "sandboxArgs('lantern-totals.csv', 'lantern-sales.csv')")
pin(read('09-upload-summary.ts'), "sandboxArgs('lantern-summary.docx')")
pin(read('11-mail-to-file.ts'), "sandboxArgs('lantern-launch.md')")
pin(
  read('14-analysis-index-follow-up.ts'),
  "'lantern-analysis.md', 'lantern-notes.md', 'lantern-sales.csv'",
)
pin(
  read('17-mail-analysis-follow-up.ts'),
  "'lantern-launch-analysis.md', 'lantern-notes.md', 'lantern-sales.csv'",
)

const SALES = '/work/in/lantern-sales.csv'
const NOTES = '/work/in/lantern-notes.md'
const BASH = {
  name: 'sandbox_bash',
  description: 'Run a shell command.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
}

const csv = {
  id: '10-csv-analysis',
  messages: [
    'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
  ],
  expectedTools: ['sandbox_bash'],
  expectedArgs: { sandbox_bash: sandboxArgs('lantern-totals.csv', 'lantern-sales.csv') },
  expectedRoutes: ['office-data'],
  answerIncludes: ['North', '47', 'South', '19', '66'],
  artifacts: ['lantern-totals.csv'],
  sandboxRun: {
    stdout: 'North,47\nSouth,19\nTotal,66',
    files: { 'lantern-totals.csv': 'region,revenue\nNorth,47\nSouth,19\nTotal,66\n' },
  },
  forbiddenTools: [],
  maxIterations: 6,
} as unknown as ConversationScenario

const summary = {
  id: '09-upload-summary',
  messages: [
    'I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.',
  ],
  expectedTools: ['sandbox_bash'],
  expectedArgs: { sandbox_bash: sandboxArgs('lantern-summary.docx') },
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-summary.docx', '2030-04-12'],
  artifacts: ['lantern-summary.docx'],
  forbiddenTools: [],
  maxIterations: 6,
} as unknown as ConversationScenario

const mail = {
  id: '11-mail-to-file',
  messages: [
    'Find the Lantern launch email in my inbox. Turn its checklist into lantern-launch.md and give me the file.',
  ],
  expectedTools: ['graph_mail_recent', 'sandbox_bash'],
  expectedArgs: { sandbox_bash: sandboxArgs('lantern-launch.md'), graph_mail_recent: mailArgs },
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-launch.md', 'CSV'],
  artifacts: ['lantern-launch.md'],
  writtenArtifacts: { 'lantern-launch.md': writtenContains('verify CSV export', 'publish notes') },
  forbiddenTools: [],
  maxIterations: 6,
} as unknown as ConversationScenario

const analysis = {
  id: '14-analysis-index-follow-up',
  messages: [
    'Analyse sales against the notes, save lantern-analysis.md, index it for this chat.',
    'From the analysis you just indexed, which region sold more and by how much? Cite that analysis.',
  ],
  expectedTools: ['sandbox_bash'],
  expectedArgs: {
    sandbox_bash: sandboxArgs('lantern-analysis.md', 'lantern-notes.md', 'lantern-sales.csv'),
  },
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['North', '47', 'South', '19', '28'],
  artifacts: ['lantern-analysis.md'],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-analysis.md',
  indexed: 'lantern-analysis.md',
} as unknown as ConversationScenario

const seventeen = {
  id: '17-mail-analysis-follow-up',
  messages: [
    'Find the Lantern launch email. Use its checklist and the uploads to prepare lantern-launch-analysis.md, index it.',
    'From that indexed analysis, which region sold more and by how much? Cite the report.',
  ],
  expectedTools: ['graph_mail_recent', 'sandbox_bash'],
  expectedArgs: {
    graph_mail_recent: mailArgs,
    sandbox_bash: sandboxArgs(
      'lantern-launch-analysis.md',
      'lantern-notes.md',
      'lantern-sales.csv',
    ),
  },
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['North', '47', 'South', '19', '28'],
  artifacts: ['lantern-launch-analysis.md'],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-launch-analysis.md',
  indexed: 'lantern-launch-analysis.md',
} as unknown as ConversationScenario

const rig = (scenario: ConversationScenario) => {
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
      ['lantern-notes.md', 'Lantern notes: release 2030-04-12, target 50.\n'],
      ['lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n'],
    ]),
    descriptions: [BASH, ...SANDBOX_FILE_TOOLS],
  })
  return {
    trace,
    call: (name: string, args: Record<string, unknown>) => sandbox.callTool(name, args),
    /** The graph transport's own trace entry, as the driver records it. */
    readMail: (limit: number) =>
      trace.tools.push({ name: 'graph_mail_recent', args: { limit }, success: true, turn: 0 }),
    /** The producing run that follows the exploration: write the script, then run it. */
    writeThenRun: async (path: string, content: string, run: string) => {
      await sandbox.callTool('sandbox_write', { path, content })
      return sandbox.callTool('sandbox_bash', { command: run })
    },
    grade: (response: string, opts?: { retrievals?: ConversationTrace['retrievals'] }) => {
      const events: ConversationTrace['turns'][number]['events'] = []
      if (opts?.retrievals?.length)
        events.push({
          type: 'tool_result',
          data: {
            result: {
              references: opts.retrievals.map((r) => ({ ...r, docId: `fixture-${r.source}` })),
            },
          },
        } as never)
      trace.turns = scenario.messages.map((_, index) => ({
        response: index === scenario.messages.length - 1 ? response : 'working.',
        status: 'running',
        events: index === scenario.messages.length - 1 ? events : [],
      }))
      if (opts?.retrievals?.length) trace.retrievals.push(...opts.retrievals)
      return grade(scenario, trace, true)
        .filter((c) => !c.pass)
        .map((c) => `${c.name}: ${c.detail.slice(0, 120)}`)
    },
  }
}

const out = (result: unknown) =>
  (result as { data: { stdout: string; stderr: string; exit_code: number } }).data

describe('fixture 10-csv-analysis (capture 2026-10-24T21-25-58-561Z, 36 controllerCalls: the exploration cycle)', () => {
  it('credits the exploration the live candidate was denied and the producing run after it', async () => {
    const t = rig(csv)
    const first = out(
      await t.call('sandbox_bash', {
        command: 'ls -la /work/in && head -20 /work/in/lantern-sales.csv',
      }),
    )
    expect(first.stdout).toContain('lantern-sales.csv')
    expect(first.stdout).toContain('region,revenue')
    expect(first.stdout).toContain('North,47')
    expect(first.exit_code).toBe(0)
    // The run-3 killer: the `echo` separator made the whole chain read as a dead box.
    const chained = out(
      await t.call('sandbox_bash', {
        command: "ls -la /work/in && echo '---' && cat /work/in/lantern-sales.csv",
      }),
    )
    expect(chained.stdout).toContain('---')
    expect(chained.stdout).toContain('South,19')
    expect(chained.exit_code).toBe(0)
    const echoed = out(
      await t.call('sandbox_bash', {
        command: "echo 'sandbox unavailable this turn'",
      }),
    )
    expect(echoed.stdout).toBe('sandbox unavailable this turn\n')
    expect(t.trace.tools.slice(0, 3).map((x) => x.valid)).toEqual([false, false, false])
    const run = out(
      await t.writeThenRun(
        '/work/totals.py',
        `import csv\nrows = list(csv.DictReader(open('${SALES}')))\nwriter = csv.writer(open('/work/out/lantern-totals.csv', 'w'))\nfor r in rows:\n    writer.writerow([r['region'], r['revenue']])\nwriter.writerow(['Total', 66])\n`,
        'python3 /work/totals.py',
      ),
    )
    expect(run.stdout).toBe('North,47\nSouth,19\nTotal,66')
    expect(t.trace.tools.at(-1)).toMatchObject({ name: 'sandbox_bash', success: true, valid: true })
    expect(t.trace.artifacts).toEqual(['lantern-totals.csv'])
    expect(t.grade('North 47, South 19, grand total 66; saved lantern-totals.csv.')).toEqual([])
  })
})

describe('fixture 09-upload-summary (capture: the heredoc run between the `echo blocked` cycles)', () => {
  it('prints the blocked echo and credits the heredoc that saves the document', async () => {
    const t = rig(summary)
    expect(out(await t.call('sandbox_bash', { command: 'echo blocked' })).stdout).toBe('blocked\n')
    const heredoc =
      "python3 - <<'PY'\nfrom docx import Document\n\ndoc = Document()\ndoc.add_heading('Lantern Summary', level=1)\ndoc.add_paragraph('Release date: 2030-04-12')\ndoc.add_paragraph('Target count: 50')\ndoc.add_paragraph('North revenue: 47')\ndoc.add_paragraph('South revenue: 19')\ndoc.add_paragraph('Hosting overspend: 5')\n\ndoc.save('/work/out/lantern-summary.docx')\nprint('Saved /work/out/lantern-summary.docx')\nPY"
    const run = out(await t.call('sandbox_bash', { command: heredoc }))
    expect(run.stdout).toBe('Saved /work/out/lantern-summary.docx')
    expect(t.trace.tools.at(-1)).toMatchObject({ name: 'sandbox_bash', success: true, valid: true })
    expect(t.trace.artifacts).toEqual(['lantern-summary.docx'])
    expect(t.grade('lantern-summary.docx is saved, covering release 2030-04-12.')).toEqual([])
  })
})

describe('fixture 11-mail-to-file (capture: mail, then the printf redirect of the checklist)', () => {
  it('credits the redirected writer from a shell line, with the file content as stdout', async () => {
    const t = rig(mail)
    t.readMail(15)
    const command =
      "mkdir -p /work/out && printf '# Lantern Launch Checklist\\n\\n- [ ] Verify CSV export\\n- [ ] Publish notes\\n' > /work/out/lantern-launch.md && cat /work/out/lantern-launch.md"
    const run = out(await t.call('sandbox_bash', { command }))
    expect(run.stdout).toBe(
      '# Lantern Launch Checklist\n\n- [ ] Verify CSV export\n- [ ] Publish notes\n',
    )
    expect(t.trace.tools.at(-1)).toMatchObject({ name: 'sandbox_bash', success: true, valid: true })
    expect(t.trace.artifacts).toEqual(['lantern-launch.md'])
    expect(t.trace.indexed).toEqual(['lantern-launch.md'])
    expect((await t.call('sandbox_read', { path: '/work/out/lantern-launch.md' })).data).toContain(
      'Publish notes',
    )
    expect(t.grade('lantern-launch.md saved from the CSV checklist mail.')).toEqual([])
  })
})

describe('fixture 14-analysis-index-follow-up (capture: list/read cycles and the blocked echoes)', () => {
  it('prints the exploration and credits the run that produces the indexed analysis', async () => {
    const t = rig(analysis)
    expect(out(await t.call('sandbox_bash', { command: 'ls -la /work/in/' })).stdout).toContain(
      'lantern-sales.csv',
    )
    expect(
      out(await t.call('sandbox_bash', { command: "echo 'sandbox unavailable'" })).stdout,
    ).toBe('sandbox unavailable\n')
    expect(out(await t.call('sandbox_bash', { command: `cat ${SALES}` })).stdout).toContain(
      'North,47',
    )
    const run = out(
      await t.writeThenRun(
        '/work/analysis.py',
        `notes = open('${NOTES}').read()\nrows = open('${SALES}').read()\nopen('/work/out/lantern-analysis.md', 'w').write(f'# Analysis\\n{notes}{rows}\\nNorth beat South by 28 (47 vs 19).\\n')\n`,
        'python3 /work/analysis.py',
      ),
    )
    expect(run.stdout).toBe('Saved /work/out/lantern-analysis.md')
    expect(t.trace.tools.at(-1)).toMatchObject({ name: 'sandbox_bash', success: true, valid: true })
    expect(t.trace.artifacts).toEqual(['lantern-analysis.md'])
    expect(t.trace.indexed).toEqual(['lantern-analysis.md'])
    // The later turn cites the indexed analysis the first turn produced.
    expect(
      t.grade('South took 19 and North took 47, a 28 gap. See lantern-analysis.md [1].', {
        retrievals: [{ source: 'lantern-analysis.md', turn: 1 }],
      }),
    ).toEqual([])
  })
})

describe('fixture 17-mail-analysis-follow-up (capture: mail, ls+cat, `echo waiting` cycles)', () => {
  it('credits the producing run behind the exploration the live candidate cycled through', async () => {
    const t = rig(seventeen)
    t.readMail(10)
    expect(
      out(
        await t.call('sandbox_bash', { command: 'ls /work/in/ && cat /work/in/lantern-sales.csv' }),
      ).stdout,
    ).toContain('North,47')
    expect(out(await t.call('sandbox_bash', { command: 'echo waiting' })).stdout).toBe('waiting\n')
    const heredoc =
      "python3 - <<'PY'\nimport csv\nrows = list(csv.DictReader(open('/work/in/lantern-sales.csv')))\nnotes = open('/work/in/lantern-notes.md').read().strip()\nopen('/work/out/lantern-launch-analysis.md', 'w').write(f'# Launch analysis\\n\\n{notes}\\n{len(rows)} regions: North 47, South 19, gap 28.\\n')\nprint('/work/out/lantern-launch-analysis.md')\nPY"
    expect(out(await t.call('sandbox_bash', { command: heredoc })).stdout).toBe(
      'Saved /work/out/lantern-launch-analysis.md',
    )
    expect(t.trace.tools.at(-1)).toMatchObject({ name: 'sandbox_bash', success: true, valid: true })
    expect(t.trace.artifacts).toEqual(['lantern-launch-analysis.md'])
    expect(t.trace.indexed).toEqual(['lantern-launch-analysis.md'])
    expect(
      t.grade('North 47 over South 19, a 28 gap — lantern-launch-analysis.md [1].', {
        retrievals: [{ source: 'lantern-launch-analysis.md', turn: 1 }],
      }),
    ).toEqual([])
  })
})

describe('determinism pin (the synthetic layer runs the same input twice, identically)', () => {
  it('a captured sequence leaves byte-identical traces on two fresh runs', async () => {
    const sequence = async () => {
      const t = rig(csv)
      await t.call('sandbox_bash', {
        command: "ls -la /work/in && echo '---' && cat /work/in/lantern-sales.csv",
      })
      await t.call('sandbox_bash', { command: 'echo waiting' })
      await t.writeThenRun(
        '/work/totals.py',
        `import csv\nrows = list(csv.DictReader(open('${SALES}')))\nwriter = csv.writer(open('/work/out/lantern-totals.csv', 'w'))\nwriter.writerow(['Total', 66])\n`,
        'python3 /work/totals.py',
      )
      return JSON.stringify({ tools: t.trace.tools, artifacts: t.trace.artifacts })
    }
    expect(await sequence()).toBe(await sequence())
  })
})
