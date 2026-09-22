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
// @unocss-include — the icon class literal lives in the app's registry overlay
// (see the host's harness-client/registry.server.ts), not here: `icon`/`accent`
// are UI fields and stay app-side (the #225 composition-root decision).
import {
  planner,
  simpleLoop,
  compactExecution,
  Tools,
  type ConfiguredPattern,
} from '@hames-ai/harness-patterns'
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import type { AgentData, AgentDefinition, AgentDeps } from '../types'

import { getGraphSchema } from './graph-schema.server'

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

// The 'use server' directive this file carried before the move was the only
// thing keeping its exports off the client; this is the real guard, and the
// reason stripping the directive removes nothing load-bearing.
assertServerOnImport()

async function createPatterns(
  sessionId: string,
  deps: AgentDeps,
): Promise<ConfiguredPattern<AgentData>[]> {
  const tools = await Tools({ namespaces: deps.toolNamespaces })
  // Warns and refuses the pattern cache on failure — see `graph-schema.server.ts`,
  // which this function used to be the only correct copy of (sf-M6).
  const schema = await getGraphSchema('general', sessionId, deps)
  // Lane A6: the BAML-backed implementations come from `harness-baml` — one
  // factory call, then each pattern takes its injected fn.
  const baml = bamlPatterns()

  // The planner sees exactly the tool surface the executor will have — a plan
  // that names a tool the loop cannot call is worse than no plan.
  const planPattern = planner<AgentData>(baml.planner(tools.all), tools.all, {
    patternId: 'plan',
    schema,
    liveEvents: true,
  })

  const executePattern = simpleLoop<AgentData>(createLoopControllerAdapter(), tools.all, {
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
  })

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
  const responseSynth = compactExecution<AgentData>({
    mode: 'thread',
    patternId: 'response-synth',
    liveEvents: true,
    synthesize: baml.synthesize,
    viewConfig: {
      fromPatterns: ['harness', 'execute'],
      fromLastNTurns: 1,
      eventTypes: ['user_message', 'controller_action', 'tool_call', 'tool_result', 'error'],
    },
  })

  return [planPattern, executePattern, responseSynth]
}

export const generalAgent: AgentDefinition = {
  id: 'general',
  name: 'General Agent',
  description: 'Plans first, then executes across every available tool namespace',
  welcome:
    'I write a plan first, then work through it across every tool I have — the ' +
    'knowledge graph, web search and fetch, library docs, and the memory graph. ' +
    'Best for questions that need more than one of those.',
  servers: ['neo4j-cypher', 'web_search', 'fetch', 'context7', 'memory'],
  createPatterns,
}
