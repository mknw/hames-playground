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
 *  knowing the shape of the graph before proposing Cypher. */
async function getSchema(): Promise<string> {
  const result = await callTool('get_neo4j_schema', {})
  return result.success ? JSON.stringify(result.data) : ''
}

async function createPatterns(_sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()
  const schema = await getSchema()

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

  const responseSynth = synthesizer<SessionData>({
    mode: 'thread',
    patternId: 'response-synth',
    liveEvents: true,
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
