/**
 * Routing - Server Only
 *
 * Routes user messages to appropriate tool namespaces.
 */

import { assertServerOnImport } from './assert.server'
import { Collector } from '@boundaryml/baml'
import { extractLLMCallData } from './baml-adapters.server'
import { clientOverrideFor } from './clients.server'
import type { LLMCallData } from './types'

assertServerOnImport()

// ============================================================================
// BAML Import Helper
// ============================================================================

async function getBAML() {
  const { b } = await import('../../../baml_client')
  return b
}

// ============================================================================
// Routing
// ============================================================================

/** Default routes for the router */
const DEFAULT_ROUTES = [
  { name: 'neo4j', description: 'Database queries and graph operations' },
  { name: 'web_search', description: 'Web lookups and information retrieval' },
  { name: 'code_mode', description: 'Multi-tool script composition' }
]

export interface RouteMessageResult {
  intent: string
  tool_call_needed: boolean
  tool_name: string | null
  response_text: string
  llmCall?: LLMCallData
}

export async function routeMessageOp(
  message: string,
  history: Array<{ role: string; content: string }>,
  routes: Array<{ name: string; description: string }> = DEFAULT_ROUTES,
  collector?: Collector
): Promise<RouteMessageResult> {
  const b = await getBAML()
  const startTime = Date.now()

  // Build a lookup from route names for validation
  const validRoutes = new Set(routes.map((r) => r.name))

  // Anthropic override applied when `USE_ANTHROPIC_ONLY=1` — routes through
  // `RouterAnthropic` (Haiku 4.5 primary, Sonnet 4.6 backstop).
  const routerOpts = { ...(collector ? { collector } : {}), ...clientOverrideFor('router') }
  const hasRouterOpts = Object.keys(routerOpts).length > 0
  const result = hasRouterOpts
    ? await b.Router(message, routes, history, routerOpts)
    : await b.Router(message, routes, history)

  // Extract LLM call data if collector present
  const llmCall = collector
    ? extractLLMCallData(
        collector,
        'Router',
        { message, routes, history },
        startTime,
        result
      )
    : undefined

  return {
    intent: result.intent,
    tool_call_needed: result.needs_tool,
    tool_name: result.route && validRoutes.has(result.route)
      ? result.route
      : null,
    response_text: result.response ?? '',
    llmCall
  }
}
