/** Opt-in conversation eval: private tier only; no module-scope model calls. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { SpendBudget, parseSpendCap, type SpendKey } from '../../src/lib/eval-support/spend-budget'
import { assertLivePreconditions } from '../../src/lib/eval-support/live-preconditions'
import { grade } from '../../src/lib/eval-support/conversation-checks'
import type { ConversationDriver, ConversationResult } from './types'
import { scenarios } from './index'

async function main() {
  // Validate cap even for list/preflight. No credentials are read in hermetic mode.
  const cap = parseSpendCap(process.env.EVAL_GENERAL_CAP_USD)
  const live = process.argv.includes('--live')
  const candidate = process.env.EVAL_GENERAL_AGENT ?? 'general-next'
  if (!/^[a-z][a-z0-9-]*$/.test(candidate)) throw new Error('Invalid EVAL_GENERAL_AGENT')
  const only = process.env.EVAL_ONLY?.split(',').map((s) => s.trim())
  if (only?.some((id) => !scenarios.some((s) => s.id === id)))
    throw new Error('Unknown EVAL_ONLY scenario id')
  const picked = scenarios.filter((s) => !only || only.includes(s.id))
  if (process.argv.includes('--list')) {
    for (const s of picked)
      console.log(
        `${s.id}\t${s.priority}\t${s.p4 ? 'GATED ON P4' : 'RUNNABLE NOW'}\t${s.baseline ? 'general baseline + candidate' : 'candidate'}`,
      )
    return
  }
  let fake: Awaited<ReturnType<typeof import('./fixture-inference').fixtureInference>> | undefined
  let backstop:
    | Awaited<ReturnType<typeof import('../../e2e/lib/egress-backstop').startEgressBackstop>>
    | undefined
  if (live) {
    // The .env FILE is authoritative: inherited variables cannot mask a stale copy.
    const deployed = parseEnv(readFileSync('.env', 'utf8'))
    assertLivePreconditions({ ...deployed, EVAL_GENERAL_GO: process.env.EVAL_GENERAL_GO })
    Object.assign(process.env, deployed)
  } else {
    process.env.ANTHROPIC_API_KEY = 'hermetic-refuses-public-provider'
    process.env.JEV_DECISIONS_URL = 'http://127.0.0.1:1/disabled'
    process.env.JEV_DECISIONS_API_KEY = 'hermetic-refuses-public-provider'
    const { startEgressBackstop } = await import('../../e2e/lib/egress-backstop')
    backstop = await startEgressBackstop()
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ])
      process.env[key] = backstop.url
    process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost,::1'
    const { fixtureInference } = await import('./fixture-inference')
    fake = await fixtureInference()
    Object.assign(process.env, {
      VERDA_INFERENCE_ENDPOINT: fake.base,
      VERDA_INFERENCE_API_KEY: 'fixture',
      SMALL_LLM_BASE_URL: fake.base,
      SMALL_LLM_DECISIONS_URL: `${fake.base}/systemone`,
      SMALL_LLM_API_KEY: 'fixture',
    })
  }
  // All model calls use the production private-role map. No EVAL_CLIENT overrides.
  process.env.USE_VERDA_INFERENCE = '1'
  const { startFakeGateway } = await import('../../e2e/lib/fake-gateway')
  const gateway = await startFakeGateway()
  process.env.MCP_GATEWAY_URL = gateway.url
  const rates = await import('../../src/lib/cost-rates.server')
  await import('../../src/lib/inference/config.server')
  const clients = await import('@hames-ai/harness-baml/clients.server')
  clients.assertInferenceTier('verda')
  const budget = new SpendBudget(cap, rates.eurPerUsdRate())
  const results: ConversationResult[] = []
  const jobs = picked.flatMap((s) =>
    (s.baseline && candidate !== 'general' ? ['general', candidate] : [candidate]).map((agent) => ({
      scenario: s,
      key: { agent, scenario: s.id, tier: 'verda' as const },
    })),
  )
  const file = resolve(
    'evals/reports',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-general-next.json`,
  )
  mkdirSync(resolve('evals/reports'), { recursive: true })
  let active: SpendKey | undefined
  let started = 0
  let driver: ConversationDriver | undefined
  const write = () => {
    const rows = jobs.map(
      ({ key }) =>
        results.find((r) => r.agent === key.agent && r.scenario === key.scenario) ?? {
          ...key,
          status: budget.stopped ? 'stopped' : 'gated',
          checks: [],
          error: budget.reason ?? 'not run',
        },
    )
    writeFileSync(
      file,
      JSON.stringify(
        {
          mode: live ? 'live' : 'hermetic',
          tier: 'verda',
          candidate,
          selectionComplete: picked.length === scenarios.length,
          capUsd: cap,
          stopUsd: budget.stopUsd,
          totalUsd: budget.totalUsd,
          stopReason: budget.reason,
          eurPerUsd: budget.eurPerUsd,
          verdaEurPerHour: rates.verdaEurPerHour(),
          smallEurPerHour: rates.smallLlmEurPerHour(),
          limitation:
            'The observer prices completed calls, so a final call can overshoot the 80% stop threshold and even the configured cap. Private infrastructure is an additional conservative floor: elapsed private-scenario time (including setup and endpoint wake wait) times both GPU hourly rates; observer call-time cost is also counted. Idle scale-down tails, provider rounding and unobserved infrastructure are not measured. This is not an invoice ceiling. Hermetic results certify scripted wiring only; they cannot authorize the default flip.',
          results: rows.map((r) => ({ ...r, spend: budget.row(r) })),
        },
        null,
        2,
      ) + '\n',
    )
  }
  const tick = () => {
    if (active && live)
      budget.infrastructure(
        active,
        Date.now() - started,
        rates.verdaEurPerHour() + rates.smallLlmEurPerHour(),
      )
  }
  const stop = () => {
    write()
    console.error(`Eval stopped: ${budget.reason}. Report: ${file}`)
    // Observer listeners swallow exceptions. Exit synchronously here so no
    // retry, synthesis or later scenario can make another call after the stop.
    process.exit(1)
  }
  const { observeLlmUsage } = await import('@hames-ai/harness-patterns/llm-usage-observer.server')
  const unobserve = observeLlmUsage((sample) => {
    if (!active) {
      budget.reason = 'Usage outside a scenario'
      stop()
    }
    if (!['VerdaQwen', 'LocalQwenSmall', 'PrivateSystemOne'].includes(sample.clientName ?? ''))
      budget.reason = 'Unexpected serving client on the private tier'
    budget.observe(active!, live ? sample.metrics : { costEur: 0 })
    tick()
    if (budget.stopped) stop()
  })
  const timer = setInterval(() => {
    tick()
    if (budget.stopped) stop()
  }, 100)
  try {
    // Before any live inference. The runner never starts an embedder.
    if (live) {
      const response = await fetch('http://127.0.0.1:8090/health', {
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined)
      if (!response?.ok)
        throw new Error(
          'Owner local embedder is down on 127.0.0.1:8090; escalate, do not start another',
        )
    }
    const { createDriver } = await import('./driver')
    driver = await createDriver(fake)
    for (const job of jobs) {
      active = job.key
      started = Date.now()
      budget.row(active)
      if (job.scenario.p4) {
        results.push({
          ...active,
          status: 'gated',
          checks: [],
          error: 'P4 file path is withheld; not attempted',
        })
      } else {
        try {
          const trace = await driver.run(job.scenario, active)
          const checks = grade(job.scenario, trace, active.agent === 'general')
          if (backstop?.recorded.length)
            checks.push({
              name: 'no unexpected egress',
              pass: false,
              detail: 'Hermetic egress backstop refused requests',
            })
          results.push({
            ...active,
            status: checks.length > 0 && checks.every((c) => c.pass) ? 'pass' : 'fail',
            checks,
          })
        } catch (err) {
          results.push({
            ...active,
            status: 'fail',
            checks: [],
            error: err instanceof Error ? err.message : 'Scenario threw',
          })
        }
      }
      tick()
      write()
      if (budget.stopped) stop()
      active = undefined
    }
    console.log(`Report: ${file}`)
    process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0
  } finally {
    clearInterval(timer)
    unobserve()
    await driver?.close()
    await fake?.close()
    await backstop?.close()
    const { closeMcpClient } = await import('@hames-ai/harness-patterns/mcp-client.server')
    await closeMcpClient()
    await gateway.goDown()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'Eval runner failed')
  process.exit(1)
})
