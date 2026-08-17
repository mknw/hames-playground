/**
 * planner Pattern (#27)
 *
 * Produces a natural-language plan ONCE, before any tool runs, and hands it to
 * the next pattern in the chain:
 *
 *   chain(
 *     planner(tools.all),
 *     simpleLoop(controller, tools.all, { patternId: 'execute' }),
 *     synthesizer({ mode: 'thread' }),
 *   )
 *
 * Why: a `simpleLoop` controller re-derives its high-level approach on EVERY
 * turn. With a diverse tool surface (neo4j + database + web + context7) that
 * re-derivation is the expensive part of the prompt and the part most prone to
 * greedy, locally-coherent choices. The planner pays for the strategy once.
 *
 * The planner NEVER executes a tool — it only reads the catalog. Its output
 * reaches downstream controllers through the SAME channel `withReferences`
 * uses for refs: it writes `scope.data.plan`, the chain forwards `scope.data`
 * as the next pattern's `currentData`, and `simpleLoop` / `actorCritic` format
 * it (`formatPlanContext`) and pass it to their controller adapter as the
 * trailing `planContext` argument. `LoopController` takes it as its own
 * `plan_context` parameter — rendered in the prompt's tier-2 (run-static)
 * block, never inside the agent-static tier-1 prefix a per-question plan would
 * re-write on every run (#122). `ActorController` merges it into `context`,
 * which is cache-safe there because its only marker is already run-scoped.
 *
 * Best-effort: on any failure it CLEARS `scope.data.plan` and the downstream
 * loop runs exactly as it does today (unplanned) — never fatal. Clearing, not
 * merely "leaving unset": `scope.data` is carried across turns (the harness
 * only resets `hasError` / `errorMessage` / `response`, and `serializeContext`
 * is a plain `JSON.stringify`), so a turn-2 failure that returned `scope`
 * untouched would hand the executor turn 1's plan — a plan for a different
 * question, under wording that tells it to prefer the plan over its own
 * judgement. Same reason `compactIntent` overwrites `data.intent` on its skip
 * path.
 */

import { assertServerOnImport } from '../assert.server'
import { Collector } from '@boundaryml/baml'
import type {
  PatternScope,
  EventView,
  ConfiguredPattern,
  PatternConfig,
  ViewConfig,
  UserMessageEventData,
  PlanCreatedEventData,
  ErrorEventData,
  LLMCallData,
} from '../types'
import type { PlanResult } from '../../../../baml_client/types'
import { trackEvent, resolveConfig } from '../context.server'
import { getErrorHint } from '../error-hints'
import { stripThinkBlocks } from '../content-transforms'
import { createPlannerAdapter, LLMCallError } from '../baml-adapters.server'

assertServerOnImport()

/** Default cap on the plan text handed downstream. The executor re-reads the
 *  plan on every turn, so an unbounded plan is a per-turn cost, not a one-off. */
export const DEFAULT_MAX_PLAN_CHARS = 2000

export interface PlannerConfig extends PatternConfig {
  /** Extra context for the planner (e.g. a graph schema). Mirrors
   *  `SimpleLoopConfig.schema` — injected under the prompt's CONTEXT heading. */
  schema?: string
  /** Cap on the plan text written to `scope.data.plan` (default 2000). */
  maxPlanChars?: number
}

export interface PlannerData {
  /** Set by `planner`; read by `simpleLoop` / `actorCritic`. Absent means
   *  "no plan" — every consumer must behave exactly as it did before #27.
   *  The planner CLEARS it on every turn it does not produce one, so absence
   *  is a live statement about this turn, not a stale value from an earlier
   *  one. */
  plan?: PlanResult
  intent?: string
}

/**
 * Render a plan for injection into a downstream controller's `context`.
 *
 * Single formatting site, called by the loop patterns rather than by each
 * adapter: the adapters receive an already-formatted string, so they stay
 * ignorant of `PlanResult`'s shape.
 *
 * @returns The formatted block, or `undefined` when there is no usable plan
 *   (so callers can pass it straight through to an optional argument).
 */
export function formatPlanContext(plan?: PlanResult): string | undefined {
  if (!plan) return undefined
  const body = plan.plan?.trim()
  if (!body) return undefined
  const reasoning = plan.reasoning?.trim()
  return [
    'PLAN (from previous step — follow it unless a result contradicts it):',
    ...(reasoning ? [reasoning] : []),
    'Steps:',
    body,
  ].join('\n')
}

/**
 * Create a planner pattern.
 *
 * @param tools - Tool names the DOWNSTREAM executor will have available. The
 *   planner only reads their descriptions; it never calls one.
 * @param config - Optional pattern configuration. The default `viewConfig`
 *   reads the last 2 user turns of message history (think-blocks stripped) so
 *   a multi-turn intent shift is visible — same shape as `router`.
 * @returns ConfiguredPattern ready for chain
 */
export function planner<T extends PlannerData>(
  tools: string[],
  config?: PlannerConfig,
): ConfiguredPattern<T> {
  const DEFAULT_VIEW: ViewConfig = {
    fromLast: false,
    fromLastNTurns: 2,
    eventTypes: ['user_message', 'assistant_message'],
    contentTransforms: [stripThinkBlocks],
  }
  const resolved = resolveConfig('planner', {
    viewConfig: DEFAULT_VIEW,
    ...config,
  })
  const maxPlanChars = config?.maxPlanChars ?? DEFAULT_MAX_PLAN_CHARS
  const plannerFn = createPlannerAdapter(tools)

  /** Drop a plan carried over from an earlier turn. Every exit path that does
   *  not produce a NEW plan goes through this: `scope.data` survives the turn
   *  boundary, so returning it untouched would silently re-inject the previous
   *  question's plan. */
  const clearPlan = (scope: PatternScope<T>): PatternScope<T> => {
    scope.data = { ...scope.data, plan: undefined }
    return scope
  }

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    try {
      // The user_message lives at the harness level, outside this pattern's
      // scope. `unfiltered()` — NOT `fromAll()`, which keeps the filters the
      // constructor installed from `viewConfig` — so a caller-supplied view
      // window can never leave the planner with no message to plan for.
      const userMessage = view.unfiltered().ofType('user_message').last(1).get()[0]
      const userContent = userMessage ? (userMessage.data as UserMessageEventData).content : ''

      // Nothing to plan for — the loop runs unplanned. Emitted (not silent) so
      // a chain that never plans is visible in the panel rather than looking
      // like a planner that simply wasn't reached; mirrors
      // `intent_compacted.skipped`.
      if (!userContent) {
        trackEvent(
          scope,
          'plan_created',
          // No adapter call happened, so there is no resolved catalog to
          // report — the requested surface is the honest number here.
          { toolCount: tools.length, skipped: 'no-message' } as PlanCreatedEventData,
          resolved.trackHistory,
        )
        return clearPlan(scope)
      }

      const intent = scope.data.intent ?? userContent
      const collector = new Collector('planner')
      const {
        plan: raw,
        llmCall,
        toolCount,
      } = await plannerFn(userContent, intent, collector, config?.schema)

      // An empty plan parses fine (`PlanResult.plan` is a required string and
      // `""` satisfies it) but injects NOTHING downstream — `formatPlanContext`
      // returns undefined. Reporting that as a success would show "0 steps" in
      // the panel over a run that is really unplanned, so it is an error.
      // Thrown as an LLMCallError carrying the call that succeeded at the HTTP
      // level but produced nothing usable: this is exactly the failure whose
      // prompt you need to read, so a bare Error here would strip the panel's
      // drill-down on the one path that most needs it. (`llmCall` is optional
      // — no collector was passed, or it captured nothing — and without one
      // there is nothing to attach, so a plain Error is the honest throw.)
      if (!raw.plan?.trim()) {
        const message = 'Planner returned an empty plan'
        throw llmCall ? new LLMCallError(message, llmCall) : new Error(message)
      }

      // Cap the plan text: the executor re-reads it every turn.
      const truncated = raw.plan.length > maxPlanChars
      const plan: PlanResult = truncated
        ? { ...raw, plan: raw.plan.slice(0, maxPlanChars) + '…[truncated]' }
        : raw

      scope.data = { ...scope.data, plan }
      trackEvent(
        scope,
        'plan_created',
        {
          plan,
          // The catalog the model was actually shown (resolved by the adapter:
          // sandbox tools + the gateway names that resolved), not the raw name
          // list this factory was handed.
          toolCount,
          ...(truncated ? { truncated: true } : {}),
        } as PlanCreatedEventData,
        resolved.trackHistory,
        llmCall,
      )

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Best-effort: the adapter wraps final failures as LLMCallError so the
      // observability panel keeps the prompt/variables drill-down.
      const failedLlmCall: LLMCallData | undefined =
        error instanceof LLMCallError ? error.llmCall : undefined
      trackEvent(
        scope,
        'error',
        {
          error: msg,
          severity: resolved.errorSeverity,
          hint: getErrorHint(msg),
          ...(failedLlmCall ? { kind: 'llm_call' as const } : {}),
        } as ErrorEventData,
        true,
        failedLlmCall,
      )
      return clearPlan(scope)
    }
  }

  return {
    name: 'planner',
    fn,
    config: resolved,
    estimateTurns: () => 1,
  }
}
