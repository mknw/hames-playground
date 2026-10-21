// @vitest-environment node
/**
 * The off-host VM rehearsal workflow stays safe to run on a public repository.
 *
 * `.github/workflows/vm-rehearsal.yml` runs a root shell script on a GitHub-hosted
 * runner for pull requests, so what keeps it harmless is a handful of properties
 * of the file, each one a line a later edit could remove without any other test
 * noticing: no privileged trigger, a read-only token at both levels, no secrets,
 * actions pinned by commit, event text reaching a script only through `env`, a
 * bounded runtime, no stored checkout credential, and no fork pull requests. The
 * path filter has a seventh job: it must cover every file the script executes, or
 * a change to the harness skips the rehearsal that exists to test it.
 *
 * `violations()` is the checker; each case below mutates a copy of the real file
 * the way one such edit would and requires the checker to name it (the real file
 * must be clean, and a mutation that changes nothing is itself a failure).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const WORKFLOW = '.github/workflows/vm-rehearsal.yml'
const SCRIPT = 'scripts/vm-rehearsal.sh'
const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8')

interface Step {
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Workflow {
  on: { pull_request?: { paths?: string[] }; [event: string]: unknown }
  permissions?: Record<string, string>
  concurrency?: { 'cancel-in-progress'?: unknown }
  jobs: Record<
    string,
    {
      if?: string
      'runs-on'?: string
      'timeout-minutes'?: number
      permissions?: Record<string, string>
      steps?: Step[]
    }
  >
}

/** GitHub's path-filter glob: `**` crosses `/`, `*` and `?` do not. */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*'
      i++
      if (glob[i + 1] === '/') i++ // `**/` also matches no directory at all
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + source + '$')
}

/** Patterns apply in order and a later `!` pattern removes what an earlier one admitted. */
function runsFor(file: string, patterns: string[]): boolean {
  let included = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(file)) included = !negated
  }
  return included
}

/** What the filter deliberately leaves out: text and tests do not run in the rehearsal. */
const INERT = /\.(md|test\.py)$/

/** The repo files the script executes or builds from, named as `$REPO/…` or `$PIPE/…`. */
function executedFiles(script: string): string[] {
  const pipe = /^PIPE=\$REPO\/(\S+)$/m.exec(script)?.[1] ?? ''
  const files = new Set<string>()
  for (const [, root, rest] of script.matchAll(/\$\{?(REPO|PIPE)\}?\/([\w./-]+)/g)) {
    if (rest.startsWith('.sandbox-vm-spike')) continue // the state directory the run creates
    const relative = root === 'PIPE' ? `${pipe}/${rest}` : rest
    const full = path.join(REPO, relative)
    if (!existsSync(full)) {
      files.add(relative) // a missing file is the filter's problem too
    } else if (statSync(full).isDirectory()) {
      const inside = readdirSync(full, { recursive: true, withFileTypes: true }).filter(
        (e) => e.isFile() && !INERT.test(e.name),
      )
      for (const e of inside) files.add(path.relative(REPO, path.join(e.parentPath, e.name)))
    } else files.add(relative)
  }
  return [...files]
}

function violations(workflowText: string, script: string): string[] {
  const found: string[] = []
  const wf = parse(workflowText) as Workflow
  const job = wf.jobs?.rehearse
  if (!job) return ['no `rehearse` job']
  const steps = job.steps ?? []

  const triggers = Object.keys(wf.on ?? {}).sort()
  if (triggers.join() !== 'pull_request,workflow_dispatch') {
    found.push(
      `triggers must be exactly pull_request and workflow_dispatch, got ${triggers.join()}`,
    )
  }
  const readOnly = JSON.stringify({ contents: 'read' })
  if (JSON.stringify(wf.permissions) !== readOnly)
    found.push('workflow permissions must be exactly contents: read')
  if (JSON.stringify(job.permissions) !== readOnly)
    found.push('job permissions must be exactly contents: read')

  if (/secrets|GITHUB_TOKEN/i.test(JSON.stringify(wf)))
    found.push('the workflow references secrets or a token')
  if (typeof job['runs-on'] !== 'string' || !/^ubuntu-[\d.]+$/.test(job['runs-on'])) {
    found.push('runs-on must be a GitHub-hosted ubuntu label, never self-hosted')
  }

  const used = steps.filter((s) => s.uses)
  if (used.length === 0) found.push('the scan found no `uses:` step')
  for (const s of used) {
    if (!/^actions\/[\w.-]+@[0-9a-f]{40}$/.test(s.uses!))
      found.push(`not a SHA-pinned GitHub-owned action: ${s.uses}`)
  }
  const checkout = used.find((s) => s.uses!.startsWith('actions/checkout@'))
  if (checkout?.with?.['persist-credentials'] !== false)
    found.push('checkout must set persist-credentials: false')

  for (const s of steps.filter((s) => s.run)) {
    if (s.run!.includes('${{'))
      found.push('an expression is interpolated into a run script; route it through env')
  }
  if (!steps.some((s) => s.env?.REHEARSAL_STOP_AFTER === '${{ inputs.stop_after }}')) {
    found.push('the dispatch input must reach the script through env')
  }

  const timeout = job['timeout-minutes']
  if (typeof timeout !== 'number' || timeout > 90)
    found.push('the job needs timeout-minutes of at most 90')
  if (!steps.some((s) => (s as { 'timeout-minutes'?: number })['timeout-minutes'])) {
    found.push('the rehearsal step needs its own timeout-minutes')
  }
  if (wf.concurrency?.['cancel-in-progress'] !== "${{ github.event_name == 'pull_request' }}") {
    found.push('a superseded pull request run must be cancelled, a manual one never')
  }
  if (!job.if?.includes('github.event.pull_request.head.repo.full_name == github.repository')) {
    found.push('fork pull requests must be skipped by the job `if`')
  }

  const paths = wf.on?.pull_request?.paths ?? []
  const files = executedFiles(script)
  if (files.length < 8) found.push(`the script scan found only ${files.length} executed files`)
  const skipped = files.filter((f) => !runsFor(f, paths))
  if (skipped.length)
    found.push(`not covered by the path filter: ${skipped.slice(0, 5).join(', ')}`)
  return found
}

const workflow = read(WORKFLOW)
const script = read(SCRIPT)

/** One edit a later change could make, and the finding that must name it. */
const mutations: [label: string, edit: (text: string) => string, expected: RegExp][] = [
  [
    'a privileged trigger',
    (t) => t.replace('  pull_request:\n', '  pull_request_target:\n'),
    /triggers must be exactly/,
  ],
  ['a push trigger', (t) => t.replace('on:\n', 'on:\n  push:\n'), /triggers must be exactly/],
  [
    'a write token at workflow level',
    (t) =>
      t.replace(
        'permissions:\n  contents: read\n\nconc',
        'permissions:\n  contents: write\n\nconc',
      ),
    /workflow permissions/,
  ],
  [
    'a write token at job level',
    (t) =>
      t.replace(
        '    permissions:\n      contents: read',
        '    permissions:\n      contents: write',
      ),
    /job permissions/,
  ],
  [
    'an extra job permission',
    (t) =>
      t.replace(
        '    permissions:\n      contents: read',
        '    permissions:\n      contents: read\n      id-token: write',
      ),
    /job permissions/,
  ],
  [
    'a secret reference',
    (t) =>
      t.replace(
        'REHEARSAL_STOP_AFTER: ${{ inputs.stop_after }}',
        'REHEARSAL_STOP_AFTER: ${{ inputs.stop_after }}\n          TOKEN: ${{ secrets.DEPLOY_KEY }}',
      ),
    /secrets or a token/,
  ],
  [
    'a self-hosted runner',
    (t) => t.replace('runs-on: ubuntu-26.04', 'runs-on: self-hosted'),
    /runs-on/,
  ],
  [
    'a floating action tag',
    (t) => t.replace(/actions\/checkout@[0-9a-f]{40} # v4\.4\.0/, 'actions/checkout@v4'),
    /SHA-pinned/,
  ],
  [
    'a third-party action',
    (t) => t.replace('actions/upload-artifact@', 'someone/upload-artifact@'),
    /SHA-pinned/,
  ],
  [
    'a stored checkout credential',
    (t) => t.replace('persist-credentials: false', 'persist-credentials: true'),
    /persist-credentials/,
  ],
  [
    'event text in a script',
    (t) =>
      t.replace(
        'run: bash scripts/vm-rehearsal.sh',
        'run: bash scripts/vm-rehearsal.sh ${{ inputs.stop_after }}',
      ),
    /interpolated/,
  ],
  [
    'the input no longer through env',
    (t) => t.replace('REHEARSAL_STOP_AFTER: ${{ inputs.stop_after }}', 'REHEARSAL_STOP_AFTER: all'),
    /through env/,
  ],
  ['no job timeout', (t) => t.replace('    timeout-minutes: 90\n', ''), /at most 90/],
  [
    'a long job timeout',
    (t) => t.replace('timeout-minutes: 90', 'timeout-minutes: 300'),
    /at most 90/,
  ],
  ['no step timeout', (t) => t.replace('        timeout-minutes: 75\n', ''), /own timeout/],
  [
    'a run that is never cancelled',
    (t) =>
      t.replace(
        "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
        'cancel-in-progress: false',
      ),
    /cancelled/,
  ],
  ['fork pull requests admitted', (t) => t.replace(/^ {4}if: .*\n/m, ''), /fork pull requests/],
  [
    'the harness library left out of the filter',
    (t) => t.replace("      - 'scripts/lib/sandbox_vm*.py'\n", ''),
    /path filter: .*sandbox_vm\.py/,
  ],
  [
    'the flavour sources left out of the filter',
    (t) => t.replace("      - 'rootfs/**'\n", ''),
    /path filter: .*rootfs\//,
  ],
  [
    'the pipeline left out of the filter',
    (t) => t.replace("      - 'packages/sandbox/scripts/vm-image/**'\n", ''),
    /path filter: .*vm-image\/build\.py/,
  ],
  [
    'an executed file excluded as a test',
    (t) => t.replace("'!**/*.test.py'", "'!**/*.py'"),
    /path filter: .*\.py/,
  ],
]

describe('vm-rehearsal workflow: what keeps it safe on a public repository', () => {
  it('the real workflow and script are clean', () => {
    expect(violations(workflow, script)).toEqual([])
  })

  it('every executed file is found, so the path-filter check cannot go quietly empty', () => {
    const files = executedFiles(script)
    expect(files).toContain('scripts/lib/sandbox_vm.py')
    expect(files).toContain('packages/sandbox/scripts/vm-image/build.py')
    expect(files.some((f) => f.startsWith('rootfs/'))).toBe(true)
  })

  it.each(mutations)('%s is named', (_label, edit, expected) => {
    const mutated = edit(workflow)
    expect(mutated, 'the mutation changed nothing').not.toBe(workflow)
    expect(violations(mutated, script).join('\n')).toMatch(expected)
  })

  it('a script that executes a file the filter never lists is named', () => {
    const extended =
      script +
      '\nbash "$REPO/scripts/lib/sandbox_vm_measure.py"\nbash "$REPO/tools/new-helper.sh"\n'
    expect(violations(workflow, extended).join('\n')).toMatch(
      /path filter: .*tools\/new-helper\.sh/,
    )
  })
})
