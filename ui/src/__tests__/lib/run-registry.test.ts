/**
 * run-registry — concurrency policy for multi-active sessions (#105 slice 2).
 *
 * The cap is a client-side policy: N conversations may stream at once, and at
 * the cap a send into an idle conversation is refused rather than queued or
 * allowed to interrupt a running one.
 */

import { describe, it, expect } from 'vitest'
import {
  countRunning,
  isAtConcurrencyCap,
  capReachedMessage,
  type SessionRunState,
} from '../../lib/run-registry'

const running = (): SessionRunState => ({ isProcessing: true, runningTool: null })
const idle = (): SessionRunState => ({ isProcessing: false, runningTool: null })

describe('countRunning', () => {
  it('counts only sessions with a stream open', () => {
    expect(
      countRunning({ a: running(), b: idle(), c: running() }),
    ).toBe(2)
  })

  it('is 0 for an empty registry', () => {
    expect(countRunning({})).toBe(0)
  })
})

describe('isAtConcurrencyCap', () => {
  it('allows a new run below the cap', () => {
    expect(
      isAtConcurrencyCap({ runningCount: 2, cap: 3, thisSessionRunning: false }),
    ).toBe(false)
  })

  it('blocks a new run once the cap is reached', () => {
    expect(
      isAtConcurrencyCap({ runningCount: 3, cap: 3, thisSessionRunning: false }),
    ).toBe(true)
  })

  it('blocks when somehow over the cap', () => {
    expect(
      isAtConcurrencyCap({ runningCount: 5, cap: 3, thisSessionRunning: false }),
    ).toBe(true)
  })

  // The session already streaming is blocked by `isProcessing`, not the cap.
  // Counting it here would refuse a turn that costs no extra concurrency and
  // would show the wrong banner ("max 3 reached" instead of "waiting for…").
  it('never reports the cap for a session that is itself running', () => {
    expect(
      isAtConcurrencyCap({ runningCount: 3, cap: 3, thisSessionRunning: true }),
    ).toBe(false)
  })

  // A corrupted localStorage value must not lock the user out of sending.
  it('treats a non-positive or non-finite cap as no cap', () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        isAtConcurrencyCap({ runningCount: 99, cap, thisSessionRunning: false }),
      ).toBe(false)
    }
  })

  it('supports a cap of 1 (serial behaviour)', () => {
    expect(
      isAtConcurrencyCap({ runningCount: 1, cap: 1, thisSessionRunning: false }),
    ).toBe(true)
    expect(
      isAtConcurrencyCap({ runningCount: 0, cap: 1, thisSessionRunning: false }),
    ).toBe(false)
  })
})

describe('capReachedMessage', () => {
  it('names the cap so the banner matches the configured value', () => {
    expect(capReachedMessage(3)).toBe('max 3 reached — wait for a session to stop')
    expect(capReachedMessage(5)).toContain('max 5')
  })
})
