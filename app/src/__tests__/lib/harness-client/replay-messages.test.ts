/**
 * replayMessages — chat-history hydration filter.
 *
 * Verifies that on conversation restore (sidebar selection), intermediate
 * router status messages ("Let me look into that…") are excluded and only
 * the compactExecution's (or direct-response router's) final emit surfaces as a
 * chat bubble. Discriminator: `AssistantMessageEventData.final === true`.
 */
import { describe, it, expect } from 'vitest'
import { replayMessages, errorBubble } from '../../../lib/harness-client/replay'
import type { ContextEvent, ErrorEventData } from '../../../lib/harness-patterns'

const userMsg = (content: string, ts: number, id: string): ContextEvent => ({
  id,
  type: 'user_message',
  ts,
  patternId: 'harness',
  data: { content },
})

const assistantMsg = (content: string, ts: number, id: string, opts?: { final?: boolean; patternId?: string }): ContextEvent => ({
  id,
  type: 'assistant_message',
  ts,
  patternId: opts?.patternId ?? 'router',
  data: { content, ...(opts?.final !== undefined ? { final: opts.final } : {}) },
})

const wrap = (events: ContextEvent[]) => JSON.stringify({ events })

describe('replayMessages', () => {
  it('returns [] for non-JSON input', () => {
    expect(replayMessages('not json')).toEqual([])
  })

  it('returns [] when context has no events', () => {
    expect(replayMessages(JSON.stringify({ events: [] }))).toEqual([])
    expect(replayMessages(JSON.stringify({}))).toEqual([])
  })

  it('keeps all user messages', () => {
    const out = replayMessages(wrap([
      userMsg('first', 1, 'u1'),
      userMsg('second', 2, 'u2'),
    ]))
    expect(out.map(m => m.content)).toEqual(['first', 'second'])
    expect(out.every(m => m.role === 'user')).toBe(true)
  })

  it('skips assistant_message events without final: true (router status)', () => {
    const out = replayMessages(wrap([
      userMsg('hi', 1, 'u1'),
      assistantMsg('Let me look into that…', 2, 'a1', { patternId: 'router' }),
      assistantMsg('Looking into the graph…', 3, 'a2', { patternId: 'router' }),
    ]))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('keeps assistant_message events with final: true (compactExecution output)', () => {
    const out = replayMessages(wrap([
      userMsg('hi', 1, 'u1'),
      assistantMsg('Looking…', 2, 'a1', { patternId: 'router' }),                          // intermediate, skipped
      assistantMsg('Here is the answer.', 3, 'a2', { final: true, patternId: 'response-synth' }),  // final, kept
    ]))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(out[1]).toMatchObject({ role: 'assistant', content: 'Here is the answer.' })
  })

  it('handles a multi-turn conversation with mixed router + compactExecution emits', () => {
    const out = replayMessages(wrap([
      userMsg('q1', 1, 'u1'),
      assistantMsg('Routing…', 2, 'r1', { patternId: 'router' }),
      assistantMsg('A1.', 3, 's1', { final: true, patternId: 'response-synth' }),
      userMsg('q2', 4, 'u2'),
      assistantMsg('Routing…', 5, 'r2', { patternId: 'router' }),
      assistantMsg('A2.', 6, 's2', { final: true, patternId: 'response-synth' }),
    ]))
    expect(out.map(m => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'A1.' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'A2.' },
    ])
  })

  it('keeps the router-as-final emit on a conversational direct-response turn', () => {
    // When the router decides no tool is needed, it emits the final response
    // itself (final: true) and the compactExecution skips BAML for that route.
    const out = replayMessages(wrap([
      userMsg('what time is it?', 1, 'u1'),
      assistantMsg("I don't have realtime access.", 2, 'r1', { final: true, patternId: 'router' }),
    ]))
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ role: 'assistant', content: "I don't have realtime access." })
  })

  it('preserves event ordering by array position', () => {
    const out = replayMessages(wrap([
      userMsg('q1', 1, 'u1'),
      assistantMsg('A1.', 3, 's1', { final: true }),
      userMsg('q2', 2, 'u2'), // intentionally out-of-order ts to confirm we keep array order
    ]))
    expect(out.map(m => m.timestamp)).toEqual([1, 3, 2])
  })

  it('falls back to a synthetic id when an event lacks one', () => {
    const out = replayMessages(wrap([
      { ...userMsg('hi', 1, ''), id: undefined } as ContextEvent,
    ]))
    expect(out[0].id).toMatch(/^replay-\d+$/)
  })
})

/**
 * Error/warning bubbles must survive a reload.
 *
 * `error` events are tracked regardless of `trackHistory`, so a persisted
 * context always carries them — but replay had no error branch and
 * `ReplayedMessage.role` could not even express 'warning'. The live stream
 * synthesized the amber bubble in the browser (`ChatInterface`), so leaving the
 * thread and coming back silently dropped it: the run looked cleaner than it
 * was. `errorBubble` is now the single presentation, shared by both paths.
 */
describe('error and warning bubbles', () => {
  // Verbatim from a live export (context-13980bb0…, the maxTurns-exhausted run)
  // minus `stack` — the shape this has to survive is a real one, not invented.
  const EXHAUSTED: ErrorEventData = {
    hint: 'The controller may have needed more turns to finish. Consider increasing maxToolTurns in settings, or simplifying the task.',
    turn: 4,
    error: "Loop exhausted: reached maxTurns (5) without 'Return' or is_final from the controller. Partial results from 5 completed turn(s) are preserved.",
    severity: 'recoverable',
  }

  const errorEvt = (data: ErrorEventData, ts: number, id: string, patternId = 'neo4j-query'): ContextEvent => ({
    id, type: 'error', ts, patternId, data,
  })

  describe('errorBubble', () => {
    it('maps a recoverable error to a warning, with a 1-indexed turn label', () => {
      // The event stores turn 4 (0-indexed); the user saw "turn 5".
      expect(errorBubble(EXHAUSTED)).toEqual({
        role: 'warning',
        content: EXHAUSTED.error,
        hint: EXHAUSTED.hint,
        turnInfo: '(turn 5)',
      })
    })

    it('treats a missing or irrecoverable severity as a terminal error', () => {
      // Absent severity must stay loud rather than be downgraded to a warning.
      expect(errorBubble({ error: 'boom' }).role).toBe('error')
      expect(errorBubble({ error: 'boom', severity: 'irrecoverable' }).role).toBe('error')
    })

    it('combines turn and iteration for actorCritic', () => {
      expect(errorBubble({ error: 'x', turn: 2, iteration: 1 }).turnInfo).toBe('(turn 3, attempt 2)')
    })

    it('omits turnInfo and hint entirely when the event carries neither', () => {
      // Absent, not undefined-valued — these spread into a Message.
      expect(Object.keys(errorBubble({ error: 'x' })).sort()).toEqual(['content', 'role'])
    })
  })

  it('replays a persisted warning in place, between the turns around it', () => {
    const out = replayMessages(wrap([
      userMsg('What are the cliques in the neo4j graph?', 1, 'u1'),
      errorEvt(EXHAUSTED, 2, 'ev-3m8fcc'),
      assistantMsg("## Heads up: this query didn't fully complete", 3, 's1', { final: true }),
    ]))

    expect(out.map((m) => m.role)).toEqual(['user', 'warning', 'assistant'])
    expect(out[1]).toEqual({
      id: 'ev-3m8fcc',
      role: 'warning',
      content: EXHAUSTED.error,
      timestamp: 2,
      patternId: 'neo4j-query',
      hint: EXHAUSTED.hint,
      turnInfo: '(turn 5)',
    })
  })

  it('replays one bubble per error event, as the live stream paints them', () => {
    const out = replayMessages(wrap([
      userMsg('q', 1, 'u1'),
      errorEvt({ error: 'first', severity: 'recoverable', turn: 0 }, 2, 'e1'),
      errorEvt({ error: 'second', severity: 'recoverable', turn: 2 }, 3, 'e2'),
      assistantMsg('done', 4, 's1', { final: true }),
    ]))
    expect(out.filter((m) => m.role === 'warning').map((m) => m.content)).toEqual(['first', 'second'])
  })

  it('carries the fields the renderer needs — the gap that hid the bubble', () => {
    // ChatMessages renders hint/patternId/turnInfo for error+warning roles. The
    // hydration map in ChatInterface used to re-list four fields and drop these.
    const [bubble] = replayMessages(wrap([errorEvt(EXHAUSTED, 1, 'e1')]))
    for (const field of ['hint', 'patternId', 'turnInfo'] as const) {
      expect(bubble[field], `${field} must survive replay`).toBeTruthy()
    }
  })
})
