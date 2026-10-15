import { describe, it, expect } from 'vitest'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import type {
  ConversationScenario,
  ConversationTrace,
} from '../../../lib/eval-support/conversation'
import { grade } from '../../../lib/eval-support/conversation-checks'

const event = (type: string, data: unknown) => ({ type, data }) as ContextEvent
const scenario: ConversationScenario = {
  id: 'fixture',
  title: 'Fixture',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: ['Count and create a report', 'Read it back'],
  expectedTools: ['read_neo4j_cypher', 'sandbox_bash'],
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['42'],
  artifacts: ['analysis.md'],
  forbiddenTools: ['write_neo4j_cypher'],
  maxIterations: 6,
  indexed: 'analysis.md',
  citation: 'analysis.md',
}
const decision = (label: string) =>
  event('decision_made', { label, labels: [{ id: 'answer' }], abstained: false })
const successful = (): ConversationTrace => ({
  turns: [
    {
      response: 'Created analysis.md; graph is read-only',
      status: 'running',
      events: [decision('office-data'), decision('answer')],
    },
    {
      response: '42 [analysis.md](stash://fixture/analysis.md); graph is read-only',
      status: 'running',
      events: [
        decision('read-documents'),
        decision('answer'),
        event('tool_result', {
          result: {
            references: [
              { source: 'analysis.md', docId: 'fixture-analysis', startOffset: 0, endOffset: 10 },
            ],
          },
        }),
      ],
    },
  ],
  tools: [
    { name: 'read_neo4j_cypher', args: {}, success: true, turn: 0 },
    { name: 'sandbox_bash', args: {}, success: true, turn: 0 },
  ],
  artifacts: ['analysis.md'],
  indexed: ['analysis.md'],
  retrievals: [{ source: 'analysis.md', turn: 1 }],
})
const failed = (trace: ConversationTrace, s = scenario) =>
  grade(s, trace, false)
    .filter((c) => !c.pass)
    .map((c) => c.name)

describe('conversation checks discriminate trace changes', () => {
  it('passes a complete trace and treats current general as a separate baseline', () => {
    expect(failed(successful())).toEqual([])
    expect(
      grade({ ...scenario, expectedRoutes: ['unused'] }, successful(), true).every((c) => c.pass),
    ).toBe(true)
  })
  it('fails a missing or unsuccessful tool and wrong ordering', () => {
    const t = successful()
    t.tools.reverse()
    expect(failed(t)).toContain('successful ordered tool: sandbox_bash')
    t.tools = []
    expect(failed(t)).toContain('successful ordered tool: read_neo4j_cypher')
  })
  it('fails a forbidden write, missing artifact, or missing index', () => {
    const t = successful()
    t.tools.push({ name: 'write_neo4j_cypher', args: {}, success: true, turn: 1 })
    t.artifacts = []
    t.indexed = []
    t.retrievals = []
    expect(failed(t)).toEqual(
      expect.arrayContaining([
        'no write_neo4j_cypher',
        'stash artifact: analysis.md',
        'markdown index exists',
        'later turn queried the new index',
      ]),
    )
  })
  it('requires an actual later retrieval instead of merely indexing', () => {
    const t = successful()
    t.retrievals[0].turn = 0
    expect(failed(t)).toContain('later turn queried the new index')
  })
  it('requires both a visible answer citation and a source locator', () => {
    const t = successful()
    t.turns[1].response = '42; graph is read-only'
    expect(failed(t)).toContain('document citation has a locator')
    t.turns[1].response = '42 [analysis.md](stash://fixture/analysis.md); graph is read-only'
    t.turns[1].events = [
      event('tool_result', { result: { references: [{ source: 'analysis.md' }] } }),
    ]
    expect(failed(t)).toContain('document citation has a locator')
  })
  it('fails a missing answer choice, missing route, iteration overflow, or abstained choice', () => {
    const t = successful()
    t.turns[0].events = Array.from({ length: 7 }, () => decision('answer'))
    t.turns[1].events = []
    expect(failed(t)).toEqual(
      expect.arrayContaining([
        'route selected: office-data',
        'turn 1: answer within 6 decisions',
        'turn 2: answer within 6 decisions',
      ]),
    )
  })
  it('fails a truncated conversation, empty response or failed final status', () => {
    const t = successful()
    t.turns = [{ response: '', status: 'error', events: [] }]
    expect(failed(t)).toEqual(
      expect.arrayContaining([
        'every user turn ran',
        'every turn has a response',
        'final turn completed',
      ]),
    )
    t.turns = []
    expect(failed(t)).toContain('final turn completed')
  })
  it('requires both the failed first attempt and successful second lookup', () => {
    const s = { ...scenario, failFirstTurn: true }
    const t = successful()
    expect(failed(t, s)).toEqual(
      expect.arrayContaining([
        'first turn recorded a tool failure',
        'retry made a fresh successful lookup',
      ]),
    )
    t.turns[0].response = 'Lookup failed; no count is known'
    t.tools.push(
      { name: 'read_neo4j_cypher', args: {}, success: false, turn: 0 },
      { name: 'read_neo4j_cypher', args: {}, success: true, turn: 1 },
    )
    t.turns[0].response = 'Lookup failed; no count is known'
    expect(failed(t, s)).toEqual([])
  })
  it('checks facts on every specified turn and rejects needless tools', () => {
    const t = successful()
    const s = { ...scenario, noTools: true, turnAnswerIncludes: [['missing'], ['42']] }
    expect(failed(t, s)).toEqual(
      expect.arrayContaining(['answers without tools', 'turn 1: answer contains missing']),
    )
    t.tools = []
    expect(
      failed(t, { ...s, expectedTools: [], turnAnswerIncludes: [['Created'], ['42']] }),
    ).toEqual([])
  })
  it('ignores unstructured data rather than manufacturing a reference or decision', () => {
    const t = successful()
    t.turns[1].events = [event('tool_result', null), event('decision_made', 'answer')]
    expect(failed(t)).toContain('document citation has a locator')
  })
})
