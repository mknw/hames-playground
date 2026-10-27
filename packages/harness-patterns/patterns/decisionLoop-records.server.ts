/**
 * The route-output record of `decisionLoop` (#507 S1): what one route produced,
 * built BY CODE from that route's committed events — no model call, so there is
 * no new LLM role for the tier rule to route.
 *
 * Three things live here and nowhere else, so each is readable (and
 * mutation-testable) on its own:
 *
 *   1. the per-kind extractors, which read ONLY the events a route committed
 *      and ONLY the types named below. They never read `content_sanitized`:
 *      that event is human-facing and holds the matched injection span verbatim
 *      (SD-3), so an extractor that touched it would convert a neutralised
 *      problem into a decision-stage one.
 *   2. the stats, counted from those same events.
 *   3. the rendering of the decision state and the child handoff from records.
 *
 * Nothing in this file sanitizes or screens: a record is not an ingress (the
 * loop's own text is the model's, or built by code). Two extractors quote
 * TOOL-RESULT bodies, which passed ingress already; they strip the ingress fence
 * to excerpt and put the SAME provenance fence back around what they quoted
 * (`carry`) — no regex pass, no screen, no finding of their own. A fence's label
 * is trusted only when the run's guard actually guards the tool it names (content
 * a guard never saw can carry a forged header). Every text field an extractor
 * returns is capped; the cap runs before the fence goes on so a long body can
 * never cut its own closing line, which means a fenced field is `max` of body
 * plus the fence's own lines.
 */

import { assertServerOnImport } from '../assert.server'
import { EXPAND_TOOL_NAME } from '../types'
import {
  closeCutFences,
  containsFence,
  spotlight,
  unspotlight,
  unspotlightParts,
} from '../injection-guard'
import { currentRunFrame } from '../run-frame.server'
import type {
  ContextEvent,
  ControllerActionEventData,
  CriticResultEventData,
  ErrorEventData,
  PlanCreatedEventData,
  ToolCallEventData,
  ToolResultEventData,
  ConfiguredPattern,
} from '../types'
import type { RetrieverResult } from './retriever.server'

assertServerOnImport()

/** The route kinds that have a default extractor. */
export type RouteKind = 'simpleLoop' | 'actorCritic' | 'retriever' | 'planner'

const KINDS: readonly RouteKind[] = ['simpleLoop', 'actorCritic', 'retriever', 'planner']

/** Counted by code from a route's events (never reported by a model). */
export interface RouteStats {
  readonly kind: RouteKind
  /** Loop turns / actor attempts used, against the route's own bound. */
  readonly used?: number
  readonly bound?: number
  readonly toolCalls: number
  readonly errors: number
  readonly wallMs: number
  /** The route ran into its own bound (an `error` of kind `budget_exhausted`). */
  readonly hitBound: boolean
  /** Retriever: matches, distinct source documents and backend names. */
  readonly matches?: number
  readonly documents?: number
  readonly backends?: readonly string[]
  /** Planner: steps in the plan. */
  readonly planSteps?: number
}

/** What an extractor found, every text field already capped. `failure` is a
 *  short, CODE-GENERATED reason (never model or tool text) for the one-line step
 *  list; `text` is the failure's own text. */
export type Extracted =
  | { ok: true; result: string; reasoning: string; planSteps?: number }
  | { ok: false; failure: string; text: string }

/** One finished iteration, as held in memory and rendered into the state. */
export interface RouteOutput {
  readonly iteration: number
  readonly route: string
  readonly status: 'succeeded' | 'failed'
  readonly stats: RouteStats
  /** Capped. For a failed route: the failure text. A quoted tool-result body
   *  keeps its ingress fence; nothing else in a record is fenced. */
  readonly result: string
  /** Capped; `''` when the route has none. */
  readonly reasoning: string
  /** A short code-generated reason; present only when `status` is `failed`. */
  readonly failure?: string
  /** The plan, for a succeeded planner route: the ONLY thing later children
   *  render under their PLAN heading. */
  readonly plan?: { readonly text: string; readonly steps: number }
}

// ============================================================================
// Route kind — found by unwrapping single-child wrappers
// ============================================================================

/** The innermost pattern of a chain of single-child wrappers
 *  (`withInjectionGuard`, `withSandbox`, `withReferences`), or `undefined` when
 *  the route is a multi-child combinator (`chain`, `routes`, `parallel`). */
export function leafPattern<T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> | undefined {
  let current = pattern
  while (current.children !== undefined) {
    if (current.children.length !== 1) return undefined
    current = current.children[0]
  }
  return current
}

/** The extractor kind of a route's pattern, or `undefined` when it has none. */
export function routeKind<T>(pattern: ConfiguredPattern<T>): RouteKind | undefined {
  const leaf = leafPattern(pattern)
  return leaf ? KINDS.find((k) => k === leaf.name) : undefined
}

/** Every `patternId` a pattern can emit events under, nested ones included.
 *  `withInjectionGuard` and `withSandbox` are config-transparent and add none of
 *  their own; `withReferences` is not (it generates its own id), and the walk
 *  collects that one too. */
export function collectPatternIds<T>(pattern: ConfiguredPattern<T>): Set<string> {
  const ids = new Set<string>()
  const walk = (p: ConfiguredPattern<T>): void => {
    ids.add(p.config.patternId ?? p.name)
    for (const child of p.children ?? []) walk(child)
  }
  walk(pattern)
  return ids
}

/** Every tool name a pattern graph declares (`capabilities.tools`), deduped, in
 *  first-seen order. */
export function collectToolNames<T>(pattern: ConfiguredPattern<T>): string[] {
  const names = new Set<string>()
  const walk = (p: ConfiguredPattern<T>): void => {
    for (const name of p.capabilities?.tools ?? []) names.add(name)
    for (const child of p.children ?? []) walk(child)
  }
  walk(pattern)
  return [...names]
}

// ============================================================================
// Extractors
// ============================================================================

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '')

/** Strip the fences from every string leaf BEFORE the value is turned into JSON,
 * which would make the fence newlines literal escape sequences. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]),
    )
  }
  return value
}

/** The last `error` event's message, or `fallback`. Error text is the event's
 *  own `error` field only. */
function lastErrorText(events: ContextEvent[], fallback: string): string {
  const errors = events.filter((e) => e.type === 'error')
  const last = errors[errors.length - 1]
  const text = (last?.data as ErrorEventData | undefined)?.error
  return text && text.trim() ? text : fallback
}

/** The provenance an ingress fence named: its source and, when it named one,
 *  its item id (the call's id for a tool result, the hit's `docId` for a hit). */
interface FenceLabel {
  readonly tool: string
  readonly namespace: string
  readonly item?: string
}

/** Put a quoted body back under the fence its label came from, item id included. */
function refence(body: string, label: FenceLabel): string {
  return spotlight(body, label.tool, label.namespace, label.item)
}

/** A quoted body, its fences stripped, and the label of the first fence it carried. */
interface Unfenced {
  readonly body: string
  readonly label?: FenceLabel
}

/** A header names provenance only when the run's guard covers that tool: content
 *  no guard sanitized still holds whatever sentinels it was sent, so its header
 *  may be forged. Without a guard (or a tool it does not declare) nothing is labelled. */
function guards(tool: string): boolean {
  return currentRunFrame()?.guard?.isUntrusted(tool) === true
}

function unfence(value: unknown, tool?: string): Unfenced {
  let label: FenceLabel | undefined
  const stripped = mapStrings(value, (text) => {
    const parts = unspotlightParts(text)
    if (!parts) return unspotlight(text)
    // A header naming another tool than the event's own was not written for this result.
    if (tool !== undefined && parts.tool !== tool) return text
    if (guards(parts.tool))
      label ??= { tool: parts.tool, namespace: parts.namespace, item: parts.item }
    return parts.body
  })
  return { body: asText(stripped), label }
}

/** Cap a quoted body, THEN put back the fence it came in. Nothing quoted means
 *  nothing to label, and a body that arrived unfenced stays unfenced. */
function carry(quoted: Unfenced, max: number): string {
  if (!quoted.body) return ''
  const body = capText(quoted.body, max)
  return quoted.label ? refence(body, quoted.label) : body
}

function extractSimpleLoop(events: ContextEvent[], max: number): Extracted {
  const actions = events.filter((e) => e.type === 'controller_action')
  const ret = [...actions].reverse().find((e) => {
    const a = (e.data as ControllerActionEventData).action
    return a.tool_name === 'Return' || a.is_final === true
  })
  if (!ret) {
    return {
      ok: false,
      failure: 'the loop ended without returning',
      text: lastErrorText(events, 'the loop ended without returning'),
    }
  }
  const action = (ret.data as ControllerActionEventData).action
  const text = (action.tool_args ?? '').trim()
  if (!text) {
    return {
      ok: false,
      failure: 'the loop returned no text',
      text: lastErrorText(events, 'the loop returned no text'),
    }
  }
  return { ok: true, result: capText(text, max), reasoning: action.reasoning ?? '' }
}

function extractActorCritic(events: ContextEvent[], max: number): Extracted {
  let action: ControllerActionEventData['action'] | undefined
  let results: ToolResultEventData[] = []
  let accepted:
    | { action: ControllerActionEventData['action']; results: ToolResultEventData[]; why: string }
    | undefined
  for (const e of events) {
    if (e.type === 'controller_action') {
      action = (e.data as ControllerActionEventData).action
      results = []
    } else if (e.type === 'tool_result') {
      results.push(e.data as ToolResultEventData)
    } else if (e.type === 'critic_result') {
      const critic = (e.data as CriticResultEventData).result
      if (critic.is_sufficient && action) {
        accepted = { action, results: [...results], why: critic.explanation ?? '' }
      }
    }
  }
  if (!accepted || accepted.results.length === 0) {
    return {
      ok: false,
      failure: 'no attempt was accepted by the critic',
      text: lastErrorText(events, 'no attempt was accepted by the critic'),
    }
  }
  // One block per accepted result, each under the fence ITS result arrived in:
  // a batch can mix tools, and one label over all of them would name the wrong
  // source for all but one. The cap is split (less each fence) so the record stays near `max`.
  const n = accepted.results.length
  const blocks = accepted.results.map((r) => {
    const value = r.success ? r.result : r.error
    const quoted = unfence(
      n === 1
        ? value
        : r.success
          ? { tool: r.tool, result: value }
          : { tool: r.tool, error: value },
      r.tool,
    )
    // The fence rides on top of the capped body, so its own length comes off the share.
    const overhead = quoted.label ? refence('', quoted.label).length : 0
    return carry(quoted, n === 1 ? max : Math.max(1, Math.floor(max / n) - overhead))
  })
  const reasoning = [accepted.action.reasoning ?? '', accepted.why ? `Critic: ${accepted.why}` : '']
    .filter(Boolean)
    .join('\n')
  return { ok: true, result: blocks.join('\n'), reasoning }
}

/** Short excerpt of one match: its first characters, one line. */
const EXCERPT_CHARS = 200

function extractRetriever(events: ContextEvent[], max: number): Extracted {
  const found = events.find(
    (e) => e.type === 'tool_result' && (e.data as ToolResultEventData).tool === 'retriever',
  )
  const result = (found?.data as ToolResultEventData | undefined)?.result as
    RetrieverResult | undefined
  const matches = result?.matches ?? []
  if (matches.length === 0) {
    const errored = events.some((e) => e.type === 'error')
    return {
      ok: false,
      failure: errored ? 'retrieval failed' : 'no documents matched',
      text: errored ? lastErrorText(events, 'retrieval failed') : 'no documents matched',
    }
  }
  // The excerpts are unfenced one by one (a capped excerpt of a fenced chunk is
  // the header, not the chunk); the block goes back under the fence the hits came
  // in, once, so the filename in each line is inside it too. Each hit's fence
  // names its own document, and one fence cannot name several: the block keeps
  // the item id only when every hit arrived fenced and named the same one (each
  // line still names its `[doc …]` where the hit has a locator). A hit that
  // arrived unfenced names nothing, so the block names no item either.
  let label: FenceLabel | undefined
  let unlabelled = false
  const lines = matches.map((m) => {
    const where =
      m.docId !== undefined && m.startOffset !== undefined && m.endOffset !== undefined
        ? ` [doc ${m.docId}, chars ${m.startOffset}-${m.endOffset}]`
        : ''
    const parts = unspotlightParts(m.content)
    if (parts && parts.tool === 'retriever' && guards(parts.tool)) {
      if (!label) label = { tool: parts.tool, namespace: parts.namespace, item: parts.item }
      else if (label.item !== parts.item) label = { tool: label.tool, namespace: label.namespace }
    } else unlabelled = true
    const excerpt = (parts?.body ?? unspotlight(m.content))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, EXCERPT_CHARS)
    return `- ${m.source ?? m.id}${where}: ${excerpt}`
  })
  if (label && unlabelled) label = { tool: label.tool, namespace: label.namespace }
  const docs = new Set(matches.map((m) => m.docId ?? m.source ?? m.id)).size
  return {
    ok: true,
    result: carry({ body: lines.join('\n'), label }, max),
    reasoning: `${matches.length} match(es) across ${docs} document(s) from ${(result?.backends ?? []).join(', ') || 'no backends'}`,
  }
}

function extractPlanner(events: ContextEvent[], max: number): Extracted {
  const created = [...events]
    .reverse()
    .find((e) => e.type === 'plan_created' && (e.data as PlanCreatedEventData).plan !== undefined)
  const plan = (created?.data as PlanCreatedEventData | undefined)?.plan
  if (!plan?.plan?.trim()) {
    return {
      ok: false,
      failure: 'no plan was produced',
      text: lastErrorText(events, 'no plan was produced'),
    }
  }
  return { ok: true, result: capText(plan.plan, max), reasoning: '', planSteps: plan.n_steps }
}

/** Default extractor for a kind, over the committed events of the route's own
 *  (leaf) pattern. Every text field it returns is capped at `max` characters. */
export function extract(kind: RouteKind, events: ContextEvent[], max: number): Extracted {
  const found = ((): Extracted => {
    switch (kind) {
      case 'simpleLoop':
        return extractSimpleLoop(events, max)
      case 'actorCritic':
        return extractActorCritic(events, max)
      case 'retriever':
        return extractRetriever(events, max)
      case 'planner':
        return extractPlanner(events, max)
    }
  })()
  return found.ok
    ? { ...found, reasoning: capText(found.reasoning, max) }
    : { ...found, text: carryText(found.text, max) }
}

/** A failure's own text, treated like a quoted body: a tool error that arrived
 *  fenced keeps its closing line under the cap; any other text is just capped. */
export function carryText(text: string, max: number): string {
  const quoted = unfence(text)
  // Fences still inside the body mean the text EMBEDS several: stripping the outer one
  // would unbalance the count, so cap the text as it came and close what the cap cut.
  if (containsFence(quoted.body)) return closeCutFences(capText(text, max))
  return carry(quoted, max)
}

// ============================================================================
// Stats
// ============================================================================

/** Count a route's stats from its committed events. `events` are the route's
 *  whole committed slice (wrappers included); the kind's own events are those of
 *  `leafId`. */
export function computeStats(
  kind: RouteKind,
  events: ContextEvent[],
  leafId: string,
  wallMs: number,
): RouteStats {
  const own = events.filter((e) => e.patternId === leafId)
  const actions = own.filter((e) => e.type === 'controller_action')
  const lastAction = actions[actions.length - 1]?.data as ControllerActionEventData | undefined
  const errorEvents = own.filter((e) => e.type === 'error')
  const budget = errorEvents
    .map((e) => e.data as ErrorEventData)
    .find((d) => d.kind === 'budget_exhausted')
  const failedResults = own.filter(
    (e) => e.type === 'tool_result' && (e.data as ToolResultEventData).success === false,
  ).length
  const toolCalls = own.filter(
    (e) => e.type === 'tool_call' && (e.data as ToolCallEventData).tool !== EXPAND_TOOL_NAME,
  ).length
  const base = {
    kind,
    toolCalls,
    errors: errorEvents.length + (kind === 'retriever' ? 0 : failedResults),
    wallMs,
    hitBound: budget !== undefined,
  }
  switch (kind) {
    case 'simpleLoop':
    case 'actorCritic':
      return {
        ...base,
        used: actions.length,
        bound: lastAction?.maxTurns ?? budget?.maxTurns,
      }
    case 'retriever': {
      const result = (
        own.find((e) => e.type === 'tool_result')?.data as ToolResultEventData | undefined
      )?.result as RetrieverResult | undefined
      const matches = result?.matches ?? []
      return {
        ...base,
        matches: matches.length,
        documents: new Set(matches.map((m) => m.docId ?? m.source ?? m.id)).size,
        backends: result?.backends ?? [],
      }
    }
    case 'planner': {
      const plan = (
        own.find((e) => e.type === 'plan_created')?.data as PlanCreatedEventData | undefined
      )?.plan
      return { ...base, planSteps: plan?.n_steps }
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Wall time as a short phrase: whole seconds, or `<1s`. */
export function formatWall(ms: number): string {
  return ms < 1000 ? '<1s' : `${Math.round(ms / 1000)}s`
}

/** The parenthesised stats of one step line, e.g.
 *  `simpleLoop: 3 of 8 turns, 4 tool calls, 0 errors, 21s`. */
export function formatStats(s: RouteStats): string {
  const wall = formatWall(s.wallMs)
  switch (s.kind) {
    case 'simpleLoop':
    case 'actorCritic': {
      const unit = s.kind === 'simpleLoop' ? 'turn' : 'attempt'
      const used = s.bound !== undefined ? `${s.used ?? 0} of ${s.bound}` : `${s.used ?? 0}`
      const bound = s.hitBound ? `, hit its ${unit} bound` : ''
      return `${s.kind}: ${used} ${unit}s, ${plural(s.toolCalls, 'tool call')}, ${plural(s.errors, 'error')}, ${wall}${bound}`
    }
    case 'retriever':
      return `retriever: ${plural(s.matches ?? 0, 'match', 'matches')} in ${plural(s.documents ?? 0, 'document')} from ${(s.backends ?? []).join(', ') || 'no backends'}, ${plural(s.errors, 'error')}, ${wall}`
    case 'planner':
      return `plan: ${plural(s.planSteps ?? 0, 'step')}, ${wall}`
  }
}

// ============================================================================
// Rendering — the decision state and the child handoff
// ============================================================================

/** The marker that replaces the excess of a capped field. */
export function truncationMarker(omitted: number): string {
  return `…[truncated, ${omitted} more characters]`
}

/** Cap `text` at `max` characters, marking the excess. */
export function capText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + truncationMarker(text.length - max) : text
}

/** `1. info-retrieval — succeeded (simpleLoop: …)` — one line per iteration. */
export function stepLine(r: RouteOutput): string {
  const head = `${r.iteration}. ${r.route} — `
  return r.status === 'succeeded'
    ? `${head}succeeded (${formatStats(r.stats)})`
    : `${head}failed: ${r.failure ?? 'unknown'} (${formatStats(r.stats)})`
}

/** One full output block: `[route] <result>` plus its reasoning. */
export function resultBlock(r: RouteOutput): string {
  if (r.status === 'failed') {
    return `[${r.route}] failed: ${r.failure ?? 'unknown'}.${r.result ? ` Reason: ${asLine(r.result)}` : ''}`
  }
  // Carried bodies stay raw: their fences are what a reader (the pseudonymiser) splits on.
  const body =
    r.stats.kind === 'actorCritic' || r.stats.kind === 'retriever' ? r.result : asLine(r.result)
  return `[${r.route}] ${body}${r.reasoning ? `\n(reasoning: ${asLine(r.reasoning)})` : ''}`
}

/** Text no ingress fence bounds (a plan, a Return, reasoning, failure text) as
 *  ONE JSON string, so a newline in it cannot start a line that reads as the
 *  state's own structure: a `User:` turn, a step line, a heading. */
const asLine = (text: string): string => JSON.stringify(text)

/** The step list and the last `lastN` outputs — the block both the decisions
 *  model ("This turn so far" + "Latest results") and the next child (its handoff)
 *  read, from the same records. */
export function renderHandoff(records: readonly RouteOutput[], lastN: number): string {
  if (records.length === 0) return ''
  const latest = lastN > 0 ? records.slice(-lastN) : []
  return [
    'Steps so far:',
    ...records.map(stepLine),
    ...(latest.length > 0
      ? ['', 'Latest results (most recent last):', ...latest.map(resultBlock)]
      : []),
  ].join('\n')
}
