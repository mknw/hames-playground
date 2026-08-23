/**
 * turn-utils — the turn boundary in the accumulated event stream.
 *
 * `splitIntoTurns` / `extractTurnGraphElements` are exercised through the Turn
 * Explorer in `AllGraphTab.test.tsx`. What is covered here is
 * `findLastUserMessageIndex`, which became a shared export for SA-H7: the Data
 * Stash partition and the citation extractor both derive "this turn" from it,
 * and they must not disagree.
 */
import { describe, it, expect } from 'vitest'
import { findLastUserMessageIndex } from '~/lib/turn-utils'
import type { ContextEvent } from '~/lib/harness-patterns'

const evt = (type: ContextEvent['type']): ContextEvent =>
  ({ type, ts: 1, patternId: 'harness', data: {} }) as unknown as ContextEvent

describe('findLastUserMessageIndex', () => {
  it('returns -1 for an empty stream', () => {
    expect(findLastUserMessageIndex([])).toBe(-1)
  })

  it('returns -1 when no user_message has been recorded', () => {
    // A replayed partial context, or an action-triggered run.
    expect(findLastUserMessageIndex([evt('tool_call'), evt('tool_result')])).toBe(-1)
  })

  it('finds the only user_message', () => {
    expect(findLastUserMessageIndex([evt('user_message'), evt('tool_call')])).toBe(0)
  })

  it('finds the LAST one, not the first', () => {
    const events = [
      evt('user_message'),
      evt('tool_result'),
      evt('assistant_message'),
      evt('user_message'),
      evt('tool_call'),
    ]
    expect(findLastUserMessageIndex(events)).toBe(3)
  })

  it('returns the final index when the turn has only just started', () => {
    const events = [evt('user_message'), evt('tool_call'), evt('user_message')]
    expect(findLastUserMessageIndex(events)).toBe(2)
  })
})
