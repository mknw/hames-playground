/**
 * Scenario plumbing: the shapes a scenario declares, and the mechanics of
 * running one and recording what happened.
 *
 * A scenario is a small, recurrent branch of one role's real behaviour, plus
 * DETERMINISTIC checks over the result. "Deterministic" is the bar that makes
 * this suite worth re-running when a client changes: a check that reads a
 * model's prose and decides whether it is good enough measures the reader, not
 * the client. What we assert instead is structural — did the envelope parse,
 * is the route name one of the offered ones, did the placeholder survive
 * verbatim, is truncation detection wired for this client at all. Those answers
 * do not move between runs unless the client's behaviour actually moved.
 *
 * Where a branch genuinely has no deterministic reading, the scenario records
 * the value as an OBSERVATION instead of a check. An observation never fails
 * the run; it lands in the report so a human comparing two clients can see it.
 */

import { Collector } from '@boundaryml/baml'
import type { EvalRole, EvalRouting } from './client'
import { evalOverrideFor, expectedClientFor } from './client'

/** One deterministic assertion inside a scenario. */
export interface Check {
  name: string
  pass: boolean
  /** What was actually seen — printed whether the check passed or failed, so a
   *  green report still carries the evidence. */
  detail: string
}

/** A non-assertive measurement, reported but never failed on. */
export interface Observation {
  name: string
  value: string
}

export interface ScenarioContext {
  routing: EvalRouting
  /** Options bag for a BAML call on `role`, already carrying the collector and
   *  this run's client override. Returns `undefined` when the bag would be
   *  empty, because BAML's generated functions are POSITIONAL and an empty
   *  trailing `{}` is not the same as passing nothing (#154). */
  opts: (role: EvalRole, collector: Collector) => { collector: Collector; client?: string }
}

export interface Scenario {
  id: string
  role: EvalRole
  title: string
  /** One line: which recurrent branch this pins, and why it is worth a call. */
  what: string
  run: (ctx: ScenarioContext) => Promise<{
    checks: Check[]
    observations?: Observation[]
    /** Collector(s) the scenario used, so the runner can report who served the
     *  call without every scenario repeating the extraction. */
    collectors?: Collector[]
  }>
}

export interface ScenarioResult {
  scenario: Scenario
  checks: Check[]
  observations: Observation[]
  /** Clients the collectors say actually served the calls. */
  servedBy: string[]
  /** What routing said SHOULD serve them. */
  expectedClient: string
  ms: number
  /** Set when the scenario threw rather than returning checks. A throw is a
   *  failure of the scenario, reported as such — never swallowed into a pass. */
  error?: string
}

/** The client the collector says actually served a call — not the one we asked
 *  for. Being told the override is on is not evidence the call went there. */
export function servedBy(collector: Collector): string | undefined {
  const calls = (collector.last?.calls ?? []) as Array<{
    selected?: boolean
    clientName?: string
  }>
  return (calls.find((c) => c.selected) ?? calls[0])?.clientName
}

/** The raw text the model returned, before BAML parsed it into a type. Used by
 *  the scenarios that care about what came back around the envelope — a
 *  thinking block that should have been switched off, a stray `</think>`. */
export function rawCompletion(collector: Collector): string | undefined {
  const calls = (collector.last?.calls ?? []) as Array<{
    selected?: boolean
    httpResponse?: unknown
  }>
  const call = calls.find((c) => c.selected) ?? calls[0]
  const body = (call as { httpResponse?: { body?: unknown } } | undefined)?.httpResponse?.body
  if (typeof body === 'string') return body
  if (body && typeof body === 'object') return JSON.stringify(body)
  return undefined
}

/** Token counts for the selected call, when the collector reported them. */
export function usageOf(collector: Collector): { input?: number; output?: number } | undefined {
  const usage = collector.last?.usage as
    { inputTokens?: number | null; outputTokens?: number | null } | undefined
  if (!usage) return undefined
  return { input: usage.inputTokens ?? undefined, output: usage.outputTokens ?? undefined }
}

export function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail }
}

/** Run one scenario, timing it and turning a throw into a reported failure. */
export async function runScenario(
  scenario: Scenario,
  routing: EvalRouting,
): Promise<ScenarioResult> {
  const ctx: ScenarioContext = {
    routing,
    opts: (role, collector) => {
      // Same contract as clients.server.ts's `clientOverrideFor`: spread, then
      // let the caller decide whether the bag is worth passing.
      return { collector, ...(evalOverrideFor(routing, role) ?? {}) }
    },
  }
  const started = Date.now()
  try {
    const { checks, observations = [], collectors = [] } = await scenario.run(ctx)
    return {
      scenario,
      checks,
      observations,
      servedBy: collectors.map((c) => servedBy(c) ?? '(unreported)'),
      expectedClient: expectedClientFor(routing, scenario.role),
      ms: Date.now() - started,
    }
  } catch (err) {
    return {
      scenario,
      checks: [],
      observations: [],
      servedBy: [],
      expectedClient: expectedClientFor(routing, scenario.role),
      ms: Date.now() - started,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }
  }
}

/** A scenario passes when it produced at least one check and none of them
 *  failed, and did not throw. A scenario with zero checks is a bug in the
 *  scenario, not a pass — it would manufacture a green cell that asserts
 *  nothing, which is worse than a red one. */
export function scenarioPassed(result: ScenarioResult): boolean {
  if (result.error) return false
  if (result.checks.length === 0) return false
  return result.checks.every((c) => c.pass)
}
