/**
 * General Agent (#27)
 *
 * Pattern: planner → simpleLoop → compactExecution.
 *
 * The A/B counterpart to the router-based `search` agent. Where `search`
 * classifies the request into ONE namespace and dispatches there — which
 * degrades on cross-domain questions, since a route can only be one thing —
 * this agent hands the whole tool surface to a single executor and pays for
 * strategy ONCE up front:
 *
 *   - `planner` reads every tool description and emits a numbered plan.
 *   - `simpleLoop` executes it; the plan arrives as the controller's own
 *     `plan_context` parameter (tier 2, beside the intent — never inside the
 *     agent-static `context` prefix), so the controller stops re-deriving the
 *     approach each turn.
 *
 * Kept alongside `search` deliberately: same session shape, different
 * strategy, so the two can be compared on the same questions.
 */
'use server'

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  planner,
  simpleLoop,
  compactExecution,
  Tools,
  createLoopControllerAdapter,
  type ConfiguredPattern,
} from '../../harness-patterns'
import type { SessionData } from '../session.server'
import type { AgentConfig } from '../registry.server'
import { getGraphSchema } from './graph-schema.server'

async function createPatterns(sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()
  // Warns and refuses the pattern cache on failure — see `graph-schema.server.ts`,
  // which this function used to be the only correct copy of (sf-M6).
  const schema = await getGraphSchema('general', sessionId)

  // The planner sees exactly the tool surface the executor will have — a plan
  // that names a tool the loop cannot call is worse than no plan.
  const planPattern = planner<SessionData>(tools.all, {
    patternId: 'plan',
    schema,
    liveEvents: true,
  })

  const executePattern = simpleLoop<SessionData>(
    createLoopControllerAdapter(tools.all),
    tools.all,
    {
      patternId: 'execute',
      schema,
      liveEvents: true,
      // Cross-namespace work needs more room than a single-route loop: the
      // plan is typically 2-6 steps and a step can take more than one call.
      //
      // **12, raised from 8 on evidence (#269).** A captured run —
      // "find the last excel I edited and return a docx report on it" — spent
      // all 8 rounds and lost the deliverable: 12 tool calls with NO repeated
      // (tool, args) pair, a new fact on every round, and the 8th still
      // recovering from a filesystem `Permission denied`. It was not spinning,
      // so a bigger budget buys real rounds rather than more of the same call:
      // 2 rounds went on a graph search that 500'd, 3 on discovering that an
      // ingested file is not on disk, and it needed roughly one more to
      // abandon the write and answer from what it already held.
      // 12 = the ~10 that run needed + 2 rounds of recovery headroom, and it
      // stays under `SETTINGS_BOUNDS.maxToolTurns[1]`, the ceiling the stuck-run
      // reaper's "longest legitimate turn" is derived from. Rounds, not calls:
      // with the default `multiToolCalls: 'parallel'` one round can carry up to
      // MAX_PARALLEL_TOOL_CALLS calls, so this is 12 controller round-trips and
      // up to ~48 tool calls — the budget bounds the LLM's thinking steps, not
      // the tool spend.
      maxTurns: 12,
    },
  )

  // Scoped view, as `sandbox-session` does. Without one,
  // `createEventView` installs no filters at all and `view.hasErrors()` sees
  // EVERY error the conversation ever recorded — including the planner's,
  // which is best-effort by design. One planner 429 on turn 2 would otherwise
  // have `Synthesize` apologise for a turn whose tool calls all succeeded, and
  // then again on turn 3, 4, 5…, because events persist across
  // `continueSession`. Scoping to the executor's own events, in this turn,
  // makes the error signal mean "the work failed" again.
  // `user_message` (patternId 'harness') is listed so the compactExecution still
  // sees the question: this chain has no router or compactIntent to set
  // `data.intent`, so an executor-only window would leave it with neither.
  const responseSynth = compactExecution<SessionData>({
    mode: 'thread',
    patternId: 'response-synth',
    liveEvents: true,
    viewConfig: {
      fromPatterns: ['harness', 'execute'],
      fromLastNTurns: 1,
      eventTypes: ['user_message', 'controller_action', 'tool_call', 'tool_result', 'error'],
    },
  })

  return [planPattern, executePattern, responseSynth]
}

export const generalAgent: AgentConfig = {
  id: 'general',
  name: 'General Agent',
  description: 'Plans first, then executes across every available tool namespace',
  icon: 'i-material-symbols-map-outline',
  accent: 'indigo',
  servers: ['neo4j-cypher', 'web_search', 'fetch', 'context7', 'memory'],
  createPatterns,
}
