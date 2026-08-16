/**
 * Router
 *
 * Routes input to patterns based on intent classification.
 * Split into two composable patterns:
 *   - router(descriptions) — classifies intent, sets scope.data.route
 *   - routes(patternMap)   — dispatches to the matched pattern
 *
 * Both are plain ConfiguredPattern<T> and compose inside chain(), parallel(),
 * guardrail(), or any other composition without special-casing.
 */

import { assertServerOnImport } from '../assert.server'
import { routeMessageOp } from '../routing.server'
import { Collector } from '@boundaryml/baml'
import type {
  PatternScope,
  EventView,
  ConfiguredPattern,
  AssistantMessageEventData,
  UserMessageEventData,
  RouterConfig,
  RoutesConfig,
  ViewConfig
} from '../types'
import { DIRECT_RESPONSE_ROUTE } from '../types'
import { trackEvent, resolveConfig, createEvent, createScope } from '../context.server'
import { emitLive } from '../live-event-context.server'
import { getRequestSettings } from '../../settings-context.server'
import { stripThinkBlocks } from '../content-transforms'
import { trimToFit, getContextWindow } from '../token-budget.server'
import { resolveClientForRole } from '../clients.server'

assertServerOnImport()

/** Route definitions: name → description */
export type Routes = Record<string, string>

/** Pattern mapping: route name → pattern */
export type RoutePatterns<T> = Record<string, ConfiguredPattern<T>>

export interface RouterData {
  route?: string
  intent?: string
  routerResponse?: string
  response?: string
}

/**
 * Create a router that classifies intent and sets scope.data.route.
 *
 * When a tool is needed, sets:
 *   - scope.data.route         = route name (e.g. 'neo4j')
 *   - scope.data.intent        = classified intent
 *   - scope.data.routerResponse = optional status text
 *
 * When no tool is needed (conversational), sets:
 *   - scope.data.response      = direct response text
 *   - scope.data.route         = directResponseRoute (default: 'user')
 *
 * Pair with routes() to dispatch to the matched sub-pattern.
 *
 * @param routeDescriptions - Route definitions (name → description)
 * @param config - Optional pattern configuration (includes directResponseRoute)
 *
 * @example
 * return [
 *   router({ neo4j: 'Database queries', web_search: 'Web lookups' }),
 *   routes({ neo4j: neo4jPattern, web_search: webPattern }),
 *   synthesizer({ mode: 'thread' })
 * ]
 */
export function router<T extends RouterData>(
  routeDescriptions: Routes,
  config?: RouterConfig
): ConfiguredPattern<T> {
  // Default viewConfig: cross-turn visibility of the last 5 turns, messages only.
  // Caller can override entirely by passing their own viewConfig in config.
  const DEFAULT_ROUTER_VIEW: ViewConfig = {
    fromLast: false,           // no pattern scope filter → see all events across turns
    fromLastNTurns: getRequestSettings().routerTurnWindow,
    eventTypes: ['user_message', 'assistant_message'],
    contentTransforms: [stripThinkBlocks]  // Strip <think> blocks from history — saves tokens, avoids confusing classifier
  }
  const resolved = resolveConfig('router', {
    viewConfig: DEFAULT_ROUTER_VIEW,
    ...config,                 // caller's config overrides defaults (including viewConfig)
  })
  const directRoute = config?.directResponseRoute ?? DIRECT_RESPONSE_ROUTE

  const fn = async (
    scope: PatternScope<T>,
    view: EventView
  ): Promise<PatternScope<T>> => {
    try {
      // view is pre-configured by viewConfig (last N turns of user/assistant messages).
      // Extract all messages, then split into current user message + prior history.
      const allMessages = view.get()

      // Current user message = the last user_message in the window
      const currentMsg = [...allMessages].reverse().find(e => e.type === 'user_message')
      const userContent = currentMsg
        ? (currentMsg.data as UserMessageEventData).content
        : ''

      // History = all messages except the current user_message, mapped to {role, content}
      // Trim oldest if context would overflow the router's model
      const rawHistory = allMessages
        .filter(e => e !== currentMsg)
        .map(e => ({
          role: e.type === 'user_message' ? 'user' : 'assistant',
          content: (e.data as UserMessageEventData | AssistantMessageEventData).content
        }))
      const contextWindow = getContextWindow(resolveClientForRole('router'))
      const history = trimToFit(rawHistory, h => JSON.stringify(h), 300, contextWindow)

      // Convert routes Record<string,string> to Array<{name,description}>
      const routeArray = Object.entries(routeDescriptions).map(([name, description]) => ({
        name,
        description
      }))

      // Route message using BAML with collector for observability
      const collector = new Collector('router')
      const result = await routeMessageOp(userContent, history, routeArray, collector)

      // No tool needed - return conversational response directly
      if (!result.tool_call_needed) {
        const responseText = result.response_text || ''
        scope.data = {
          ...scope.data,
          route: directRoute,
          intent: result.intent,
          routerResponse: responseText,
          response: responseText
        }

        // Track assistant message with LLM call data. `final: true` because
        // on the conversational route the router IS the final responder —
        // the downstream synthesizer skips BAML in this case.
        trackEvent(
          scope,
          'assistant_message',
          { content: responseText, final: true } as AssistantMessageEventData,
          resolved.trackHistory,
          result.llmCall
        )

        return scope
      }

      // Tool needed — record routing decision, let routes() dispatch
      const routeName = result.tool_name
      if (!routeName) {
        trackEvent(scope, 'error', { error: 'Router returned tool_call_needed but no tool_name' }, true)
        return scope
      }

      // Track the routing decision as an assistant message with LLM data.
      // No `final` flag — this is an intermediate "Looking into that…"
      // status that the synthesizer will later supersede with the real
      // response. Chat-history replay filters these out.
      const statusText = result.response_text || ''
      if (statusText) {
        trackEvent(
          scope,
          'assistant_message',
          { content: statusText } as AssistantMessageEventData,
          resolved.trackHistory,
          result.llmCall
        )
      }

      // Update scope data with routing info
      scope.data = {
        ...scope.data,
        route: routeName,
        intent: result.intent,
        routerResponse: statusText
      }

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      trackEvent(scope, 'error', { error: msg }, true)
      return scope
    }
  }

  return {
    name: 'router',
    fn,
    config: resolved,
    estimateTurns: () => 1
  }
}

/**
 * Create a dispatch pattern that reads scope.data.route and executes the matched pattern.
 *
 * - If scope.data.route is undefined: throws — routes() must be preceded by router()
 * - If scope.data.route is the direct-response sentinel ('user'): pass-through (router responded directly)
 * - If route found in patternMap: dispatch with pattern_enter/exit wrapping
 * - If route not found: track error event, pass-through
 *
 * Designed to follow router() in a harness() or chain() sequence.
 *
 * @param patternMap - Route name → ConfiguredPattern mapping
 * @param config - Optional pattern configuration (includes directResponseRoute)
 *
 * @example
 * return [
 *   router({ neo4j: 'Database queries', web_search: 'Web lookups' }),
 *   routes({ neo4j: neo4jPattern, web_search: webPattern }),
 *   synthesizer({ mode: 'thread' })
 * ]
 */
export function routes<T extends RouterData & Record<string, unknown>>(
  patternMap: RoutePatterns<T>,
  config?: RoutesConfig
): ConfiguredPattern<T> {
  const resolved = resolveConfig('routes', config)
  const directRoute = config?.directResponseRoute ?? DIRECT_RESPONSE_ROUTE

  return {
    name: `routes(${Object.keys(patternMap).join('|')})`,
    fn: async (scope, view) => {
      const routeName = scope.data.route as string | undefined

      // route undefined means routes() was used without a preceding router()
      if (routeName === undefined) {
        throw new Error('routes() called without a preceding router() — data.route is undefined')
      }

      // Direct-response route — router handled it, pass through
      if (routeName === directRoute) return scope

      const pattern = patternMap[routeName]
      if (!pattern) {
        const errMsg = `Unknown route: ${routeName}. Available: ${Object.keys(patternMap).join(', ')}`
        trackEvent(scope, 'error', { error: errMsg }, true)
        return scope
      }

      // Dispatch to matched pattern with a child scope so events are
      // tagged with the sub-pattern's own patternId, not routes' id.
      const childId = pattern.config.patternId ?? pattern.name
      const childScope = createScope<T>(childId, scope.data)

      // Surface the dispatched pattern's maxTurns on its boundary event so
      // downstream consumers (UI progress) can size their indicators.
      const childMaxTurns = (pattern.config as { maxTurns?: number }).maxTurns
      const enterEvent = createEvent('pattern_enter', childId, {
        pattern: pattern.name,
        route: routeName,
        ...(childMaxTurns !== undefined ? { maxTurns: childMaxTurns } : {})
      })
      scope.events.push(enterEvent)
      emitLive(enterEvent)

      const childResult = await pattern.fn(childScope, view)
      // Merge child events and data back into routes' scope
      scope.events.push(...childResult.events)
      const exitEvent = createEvent('pattern_exit', childId, { status: 'completed' })
      scope.events.push(exitEvent)
      emitLive(exitEvent)
      scope.data = childResult.data

      return scope
    },
    config: resolved,
    // Worst-case projection: route is picked at runtime, so the longest branch
    // drives perceived progress duration. UI can refine downward once the
    // dispatched branch's `pattern_enter` arrives.
    estimateTurns: (s) =>
      Math.max(...Object.values(patternMap).map((p) => p.estimateTurns?.(s) ?? 1)),
    children: Object.values(patternMap)
  }
}
