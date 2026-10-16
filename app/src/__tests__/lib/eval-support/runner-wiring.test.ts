/** Structural pins for the opt-in runner: CI never imports or executes it. */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { runInNewContext } from 'node:vm'
import { it, expect } from 'vitest'
import { assertLivePreconditions } from '../../../lib/eval-support/live-preconditions'
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
      'VERDA_INFERENCE_ENDPOINT=https://verda.example.invalid/v1',
      'SMALL_LLM_BASE_URL=https://small.example.invalid/v1',
      'SMALL_LLM_DECISIONS_URL=https://small.example.invalid/v1/systemone',
      'VERDA_INFERENCE_API_KEY=synthetic',
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
it('awaits production wake after starting the scenario clock, fails and stops without fallback', () => {
  const s = run()
  expect(s.indexOf('started = Date.now()')).toBeLessThan(
    s.indexOf('await ensurePrivateTierAwake()'),
  )
  expect(s.indexOf('await ensurePrivateTierAwake()')).toBeLessThan(s.indexOf('await driver.run('))
  expect(s).toMatch(
    /catch\s*\{\s*budget.reason = 'VERDA_WAKE_FAILED'\s*results.push\(\{[^}]*status: 'fail'[^}]*VERDA_WAKE_FAILED[^}]*\}\)\s*tick\(\)\s*stop\(\)/,
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
it('uses live production metadata, records refusing writes, and never returns a precalculated total', () => {
  const driver = read('evals/general-next/driver.ts')
  expect(run()).toContain('productionCatalog(')
  expect(run()).toContain('createDriver(fake, live, liveCatalog)')
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
it('keeps 17 scenarios, realistic messages, a runnable must multi-route case, and an explicit proof per scenario', () => {
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
  expect(catalogue.match(/A live pass proves:/g)).toHaveLength(17)
  expect(catalogue).toContain('Rollout criterion → evidence map')
  expect(catalogue).toContain('candidate only:')
  expect(read('evals/general-next/README.md')).not.toContain('/Users/')
})
it('writes the computed flip gate, reserves configured tails, floors rates, and lists the live release step', () => {
  const s = run()
  expect(s).toContain('flipGate: flipGate(')
  expect(s).toContain('budget.beginInfrastructure(active, started, [')
  expect(s).toContain('seconds: verdaScaledownSeconds()')
  expect(s).toContain('seconds: smallScaledownSeconds()')
  expect(s).toContain('budget.infrastructure(active, Date.now() - started, verdaRate + smallRate)')
  expect(s).toContain('floorHourlyRate(rates.verdaEurPerHour(), DEFAULT_VERDA_EUR_PER_HOUR)')
  expect(s).toContain('floorHourlyRate(rates.smallLlmEurPerHour(), DEFAULT_SMALL_LLM_EUR_PER_HOUR)')
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
