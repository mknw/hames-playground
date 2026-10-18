/** CI source pins; runtime eval proof is manual and never imported here. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLIENT_MAX_OUTPUT_TOKENS } from '../lib/settings'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('#636 eval-only thinking configuration', () => {
  it('keeps 8192/340s in the eval and the shipped twin at 4096/180s', () => {
    const scenario = read('../../evals/scenarios/planner.ts')
    expect(scenario).toMatch(/THINKING_EVAL_MAX_TOKENS = 8192\b/)
    expect(scenario).toMatch(/THINKING_EVAL_TIMEOUT_MS = 340_000\b/)
    const corpus = read('../../../packages/harness-baml/baml_src/verda-client.baml')
    const twin = corpus.slice(corpus.indexOf('client<llm> VerdaQwenThink'))
    expect(twin).toMatch(/max_tokens 4096\b/)
    expect(twin).toMatch(/request_timeout_ms 180000\b/)
    expect(CLIENT_MAX_OUTPUT_TOKENS.VerdaQwenThink).toBe(4096)
  })

  it('validates planner-only selection before preflight and skips the unrelated Critic call', () => {
    const runner = read('../../evals/run.ts')
    const validate = runner.indexOf(
      'const thinkingPlanner = isThinkingPlannerRun(routing, scenarios)',
    )
    expect(validate).toBeGreaterThan(0)
    expect(validate).toBeLessThan(runner.indexOf('await preflight('))
    expect(runner).toMatch(/if \(!thinkingPlanner && scenarios.some\(/)
  })
})
