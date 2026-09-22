/**
 * findLastUserMessageIndex — the turn boundary in the accumulated event
 * stream.
 *
 * The helper lives in core now (`packages/harness-patterns/content-transforms`,
 * beside the other event lenses — #225 @hames-ai/agents PR-2): the citation
 * extractor moved into `@hames-ai/agents` and reads it from there, and the app's
 * Data Stash partition reads the same core export, so they cannot disagree
 * (SA-H7). This file covers the helper wherever it is imported from.
 */
import { describe, it, expect } from 'vitest'
import { findLastUserMessageIndex } from '@hames-ai/harness-patterns/content-transforms'
import type { ContextEvent } from '@hames-ai/harness-patterns'

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
