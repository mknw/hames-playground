/** Opt-in conversation eval: private tier only; no module-scope model calls. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import {
  SpendBudget,
  parseSpendCap,
  floorHourlyRate,
  screenShare,
  type SpendKey,
} from '../../src/lib/eval-support/spend-budget'
import { createSpendObserver } from '../../src/lib/eval-support/spend-observer'
import { flipGate } from '../../src/lib/eval-support/flip-gate'
import { GENERAL_BASELINE } from '../../src/lib/eval-support/general-baseline'
import { describeWakeFailure, wakeFailureReason } from '../../src/lib/eval-support/wake-failure'
import {
  assertProxyNode,
  proxyEnvironment,
  assertEgressSelfTest,
} from '../../src/lib/eval-support/hermetic-egress'
import {
  DEFAULT_LARGE_LLM_EUR_PER_HOUR,
  DEFAULT_SMALL_LLM_EUR_PER_HOUR,
} from '../../src/lib/settings'
import {
  assertLivePreconditions,
  poisonPublicProviders,
} from '../../src/lib/eval-support/live-preconditions'
import { assertPackageLayout } from '../../src/lib/eval-support/package-layout'
import { grade } from '../../src/lib/eval-support/conversation-checks'
import { guardTurnCounts } from '../../src/lib/eval-support/guard-report'
import { CaptureLog, captureEnabled } from '../../src/lib/eval-support/capture'
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
        `${s.id}\t${s.priority}\t${s.p4 ? 'GATED ON P4' : 'RUNNABLE NOW'}\t${s.baseline ? 'recorded general baseline + candidate' : 'candidate'}`,
      )
    return
  }
  // Before the proxy child, the fixture server or any wake: nothing below may start on a
  // checkout that cannot load its agents.
  const agents = [candidate]
  assertPackageLayout(agents)
  let fake: Awaited<ReturnType<typeof import('./fixture-inference').fixtureInference>> | undefined
  if (!live && process.env.GENERAL_EVAL_CHILD !== '1') {
    assertProxyNode()
    const { startEgressBackstop } = await import('../../e2e/lib/egress-backstop')
    const backstop = await startEgressBackstop()
    try {
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        env: proxyEnvironment(backstop.url),
        stdio: 'inherit',
      })
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', (code) => resolve(code ?? 1))
      })
    } finally {
      await backstop.close()
    }
    return
  }
  let takeEgressAttempts: (() => Promise<Array<{ target: string }>>) | undefined
  if (live) {
    // Validate the effective environment, including inherited settings absent from .env.
    const deployed = parseEnv(readFileSync('.env', 'utf8'))
    assertLivePreconditions({
      ...process.env,
      ...deployed,
      EVAL_GENERAL_GO: process.env.EVAL_GENERAL_GO,
    })
    Object.assign(process.env, deployed)
  } else {
    assertProxyNode()
    const egress = await import('../../e2e/lib/egress-backstop')
    takeEgressAttempts = egress.takeEgressAttempts
    await assertEgressSelfTest(takeEgressAttempts)
    const { fixtureInference } = await import('./fixture-inference')
    fake = await fixtureInference()
    Object.assign(process.env, {
      LARGE_LLM_BASE_URL: fake.base,
      LARGE_LLM_API_KEY: 'fixture',
      SMALL_LLM_BASE_URL: fake.base,
      SMALL_LLM_DECISIONS_URL: `${fake.base}/systemone`,
      SMALL_LLM_API_KEY: 'fixture',
    })
  }
  poisonPublicProviders(process.env)
  // All model calls use the production private-role map. No EVAL_CLIENT overrides.
  process.env.USE_SELF_DEPLOYED_INFERENCE = '1'
  const liveCatalog = live
    ? await (
        await import('./tool-catalog')
      ).productionCatalog(process.env.MCP_GATEWAY_URL ?? 'http://127.0.0.1:8811/mcp')
    : []
  const { startFakeGateway } = await import('../../e2e/lib/fake-gateway')
  const gateway = await startFakeGateway()
  process.env.MCP_GATEWAY_URL = gateway.url
  const rates = await import('../../src/lib/cost-rates.server')
  const largeRate = floorHourlyRate(rates.largeEurPerHour(), DEFAULT_LARGE_LLM_EUR_PER_HOUR)
  const smallRate = floorHourlyRate(rates.smallLlmEurPerHour(), DEFAULT_SMALL_LLM_EUR_PER_HOUR)
  const { largeScaledownSeconds } = await import('../../src/lib/inference/large-activity.server')
  const { smallScaledownSeconds } = await import('../../src/lib/inference/cold-start.server')
  await import('../../src/lib/inference/config.server')
  const clients = await import('@hames-ai/harness-baml/clients.server')
  clients.assertInferenceTier('self_deployed')
  const budget = new SpendBudget(cap, rates.eurPerUsdRate())
  const results: ConversationResult[] = []
  let wakeDetail: string | undefined
  const jobs = picked.map((s) => ({
    scenario: s,
    key: { agent: candidate, scenario: s.id, tier: 'self_deployed' as const },
  }))
  const file = resolve(
    'evals/reports',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-general-next.json`,
  )
  mkdirSync(resolve('evals/reports'), { recursive: true })
  // Off unless EVAL_GENERAL_CAPTURE=1: decision requests/choices and raw controller outputs,
  // beside the report and gitignored with it.
  const capture = captureEnabled(process.env) ? new CaptureLog() : undefined
  const captureFile = file.replace(/\.json$/, '-capture.json')
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
          tier: 'self_deployed',
          candidate,
          selectionComplete: picked.length === scenarios.length,
          flipGate: flipGate(
            live,
            picked.length === scenarios.length,
            candidate,
            scenarios,
            rows as ConversationResult[],
          ),
          // RECORDED, not run: `general` was removed, so these are its last live results.
          generalBaselineRecorded: GENERAL_BASELINE,
          hermeticCaveat: live
            ? undefined
            : 'Hermetic passes are wiring only. Scripted Synthesize echoes the expected answer, so answer/read-only/no-write/failure-acknowledged checks are self-fulfilling; only tool order+arguments, route selection+completion, artifacts, index/retrieval and first-turn-failure checks discriminate. 06-read-only passes vacuously. No G14 substitution is exercised (no fixture identity, directory off).',
          tailLines: budget.tailLines,
          capUsd: cap,
          stopUsd: budget.stopUsd,
          totalUsd: budget.totalUsd,
          stopReason: budget.reason,
          stopDetail: wakeDetail,
          eurPerUsd: budget.eurPerUsd,
          largeEurPerHour: largeRate,
          smallEurPerHour: smallRate,
          captureFile: capture ? captureFile : undefined,
          limitation:
            'The observer prices completed calls, so a final call can overshoot the 80% stop threshold and even the configured cap. Private infrastructure is an additional conservative floor: elapsed private-scenario time (including setup and endpoint wake wait) times both GPU hourly rates; observer call-time cost is also counted. Configured scale-down tails are reserved once per run and after idle gaps longer than each box window. Provider rounding and unobserved infrastructure are not measured. This is not an invoice ceiling. Hermetic results certify scripted wiring only; they cannot authorize the default flip.',
          results: rows.map((r) => {
            const spend = budget.row(r)
            return { ...r, spend, screen: screenShare(spend) }
          }),
        },
        null,
        2,
      ) + '\n',
    )
    if (capture) writeFileSync(captureFile, JSON.stringify(capture, null, 2) + '\n')
  }
  const tick = () => {
    if (active && live) budget.infrastructure(active, Date.now() - started, largeRate + smallRate)
  }
  const stop = () => {
    write()
    console.error(`Eval stopped: ${budget.reason}. Report: ${file}`)
    // Observer listeners swallow exceptions. Exit synchronously here so no
    // retry, synthesis or later scenario can make another call after the stop.
    process.exit(1)
  }
  const { observeLlmUsage } = await import('@hames-ai/harness-patterns/llm-usage-observer.server')
  const observer = createSpendObserver({ budget, live, onStop: stop })
  const unobserve = observeLlmUsage(observer.observe)
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
    driver = await createDriver(fake, live, liveCatalog, agents)
    for (const job of jobs) {
      active = job.key
      started = Date.now()
      observer.activate(active)
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
          if (live) {
            budget.beginInfrastructure(active, started, [
              {
                box: 'self_deployed',
                seconds: largeScaledownSeconds(),
                eurPerHour: largeRate,
              },
              { box: 'small', seconds: smallScaledownSeconds(), eurPerHour: smallRate },
            ])
            if (budget.stopped) stop()
            const { ensurePrivateTierAwake } = await import('../../src/lib/inference/wake.server')
            try {
              await ensurePrivateTierAwake()
            } catch (err) {
              const reason = wakeFailureReason(err)
              budget.reason = reason
              wakeDetail = describeWakeFailure(err)
              results.push({ ...active, status: 'fail', checks: [], error: reason })
              tick()
              stop()
            }
          }
          const trace = await driver.run(job.scenario, active)
          const checks = grade(job.scenario, trace, false)
          if ((await takeEgressAttempts?.())?.length)
            checks.push({
              name: 'no unexpected egress',
              pass: false,
              detail: 'Hermetic egress backstop refused requests',
            })
          const status = checks.length > 0 && checks.every((c) => c.pass) ? 'pass' : 'fail'
          capture?.add(active, trace, status === 'fail')
          results.push({ ...active, status, checks, guards: guardTurnCounts(trace.turns) })
        } catch (err) {
          capture?.addError(active, err instanceof Error ? err.message : 'Scenario threw')
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
      if (live && !job.scenario.p4) budget.endInfrastructure(Date.now())
      active = undefined
      observer.activate(undefined)
    }
    console.log(`Report: ${file}`)
    process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0
  } finally {
    clearInterval(timer)
    unobserve()
    await driver?.close()
    await fake?.close()
    const { closeMcpClient } = await import('@hames-ai/harness-patterns/mcp-client.server')
    await closeMcpClient()
    await gateway.goDown()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'Eval runner failed')
  process.exit(1)
})
