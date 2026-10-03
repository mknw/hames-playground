/**
 * EventView: the `fromLastN` ViewConfig scope and the serializers' per-type
 * formatting — paths the app-side event-view suites do not reach (#407).
 *
 * Each test names the source mutation that reddens it; every one was run.
 * `fromLastNPatterns`' empty guard has no test: `fromPatterns([])` already
 * matches nothing, so removing the guard changes no output, and a test of it
 * was deleted when no mutation could redden it.
 */

import { describe, expect, it } from 'vitest'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import type { ContextEvent, EventType, UnifiedContext } from '@hames-ai/harness-patterns/types'

let seq = 0
function ev(type: EventType, patternId: string, data: unknown, ts = ++seq): ContextEvent {
  return { id: `e${seq}`, type, ts, patternId, data }
}

function ctxOf(events: ContextEvent[]): UnifiedContext {
  return { sessionId: 's', createdAt: 0, events, status: 'running', data: {}, input: '' }
}

const ids = (events: ContextEvent[]) => events.map((e) => e.patternId)

// A pattern is known to a view by its `pattern_enter` event.
describe('ViewConfig.fromLastN', () => {
  const events = [
    ev('pattern_enter', 'a', { pattern: 'a' }),
    ev('pattern_enter', 'b', { pattern: 'b' }),
    ev('pattern_enter', 'c', { pattern: 'c' }),
    ev('pattern_enter', 'self', { pattern: 'self' }),
  ]

  // Mutation: drop the `selfPatternId` exclusion in `applyConfig` (always
  // `this.getPatternIds()`) → `self` is one of the last two, so `b` is lost.
  it('shows the last N patterns, excluding the view owner', () => {
    const view = createEventView(ctxOf(events), { fromLastN: 2 }, 'self')
    expect(ids(view.get())).toEqual(['b', 'c'])
  })

  // Mutation: replace the empty-set `() => false` with no filter at all →
  // with no other pattern to show, the owner's own events leak through.
  it('shows nothing when the owner is the only pattern', () => {
    const view = createEventView(ctxOf([events[3]]), { fromLastN: 2 }, 'self')
    expect(view.get()).toEqual([])
  })
})

describe('serialize formatting', () => {
  // Mutation: in `formatEventData`, drop the `tool_call` case → the call is
  // rendered as its whole JSON payload instead of `tool: args`.
  it('renders a tool_call as `tool: args`', () => {
    const view = createEventView(
      ctxOf([ev('tool_call', 'p', { tool: 'read', args: { path: '/x' } })]),
      {
        fromLast: false,
      },
    )
    expect(view.serialize()).toBe('<tool_call>read: {"path":"/x"}</tool_call>')
  })

  // Mutation: in the `content_sanitized` case, always append ` [${rules}]` →
  // a finding-less event renders a dangling ` []`.
  it('renders a content_sanitized event with no findings as its head alone', () => {
    const view = createEventView(
      ctxOf([ev('content_sanitized', 'p', { namespace: 'web', tool: 'fetch', findings: [] })]),
      { fromLast: false },
    )
    expect(view.serialize()).toBe(
      '<content_sanitized>web/fetch: 0 finding(s) neutralized</content_sanitized>',
    )
  })

  // #420. A warning's `error` is the failed describe call's message verbatim,
  // and a describe call is handed tool results verbatim — a parse failure can
  // quote them back. Mutation: delete the `warning` case (fall through to the
  // default JSON dump) → the raw error reaches the serialized view.
  it('renders a warning from its task and message only, never its raw error', () => {
    const view = createEventView(
      ctxOf([
        ev('warning', 'compactBulkData', {
          task: 'result_summaries',
          message: "None of this turn's 2 tool results could be summarized.",
          fallback: 'Later turns see their raw output in place of a summary.',
          error: 'BamlValidationError: <tool result text the model echoed>',
        }),
      ]),
      { fromLast: false },
    )
    expect(view.serialize()).toBe(
      "<warning>result_summaries: None of this turn's 2 tool results could be summarized.</warning>",
    )
  })

  // Mutation: in the default case, always `JSON.stringify(event.data)` → a
  // bare string payload is rendered with its quotes.
  it('renders a non-object payload of an unformatted type as plain text', () => {
    const view = createEventView(ctxOf([ev('pattern_exit', 'p', 'done')]), { fromLast: false })
    expect(view.serialize()).toBe('<pattern_exit>done</pattern_exit>')
  })
})

describe('serializeCompact pointers', () => {
  // Older turn: the tool_results below sit before the last user_message, so
  // they render as compact pointers.
  const older = (data: Record<string, unknown>) => [
    ev('user_message', 'h', { content: 'q1' }),
    ev('tool_result', 'p', { tool: 't', success: true, ...data }),
    ev('user_message', 'h', { content: 'q2' }),
  ]

  // Mutation: drop the `...` suffix (`const suffix = ''`) → a truncated
  // preview no longer says it was truncated.
  it('marks a truncated raw preview with an ellipsis and the full length', () => {
    const view = createEventView(ctxOf(older({ result: 'z'.repeat(130) })), { fromLast: false })
    const pointer = view.serializeCompact().split('\n')[1]
    expect(pointer).toContain(`>${'z'.repeat(120)}... (130 chars)`)
  })

  // Mutation: prefer the raw slice over the summary (`resultStr.slice(...)
  // ?? data.summary`) → the pointer shows raw data instead of the summary.
  it('prefers the summary, with no ellipsis', () => {
    const view = createEventView(ctxOf(older({ result: 'z'.repeat(130), summary: 'short' })), {
      fromLast: false,
    })
    const pointer = view.serializeCompact().split('\n')[1]
    expect(pointer).toContain('>short (130 chars)')
  })
})

// #420: `compactExecution` hands `hasErrors()` / `lastError()` to the
// synthesizer, which then apologises in the answer. A side task's warning must
// never reach that — it is a separate TYPE so no error reader can match it.
describe('error readers do not see warnings (#420)', () => {
  // Mutation: make `errors()` select `['error', 'warning']` → reds.
  it('a view holding only a warning has no errors', () => {
    const view = createEventView(
      ctxOf([
        ev('user_message', 'h', { content: 'q' }),
        ev('warning', 'p', { task: 'intent_compaction', message: 'm', fallback: 'f', error: 'x' }),
      ]),
      { fromLast: false },
    )
    expect(view.hasErrors()).toBe(false)
    expect(view.lastError()).toBeUndefined()
  })
})
