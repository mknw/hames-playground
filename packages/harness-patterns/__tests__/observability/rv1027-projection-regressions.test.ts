import { describe, expect, it } from 'vitest'
import { createContext, createScope } from '../../context.server'
import { createEventView } from '../../patterns/event-view.server'
import { retriever } from '../../patterns/retriever.server'
import { evaluateDecision } from '../../patterns/typedDecision.server'
import { buildTimelineSections, sectionSummary } from '../../observability/projection'
import type { ContextEvent, DecideFn } from '../../types'

describe('rv1027 production event projection regressions', () => {
  it('folds consecutive real retrieval results without requiring a controller action', async () => {
    const pattern = retriever<Record<string, unknown>>({
      patternId: 'read-documents',
      backends: [{ name: 'stash', type: 'vector', search: async () => [] }],
      generateQuery: false,
      rewrite: async () => ({ value: 'unused' }),
    })
    const context = createContext('find the document')
    const view = createEventView(context, undefined, 'read-documents')
    const scope = createScope<Record<string, unknown>>('read-documents', {})
    await pattern.fn(scope, view)
    await pattern.fn(scope, view)

    expect(scope.events.map((event) => event.type)).toEqual(['tool_result', 'tool_result'])
    expect(scope.events.map((event) => (event.data as { tool: string }).tool)).toEqual([
      'retriever',
      'retriever',
    ])
    const sections = buildTimelineSections(scope.events)
    expect(sections).toHaveLength(1)
    expect(sections[0].kind).not.toBe('single')
    if (sections[0].kind !== 'single') expect(sections[0].items).toHaveLength(2)
  })

  it.each([undefined, 'choice'] as const)(
    'shows the chosen route probability from a real choice decision (type %s)',
    async (type) => {
      const decide: DecideFn = async <L extends string>() => ({
        probs: { docs: 0.25, web: 0.75 } as Record<L, number>,
        method: 'jev',
        calibrated: true,
      })
      const { event } = await evaluateDecision({
        decide,
        state: 'a routing state',
        spec: {
          ...(type ? { type } : {}),
          key: 'router.route',
          question: 'Which route?',
          labels: [
            { id: 'docs', description: 'documents' },
            { id: 'web', description: 'web' },
          ],
        },
      })
      expect(event.type).toBeUndefined()
      expect(event.probs.web).toBe(0.75)
      const events: ContextEvent[] = [0, 1].map((ts) => ({
        type: 'decision_made',
        patternId: 'router',
        ts,
        data: event,
      }))
      const [section] = buildTimelineSections(events)
      expect(section.kind).toBe('pattern')
      if (section.kind === 'single') throw new Error('expected a grouped decision')
      expect(sectionSummary(section)).toBe('2 decisions · web (p=0.75)')
    },
  )
})
