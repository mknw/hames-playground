/**
 * General Agent (#27)
 *
 * Pattern: planner → simpleLoop → synthesizer.
 *
 * The A/B counterpart to the router-based `default` agent. Where `default`
 * classifies the request into ONE namespace and dispatches there — which
 * degrades on cross-domain questions, since a route can only be one thing —
 * this agent hands the whole tool surface to a single executor and pays for
 * strategy ONCE up front:
 *
 *   - `planner` reads every tool description and emits a numbered plan.
 *   - `simpleLoop` executes it; the plan arrives prepended to its controller's
 *     `context`, so the controller stops re-deriving the approach each turn.
 *
 * Kept alongside `default` deliberately: same session shape, different
 * strategy, so the two can be compared on the same questions.
 */
'use server'

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  planner,
  simpleLoop,
  synthesizer,
  Tools,
  callTool,
  createLoopControllerAdapter,
  type ConfiguredPattern,
} from '../../harness-patterns'
import type { SessionData } from '../session.server'
import type { AgentConfig } from '../registry.server'

/** Best-effort graph schema — the planner and the executor both benefit from
 *  knowing the shape of the graph before proposing Cypher.
 *
 *  A failure is logged, never swallowed: `planner.baml` tells the model "only
 *  plan steps the listed tools can actually perform", so a silently empty
 *  schema shows up as worse plans rather than as an error. `listTools` logs on
 *  the same principle. */
async function getSchema(): Promise<string> {
  const result = await callTool('get_neo4j_schema', {})
  if (!result.success) {
    console.warn(
      `[general] graph schema unavailable (${result.error ?? 'unknown error'}) — the planner ` +
        'and executor run without it this turn; patterns will be rebuilt on the next message.',
    )
    return ''
  }
  return JSON.stringify(result.data)
}

async function createPatterns(sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()
  const schema = await getSchema()

  // Patterns are cached per session and never rebuilt, so a transient schema
  // failure would otherwise freeze a schema-less planner AND executor into the
  // whole conversation. Keep this build (it works, just blind) but refuse the
  // cache entry so the next message retries the fetch.
  if (!schema) {
    const { doNotCachePatterns } = await import('../session.server')
    doNotCachePatterns(sessionId)
  }

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
      maxTurns: 8,
    },
  )

  // Scoped view, as `code-mode` and `sandbox-session` do. Without one,
  // `createEventView` installs no filters at all and `view.hasErrors()` sees
  // EVERY error the conversation ever recorded — including the planner's,
  // which is best-effort by design. One planner 429 on turn 2 would otherwise
  // have `Synthesize` apologise for a turn whose tool calls all succeeded, and
  // then again on turn 3, 4, 5…, because events persist across
  // `continueSession`. Scoping to the executor's own events, in this turn,
  // makes the error signal mean "the work failed" again.
  // `user_message` (patternId 'harness') is listed so the synthesizer still
  // sees the question: this chain has no router or compactIntent to set
  // `data.intent`, so an executor-only window would leave it with neither.
  const responseSynth = synthesizer<SessionData>({
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
