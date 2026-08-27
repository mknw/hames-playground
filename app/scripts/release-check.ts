/**
 * `pnpm release:check` — the pyramid, in order, once, with one answer at the end.
 *
 * ## What this is for
 *
 * The four test layers this repo runs are described in `docs/testing/pyramid.md`
 * and each is invoked differently: `pnpm test:run --coverage` (vitest, jsdom,
 * coverage floors), `pnpm test:e2e` (vitest, node, real Postgres), and
 * `pnpm test:e2e:browser` (Playwright, a real dev server, a real browser). Running
 * them by hand works and has one failure mode that keeps mattering: a person runs
 * two of the three, remembers the third as "probably fine", and the go/no-go is
 * made on a partial picture nobody wrote down.
 *
 * So: one command, fixed order, stop at the first failure, and one report file
 * that says what ran, how long it took, what it counted — and, in its last
 * section, WHAT IT DID NOT CHECK. That last part is what makes the answer honest.
 * The live layers (the eval suite against both tiers, the deployment smoke script)
 * need a GPU endpoint, a key and a bill; they are coordinated by hand and they are
 * not going to be run from here. A report that quietly omitted them would read as
 * a full pass.
 *
 * ## Order, and why it stops
 *
 * Cheapest first, and each layer subsumes the one below it in scope while costing
 * more: unit (~1 min) → app-path e2e (minutes, needs Postgres) → browser e2e
 * (minutes, needs Postgres + a browser + a dev-server boot). Stopping at the first
 * failure is deliberate: a red unit suite makes the layers above it un-diagnosable
 * — you cannot tell a browser scenario failing because of the bug from one failing
 * because of the bug's blast radius — and the report says which layer stopped it
 * and which were therefore not attempted, so a partial run is never mistaken for
 * a full one.
 *
 * `--from <layer>` and `--only <layer>` exist for the loop where you are fixing
 * one layer, and the report records that it was a partial run.
 *
 * ## Counts
 *
 * Each layer is asked for machine-readable output rather than having its log
 * scraped: `--reporter=json` for both vitest layers, Playwright's own JSON
 * reporter for the browser one. A parse failure is reported as such and never
 * silently becomes a zero — "0 tests passed" and "I could not read the output"
 * are different facts and only one of them is a reason to ship.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPORT_DIR = path.join(APP_DIR, 'evals', 'reports')
/** Scratch for the machine-readable output each layer is asked for. Under
 *  `evals/reports/` so nothing new needs gitignoring; deleted after parsing. */
const SCRATCH = path.join(REPORT_DIR, '.release-check')
const UNIT_RESULT = path.join(SCRATCH, 'unit.json')
const E2E_RESULT = path.join(SCRATCH, 'e2e.json')
const BROWSER_RESULT = path.join(SCRATCH, 'browser.json')

// ============================================================================
// The layers
// ============================================================================

interface Layer {
  /** What `--only` / `--from` take. */
  readonly id: string
  readonly title: string
  /** One line on what this layer can see that the one below it cannot. */
  readonly sees: string
  /** The `pnpm` script, plus whatever it takes to make it write JSON. The two
   *  runners disagree about how: vitest takes `--outputFile`, Playwright has no
   *  such flag and reads `PLAYWRIGHT_JSON_OUTPUT_NAME` from the environment
   *  instead. Both are spelled out per layer rather than guessed at, because
   *  passing vitest's flag to Playwright is an unknown-option error and passing
   *  neither makes the reporter print to stdout, where this would then be
   *  scraping a log — the thing the module docstring says it does not do. */
  readonly command: readonly string[]
  /** Extra environment for this layer's process. */
  readonly env?: Readonly<Record<string, string>>
  /** Where the layer writes its machine-readable result, and how to read it. */
  readonly resultFile: string
  readonly parse: (raw: string) => Counts
}

interface Counts {
  passed: number
  failed: number
  skipped: number
}

/** Vitest's `--reporter=json` shape, narrowed to what is read. */
interface VitestJson {
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
  numTodoTests?: number
}

/** Playwright's JSON reporter shape, narrowed to what is read. */
interface PlaywrightJson {
  stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number }
}

function parseVitest(raw: string): Counts {
  const json = JSON.parse(raw) as VitestJson
  return {
    passed: json.numPassedTests ?? 0,
    failed: json.numFailedTests ?? 0,
    skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0),
  }
}

function parsePlaywright(raw: string): Counts {
  const stats = (JSON.parse(raw) as PlaywrightJson).stats ?? {}
  return {
    // `flaky` counts as failed here on purpose: this suite runs with `retries: 0`
    // (see its config — "a retry that turns a red scenario green is a finding
    // erased"), so a flaky count is a surprise worth being red about rather than
    // a category to absorb.
    passed: stats.expected ?? 0,
    failed: (stats.unexpected ?? 0) + (stats.flaky ?? 0),
    skipped: stats.skipped ?? 0,
  }
}

const LAYERS: readonly Layer[] = [
  {
    id: 'unit',
    title: 'Unit + integration (vitest, jsdom)',
    sees:
      'every module and component in isolation, with coverage floors enforced ' +
      '(statements 93 / branches 82 / functions 92 / lines 94)',
    command: ['test:run', '--coverage', '--reporter=json', `--outputFile=${UNIT_RESULT}`],
    resultFile: UNIT_RESULT,
    parse: parseVitest,
  },
  {
    id: 'e2e',
    title: 'App-path e2e (vitest, node, real Postgres)',
    sees:
      'whole conversations through the real server action and the SSE route, ' +
      'against a fake inference endpoint and a fake MCP gateway',
    command: ['test:e2e', '--reporter=json', `--outputFile=${E2E_RESULT}`],
    resultFile: E2E_RESULT,
    parse: parseVitest,
  },
  {
    id: 'browser',
    title: 'Browser e2e (Playwright, real dev server, Chromium)',
    sees:
      'what a person actually looks at — paint, reload, clicks, both themes, ' +
      'committed screenshot baselines and an axe pass',
    command: ['test:e2e:browser', '--reporter=json'],
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: BROWSER_RESULT },
    resultFile: BROWSER_RESULT,
    parse: parsePlaywright,
  },
]

/**
 * The live steps this command deliberately does not run, reproduced in every
 * report's last section.
 *
 * Each needs infrastructure with a bill attached — a GPU endpoint that scales to
 * zero and charges by the second, or a real provider key — so they are
 * coordinated by hand rather than fired by a script somebody runs in a loop. The
 * point of listing them is that a go/no-go which silently omitted them would read
 * as a full pass.
 */
const LIVE_STEPS_STILL_OWED = [
  {
    what: '`pnpm eval:harness` on the **Anthropic** tier (the baseline report)',
    why: 'grades the workflows against a real provider; the only thing that reads model quality at all',
  },
  {
    what: '`USE_VERDA_INFERENCE=1 pnpm eval:harness` on the **self-hosted** tier',
    why:
      'the tier the deployment defaults to. Two scenarios are owed specifically: ' +
      '`planner-plan-shape` (the planner runs with thinking OFF and a halved output ceiling on ' +
      "this tier, and its chain's whole justification is that the reasoning IS the deliverable) " +
      'and `screen-on-the-tier` (the injection screen was moved onto an UNMEASURED screener by ' +
      'owner decision on 2026-08-26; a failing run of that scenario is evidence the move was ' +
      'wrong). Neither is checkable hermetically — a fake endpoint cannot be bad at screening.',
  },
  {
    what:
      '`USE_VERDA_INFERENCE=1 pnpm dlx tsx --env-file=.env ' +
      'src/lib/harness-patterns/scripts/smoke-verda.ts`',
    why:
      'the runbook smoke check: six calls back-to-back against the live box, each asserting the ' +
      'client that ACTUALLY served it. Covers the cold start, the wake ping and the real ' +
      'endpoint, none of which a fake can be wrong about.',
  },
  {
    what: 'the warm-burst check (`smoke-verda-load.ts`) if concurrency behaviour matters to the release',
    why: 'one replica, so concurrency is queueing rather than scaling; the only measurement of what a burst costs a user',
  },
] as const

// ============================================================================
// Running
// ============================================================================

interface LayerRun {
  layer: Layer
  status: 'passed' | 'failed' | 'not attempted'
  /** Whether the command line asked for this layer. Kept apart from `status` so
   *  the report can tell "you did not ask for it" from "an earlier layer failed
   *  before we got here" — two very different reasons for a blank row. */
  selected: boolean
  ms: number
  counts?: Counts
  /** Set when the layer ran but its machine-readable output could not be read.
   *  Never collapsed into zeroes — see the module docstring. */
  parseError?: string
  exitCode?: number
}

function run(layer: Layer): Promise<{ code: number; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn('pnpm', [...layer.command], {
      cwd: APP_DIR,
      // Inherited, so a failing layer's own output is on the terminal where the
      // person running this can read it. The report is a summary, never a
      // replacement for the log.
      stdio: 'inherit',
      env: { ...process.env, CI: process.env.CI ?? '1', ...layer.env },
    })
    child.on('close', (code) => resolve({ code: code ?? 1, ms: Date.now() - started }))
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const only = valueOf(args, '--only')
  const from = valueOf(args, '--from')

  let selected = [...LAYERS]
  if (only) selected = LAYERS.filter((l) => l.id === only)
  else if (from) {
    const index = LAYERS.findIndex((l) => l.id === from)
    if (index < 0) selected = []
    else selected = LAYERS.slice(index)
  }
  if (selected.length === 0) {
    console.error(
      `release-check: no layer matched. Known layers: ${LAYERS.map((l) => l.id).join(', ')}`,
    )
    process.exit(2)
  }

  // Cleared, not just created: a run that was killed between writing a layer's
  // JSON and the `rmSync` below leaves that file behind, and the next run would
  // read it as its OWN counts for a layer that never wrote one. That is the
  // failure the module docstring rules out for unparseable output — a stale
  // count and an unreadable one are both "not this run's result", and only one
  // of them currently says so.
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  const startedAt = new Date().toISOString()
  const runs: LayerRun[] = LAYERS.map((layer) => ({
    layer,
    status: 'not attempted',
    selected: selected.includes(layer),
    ms: 0,
  }))

  let stoppedAt: Layer | undefined
  for (const layer of selected) {
    const entry = runs.find((r) => r.layer === layer)
    if (!entry) continue
    console.log(`\n── ${layer.title} ────────\n`)
    const { code, ms } = await run(layer)
    entry.ms = ms
    entry.exitCode = code
    try {
      entry.counts = layer.parse(readFileSync(layer.resultFile, 'utf8'))
    } catch (err) {
      entry.parseError = err instanceof Error ? err.message : String(err)
    }
    entry.status = code === 0 ? 'passed' : 'failed'
    if (code !== 0) {
      stoppedAt = layer
      break
    }
  }

  const partial = Boolean(only || from)
  const report = renderReport({ startedAt, runs, selected, stoppedAt, partial })
  mkdirSync(REPORT_DIR, { recursive: true })
  const file = path.join(REPORT_DIR, `${startedAt.replace(/[:.]/g, '-')}-release-check.md`)
  writeFileSync(file, report)
  rmSync(SCRATCH, { recursive: true, force: true })

  console.log(`\n${terminalSummary({ runs, selected, stoppedAt, partial })}`)
  console.log(`\nReport: ${path.relative(APP_DIR, file)}`)
  process.exit(stoppedAt ? 1 : 0)
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  const inline = args.find((a) => a.startsWith(`${flag}=`))
  return inline?.slice(flag.length + 1)
}

// ============================================================================
// The report
// ============================================================================

interface ReportInput {
  startedAt: string
  runs: LayerRun[]
  selected: readonly Layer[]
  stoppedAt?: Layer
  partial: boolean
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

function verdict(input: Omit<ReportInput, 'startedAt'>): string {
  if (input.stoppedAt) return `NO-GO — ${input.stoppedAt.title} failed`
  if (input.partial) return 'PARTIAL — the layers named on the command line passed'
  return 'GO — every hermetic layer passed'
}

function countsCell(entry: LayerRun): string {
  if (entry.status === 'not attempted') return '—'
  if (entry.parseError) return '**unreadable**'
  const c = entry.counts
  if (!c) return '**unreadable**'
  // A layer that FAILED having run no test at all did not pass zero tests — it
  // never got as far as one, which is a third fact alongside "counted" and
  // "unreadable". Observed: the browser layer's dev server died in global setup
  // (a `presetWebFonts` fetch to fonts.googleapis.com timed out and threw), and
  // Playwright still wrote a perfectly parseable report whose stats were all
  // zero. `0 passed, 0 failed, 0 skipped` reads like a clean empty suite next to
  // two green rows; the verdict was already NO-GO off the exit code, and this is
  // the counts column catching up with it.
  if (entry.status === 'failed' && c.passed + c.failed + c.skipped === 0) {
    return '**no test ran** — the layer failed before collecting one'
  }
  return `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped`
}

/** The terminal half: short enough to read without scrolling, and it names the
 *  file rather than restating it. */
function terminalSummary(input: Omit<ReportInput, 'startedAt'>): string {
  const lines = [`RELEASE CHECK: ${verdict(input)}`, '']
  for (const entry of input.runs) {
    const mark = entry.status === 'passed' ? '✓' : entry.status === 'failed' ? '✗' : '·'
    // Padded rather than empty, so the counts column lines up whether or not a
    // layer ran — a ragged summary is one nobody scans.
    const timing =
      entry.status === 'not attempted' ? '       ' : ` ${seconds(entry.ms).padStart(6)}`
    lines.push(`  ${mark} ${entry.layer.id.padEnd(8)}${timing}  ${countsCell(entry)}`)
  }
  lines.push('', `  Live steps still owed: ${LIVE_STEPS_STILL_OWED.length} (see the report)`)
  return lines.join('\n')
}

function renderReport(input: ReportInput): string {
  const total = input.runs.reduce((sum, r) => sum + r.ms, 0)
  const out: string[] = []

  out.push('# Release check')
  out.push('')
  out.push(`- **Verdict:** ${verdict(input)}`)
  out.push(`- **Run:** ${input.startedAt} · ${seconds(total)}`)
  // "selected", not "attempted": on a NO-GO the layers above the failure were
  // selected and never run, and the table below says so per row. A header line
  // claiming they were attempted contradicts it, in the one report whose whole
  // argument is that it does not overstate what it checked.
  out.push(
    `- **Layers selected:** ${input.selected.map((l) => l.id).join(' → ') || 'none'}` +
      (input.partial ? ' (PARTIAL — named on the command line)' : ''),
  )
  out.push('')
  out.push('> Generated by `pnpm release:check`. Every layer below is HERMETIC — no provider')
  out.push('> key, no GPU endpoint, no bill. What that leaves unchecked is the last section,')
  out.push('> and it is not a footnote: read it before treating a GO as a release decision.')
  out.push('')

  out.push('## Layers')
  out.push('')
  out.push('|     | Layer | Result | Tests | Wall clock |')
  out.push('| --- | ----- | ------ | ----- | ---------: |')
  for (const entry of input.runs) {
    const mark = entry.status === 'passed' ? '✅' : entry.status === 'failed' ? '❌' : '⬜'
    const result =
      entry.status === 'not attempted'
        ? !entry.selected
          ? 'not selected on the command line'
          : 'not attempted — an earlier layer failed'
        : entry.status === 'passed'
          ? 'passed'
          : `failed (exit ${entry.exitCode})`
    out.push(
      `| ${mark} | ${entry.layer.title} | ${result} | ${countsCell(entry)} | ` +
        `${entry.status === 'not attempted' ? '—' : seconds(entry.ms)} |`,
    )
  }
  out.push('')
  for (const entry of input.runs) {
    out.push(`- **${entry.layer.id}** sees ${entry.layer.sees}.`)
  }
  out.push('')

  const unreadable = input.runs.filter((r) => r.parseError)
  if (unreadable.length > 0) {
    out.push('### Output that could not be read')
    out.push('')
    out.push('A layer ran and its machine-readable result did not parse. That is NOT the same as a')
    out.push(
      'zero, and it is not a pass: the exit code below is what the verdict used, and the counts',
    )
    out.push('for these layers are unknown.')
    out.push('')
    for (const entry of unreadable) {
      out.push(`- \`${entry.layer.id}\` (exit ${entry.exitCode}): ${entry.parseError}`)
    }
    out.push('')
  }

  if (input.stoppedAt) {
    out.push('## Why it stopped')
    out.push('')
    out.push(
      `\`${input.stoppedAt.id}\` failed, so the layers above it were not attempted. That is` +
        ' deliberate: a failure below makes the layers above un-diagnosable — a browser',
    )
    out.push(
      'scenario going red because of the bug is indistinguishable from one going red because of',
    )
    out.push(
      "the bug's blast radius. Fix this layer, then `pnpm release:check` again (or " +
        `\`--from ${input.stoppedAt.id}\` while iterating).`,
    )
    out.push('')
  }

  out.push('## Live steps still owed')
  out.push('')
  out.push('None of these ran. Each needs infrastructure with a bill attached — a scale-to-zero')
  out.push('GPU billed by the second, or a real provider key — so they are coordinated by hand.')
  out.push('**A GO above is a statement about the hermetic layers only.**')
  out.push('')
  for (const step of LIVE_STEPS_STILL_OWED) {
    out.push(`- [ ] ${step.what}`)
    out.push(`      ${step.why}`)
  }
  out.push('')
  out.push('Also not checked here, and not checkable here: the production bundle (every browser')
  out.push('scenario runs under `vinxi dev`, because the dev auth bypass is gated on')
  out.push('`import.meta.env.DEV`), the auth gate itself, and any browser but Chromium. See')
  out.push('`app/e2e-browser/README.md`.')
  out.push('')

  return out.join('\n')
}

await main()
