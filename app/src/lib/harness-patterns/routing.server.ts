/**
 * Routing - Server Only
 *
 * Routes user messages to appropriate tool namespaces.
 */

import { assertServerOnImport } from './assert.server'
import { Collector } from '@boundaryml/baml'
import { extractLLMCallData, wrapAsLLMCallError } from './baml-adapters.server'
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
  collector?: Collector,
): Promise<RouteMessageResult> {
  const b = await getBAML()
  const startTime = Date.now()

  // Build a lookup from route names for validation
  const validRoutes = new Set(routes.map((r) => r.name))

  // `router.baml` declares `RouterAnthropic` (Haiku 4.5 primary, Sonnet 4.6
  // backstop). A verda-tier run overrides that per call: the router is handed
  // the user's raw message, which is the payload the private tier is least
  // entitled to send off the box (2026-08-26 owner decision — see
  // `VERDA_CLIENT_BY_ROLE`).
  const routerOpts = { ...(collector ? { collector } : {}), ...clientOverrideFor('router') }
  const hasRouterOpts = Object.keys(routerOpts).length > 0
  const variables = { message, routes, history }
  // Wrap like every other adapter does: the router is the FIRST LLM call of a
  // turn, so a parse failure here aborts routing before any tool runs. Bare,
  // it reached `router`'s catch as a plain Error and the emitted error event
  // carried no `llmCall` at all — the raw response that failed to parse was
  // captured in the collector and then thrown away.
  let result: Awaited<ReturnType<typeof b.Router>>
  try {
    result = hasRouterOpts
      ? await b.Router(message, routes, history, routerOpts)
      : await b.Router(message, routes, history)
  } catch (e) {
    throw wrapAsLLMCallError(e, 'Router', variables, startTime, collector)
  }

  // Extract LLM call data if collector present
  const llmCall = collector
    ? extractLLMCallData(collector, 'Router', variables, startTime, result)
    : undefined

  return {
    intent: result.intent,
    tool_call_needed: result.needs_tool,
    tool_name: result.route && validRoutes.has(result.route) ? result.route : null,
    response_text: result.response ?? '',
    llmCall,
  }
}
