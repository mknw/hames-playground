/**
 * When the Sandbox tab blinks (#415) — client-safe, pure.
 *
 * Owner decision (2026-10-02): the tab "blinks twice when a sandbox is
 * entered". The blink is the `sandbox-tab-blink` preflight class
 * (`uno.config.ts`: one 1.2s run of two pulses, motionless under
 * `prefers-reduced-motion`); this module decides when `SupportPanel` applies
 * it, and for how long.
 */
import type { ContextEvent } from '@hames-ai/harness-patterns'

/** How long the tab carries the class: one run of the keyframes, mirrored by
 *  the animation duration in `uno.config.ts` (`uno-theme.test.ts` pins both). */
export const SANDBOX_BLINK_MS = 1_200

/** How recent a sandbox entry must be to count as happening NOW. Events
 *  replayed from a stored conversation are older than this, so opening an old
 *  sandbox conversation does not blink; a live one always is. Generous, so a
 *  server clock a little ahead of or behind the browser's still counts. */
export const SANDBOX_BLINK_WINDOW_MS = 30_000

/**
 * Whether `events` hold a sandbox being entered that the panel has not seen yet.
 *
 * "A sandbox is entered" is the event a run already emits for it: the
 * `pattern_enter` of a `withSandbox(…)` pattern — `chain` and `routes` both
 * name the entered pattern, and the wrapper's name is `withSandbox(<inner>)`.
 * Every such event is added to `seen` whether or not it is recent, so a
 * replayed one can never count later; it counts as new only when it is also
 * within {@link SANDBOX_BLINK_WINDOW_MS} of `now`.
 */
export function sawSandboxEntry(
  events: readonly ContextEvent[],
  seen: Set<string>,
  now: number,
): boolean {
  let fresh = false
  for (const e of events) {
    if (e.type !== 'pattern_enter') continue
    const pattern = (e.data as { pattern?: unknown } | null)?.pattern
    if (typeof pattern !== 'string' || !pattern.startsWith('withSandbox(')) continue
    const key = e.id ?? `${e.patternId}:${e.ts}`
    if (seen.has(key)) continue
    seen.add(key)
    if (Math.abs(now - e.ts) <= SANDBOX_BLINK_WINDOW_MS) fresh = true
  }
  return fresh
}
