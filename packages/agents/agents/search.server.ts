/**
 * Search Agent
 *
 * Router-based agent with Neo4j and Web Search routes.
 *
 * Registered id `search`. It was `default` until PR #234 — a name that said
 * "the fallback" rather than what the agent does. `registry.server.ts` maps the
 * old id forward so conversations persisted under it still open.
 */
// @unocss-include — the icon class literal lives in the app's registry overlay
// (see the host's harness-client/registry.server.ts), not here: `icon`/`accent`
// are UI fields and stay app-side (the #225 composition-root decision).
import {
  router,
  routes,
  simpleLoop,
  compactExecution,
  withReferences,
  withInjectionGuard,
  Tools,
  type ConfiguredPattern,
} from '@hames-ai/harness-patterns'
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import type { AgentData, AgentDefinition, AgentDeps } from '../types'

import { getGraphSchema } from './graph-schema.server'
import { NEO4J_FEW_SHOTS_DEFAULT } from './neo4j-fewshots.server'

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
  const schema = await getGraphSchema('search', sessionId, deps)
  const baml = bamlPatterns()

  const webTools = tools.web ?? []

  // L14 (#225 Lane B3): each list appears exactly once, at the loop — it is
  // the allowlist AND what the controller advertises, via the seam.
  const neo4jPattern = simpleLoop<AgentData>(createLoopControllerAdapter(), tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema,
    liveEvents: true,
    rememberPriorTurns: false,
    fewShots: NEO4J_FEW_SHOTS_DEFAULT,
    onToolResult: deps.enrichNeo4jResult,
  })

  const webPattern = simpleLoop<AgentData>(createLoopControllerAdapter(), webTools, {
    patternId: 'web-search',
    liveEvents: true,
    rememberPriorTurns: false,
  })

  const routerPattern = router<AgentData>(
    {
      neo4j: 'Database queries and graph operations',
      web_search: 'Web lookups and information retrieval',
    },
    // The routing implementation is REQUIRED config, wired from `harness-baml`
    // at the composition root (BAML-companion seam lane) — core hosts no
    // default import.
    { liveEvents: true, route: baml.router },
  )

  // Each route is wrapped in `withReferences` so the inner pattern receives
  // an LLM-curated set of relevant prior tool_results from any earlier turn,
  // attached to its `priorResults` channel. See docs/harness-patterns/with-references.md.
  //
  // The WEB route is additionally wrapped in `withInjectionGuard`: search
  // results and fetched pages are attacker-controlled text, so anything the
  // `web` namespace returns is sanitized before it can reach the controller.
  // The `neo4j` route is NOT guarded — that graph is our own data, written by
  // this app, and is trusted by the same reasoning that makes user input
  // trusted. Behaviour is unchanged unless a detection fires.
  const routesPattern = routes<AgentData>(
    {
      neo4j: withReferences<AgentData>(neo4jPattern, {
        scope: 'global',
        liveEvents: true,
        selector: baml.selector,
      }),
      web_search: withInjectionGuard({ namespaces: ['web'], catalog: tools.all })(
        withReferences<AgentData>(webPattern, {
          scope: 'global',
          liveEvents: true,
          selector: baml.selector,
        }),
      ),
    },
    { liveEvents: true },
  )

  const responseSynth = compactExecution<AgentData>({
    mode: 'thread',
    patternId: 'response-synth',
    liveEvents: true,
    synthesize: baml.synthesize,
  })

  return [routerPattern, routesPattern, responseSynth]
}

export const searchAgent: AgentDefinition = {
  id: 'search',
  name: 'Search Agent',
  description: 'Router-based agent with Neo4j and Web Search',
  welcome:
    'Ask a question and I send it down one route: the knowledge graph, or a web ' +
    'search. Best when the answer lives in one of those two places.',
  servers: ['neo4j-cypher', 'web_search', 'fetch'],
  createPatterns,
}
