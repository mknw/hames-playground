/**
 * withReferences — Meta-Pattern Wrapper
 *
 * On pattern entry, runs an LLM-driven selector over visible `tool_result`
 * events and attaches relevant ones to the inner pattern's `priorResults`
 * channel via `scope.data.attachedRefs`. The adapter merges these into the
 * BAML `turns_previous_runs` argument.
 *
 * See: docs/harness-patterns/with-references.md (issue #30).
 */

import { Collector } from '@boundaryml/baml'
import { assertServerOnImport } from '../assert.server'
import {
  trackEvent,
  resolveConfig,
  createScope,
  createEvent
} from '../context.server'
import type {
  ConfiguredPattern,
  ContextEvent,
  EventView,
  PatternScope,
  ReferenceAttachedEventData,
  ReferenceCandidate,
  SelectorFn,
  ToolCallEventData,
  ToolResultEventData,
  WithReferencesConfig,
  UserMessageEventData,
  AssistantMessageEventData
} from '../types'
import type { PriorResult } from '../../../../baml_client/types'

assertServerOnImport()

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_REFS = 5
const SUMMARY_FALLBACK_CHARS = 120
const RECENT_MESSAGE_COUNT = 4
const CACHE_MAX_ENTRIES = 200

// ============================================================================
// Cache (process-lifetime, LRU by insertion order)
// ============================================================================

interface CachedDecision {
  selected: Array<{ ref_id: string; reason: string }>
  reasoning: string
}

const referenceCache = new Map<string, CachedDecision>()

function cacheGet(key: string): CachedDecision | undefined {
  const hit = referenceCache.get(key)
  if (hit) {
    referenceCache.delete(key)
    referenceCache.set(key, hit)
  }
  return hit
}

function cacheSet(key: string, value: CachedDecision): void {
  if (referenceCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = referenceCache.keys().next().value
    if (oldest !== undefined) referenceCache.delete(oldest)
  }
  referenceCache.set(key, value)
}

/** Test-only — exported for unit tests to start from a clean state. */
export function __clearReferenceCache(): void {
  referenceCache.clear()
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function summaryFromEvent(data: ToolResultEventData): string {
  if (data.summary && data.summary.trim().length > 0) return data.summary
  const raw = typeof data.result === 'string' ? data.result : JSON.stringify(data.result)
  return truncate(raw, SUMMARY_FALLBACK_CHARS)
}

function findToolArgs(events: ContextEvent[], callId?: string): string | undefined {
  if (!callId) return undefined
  const call = events.find(e => e.type === 'tool_call' && (e.data as ToolCallEventData).callId === callId)
  if (!call) return undefined
  const args = (call.data as ToolCallEventData).args
  const s = typeof args === 'string' ? args : JSON.stringify(args)
  return truncate(s, SUMMARY_FALLBACK_CHARS)
}

function buildCandidates(
  events: ContextEvent[],
  allEvents: ContextEvent[]
): ReferenceCandidate[] {
  const out: ReferenceCandidate[] = []
  for (const ev of events) {
    if (ev.type !== 'tool_result' || !ev.id) continue
    const d = ev.data as ToolResultEventData
    if (d.hidden || d.archived) continue
    if (!d.success) continue
    out.push({
      ref_id: ev.id,
      tool: d.tool,
      summary: summaryFromEvent(d),
      tool_args: findToolArgs(allEvents, d.callId),
      ts: ev.ts
    })
  }
  return out
}

function extractIntent<T>(scope: PatternScope<T>, view: EventView): string {
  const fromData = (scope.data as { intent?: string }).intent
  if (fromData && fromData.trim().length > 0) return fromData
  const userMsg = view.fromAll().ofType('user_message').last(1).get()[0]
  if (userMsg) return (userMsg.data as UserMessageEventData).content
  return ''
}

function getRecentMessages(view: EventView, n: number): Array<{ role: 'user' | 'assistant'; content: string }> {
  const events = view.fromAll().ofTypes(['user_message', 'assistant_message']).last(n).get()
  return events.map(e => ({
    role: e.type === 'user_message' ? 'user' as const : 'assistant' as const,
    content: e.type === 'user_message'
      ? (e.data as UserMessageEventData).content
      : (e.data as AssistantMessageEventData).content
  }))
}

function makeCacheKey(intent: string, candidates: ReferenceCandidate[]): string {
  const stash = candidates
    .map(c => `${c.ref_id}|${c.summary}`)
    .sort()
    .join('\n')
  return `${intent}\n--\n${stash}`
}

function pickCandidatesByIds(
  candidates: ReferenceCandidate[],
  ids: Array<{ ref_id: string }>
): ReferenceCandidate[] {
  const map = new Map(candidates.map(c => [c.ref_id, c]))
  const out: ReferenceCandidate[] = []
  for (const { ref_id } of ids) {
    const c = map.get(ref_id)
    if (c) out.push(c)
  }
  return out
}

function toPriorResults(refs: ReferenceCandidate[]): PriorResult[] {
  return refs.map(r => ({
    ref_id: r.ref_id,
    tool: r.tool,
    summary: r.summary
  }))
}

// ============================================================================
// Default selector — calls BAML ReferenceSelector
// ============================================================================

const defaultSelector: SelectorFn = async (input) => {
  const { b } = await import('../../../../baml_client')
  const { clientOverrideFor } = await import('../clients.server')
  const now = Date.now()
  const collector = new Collector('reference-selector')
  const result = await b.ReferenceSelector(
    input.intent,
    input.recentMessages.map(m => ({ role: m.role, content: m.content })),
    input.candidates.map(c => ({
      ref_id: c.ref_id,
      tool: c.tool,
      summary: c.summary,
      tool_args: c.tool_args ?? null,
      ts_offset_s: Math.max(0, Math.floor((now - c.ts) / 1000))
    })),
    { collector, ...clientOverrideFor('describe') }
  )
  return {
    selected: result.selected.map(s => ({ ref_id: s.ref_id, reason: s.reason })),
    reasoning: result.reasoning
  }
}

// ============================================================================
// Wrapper
// ============================================================================

/**
 * Wrap a pattern so that on entry, an LLM selector picks relevant prior
 * tool results from the visible event stream and attaches them to the inner
 * pattern's `priorResults` channel.
 *
 * @example
 *   const route = withReferences(
 *     simpleLoop(b.Neo4jController, tools.neo4j, { patternId: 'neo4j-query' }),
 *     { scope: 'global', maxRefs: 5 }
 *   )
 */
export function withReferences<T>(
  wrappedPattern: ConfiguredPattern<T>,
  config?: WithReferencesConfig
): ConfiguredPattern<T> {
  const resolved = resolveConfig('withReferences', config)
  const maxRefs = config?.maxRefs ?? DEFAULT_MAX_REFS
  const selector = config?.selector ?? defaultSelector

  const fn = async (
    scope: PatternScope<T>,
    view: EventView
  ): Promise<PatternScope<T>> => {
    try {
      // 1. Build candidate list
      const allEvents = view.fromAll().get()
      const sourceList = config?.source
        ? (Array.isArray(config.source) ? config.source : [config.source])
        : config?.scope === 'self'
          ? [scope.id]
          : null

      const eligibleEvents = sourceList
        ? view.fromPatterns(sourceList).ofType('tool_result').get()
        : view.fromAll().ofType('tool_result').get()

      const candidates = buildCandidates(eligibleEvents, allEvents)

      // 2. Skip optimizations
      let attached: ReferenceCandidate[] = []
      let trackPayload: ReferenceAttachedEventData

      if (candidates.length === 0) {
        trackPayload = { candidates: [], selected: [], reasoning: '', skipped: 'empty' }
      } else if (candidates.length === 1) {
        attached = candidates
        trackPayload = {
          candidates: candidates.map(c => ({ ref_id: c.ref_id, tool: c.tool, summary: c.summary })),
          selected: [{ ref_id: candidates[0].ref_id, reason: 'sole candidate' }],
          reasoning: 'Only one eligible reference; attached without selector call.',
          skipped: 'single'
        }
      } else {
        const intent = extractIntent(scope, view)
        const cacheKey = makeCacheKey(intent, candidates)
        const cached = cacheGet(cacheKey)

        if (cached) {
          attached = pickCandidatesByIds(candidates, cached.selected).slice(0, maxRefs)
          trackPayload = {
            candidates: candidates.map(c => ({ ref_id: c.ref_id, tool: c.tool, summary: c.summary })),
            selected: cached.selected.slice(0, maxRefs),
            reasoning: cached.reasoning,
            skipped: 'cached'
          }
        } else {
          const recentMessages = getRecentMessages(view, RECENT_MESSAGE_COUNT)
          const result = await selector({ intent, recentMessages, candidates })
          attached = pickCandidatesByIds(candidates, result.selected).slice(0, maxRefs)
          cacheSet(cacheKey, { selected: result.selected, reasoning: result.reasoning })
          trackPayload = {
            candidates: candidates.map(c => ({ ref_id: c.ref_id, tool: c.tool, summary: c.summary })),
            selected: result.selected.slice(0, maxRefs),
            reasoning: result.reasoning
          }
        }
      }

      // 3. Track the decision
      trackEvent(scope, 'reference_attached', trackPayload, resolved.trackHistory)

      // 4. Stash on scope.data so the adapter can pick it up
      ;(scope.data as { attachedRefs?: PriorResult[] }).attachedRefs = toPriorResults(attached)

      // 5. Dispatch to inner pattern with a child scope so its events are
      //    surrounded by pattern_enter/exit. Mirrors guardrail/hook wrapping.
      const childScope = createScope<T>(wrappedPattern.config.patternId ?? wrappedPattern.name, scope.data)
      const result = await wrappedPattern.fn(childScope, view)

      const innerPatternId = wrappedPattern.config.patternId ?? wrappedPattern.name
      scope.events.push(createEvent('pattern_enter', innerPatternId, { pattern: wrappedPattern.name }))
      scope.events.push(...result.events)
      scope.events.push(createEvent('pattern_exit', innerPatternId, { status: 'completed' }))
      scope.data = result.data

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      trackEvent(scope, 'error', { error: msg }, true)
      return scope
    }
  }

  return {
    name: `withReferences(${wrappedPattern.name})`,
    fn,
    config: resolved,
    estimateTurns: (s) => wrappedPattern.estimateTurns?.(s) ?? 1,
    children: [wrappedPattern]
  }
}
