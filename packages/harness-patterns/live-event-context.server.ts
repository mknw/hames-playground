/**
 * Live Event Context (server-only).
 *
 * Provides an AsyncLocalStorage frame that lets `trackEvent()` forward events
 * to a listener as they happen, instead of waiting for the pattern to commit.
 *
 * Patterns opt in via `PatternConfig.liveEvents = true`. The chain runner
 * toggles `setLivePatternEnabled()` per pattern; `emitLive()` is a no-op
 * unless both the listener exists and the current pattern is enabled.
 *
 * Events emitted live are tracked in `emittedIds` so that the post-commit
 * emission in `runChain` can skip them and avoid duplicates downstream.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from './assert.server'
import type { ContextEvent } from './types'

assertServerOnImport()

export type LiveEventListener = (event: ContextEvent) => void

interface LiveEventFrame {
  listener: LiveEventListener
  emittedIds: Set<string>
  enabled: boolean
}

const store = new AsyncLocalStorage<LiveEventFrame>()

/**
 * Install a live-event listener for the duration of `fn`.
 * If `listener` is undefined, runs `fn` with no live emission active.
 */
export function runWithLiveListener<T>(
  listener: LiveEventListener | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!listener) return fn()
  const frame: LiveEventFrame = {
    listener,
    emittedIds: new Set<string>(),
    enabled: false
  }
  return store.run(frame, fn)
}

/** Toggle whether the current pattern's events stream live. */
export function setLivePatternEnabled(enabled: boolean): void {
  const frame = store.getStore()
  if (frame) frame.enabled = enabled
}

/**
 * Emit an event live if the current frame is enabled.
 * Returns true when the listener was invoked, false otherwise.
 */
export function emitLive(event: ContextEvent): boolean {
  const frame = store.getStore()
  if (!frame || !frame.enabled) return false
  frame.listener(event)
  if (event.id) frame.emittedIds.add(event.id)
  return true
}

/** Has this event already been delivered to the listener? */
export function wasEmittedLive(event: ContextEvent): boolean {
  const frame = store.getStore()
  if (!frame || !event.id) return false
  return frame.emittedIds.has(event.id)
}

/** Test helper — clear the emitted-id set within the current frame. */
export function _resetEmittedIdsForTest(): void {
  const frame = store.getStore()
  if (frame) frame.emittedIds.clear()
}
