/** Structural pins for the opt-in runner: CI never imports or executes it. */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertLivePreconditions } from '../../../lib/eval-support/live-preconditions'
import { smallInfraRate } from '../../../lib/eval-support/small-infra.server'
import {
  resetSmallGpuForTests,
  seedSmallGpuForTests,
} from '../../../lib/inference/small-gpu.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const read = (file: string) => readFileSync(resolve(file), 'utf8')
const run = () => read('evals/general-next/run.ts')
it.each([
  ['EMBEDDINGS_PROVIDER', 'openrouter', 'EMBEDDINGS_PROVIDER'],
  ['EMBEDDINGS_LOCAL_URL', 'https://embed.example.invalid/v1', 'owner local embedder'],
])(
  'validates inherited %s in the runner preflight when absent from dotenv',
  (key, value, error) => {
    // Execute only the real preflight block with synthetic inputs: no runner import,
    // credentials, gateway connection or inference request.
    const preflight = /if \(live\) \{([\s\S]*?)\n {2}\} else \{/.exec(run())?.[1]
    expect(preflight).toBeDefined()
    const deployed = [
      'LARGE_LLM_BASE_URL=https://self_deployed.example.invalid/v1',
      'SMALL_LLM_BASE_URL=https://small.example.invalid/v1',
      'SMALL_LLM_DECISIONS_URL=https://small.example.invalid/v1/systemone',
      'LARGE_LLM_API_KEY=synthetic',
      'SMALL_LLM_API_KEY=synthetic',
    ].join('\n')
    expect(() =>
      runInNewContext(preflight!, {
        parseEnv,
        readFileSync: () => deployed,
        process: { env: { [key]: value, EVAL_GENERAL_GO: 'S3 merged: go' } },
        assertLivePreconditions,
      }),
    ).toThrow(error)
  },
)
it('lets the hermetic fixture pick the scripted route by its key, not by a description that mentions it', () => {
  // Execute only the real selection block (no server, no import: src/ may not import evals/).
  // #689's read-documents wording contains "answer", the default route, and sits before it.
  const block = /(const described = [\s\S]*?)\n\s*if \(!chosen\)/.exec(
    read('evals/general-next/fixture-inference.ts'),
  )?.[1]
  expect(block).toBeDefined()
  // The block is TypeScript; strip its one cast so the VM can run it.
  const js = block!.replace(/\(question as \{[^}]*\}\)/, 'question')
  const criteria = {
    'office-data': 'Run code over uploaded files',
    'info-retrieval':
      'Look things up... it cannot open files uploaded to this conversation (that is read-documents)',
    'read-documents': 'Use it when the answer needs text quoted from such a file',
    answer: 'Reply directly',
  }
  const pick = (route: string) =>
    runInNewContext(`${js}; chosen`, { question: { criteria }, route })
  expect(pick('answer')).toBe('answer')
  expect(pick('read-documents')).toBe('read-documents')
  // A route with no key of its own selects nothing; the fixture's throw then fails closed.
  expect(pick('quoted')).toBeUndefined()
})
it('awaits production wake after starting the scenario clock, fails and stops without fallback', () => {
  const s = run()
  expect(s.indexOf('started = Date.now()')).toBeLessThan(
    s.indexOf('await ensurePrivateTierAwake()'),
  )
  expect(s.indexOf('await ensurePrivateTierAwake()')).toBeLessThan(s.indexOf('await driver.run('))
  expect(s).toMatch(
    /catch\s*(?:\(err\)\s*)?\{\s*const reason = wakeFailureReason\(err\)\s*budget.reason = reason\s*(?:wakeDetail = describeWakeFailure\(err\)\s*)?results.push\(\{[^}]*status: 'fail'[^}]*error: reason[^}]*\}\)\s*tick\(\)\s*stop\(\)/,
  )
})
it('poisons after dotenv loading and before any inference configuration', () => {
  const s = run()
  expect(s.indexOf('poisonPublicProviders(process.env)')).toBeGreaterThan(
    s.indexOf('Object.assign(process.env, deployed)'),
  )
  expect(s.indexOf('poisonPublicProviders(process.env)')).toBeLessThan(
    s.indexOf("await import('../../src/lib/inference/config.server')"),
  )
})
it('spawns a proxy-configured child and demands its startup self-test before fixture setup', () => {
  const s = run()
  expect(s).toMatch(/spawn\(process.execPath,[\s\S]*env: proxyEnvironment\(backstop.url\)/)
  expect(s).toContain('await assertEgressSelfTest(takeEgressAttempts)')
  expect(s.indexOf('await assertEgressSelfTest(takeEgressAttempts)')).toBeLessThan(
    s.indexOf('fake = await fixtureInference()'),
  )
})
it('connects the observer stop to synchronous exit, and checks wall-clock spend every 100ms', () => {
  const s = run()
  const stop = s.slice(s.indexOf('  const stop ='), s.indexOf('  const { observeLlmUsage }'))
  expect(stop).toMatch(/write\(\)[\s\S]*process.exit\(1\)/)
  expect(s).toMatch(/createSpendObserver\(\{ budget, live, onStop: stop \}\)/)
  expect(s).toContain('observeLlmUsage(observer.observe)')
  expect(s).toMatch(
    /setInterval\(\(\) => \{\s*tick\(\)\s*if \(budget.stopped\) stop\(\)\s*\}, 100\)/,
  )
})
// The report is what the flip gate reads: the frozen general baseline has to ride in it.
// MUTATION: `generalBaselineRecorded: undefined` in run.ts reddens this.
it('carries the recorded general baseline in the report', () => {
  expect(run()).toContain('generalBaselineRecorded: GENERAL_BASELINE')
})
it('uses live production metadata, records refusing writes, and never returns a precalculated total', () => {
  const driver = read('evals/general-next/driver.ts')
  expect(run()).toContain('productionCatalog(')
  expect(run()).toContain('createDriver(fake, live, liveCatalog, agents)')
  expect(driver).toMatch(
    /const descriptions = live\s*\?\s*liveDescriptions\(\s*Object.keys\(NAMESPACES\)/,
  )
  expect(driver).toContain("write_neo4j_cypher: 'neo4j'")
  expect(driver).toContain("name !== 'write_neo4j_cypher'")
  expect(driver).toContain('trace?.tools.push({ name, args, success, turn })')
  expect(driver).not.toMatch(/\btotal:\s*\d/)
  expect(driver).toContain('North revenue: 47. South revenue: 19.')
  const catalog = read('evals/general-next/tool-catalog.ts')
  expect(catalog).toContain('await client.listTools({ cursor })')
  expect(catalog).toContain('registerGraphConnectorTools(')
  expect(catalog).toContain('...page.tools.map')
  const shell = read('../rootfs/mcp-shell/server.mjs')
  expect(shell).toContain(
    "'exit code, and whether it timed out. Working directory defaults to /work.'",
  )
  expect(catalog).toContain(
    "'exit code, and whether it timed out. Working directory defaults to /work.'",
  )
  const description = (source: string) =>
    source
      .slice(source.indexOf('description:'), source.indexOf('inputSchema:'))
      .match(/'[^']*'/g)
      ?.join('')
  expect(description(catalog.slice(catalog.indexOf("name: 'sandbox_bash'")))).toBe(
    description(shell),
  )
  for (const key of ['command', 'cwd', 'timeout_ms']) {
    expect(shell).toMatch(new RegExp(`${key}: z`))
    expect(catalog).toMatch(new RegExp(`${key}: \\{`))
  }
})
it('wires the guards’ settings into the driver’s bag, one env read (#845 review finding 2)', () => {
  // The driver’s bag carries `guardConfig()`’s three settings — the same
  // numbers the runner counts against — so the eval’s gate runs at the env’s
  // τi and its egress gate at the env’s τe and N, never the library defaults.
  // Structural by necessity: nothing under src/ may import evals/
  // (`evals-not-in-ci.test.ts`), so a behavioural pin with
  // GUARD_EGRESS_THRESHOLD=0.4 stubbed cannot import the driver here; the
  // parse itself is pinned in `guard-config.test.ts`.
  const driver = read('evals/general-next/driver.ts')
  expect(driver).toMatch(/const guardNumbers = guardConfig\(\)/)
  expect(driver).toMatch(/gateThreshold: guardNumbers\.gateThreshold/)
  expect(driver).toMatch(/egressThreshold: guardNumbers\.egressThreshold/)
  expect(driver).toMatch(
    /maxOutgoingRetriesPostTripwire: guardNumbers\.maxOutgoingRetriesPostTripwire/,
  )
  // The bag has to BE the deps slot it fills, not a rebuilt subset of it.
  // MUTATION: rebuild the deps literal's `guards` slot without the three
  // numbers (`guards: { pseudonymiseForWeb: guards.pseudonymiseForWeb,
  // classifyIngress: guards.classifyIngress }` — tsc-clean) → the scan of the
  // literal below misses `/^\s*guards,$/m` and this goes red; the eval's agent
  // is back on the library's defaults while the report counts at the env's τi.
  const depsLiteral = /const deps: AgentDeps = \{([\s\S]*?)\n {2}\}\n/.exec(driver)?.[1]
  expect(depsLiteral, 'the deps literal').toBeDefined()
  expect(depsLiteral!).toMatch(/^\s*guards,$/m)
  // And the return carries the same read, not a second one or a re-read.
  // MUTATION: `guards: guardConfig()` in the return → both this pin and the
  // one-call count below go red.
  expect(driver).toMatch(/guards: guardNumbers,\s*async run/)
  // One read: every `guardConfig(` call in the file, exactly one — the count
  // excludes the comments' backtick-quoted mentions via the lookbehind, so a
  // second read anywhere in code reddens. The runner counts against the same
  // bag, never a second env read.
  expect(driver.match(/(?<!`)guardConfig\(/g)).toHaveLength(1)
  expect(run()).toMatch(/guardTurnCounts\(trace\.turns, driver\.guards\.gateThreshold\)/)
  expect(run()).not.toContain('guardConfig()')
})
it('keeps 17 executable scenarios, 18 documented contracts, and an explicit proof per scenario', () => {
  const files = readdirSync(resolve('evals/general-next/scenarios')).filter((f) =>
    f.endsWith('.ts'),
  )
  expect(files).toHaveLength(17)
  for (const file of files) {
    const source = read(`evals/general-next/scenarios/${file}`)
    const messages = source.slice(source.indexOf('messages:'), source.indexOf('expectedTools:'))
    expect(messages).not.toMatch(/synthetic|fixture/i)
    if (!source.includes('expectedTools: []')) {
      expect(source).toContain('expectedArgs:')
      const tools = /expectedTools: \[([^\]]*)\]/.exec(source)?.[1].match(/'([^']+)'/g) ?? []
      const predicates = source.slice(
        source.indexOf('expectedArgs:'),
        source.indexOf('expectedRoutes:'),
      )
      for (const tool of tools)
        expect(predicates).toContain(`${tool.slice(1, -1)}${tool.includes('-') ? "'" : ''}:`)
    }
  }
  const flagship = read('evals/general-next/scenarios/17-mail-analysis-follow-up.ts')
  expect(flagship).toMatch(/priority: 'must'/)
  expect(flagship).toMatch(/p4: false/)
  for (const token of [
    'graph_mail_recent',
    'sandbox_bash',
    'office-data',
    'read-documents',
    "indexed: 'lantern-launch-analysis.md'",
    "citation: 'lantern-launch-analysis.md'",
  ])
    expect(flagship).toContain(token)
  for (const [file, facts] of [
    ['10-csv-analysis.ts', ['North', '47', 'South', '19', '66']],
    ['13-two-sources.ts', ['42', '50', '8']],
    ['14-analysis-index-follow-up.ts', ['North', '47', 'South', '19', '28']],
    ['17-mail-analysis-follow-up.ts', ['North', '47', 'South', '19', '28']],
  ] as const) {
    const answer =
      /answerIncludes: \[([^\]]*)\]/.exec(read(`evals/general-next/scenarios/${file}`))?.[1] ?? ''
    for (const fact of facts) expect(answer).toContain(`'${fact}'`)
  }
  const catalogue = read('evals/general-next/SCENARIOS.md')
  expect(catalogue.match(/A live pass proves:/g)).toHaveLength(18)
  expect(catalogue).toContain('Rollout criterion → evidence map')
  expect(catalogue).toContain('candidate only:')
  expect(read('evals/general-next/README.md')).not.toContain('/Users/')
})
it('writes the computed flip gate, reserves configured tails, floors rates, and lists the live release step', () => {
  const s = run()
  expect(s).toContain('flipGate: flipGate(')
  expect(s).toContain('budget.beginInfrastructure(active, started, [')
  // The large box's lines are conditional: dropped while the route switch
  // sends the 27B roles to OpenRouter — there is no GPU to bill.
  expect(s).toContain('seconds: largeScaledownSeconds()')
  expect(s).toContain('seconds: smallScaledownSeconds()')
  expect(s).toContain('openRouterLarge ? small.eurPerHour : largeRate + small.eurPerHour')
  expect(s).toContain('...(openRouterLarge')
  expect(s).toMatch(
    /floorHourlyRate\(\s*rates\.largeEurPerHour\(\),\s*DEFAULT_LARGE_LLM_EUR_PER_HOUR,?\s*\)/,
  )
  // #882: the small box's rate is read per charge from the GPU-aware seam
  // (family-priced, conservative while unobserved), never captured once at
  // the L4 base — and the report states the observed family and its basis.
  expect(s).toContain('const small = smallInfraRate()')
  expect(s).not.toContain('smallRate')
  expect(s).toContain('smallGpuFamily: small.family')
  expect(s).toContain('smallGpuBasis: small.basis')
  // The route switch is read at the seam, before the budget exists.
  expect(s.indexOf('largeOnOpenRouter()')).toBeGreaterThan(s.indexOf('clients.assertInferenceTier'))
  expect(s.indexOf('largeOnOpenRouter()')).toBeLessThan(s.indexOf('new SpendBudget('))
  expect(read('scripts/release-check.ts')).toContain('eval:general-next --live')
  expect(read('../docs/plan/decision-loop-agent.md')).toContain(
    'on the private tier only (owner amendment, 2026-10-15; #507 W4)',
  )
})
it('writes the screen subtotal beside every scenario row', () => {
  expect(run()).toMatch(/return \{ \.\.\.r, spend, screen: screenShare\(spend\) \}/)
})
it('marks hermetic reports with the vacuous-pass caveat', () => {
  expect(run()).toMatch(/hermeticCaveat: live\s*\? undefined\s*: 'Hermetic passes are wiring only/)
})
// #842: a failing must is re-run twice more, and only failures are re-run — a
// first-attempt pass breaks out of the attempt loop after one run, so it is not spent
// twice. Every other priority still runs exactly once.
// MUTATION: drop the `&& attempt === 1` from run.ts's break condition → this reddens
// (a first-attempt pass would be re-run); restore it → green.
it('a first-attempt pass runs once; a failing must earns exactly two more attempts', () => {
  const s = run()
  expect(s).toContain('MUST_RERUN_ATTEMPTS : 1')
  expect(s).toMatch(/if \(attempt === 1 && status === 'pass'\) break/)
  // #842 fix round 1: the re-run count itself is pinned to the README's cost bound
  // (at most two extra attempts per failing MUST) — mutating the value must redden here.
  expect(read('src/lib/eval-support/flip-gate.ts')).toContain('MUST_RERUN_ATTEMPTS = 3')
})
it('captures decisions and controller outputs only behind the env flag, beside the gitignored report', () => {
  const s = run()
  // Off by default: the log exists only when the flag says so, and the report names the file only then.
  expect(s).toMatch(
    /const capture = captureEnabled\(process\.env\) \? new CaptureLog\(\) : undefined/,
  )
  expect(s).toContain('captureFile: capture ? captureFile : undefined')
  // The capture file sits next to the report, inside evals/reports, which is gitignored.
  expect(s).toContain("const captureFile = file.replace(/\\.json$/, '-capture.json')")
  expect(read('.gitignore')).toMatch(/^evals\/reports\/\*$/m)
  // Written with every checkpoint of the report, so an interrupted run keeps what it saw.
  const write = /const write = \(\) => \{[\s\S]*?\n {2}\}\n {2}const tick/.exec(s)?.[0]
  expect(write).toContain(
    "if (capture) writeFileSync(captureFile, JSON.stringify(capture, null, 2) + '\\n')",
  )
  // Fed from the graded trace, with the verdict that widens controller capture to every call.
  expect(s).toMatch(
    /const status = checks\.length > 0 && checks\.every\(\(c\) => c\.pass\) \? 'pass' : 'fail'\s*capture\?\.add\(active, trace, status === 'fail'\)\s*results\.push\(/,
  )
  expect(s.indexOf('grade(job.scenario')).toBeLessThan(s.indexOf('capture?.add('))
  // A scenario that throws before grading still leaves a row, so a gap is never read as "no decisions".
  expect(s).toMatch(
    /\} catch \(err\) \{\s*capture\?\.addError\(active, err instanceof Error \? err\.message : 'Scenario threw'\)\s*results\.push\(/,
  )
})
// The egress-gate scenario runs under the runner, which opens the run's frame
// (harness.ts `runScenario`). Its gate rows scope their fake transport BELOW
// that frame, with `amendRunFrame` — the seam run-frame.server.ts names for
// "a combinator that legitimately scopes below a run" — because a nested
// `withRunFrame` that supplies a slot is refused ("a nested entry joins the
// open frame and brings no slots"), which is what threw on every gate row
// (#788 c6445541842). The runner frame is never absent when this scenario
// runs, so an amend outside a frame refusing is the correct failure there.
// MUTATION: revert the scenario's transport scope to `withRunFrame` (the
// pre-fix shape at egress-gate.ts) — this pin reddens on both halves, and the
// live run throws on every gate row again.
it('scopes the egress-gate gate-row transports below the runner frame with amendRunFrame', () => {
  const s = read('evals/scenarios/egress-gate.ts')
  expect(s).toMatch(/await amendRunFrame\(\s*\{\s*transports: \[/)
  expect(s).not.toContain('withRunFrame(')
})

// #832 (owner, 2026-10-28): the agent does not index a deliverable; the person does, from
// the Data Stash. The driver makes that click before each later turn's run, and its
// retriever and documents list serve only uploaded markdown and what the person indexed.
// MUTATIONS: drop the click → 14, 16 and 17 have nothing to retrieve; restore either
// `.endsWith('.md')` filter → an unindexed deliverable is served as if indexed.
it('mocks the Data Stash click between turns and serves only searchable documents', () => {
  const driver = read('evals/general-next/driver.ts')
  const beforeRun =
    /for \(turn = 0; turn < next\.messages\.length; turn\+\+\) \{([\s\S]*?)const result/.exec(
      driver,
    )?.[1]
  expect(beforeRun).toContain('if (turn > 0) indexForUser(next, trace)')
  expect(driver.match(/stashSearchable\((?:name|source), UPLOADED, trace\)/g)).toHaveLength(2)
  expect(driver).not.toMatch(/endsWith\('\.md'\)/)
})
// The same ruling, per scenario (PM addition, 2026-10-28): every runnable scenario that
// declares an `indexed` deliverable depends on the click, so its turn 1 must tell the
// person where to index it. Today that is 14 and 17 (a must); 16 is P4-gated.
// MUTATION: drop 17's `turnAnswerIncludes` (with its catalogue item) → red here only.
it('every runnable scenario with an indexed deliverable names the Data Stash on turn 1', () => {
  const dir = 'evals/general-next/scenarios'
  const runnable = readdirSync(resolve(dir))
    .map((file) => [file, read(`${dir}/${file}`)] as const)
    .filter(([, source]) => /\n {2}indexed: '/.test(source) && /\n {2}p4: false/.test(source))
  expect(runnable.map(([file]) => file)).toEqual([
    '14-analysis-index-follow-up.ts',
    '17-mail-analysis-follow-up.ts',
  ])
  for (const [, source] of runnable)
    expect(source).toMatch(/\n {2}turnAnswerIncludes: \[\['Data Stash'\]/)
})

// #882: the runner's small-box charges must follow the served GPU family.
// These execute the runner's REAL tick and reservation blocks (extracted from
// its source, so nothing under src/ imports evals/) with the production seam
// seeded per family — the recorded charge is the family's rate, and the
// OpenRouter switch still drops only the large half.
describe('the small box charges through the served-family seam (#882)', () => {
  /** Independent full-container arithmetic from the 2026-10-30 Modal list
   * prices — the derivation `modal-pricing.ts` encodes, not its output. */
  const L4_USD = (0.8 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15
  const A10_USD = (1.1 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15
  const L4_EUR = L4_USD * 0.86
  const A10_EUR = A10_USD * 0.86
  const active = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' }

  beforeEach(() => {
    resetSmallGpuForTests()
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR', undefined as unknown as string)
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR_A10', undefined as unknown as string)
    vi.stubEnv('EUR_PER_USD', undefined as unknown as string)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetSmallGpuForTests()
  })

  // MUTATION: restore the pre-fix captured rate in run.ts (`const smallRate =
  // floorHourlyRate(rates.smallLlmEurPerHour(), ...)` and `smallRate` in the
  // tick/begin/report sites) → the A10 rows below redden on the recorded
  // value: the context still provides `smallRate` (the L4 figure the old
  // code captured) precisely so the reverted block RUNS and fails the
  // assertion, instead of dying on a ReferenceError that proves nothing.
  it.each([
    ['L4', L4_EUR],
    ['A10', A10_EUR],
    [undefined, A10_EUR], // no sample: unknown prices at the highest supported family
  ] as const)(
    'tick charges elapsed time at the %s family rate, dropping the large half on OpenRouter',
    (family, expectedSmall) => {
      if (family !== undefined) seedSmallGpuForTests(family)
      const block = /const tick = \(\) => \{([\s\S]*?)\n {2}\}\n {2}const stop/.exec(run())?.[1]
      expect(block).toBeDefined()
      const charge = (openRouterLarge: boolean) => {
        const charged: number[] = []
        runInNewContext(`(() => {${block}})()`, {
          active,
          live: true,
          budget: {
            infrastructure: (_key: unknown, _ms: number, rate: number) => charged.push(rate),
          },
          started: Date.now() - 60_000,
          openRouterLarge,
          largeRate: 4,
          smallInfraRate,
          smallRate: L4_EUR,
          Date,
        })
        return charged
      }
      expect(charge(false), `${family}: both boxes charge`).toEqual([4 + expectedSmall])
      expect(charge(true), `${family}: OpenRouter drops only the large half`).toEqual([
        expectedSmall,
      ])
    },
  )

  it.each([
    ['L4', L4_EUR],
    ['A10', A10_EUR],
    [undefined, A10_EUR],
  ] as const)(
    'the tail reservation prices the %s family, before the wake, and keeps the large tail off OpenRouter',
    (family, expectedSmall) => {
      if (family !== undefined) seedSmallGpuForTests(family)
      const inner =
        /const small = smallInfraRate\(\)\s*budget\.beginInfrastructure\(active, started, \[([\s\S]*?)\]\)\n {12}if \(budget\.stopped\)/.exec(
          run(),
        )?.[1]
      expect(inner).toBeDefined()
      const reserve = (openRouterLarge: boolean) => {
        let boxes: Array<{ box: string; seconds: number; eurPerHour: number }> = []
        // The seam statement is part of the runner's block, so the VM — not
        // this test — evaluates it, exactly as the live runner does per charge.
        runInNewContext(
          'const small = smallInfraRate(); budget.beginInfrastructure(active, started, [' +
            inner +
            '])',
          {
            budget: {
              beginInfrastructure: (
                _key: unknown,
                _now: number,
                reserved: Array<{ box: string; seconds: number; eurPerHour: number }>,
              ) => {
                boxes = reserved
              },
            },
            active,
            started: 0,
            openRouterLarge,
            largeScaledownSeconds: () => 300,
            smallScaledownSeconds: () => 600,
            largeRate: 4,
            smallInfraRate,
            smallRate: L4_EUR,
          },
        )
        return boxes
      }
      for (const openRouterLarge of [false, true]) {
        const boxes = reserve(openRouterLarge)
        expect(boxes.map((b) => b.box)).toEqual(
          openRouterLarge ? ['small'] : ['self_deployed', 'small'],
        )
        expect(boxes.find((b) => b.box === 'small')!.eurPerHour).toBeCloseTo(expectedSmall, 6)
        if (!openRouterLarge) expect(boxes[0].eurPerHour).toBe(4)
      }
    },
  )
})
