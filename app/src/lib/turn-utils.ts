/**
 * Turn Utilities
 *
 * Where "this turn" starts in an accumulated ContextEvent stream.
 *
 * The per-turn graph derivation that used to live here (`splitIntoTurns`,
 * `extractTurnGraphElements`, `extractMultiTurnGraphElements`, `TurnData`) had
 * exactly one consumer, the right panel's "All" tab, and went with it.
 */

import type { ContextEvent } from '~/lib/harness-patterns'

/**
 * Index of the most recent `user_message` in the stream, or -1 when there is
 * none. This is the turn boundary: everything after it belongs to the current
 * turn. Shared so the Data Stash partition and the citation extractor agree on
 * where "this turn" starts (SA-H7).
 */
export function findLastUserMessageIndex(events: ContextEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') return i
  }
  return -1
}
