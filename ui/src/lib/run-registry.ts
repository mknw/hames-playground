/**
 * Per-session run bookkeeping (#105).
 *
 * Shared by the route (which owns the registries), the chat view (which
 * drives them) and the sidebar (which renders them). Lives here rather than
 * on a component so all three can agree on the shape without importing each
 * other — and so the pure policy helpers stay unit-testable without jsdom.
 */

/**
 * Per-session UI run state. Lives at the route so progress and the submit
 * guard survive sidebar switches — see #47.
 */
export interface SessionRunState {
  /** A submit for this session is in flight (SSE stream open). */
  isProcessing: boolean
  /** Tool name from the latest `controller_action` event of the active loop.
   *  Drives the composer guard banner ("Waiting for `<tool>`…"). */
  runningTool: string | null
}

export const DEFAULT_RUN_STATE: SessionRunState = {
  isProcessing: false,
  runningTool: null,
}

// ============================================================================
// Completion marks
// ============================================================================

/** How a finished run ended. */
export type RunOutcome = 'done' | 'error'

/**
 * A run that finished while the user was reading a *different* thread.
 * The row flashes once to catch the eye, then keeps a quiet accent border
 * until the thread is opened — with several runs in flight, a purely
 * transient signal is easy to miss.
 */
export interface CompletionMark {
  outcome: RunOutcome
  /** True during the one-shot flash animation, false once it has settled
   *  into the static border. */
  flashing: boolean
}

/** How long the completion flash runs. Kept in sync with the
 *  `thread-flash-*` keyframes in `uno.config.ts`. */
export const COMPLETION_FLASH_MS = 2400

// ============================================================================
// Concurrency policy (#105 slice 2)
// ============================================================================

/** Number of sessions with a stream currently open. */
export function countRunning(states: Record<string, SessionRunState>): number {
  let n = 0
  for (const s of Object.values(states)) if (s.isProcessing) n++
  return n
}

/**
 * Whether starting a *new* run would exceed the concurrency cap.
 *
 * A session that is already running is never "at cap" on its own account —
 * its composer is blocked by `isProcessing` instead, and counting it here
 * would refuse a turn that costs no additional concurrency.
 *
 * A non-positive or non-finite cap means "no cap" rather than "block
 * everything", so a corrupted localStorage value can't lock the user out.
 */
export function isAtConcurrencyCap(args: {
  runningCount: number
  cap: number
  /** True when the session attempting to send is itself already running. */
  thisSessionRunning: boolean
}): boolean {
  if (!Number.isFinite(args.cap) || args.cap <= 0) return false
  if (args.thisSessionRunning) return false
  return args.runningCount >= args.cap
}

/** Composer banner shown when a send is refused for hitting the cap. */
export function capReachedMessage(cap: number): string {
  return `max ${cap} reached — wait for a session to stop`
}
