/**
 * Classified sandbox failures.
 *
 * A boot error carries the container engine's own words — the command line it
 * ran, the socket it dialled, stderr — and everything an error says can reach
 * the model's next prompt and from there the user. The model and the user get a
 * FIXED sentence per class; the raw error goes to the server log and nowhere
 * else. A class is a decision about what the model may be told, so adding one
 * means writing its sentence here, never interpolating the error.
 *
 * Pure: no `node:` imports, safe to read from a test without the server assert.
 */

export type SandboxFailureReason = 'engine_unreachable' | 'boot_failed'

export interface SandboxFailure {
  reason: SandboxFailureReason
  /** Fixed text for the tool result — the only thing the model sees. */
  message: string
}

const DO_NOT_RETRY =
  'The sandbox_* tools cannot run in this turn: do not call them again. ' +
  'Continue with the other tools if the task allows it, and tell the user which part could not be done.'

const FAILURE_MESSAGE: Record<SandboxFailureReason, string> = {
  engine_unreachable: `The code workspace is unavailable on this server. ${DO_NOT_RETRY}`,
  boot_failed: `The code workspace could not be started. ${DO_NOT_RETRY}`,
}

/** Shapes a missing, stopped or unreachable container engine takes — the CLI's
 *  own words, the socket error codes, and the spawn failure for an absent binary. */
const ENGINE_UNREACHABLE =
  /cannot connect to the docker daemon|is the docker daemon running|docker\.sock|could not start|\b(?:ENOENT|ECONNREFUSED|EACCES)\b|no such file or directory|connection refused/i

export function classifySandboxFailure(err: unknown): SandboxFailure {
  const detail = err instanceof Error ? `${err.message} ${String(err.cause ?? '')}` : String(err)
  const reason: SandboxFailureReason = ENGINE_UNREACHABLE.test(detail)
    ? 'engine_unreachable'
    : 'boot_failed'
  return { reason, message: FAILURE_MESSAGE[reason] }
}
