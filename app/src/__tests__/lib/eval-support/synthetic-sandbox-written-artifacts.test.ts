/** #507 scenario 11 (mail-to-file), eval run 3: the actor read the mail, then saved the
 * checklist with `sandbox_write` to /work/out/lantern-launch.md and never ran
 * `sandbox_bash`, so the ordered-tool, valid-arguments and stash-artifact checks failed
 * on a deliverable production would have kept.
 *
 * Production promotes ANY new or changed file under /work/out at turn exit, whichever tool
 * wrote it (`promoteOutputs`, packages/sandbox/work-artifacts.server.ts:164-197, called
 * from with-sandbox.server.ts:841 over `listWorkFiles`/`diffWorkFiles`,
 * work-sync.server.ts:147-177). So the synthetic sandbox credits a `sandbox_write` — for the
 * scenarios that declare `writtenArtifacts`, and only with the written bytes meeting the
 * scenario's content predicate. Scenarios 10, 14 and 17 compute (the office actor's own
 * rule is "Run code for computations"): `sandbox_bash` stays their only producer.
 *
 * Every rejected shape below is one the run-3 behaviour must NOT be widened into. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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

const read = (file: string) => readFileSync(resolve(file), 'utf8')
const scenarioSource = (file: string) => read(`evals/general-next/scenarios/${file}`)

// Scenario 11 as written (src/ may not import evals/; the source pins at the end hold this
// copy to the file).
const mail = {
  id: '11-mail-to-file',
  title: 'Find synthetic mail, then create a document',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'Find the Lantern launch email in my inbox. Turn its checklist into lantern-launch.md and give me the file.',
  ],
  expectedTools: ['graph_mail_recent', 'sandbox_bash'],
  expectedArgs: { sandbox_bash: sandboxArgs(['lantern-launch.md']), graph_mail_recent: mailArgs },
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-launch.md', 'CSV'],
  artifacts: ['lantern-launch.md'],
  writtenArtifacts: { 'lantern-launch.md': writtenContains('verify CSV export', 'publish notes') },
  forbiddenTools: [],
  maxIterations: 6,
} as unknown as ConversationScenario
// Scenario 10: a computation, no declared written deliverable.
const csv = {
  id: '10-csv-analysis',
  messages: ['Use the uploaded lantern-sales.csv to total revenue by region.'],
  expectedTools: ['sandbox_bash'],
  expectedArgs: { sandbox_bash: sandboxArgs(['lantern-sales.csv', 'lantern-totals.csv']) },
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: ['lantern-totals.csv'],
  forbiddenTools: [],
  maxIterations: 6,
} as unknown as ConversationScenario

const LAUNCH = '/work/out/lantern-launch.md'
// What run 3's actor sent, verbatim (capture 2026-10-20T01-12-30-716Z, synthetic content).
const RECORDED_WRITE = {
  path: LAUNCH,
  content: '# Lantern Launch Checklist\n\n- [ ] Verify CSV export\n- [ ] Publish notes\n',
}
const BASH = {
  name: 'sandbox_bash',
  description: 'Run a shell command.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
}

function rig(scenario: ConversationScenario = mail) {
  const trace: ConversationTrace = {
    turns: [],
    tools: [],
    artifacts: [],
    indexed: [],
    retrievals: [],
  }
  const documents = new Map([
    ['lantern-notes.md', 'Lantern notes'],
    ['lantern-sales.csv', 'region,revenue\nNorth,47\nSouth,19\n'],
  ])
  const sandbox = createSyntheticSandbox({
    scenario: () => scenario,
    trace: () => trace,
    turn: () => 0,
    documents,
    descriptions: [BASH, ...SANDBOX_FILE_TOOLS],
  })
  return {
    trace,
    documents,
    call: (name: string, args: Record<string, unknown>) => sandbox.callTool(name, args),
    /** The graph transport's own trace entry, as the driver records it. */
    readMail: () =>
      trace.tools.push({ name: 'graph_mail_recent', args: { limit: 25 }, success: true, turn: 0 }),
    /** Grade the run the way the runner does, baseline mode (no route events in a unit trace). */
    failed: (s: ConversationScenario = scenario) => {
      trace.turns = [{ response: 'Saved lantern-launch.md (CSV).', status: 'running', events: [] }]
      return grade(s, trace, true)
        .filter((c) => !c.pass)
        .map((c) => c.name)
    },
  }
}
const THE_THREE = [
  'successful ordered tool: sandbox_bash',
  'valid arguments: sandbox_bash',
  'stash artifact: lantern-launch.md',
]

describe('scenario 11 as recorded in eval run 3: mail, then sandbox_write to /work/out', () => {
  it('credits the written checklist as the artifact, indexed, and lets the actor read it back', async () => {
    const { call, readMail, trace, documents, failed } = rig()
    readMail()
    const write = await call('sandbox_write', RECORDED_WRITE)
    expect(write.success).toBe(true)
    expect(trace.tools.at(-1)).toMatchObject({ name: 'sandbox_write', success: true, valid: true })
    expect((await call('sandbox_read', { path: LAUNCH })).data).toBe(RECORDED_WRITE.content)
    expect(trace.artifacts).toEqual(['lantern-launch.md'])
    expect(trace.indexed).toEqual(['lantern-launch.md'])
    expect(documents.get('lantern-launch.md')).toBe(RECORDED_WRITE.content)
    expect(failed()).toEqual([])
  })

  it('names the tool that produced the file in the check detail', async () => {
    const { call, readMail, trace } = rig()
    readMail()
    await call('sandbox_write', RECORDED_WRITE)
    trace.turns = [{ response: 'lantern-launch.md CSV', status: 'running', events: [] }]
    expect(grade(mail, trace, true).find((c) => c.name.endsWith('sandbox_bash'))?.detail).toBe(
      'call index 1 (sandbox_write)',
    )
  })

  it('without the declaration, the same run reproduces run 3’s three failures and nothing else', async () => {
    const { call, readMail, failed } = rig({ ...mail, writtenArtifacts: undefined })
    readMail()
    await call('sandbox_write', RECORDED_WRITE)
    expect(failed({ ...mail, writtenArtifacts: undefined })).toEqual(THE_THREE)
  })

  it('still credits the shell path, which has no content to judge', async () => {
    const { call, readMail, failed } = rig()
    readMail()
    await call('sandbox_bash', {
      command: `python3 -c "open('/work/out/lantern-launch.md','w')" # lantern-launch.md`,
    })
    expect(failed()).toEqual([])
  })
})

describe('what a write must still be to count (every shape below stays rejected)', () => {
  const CHECKLIST = RECORDED_WRITE.content
  it.each([
    ['outside /work/out', '/work/lantern-launch.md', CHECKLIST],
    ['to /work/in', '/work/in/lantern-launch.md', CHECKLIST],
    ['in a /work/out subdirectory', '/work/out/drafts/lantern-launch.md', CHECKLIST],
    ['under another name', '/work/out/other.md', CHECKLIST],
    ['to a name Object.prototype owns', '/work/out/constructor', CHECKLIST],
    ['empty', LAUNCH, ''],
    ['whitespace only', LAUNCH, ' \n\t\n'],
    ['with the wrong content', LAUNCH, '# Lantern Launch Checklist\n\n- [ ] Ship it\n'],
    ['with one of the two checklist items', LAUNCH, '- [ ] Verify CSV export\n'],
  ])('a write %s is accepted by the VM and credits nothing', async (_shape, path, content) => {
    const { call, readMail, trace, failed } = rig()
    readMail()
    expect((await call('sandbox_write', { path, content })).success).toBe(true)
    expect(trace.tools.at(-1)?.valid).toBe(false)
    expect(trace.artifacts).toEqual([])
    expect(trace.indexed).toEqual([])
    expect(failed()).toEqual(THE_THREE)
  })

  it.each([
    ['traversal out of /work/out', '/work/out/../lantern-launch.md'],
    ['a path outside /work', '/tmp/out/lantern-launch.md'],
  ])('a write by %s fails outright and credits nothing', async (_shape, path) => {
    const { call, readMail, trace, failed } = rig()
    readMail()
    expect((await call('sandbox_write', { path, content: RECORDED_WRITE.content })).success).toBe(
      false,
    )
    expect(trace.artifacts).toEqual([])
    expect(failed()).toEqual(THE_THREE)
  })

  it('refuses an empty file even when the scenario’s predicate would accept anything', async () => {
    const lax = { ...mail, writtenArtifacts: { 'lantern-launch.md': () => true } }
    const { call, readMail, trace } = rig(lax as unknown as ConversationScenario)
    readMail()
    await call('sandbox_write', { path: LAUNCH, content: '  \n' })
    expect(trace.artifacts).toEqual([])
    await call('sandbox_write', { path: LAUNCH, content: 'x' })
    expect(trace.artifacts).toEqual(['lantern-launch.md'])
  })

  it('lets the last write decide, as the exit-time diff would: a later bad write withdraws the credit', async () => {
    const { call, readMail, trace, documents, failed } = rig()
    readMail()
    await call('sandbox_write', RECORDED_WRITE)
    await call('sandbox_write', { path: LAUNCH, content: 'overwritten' })
    expect(trace.tools.map((t) => t.valid)).toEqual([undefined, true, false])
    expect(trace.artifacts).toEqual([])
    expect(trace.indexed).toEqual([])
    expect(documents.has('lantern-launch.md')).toBe(false)
    expect(failed()).toEqual(['stash artifact: lantern-launch.md'])
  })

  it('credits a bad write followed by a good one, once', async () => {
    const { call, readMail, trace, failed } = rig()
    readMail()
    await call('sandbox_write', { path: LAUNCH, content: 'draft' })
    await call('sandbox_write', RECORDED_WRITE)
    expect(trace.artifacts).toEqual(['lantern-launch.md'])
    expect(failed()).toEqual([])
  })

  it('requires the write to come after the mail lookup the scenario orders first', async () => {
    const { call, readMail, failed } = rig()
    await call('sandbox_write', RECORDED_WRITE)
    readMail()
    expect(failed()).toContain('successful ordered tool: sandbox_bash')
  })
})

describe('the computing scenarios keep sandbox_bash as their only producer', () => {
  it('credits no write in a scenario that declares no written deliverable', async () => {
    const { call, trace, failed } = rig(csv)
    const res = await call('sandbox_write', {
      path: '/work/out/lantern-totals.csv',
      content: 'region,revenue\nNorth,47\nSouth,19\nTotal,66\n',
    })
    expect(res.success).toBe(true)
    expect(trace.tools.at(-1)?.valid).toBeUndefined()
    expect(trace.artifacts).toEqual([])
    expect(failed(csv)).toEqual(
      expect.arrayContaining([
        'successful ordered tool: sandbox_bash',
        'stash artifact: lantern-totals.csv',
      ]),
    )
  })

  it('does not let a write the transport flagged valid stand in for the shell step either', () => {
    const { trace, failed } = rig(csv)
    trace.tools.push({
      name: 'sandbox_write',
      args: { path: '/work/out/lantern-totals.csv', content: 'x' },
      success: true,
      turn: 0,
      valid: true,
    })
    expect(failed(csv)).toContain('successful ordered tool: sandbox_bash')
  })

  it('does not accept a write for the shell step unless the transport judged it valid', () => {
    const { trace, failed } = rig()
    trace.tools.push({ name: 'graph_mail_recent', args: {}, success: true, turn: 0 })
    for (const valid of [undefined, false])
      trace.tools.push({
        name: 'sandbox_write',
        args: RECORDED_WRITE,
        success: true,
        turn: 0,
        ...(valid === undefined ? {} : { valid }),
      })
    expect(failed()).toEqual(
      expect.arrayContaining(['successful ordered tool: sandbox_bash', ...THE_THREE.slice(1)]),
    )
  })

  it('declares the write path for scenario 11 only, with the predicate and the mail’s own items', () => {
    const eleven = scenarioSource('11-mail-to-file.ts')
    // Anchored to a live line: a commented-out declaration must not satisfy the pin.
    expect(eleven).toMatch(
      /^ {2}writtenArtifacts: \{\s*'lantern-launch\.md': writtenContains\('verify CSV export', 'publish notes'\),?\s*\}/m,
    )
    expect(eleven).toContain("expectedTools: ['graph_mail_recent', 'sandbox_bash']")
    expect(eleven).toContain(mail.messages[0])
    expect(read('evals/general-next/driver.ts')).toContain(
      'Launch checklist: verify CSV export; publish notes.',
    )
    for (const file of [
      '09-upload-summary.ts',
      '10-csv-analysis.ts',
      '14-analysis-index-follow-up.ts',
      '17-mail-analysis-follow-up.ts',
    ])
      expect(scenarioSource(file), file).not.toContain('writtenArtifacts')
  })
})

describe('writtenContains', () => {
  const has = writtenContains('verify CSV export', 'publish notes')
  it('ignores case and whitespace runs, and needs every phrase', () => {
    expect(has('- [ ] VERIFY  csv\nexport\n- [ ] Publish   Notes')).toBe(true)
    expect(has('- [ ] Verify CSV export')).toBe(false)
    expect(has('- [ ] Check the CSV export\n- [ ] Publish notes')).toBe(false)
    expect(has('')).toBe(false)
  })
})
