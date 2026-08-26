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
 *
 * LATENCY IS COLLECTED HERE, NOT IN THE SCENARIOS. `runScenario` attaches a
 * second, run-owned Collector to every options bag `ctx.opts` builds, so a
 * scenario cannot forget to be timed and cannot decide which of its calls
 * count. That matters most where a scenario deliberately reports only one of
 * its collectors — the reliability scenario makes N calls and surfaces the
 * first, which is the right call for the served-by table and would throw away
 * the only sample in this suite large enough for a p95.
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
  /** Options bag for a BAML call on `role`, already carrying the scenario's
   *  collector, the run's latency collector, and this run's client override.
   *  Spread it, then branch on whether it ended up empty: BAML's generated
   *  functions are POSITIONAL and an empty trailing `{}` is not the same as
   *  passing nothing (#154). */
  opts: (role: EvalRole, collector: Collector) => { collector: Collector[]; client?: string }
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

/**
 * One LLM call's wall-clock and output tokens, attributed to the leaf client
 * that actually served it.
 *
 * Attributed to `clientName` rather than to the client under test, because a
 * chain can fall back: a `controller` scenario on the Anthropic baseline can
 * produce a Sonnet call and a Haiku call, and averaging them would report a
 * latency no single client has. Every call is sampled, INCLUDING the
 * non-selected attempts of a fallback chain — a failed attempt still cost the
 * wall-clock the caller waited, and hiding it would flatter the chain.
 */
export interface CallSample {
  client: string
  ms: number
  /** Absent when the provider reported no usage for the call. */
  outputTokens?: number
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
  /** Every LLM call the scenario made through `ctx.opts`, one sample each. */
  calls: CallSample[]
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

/**
 * Every call the collector saw, as latency samples.
 *
 * Reads `collector.logs` rather than `collector.last`, so a collector shared
 * across several calls yields all of them. A call with no reported duration is
 * dropped rather than counted as 0ms: a zero would drag a p50 down and read as
 * a fast call rather than as a missing measurement.
 */
export function callSamples(collector: Collector): CallSample[] {
  const samples: CallSample[] = []
  for (const log of collector.logs ?? []) {
    for (const call of log.calls ?? []) {
      const ms = call.timing?.durationMs
      if (typeof ms !== 'number') continue
      samples.push({
        client: call.clientName || '(unreported)',
        ms,
        outputTokens: call.usage?.outputTokens ?? undefined,
      })
    }
  }
  return samples
}

/** Wall-clock and throughput for one (scope, client) group of calls. */
export interface LatencyStats {
  client: string
  calls: number
  p50Ms: number
  p95Ms: number
  /** Summed over the calls that reported usage; `undefined` when none did. */
  outputTokens?: number
  /** Aggregate decode rate: those output tokens over the wall-clock of the
   *  calls that reported them. `undefined` when no call reported usage. */
  tokensPerSecond?: number
}

/**
 * Nearest-rank percentile — `sorted[ceil(q·n) - 1]`.
 *
 * No interpolation on purpose: every value it can return is a call that
 * actually happened, which is the honest thing to print next to an `n` of 1.
 * Most scenarios here make one to three calls, so read p95 as "the slowest of
 * a handful" unless `n` says otherwise; the reliability scenario is the only
 * sample in the suite large enough for the word to mean what it usually does.
 */
function percentile(sortedMs: number[], q: number): number {
  const i = Math.ceil(q * sortedMs.length) - 1
  return sortedMs[Math.min(Math.max(i, 0), sortedMs.length - 1)]
}

/** Group samples by the client that served them, slowest p50 first. */
export function summarizeLatency(samples: CallSample[]): LatencyStats[] {
  const byClient = new Map<string, CallSample[]>()
  for (const s of samples) {
    const bucket = byClient.get(s.client)
    if (bucket) bucket.push(s)
    else byClient.set(s.client, [s])
  }
  const stats: LatencyStats[] = []
  for (const [client, group] of byClient) {
    const sorted = group.map((s) => s.ms).sort((a, b) => a - b)
    // Throughput is computed over the calls that reported usage only. Mixing
    // in the wall-clock of a call whose tokens we never saw would understate
    // the rate by exactly the time that call took.
    const withUsage = group.filter((s) => s.outputTokens !== undefined)
    const tokens = withUsage.reduce((n, s) => n + (s.outputTokens ?? 0), 0)
    const tokenMs = withUsage.reduce((n, s) => n + s.ms, 0)
    stats.push({
      client,
      calls: group.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      outputTokens: withUsage.length > 0 ? tokens : undefined,
      tokensPerSecond: tokenMs > 0 ? (tokens / tokenMs) * 1000 : undefined,
    })
  }
  return stats.sort((a, b) => b.p50Ms - a.p50Ms)
}

export function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail }
}

/** Run one scenario, timing it and turning a throw into a reported failure. */
export async function runScenario(
  scenario: Scenario,
  routing: EvalRouting,
): Promise<ScenarioResult> {
  // Attached to every bag below, so the latency sample is a property of the
  // runner rather than of what each scenario remembered to hand back. BAML
  // accepts `Collector | Collector[]` and fans the record out to all of them.
  const timing = new Collector(`eval-timing-${scenario.id}`)
  const ctx: ScenarioContext = {
    routing,
    opts: (role, collector) => {
      // Same contract as clients.server.ts's `clientOverrideFor`: spread, then
      // let the caller decide whether the bag is worth passing.
      return { collector: [collector, timing], ...(evalOverrideFor(routing, role) ?? {}) }
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
      calls: callSamples(timing),
    }
  } catch (err) {
    return {
      scenario,
      checks: [],
      observations: [],
      servedBy: [],
      expectedClient: expectedClientFor(routing, scenario.role),
      ms: Date.now() - started,
      // A scenario that threw still made the calls it made before throwing —
      // and on a new client those are often the interesting ones.
      calls: callSamples(timing),
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
