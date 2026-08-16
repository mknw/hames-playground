/**
 * withReferences — Canonical Selection Cases (Eval Suite)
 *
 * Documents the expected selector behavior on the canonical cases from the
 * design doc (docs/harness-patterns/with-references.md §9). Each case sets
 * up a realistic event stash + intent, swaps in a deterministic fixture
 * `selector` (so the test is fast and doesn't need API keys), and asserts
 * the wrapper attaches the canonically-correct refs.
 *
 * The fixture selectors mirror the rules the real `b.ReferenceSelector`
 * prompt is meant to produce. To re-run against the live LLM:
 *   1) Remove the `selector:` config from each case
 *   2) Unmock the baml_client import below
 *   3) Run with `RUN_EVALS=1 pnpm test:run`
 *
 * These cases ALSO validate that the wrapper's pre-selection filtering
 * (scope, hidden/archived, success) feeds the selector the right candidate
 * set — independent of which model is in use.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  ContextEvent,
  PatternScope,
  SelectorFn,
  ToolResultEventData,
  ConfiguredPattern
} from '../../../lib/harness-patterns/types'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Stub the BAML client — these eval tests use custom `selector` configs,
// so the default selector is never actually called. Mocking it just keeps
// the import graph happy under vi.
vi.mock('../../../../baml_client', () => ({
  b: {
    ReferenceSelector: vi.fn(async () => ({ reasoning: 'mocked', selected: [] }))
  }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolResultEvent(opts: {
  id: string
  patternId: string
  tool: string
  result: unknown
  summary?: string
  ts?: number
  hidden?: boolean
  archived?: boolean
  success?: boolean
}): ContextEvent {
  return {
    id: opts.id,
    type: 'tool_result',
    ts: opts.ts ?? Date.now(),
    patternId: opts.patternId,
    data: {
      tool: opts.tool,
      result: opts.result,
      success: opts.success ?? true,
      summary: opts.summary,
      hidden: opts.hidden,
      archived: opts.archived
    } satisfies ToolResultEventData
  }
}

function userMessageEvent(content: string, ts = Date.now()): ContextEvent {
  return {
    id: `um-${ts}`,
    type: 'user_message',
    ts,
    patternId: 'harness',
    data: { content }
  }
}

function assistantMessageEvent(content: string, ts = Date.now()): ContextEvent {
  return {
    id: `am-${ts}`,
    type: 'assistant_message',
    ts,
    patternId: 'harness',
    data: { content }
  }
}

function makeInner(): { pattern: ConfiguredPattern<Record<string, unknown>>; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (s: PatternScope<Record<string, unknown>>) => s)
  return { pattern: { name: 'inner', fn, config: { patternId: 'inner' } }, fn }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('withReferences — canonical eval cases', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { __clearReferenceCache } = await import('../../../lib/harness-patterns/patterns/with-references.server')
    __clearReferenceCache()
  })

  it('postgres-18 (must select): "add this info to the graph" after web-search', async () => {
    const { withReferences } = await import('../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('add this info to the graph')
    ctx.events.push(userMessageEvent('search the web for postgres 18 release info', 1))
    ctx.events.push(assistantMessageEvent("Here's what I found about Postgres 18...", 2))
    ctx.events.push(toolResultEvent({
      id: 'ev-pg18', patternId: 'web-search', tool: 'fetch',
      result: 'Postgres 18 release notes: new features include...',
      summary: 'Postgres 18 release notes and feature overview', ts: 3
    }))
    ctx.events.push(userMessageEvent('add this info to the graph', 4))

    // Fixture mirrors what the real selector should produce: pg18 ref is
    // strongly relevant to "add this info to the graph" given the prior turn
    // returned exactly that information.
    const fixtureSelector: SelectorFn = async (input) => {
      const pg18 = input.candidates.find(c => c.summary.toLowerCase().includes('postgres'))
      return pg18
        ? { reasoning: 'pg18 ref directly answers "this info"', selected: [{ ref_id: pg18.ref_id, reason: 'subject of prior turn' }] }
        : { reasoning: 'no postgres candidate', selected: [] }
    }

    const inner = makeInner()
    const wrapped = withReferences(inner.pattern, { scope: 'global', selector: fixtureSelector, trackHistory: 'reference_attached' })
    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap-neo4j', data: { intent: 'add this info to the graph' }, events: [], startTime: Date.now()
    }

    await wrapped.fn(scope, createEventView(ctx))

    const attached = scope.data.attachedRefs as Array<{ ref_id: string }>
    expect(attached.map(r => r.ref_id)).toContain('ev-pg18')
  })

  it('conversational-unrelated: "thanks!" yields empty selection', async () => {
    const { withReferences } = await import('../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('thanks!')
    ctx.events.push(toolResultEvent({ id: 'ev-1', patternId: 'web-search', tool: 'fetch', result: 'X', summary: 'old web result', ts: 1 }))
    ctx.events.push(toolResultEvent({ id: 'ev-2', patternId: 'neo4j-query', tool: 'read_neo4j_cypher', result: 'Y', summary: 'old neo4j result', ts: 2 }))
    ctx.events.push(userMessageEvent('thanks!', 3))

    // Hard floor: when the intent is conversational, the selector returns [].
    const fixtureSelector: SelectorFn = async (input) => {
      const conversational = /^(thanks|thank you|hello|hi|ok|got it)\b/i.test(input.intent.trim())
      return conversational
        ? { reasoning: 'conversational intent', selected: [] }
        : { reasoning: 'fallback include all', selected: input.candidates.map(c => ({ ref_id: c.ref_id, reason: 'fallback' })) }
    }

    const inner = makeInner()
    const wrapped = withReferences(inner.pattern, { scope: 'global', selector: fixtureSelector, trackHistory: 'reference_attached' })
    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap', data: { intent: 'thanks!' }, events: [], startTime: Date.now()
    }

    await wrapped.fn(scope, createEventView(ctx))

    const attached = scope.data.attachedRefs as Array<{ ref_id: string }>
    expect(attached).toEqual([])
  })

  it('multiple-relevant: "summarize what we found" selects all 3 within budget', async () => {
    const { withReferences } = await import('../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('summarize what we found')
    ctx.events.push(toolResultEvent({ id: 'ev-w1', patternId: 'web-search', tool: 'fetch', result: 'A', summary: 'page about kubernetes networking', ts: 1 }))
    ctx.events.push(toolResultEvent({ id: 'ev-w2', patternId: 'web-search', tool: 'fetch', result: 'B', summary: 'page about kubernetes pod lifecycle', ts: 2 }))
    ctx.events.push(toolResultEvent({ id: 'ev-w3', patternId: 'web-search', tool: 'fetch', result: 'C', summary: 'page about kubernetes RBAC', ts: 3 }))
    ctx.events.push(userMessageEvent('summarize what we found', 4))

    const fixtureSelector: SelectorFn = async (input) => ({
      reasoning: 'all related to the same topic',
      selected: input.candidates.map(c => ({ ref_id: c.ref_id, reason: 'on-topic' }))
    })

    const inner = makeInner()
    const wrapped = withReferences(inner.pattern, { scope: 'global', maxRefs: 5, selector: fixtureSelector, trackHistory: 'reference_attached' })
    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap', data: { intent: 'summarize what we found' }, events: [], startTime: Date.now()
    }

    await wrapped.fn(scope, createEventView(ctx))

    const attached = scope.data.attachedRefs as Array<{ ref_id: string }>
    expect(attached.map(r => r.ref_id).sort()).toEqual(['ev-w1', 'ev-w2', 'ev-w3'])
  })

  it('scope=self: only own-pattern refs reach the selector regardless of relevance', async () => {
    const { withReferences } = await import('../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('list all Person nodes')
    ctx.events.push(toolResultEvent({ id: 'ev-web', patternId: 'web-search', tool: 'fetch', result: 'unrelated', summary: 'web page about Person schemas', ts: 1 }))
    ctx.events.push(toolResultEvent({ id: 'ev-neo-1', patternId: 'wrap-neo4j', tool: 'read_neo4j_cypher', result: 'rows', summary: 'prior neo4j Person query', ts: 2 }))
    ctx.events.push(toolResultEvent({ id: 'ev-neo-2', patternId: 'wrap-neo4j', tool: 'read_neo4j_cypher', result: 'rows', summary: 'prior neo4j relationship walk', ts: 3 }))
    ctx.events.push(userMessageEvent('list all Person nodes', 4))

    let observedCandidates: Array<{ ref_id: string }> = []
    const fixtureSelector: SelectorFn = async (input) => {
      observedCandidates = input.candidates
      return { reasoning: 'select all eligible', selected: input.candidates.map(c => ({ ref_id: c.ref_id, reason: 'on-topic' })) }
    }

    const inner = makeInner()
    const wrapped = withReferences(inner.pattern, { scope: 'self', selector: fixtureSelector, trackHistory: 'reference_attached' })
    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap-neo4j', data: { intent: 'list all Person nodes' }, events: [], startTime: Date.now()
    }

    await wrapped.fn(scope, createEventView(ctx))

    // Selector saw only the wrap-neo4j-tagged candidates — web ref was filtered out before selection.
    const ids = observedCandidates.map(c => c.ref_id).sort()
    expect(ids).toEqual(['ev-neo-1', 'ev-neo-2'])
    expect(ids).not.toContain('ev-web')
  })

  it('stale-on-topic: prefers more-recent items when relevance is similar', async () => {
    const { withReferences } = await import('../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const now = Date.now()
    const ctx = createContext<Record<string, unknown>>('list all Person nodes')
    // Same-topic-tagged refs, different ages. Selector ought to prefer the recent one within budget.
    ctx.events.push(toolResultEvent({ id: 'ev-old', patternId: 'wrap-neo4j', tool: 'read_neo4j_cypher', result: 'rows', summary: 'older neo4j result on Person', ts: now - 600_000 }))
    ctx.events.push(toolResultEvent({ id: 'ev-recent', patternId: 'wrap-neo4j', tool: 'read_neo4j_cypher', result: 'rows', summary: 'recent neo4j result on Person', ts: now - 5_000 }))
    ctx.events.push(userMessageEvent('list all Person nodes', now))

    // Soft expectation: selector prefers recency. We assert that *if* the
    // selector picks one, it picks the recent one — without requiring the
    // selector to pick anything (the design doc marks this case as a soft
    // expectation, not a hard floor).
    const fixtureSelector: SelectorFn = async (input) => {
      const sorted = [...input.candidates].sort((a, b) => b.ts - a.ts)
      return { reasoning: 'recency tie-break', selected: sorted.slice(0, 1).map(c => ({ ref_id: c.ref_id, reason: 'most recent on-topic' })) }
    }

    const inner = makeInner()
    const wrapped = withReferences(inner.pattern, { scope: 'self', maxRefs: 1, selector: fixtureSelector, trackHistory: 'reference_attached' })
    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap-neo4j', data: { intent: 'list all Person nodes' }, events: [], startTime: Date.now()
    }

    await wrapped.fn(scope, createEventView(ctx))

    const attached = scope.data.attachedRefs as Array<{ ref_id: string }>
    if (attached.length > 0) {
      expect(attached[0].ref_id).toBe('ev-recent')
    }
  })
})
