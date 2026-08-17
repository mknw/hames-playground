/**
 * Default Agent
 *
 * Router-based agent with Neo4j and Web Search routes.
 * Code-mode lives in a dedicated agent (`code-mode.server.ts`) because the
 * kg-agent gateway's `code-mode` tool is a factory that creates `code-mode-<name>`
 * tools — that workflow needs an actorCritic loop rather than a simpleLoop.
 */
'use server'

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  router,
  routes,
  simpleLoop,
  compactExecution,
  withReferences,
  Tools,
  callTool,
  createNeo4jController,
  createWebSearchController,
  type ConfiguredPattern,
} from '../../harness-patterns'
import type { SessionData } from '../session.server'
import type { AgentConfig } from '../registry.server'
import { NEO4J_FEW_SHOTS_DEFAULT } from './neo4j-fewshots.server'
import { enrichNeo4jResult } from '../neo4j-enricher.server'

async function getSchema(): Promise<string> {
  const result = await callTool('get_neo4j_schema', {})
  return result.success ? JSON.stringify(result.data) : ''
}

async function createPatterns(_sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()
  const schema = await getSchema()

  const neo4jController = createNeo4jController(tools.neo4j ?? [])
  const webTools = tools.web ?? []
  const webController = createWebSearchController(webTools)

  const neo4jPattern = simpleLoop<SessionData>(neo4jController, tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema,
    liveEvents: true,
    rememberPriorTurns: false,
    fewShots: NEO4J_FEW_SHOTS_DEFAULT,
    onToolResult: enrichNeo4jResult,
  })

  const webPattern = simpleLoop<SessionData>(webController, webTools, {
    patternId: 'web-search',
    liveEvents: true,
    rememberPriorTurns: false,
  })

  const routerPattern = router<SessionData>(
    {
      neo4j: 'Database queries and graph operations',
      web_search: 'Web lookups and information retrieval',
    },
    { liveEvents: true },
  )

  // Each route is wrapped in `withReferences` so the inner pattern receives
  // an LLM-curated set of relevant prior tool_results from any earlier turn,
  // attached to its `priorResults` channel. See docs/harness-patterns/with-references.md.
  const routesPattern = routes<SessionData>(
    {
      neo4j: withReferences<SessionData>(neo4jPattern, { scope: 'global', liveEvents: true }),
      web_search: withReferences<SessionData>(webPattern, { scope: 'global', liveEvents: true }),
    },
    { liveEvents: true },
  )

  const responseSynth = compactExecution<SessionData>({
    mode: 'thread',
    patternId: 'response-synth',
    liveEvents: true,
  })

  return [routerPattern, routesPattern, responseSynth]
}

export const defaultAgent: AgentConfig = {
  id: 'default',
  name: 'Default Agent',
  description: 'Router-based agent with Neo4j and Web Search',
  icon: 'i-material-symbols-robot-2-outline',
  accent: 'indigo',
  servers: ['neo4j-cypher', 'web_search', 'fetch'],
  createPatterns,
}
