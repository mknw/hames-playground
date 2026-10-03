/**
 * Loop recovery — which failures a tool loop survives, and what the model is
 * told about them (#437 slice 1, from #425 C1/C2).
 *
 * `simpleLoop` used to end on the first failed tool call, the first tool name
 * off its allowlist and the first unparseable `tool_args`, and `actorCritic`
 * on the first actor response that would not parse — each with rounds or
 * attempts left. Both loops now feed such a failure back to the model as that
 * round's observation and continue on their remaining budget. This module holds
 * the parts the two loops share, so the rule cannot drift between them:
 *
 *   - **Which failures are recoverable.** A tool's own failure, a refused tool
 *     name, unparseable `tool_args`, and an LLM call whose ANSWER could not be
 *     parsed — {@link isRecoverableLLMFailure}. Everything else stays fatal
 *     exactly as before: the gateway-outage refusal before a loop starts, an LLM
 *     call that never answered (transport, timeout, abort), any error the
 *     implementation did not classify, and a `callTool` that throws — singular,
 *     or in a `simpleLoop` batch whose calls all failed (the deterministic
 *     sanitizer's throw policy is #206 D1, an owner decision this does not
 *     touch; the batch cases behave exactly as they did before, including
 *     `actorCritic`'s, which has always continued).
 *   - **What the model is told.** {@link unparseableOutputFeedback} and
 *     {@link invalidToolArgsFeedback}.
 *   - **What the panel shows.** {@link trackLoopRecovery}: one `loop_recovery`
 *     event per recovery, always tracked — see `LoopRecoveryEventData` for why
 *     it is not an `error`.
 */

import { assertServerOnImport } from './assert.server'
import { trackEvent } from './context.server'
import { LLMCallError } from './types'
import type { LLMCallRecord, LoopRecoveryEventData, PatternScope } from './types'

assertServerOnImport()

/**
 * Is this controller/actor failure one the loop feeds back and survives?
 *
 * True only when the implementation said so: an `LLMCallError` carrying
 * `recoverable` — the model answered and the answer could not be parsed. The
 * flag is read, never inferred from the message, so a custom controller that
 * throws a plain `Error` (or an unflagged `LLMCallError`) keeps the old fatal
 * behaviour rather than spending the budget on a call that cannot succeed.
 */
export function isRecoverableLLMFailure(err: unknown): err is LLMCallError {
  return err instanceof LLMCallError && err.recoverable
}

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text
}

/** The append advice both cut-off messages end with. The actor prompt and the
 *  adapters' one corrective retry (`TRUNCATION_RETRY_GUIDANCE`) say the same. */
const APPEND_ADVICE =
  'when a file or script is large, write the first part now and CONTINUE BY APPENDING ' +
  "in later calls (e.g. bash `cat >> file <<'EOF'`)"

/**
 * What the model reads after an answer that could not be parsed.
 *
 * It arrives as the failed round's ERROR, so it names the cause the record
 * shows: a cut-off at the output cap (where generic "fix your JSON" advice makes
 * the model regenerate the same oversized answer), an empty completion, or a
 * parse failure — the last with a bounded excerpt of the parser's message,
 * which says which field was missing.
 */
export function unparseableOutputFeedback(err: LLMCallError): string {
  if (err.llmCall.hitOutputCap) {
    return (
      'Your previous response was CUT OFF at the output-token limit, so it could not be ' +
      'parsed. Respond again with a materially SMALLER action: keep tool_args compact, and ' +
      `${APPEND_ADVICE}.`
    )
  }
  if (err.llmCall.rawOutput !== undefined && err.llmCall.rawOutput.trim() === '') {
    return 'Your previous response was empty. Respond with exactly one JSON action object.'
  }
  return (
    'Your previous response could not be parsed into the required JSON action object ' +
    `(${excerpt(err.message, 300)}). Respond with exactly one JSON object in the required format.`
  )
}

/**
 * What the model reads after `tool_args` that did not parse.
 *
 * The args themselves are already replayed in the turn log's assistant
 * message, so the error carries a bounded excerpt rather than a second full
 * copy of what can be a report-sized script.
 */
export function invalidToolArgsFeedback(tool: string, args: string, cutOff: boolean): string {
  return cutOff
    ? `tool_args for ${tool} were CUT OFF at the output-token limit (response truncated ` +
        'mid-generation, not a formatting mistake). Produce a materially smaller tool_args: ' +
        `${APPEND_ADVICE}.`
    : `Invalid tool_args JSON for ${tool}: ${excerpt(args, 200)}`
}

/**
 * Record one recovery. Always tracked (`true`, not the pattern's
 * `trackHistory`): `actorCritic`'s default history is a content-event allowlist,
 * and passing it once dropped that loop's in-loop failures for every agent on
 * default config. `llmCall` is the response that caused the failure, when the
 * model's answer is the defect — the only record of what it actually said.
 */
export function trackLoopRecovery(
  scope: PatternScope<unknown>,
  data: LoopRecoveryEventData,
  llmCall?: LLMCallRecord,
): void {
  trackEvent(scope, 'loop_recovery', data, true, llmCall)
}
