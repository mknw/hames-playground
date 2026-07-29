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
