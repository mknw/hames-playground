/**
 * Live Event emission (server-only).
 *
 * Lets `trackEvent()` forward events to a listener as they happen, instead of
 * waiting for the pattern to commit.
 *
 * Patterns opt in via `PatternConfig.liveEvents = true`. The chain runner
 * toggles `setLivePatternEnabled()` per pattern; `emitLive()` is a no-op unless
 * both the listener exists and the current pattern is enabled.
 *
 * Events emitted live are tracked in `emittedIds` so that the post-commit
 * emission in `runChain` can skip them and avoid duplicates downstream.
 *
 * The listener and that id set live in the run frame's `live` slot
 * (`run-frame.server.ts`); the scope this module used to own
 * (`runWithLiveListener`) is gone. All three readers below take the SOFT read:
 * emission outside a run is a no-op exactly as it always was, and the refusal
 * that stops a run happening without a frame belongs at the run boundary.
 */
import { assertServerOnImport } from './assert.server'
import { currentRunFrame } from './run-frame.server'
import type { ContextEvent } from './types'

assertServerOnImport()

export type { LiveEventListener } from './run-frame.server'

/** Toggle whether the current pattern's events stream live. */
export function setLivePatternEnabled(enabled: boolean): void {
  const slot = currentRunFrame()?.live
  if (slot) slot.enabled = enabled
}

/**
 * Emit an event live if the current frame is enabled.
 * Returns true when the listener was invoked, false otherwise.
 */
export function emitLive(event: ContextEvent): boolean {
  const slot = currentRunFrame()?.live
  if (!slot || !slot.enabled) return false
  slot.listener(event)
  if (event.id) slot.emittedIds.add(event.id)
  return true
}

/** Has this event already been delivered to the listener? */
export function wasEmittedLive(event: ContextEvent): boolean {
  const slot = currentRunFrame()?.live
  if (!slot || !event.id) return false
  return slot.emittedIds.has(event.id)
}
