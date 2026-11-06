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
 *   - **When recovering stops.** {@link recoveryStreak}: the consecutive-
 *     recovery cap. An answer the loop cannot use — one that would not parse,
 *     `tool_args` that would not parse, a tool off the allowlist, a multi-call
 *     turn of which nothing could be dispatched — is fed back at most
 *     `maxConsecutiveRecoveries` times in a row (default
 *     {@link DEFAULT_MAX_CONSECUTIVE_RECOVERIES}); the next one is fatal
 *     exactly as it was before #437, marked `kind: 'recovery_exhausted'`
 *     ({@link recoveryExhaustedMarker}).
 *   - **What the panel shows.** {@link trackLoopRecovery}: one `loop_recovery`
 *     event per recovery, always tracked — see `LoopRecoveryEventData` for why
 *     it is not an `error`.
 */

import { assertServerOnImport } from './assert.server'
import { trackEvent } from './context.server'
import { TooLongToRepairError } from './json-repair'
import { LLMCallError } from './types'
import type { ErrorEventData, LLMCallRecord, LoopRecoveryEventData, PatternScope } from './types'

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

/** How much of its own unparseable answer the model is shown again: a HEAD
 *  excerpt, because the shape that failed is set at the top — a brace-less
 *  `reasoning: …` / `tool_name: …` envelope (the case captured in
 *  `LoopFewShots`' comment) is visible in its first line. */
const RAW_OUTPUT_EXCERPT_CHARS = 400

/**
 * What the model reads after an answer that could not be parsed.
 *
 * It arrives as the failed round's ERROR, so it names the cause the record
 * shows: a cut-off at the output cap (where generic "fix your JSON" advice makes
 * the model regenerate the same oversized answer), an empty completion, or a
 * parse failure. Only the last quotes anything: a bounded excerpt of the
 * parser's message, which says which field was missing, and a bounded head of
 * the model's OWN previous response, labelled as such. Without that head the
 * model saw a diagnosis of an answer it could not see — the turn log replays an
 * EMPTY action for such a round, because no action was ever parsed out of it.
 * A cut-off echoes nothing: what it needs is "smaller", not its own oversized
 * text back. An empty answer has nothing to echo.
 */
export function unparseableOutputFeedback(err: LLMCallError): string {
  const raw = err.llmCall.rawOutput
  if (err.llmCall.hitOutputCap) {
    return (
      'Your previous response was CUT OFF at the output-token limit, so it could not be ' +
      'parsed. Respond again with a materially SMALLER action: keep tool_args compact, and ' +
      `${APPEND_ADVICE}.`
    )
  }
  if (raw !== undefined && raw.trim() === '') {
    return 'Your previous response was empty. Respond with exactly one JSON action object.'
  }
  const ownAnswer =
    raw === undefined
      ? ' '
      : ` This is your previous response, as you wrote it:\n${excerpt(raw, RAW_OUTPUT_EXCERPT_CHARS)}\n`
  return (
    'Your previous response could not be parsed into the required JSON action object ' +
    `(${excerpt(err.message, 300)}).${ownAnswer}Respond with exactly one JSON object in the required format.`
  )
}

/**
 * What the model reads after `tool_args` that did not parse.
 *
 * The args themselves are already replayed in the turn log's assistant
 * message, so the error carries a bounded excerpt rather than a second full
 * copy of what can be a report-sized script.
 */
export function invalidToolArgsFeedback(
  tool: string,
  args: string,
  cutOff: boolean,
  err?: unknown,
): string {
  return cutOff
    ? `tool_args for ${tool} were CUT OFF at the output-token limit (response truncated ` +
        'mid-generation, not a formatting mistake). Produce a materially smaller tool_args: ' +
        `${APPEND_ADVICE}.`
    : `Invalid tool_args JSON for ${tool}: ${err instanceof TooLongToRepairError ? err.message : excerpt(args, 200)}`
}

/** The consecutive-recovery cap when a loop declares none: ONE recovery, so
 *  the second unusable answer in a row ends the loop (#450 review §3; owner
 *  decision 2026-10-03, "cap 2", expressed in recoveries since fix round 3 so
 *  the option counts what it permits, as `maxTurns` and `maxRetries` do). Each
 *  failing round already holds the adapters' one corrective retry, so two
 *  rounds is up to four answers produced after being told what was wrong — and
 *  on the self-hosted tier a cut-off round is two full-cap generations, which
 *  is what an uncapped run multiplied by the whole budget. */
export const DEFAULT_MAX_CONSECUTIVE_RECOVERIES = 1

/**
 * A loop's `maxConsecutiveRecoveries`, resolved: absent (or NaN) is the
 * default, anything else is floored and clamped to at least 0 — `0` permits no
 * recovery, so the first unusable answer is fatal (`simpleLoop`'s pre-#437
 * behaviour) — and `Infinity` switches the cap off, leaving only the round
 * budget.
 */
export function resolveMaxConsecutiveRecoveries(declared: number | undefined): number {
  if (declared === undefined || Number.isNaN(declared)) return DEFAULT_MAX_CONSECUTIVE_RECOVERIES
  return Math.max(0, Math.floor(declared))
}

/** The run of unusable answers since the last round that dispatched a tool. */
export interface RecoveryStreak {
  /**
   * Count one round whose ANSWER the loop could not use: it would not parse,
   * its `tool_args` would not parse, it named a tool off the allowlist, or it
   * was a multi-call turn of which no call could be dispatched (every call
   * refused or unparseable at the precheck, or skipped behind one). Returns
   * true when feeding this one back would exceed the cap — `cap` recoveries in
   * a row have already been spent — and the caller then ends the loop the way
   * it did before #437 instead. A tool that ran and failed is NOT counted:
   * fail, fix, fail is how a sandbox actor debugs, and capping it would cut
   * that off.
   */
  unusableAnswer(): boolean
  /** A round dispatched a tool (whatever the tool then returned): the run is
   *  broken. A round that does neither — an `expandPreviousResult`, a
   *  well-formed action that dispatches nothing — leaves the count where it
   *  was. */
  dispatched(): void
}

/** One streak per loop run; both loops share it so the rule cannot drift. */
export function recoveryStreak(cap: number): RecoveryStreak {
  let run = 0
  return {
    unusableAnswer: () => ++run > cap,
    dispatched: () => {
      run = 0
    },
  }
}

/**
 * What a loop stopped by its consecutive-recovery cap adds to its fatal `error`
 * event: the marker, the cap, and a hint naming the lever. The rest of the
 * event — the verbatim failure, the pattern's severity, the failed call's
 * `llmCall` — is what that failure carried when it ended the loop before #437.
 * The hint replaces the message-keyed one, which for a parse failure says it
 * "may resolve on the next loop iteration" — wrong once the loop has stopped.
 */
export function recoveryExhaustedMarker(
  cap: number,
  patternId: string,
): Pick<ErrorEventData, 'kind' | 'maxConsecutiveRecoveries' | 'hint'> {
  return {
    kind: 'recovery_exhausted',
    maxConsecutiveRecoveries: cap,
    hint:
      `Stopped by the consecutive-recovery cap: after ${cap} recover${cap === 1 ? 'y' : 'ies'} ` +
      'in a row, another answer the loop could not use (it would not parse, its tool_args ' +
      'would not parse, it named a tool off the allowlist, or a multi-call turn dispatched ' +
      'nothing). Raise `maxConsecutiveRecoveries` on the ' +
      `\`${patternId}\` pattern to allow more. The answer is composed from the completed rounds only.`,
  }
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

// ---------------------------------------------------------------------------
// The JSON-decoded-newline signature (#1018).
//
// A sandbox actor writing Python inside a JSON `tool_args` wrote `'\n'` where
// the code needed the two characters `\n`: JSON decoding turned the escape
// into a REAL line break inside a quoted string literal, and the executed
// script died with `SyntaxError: unterminated string literal` — an error that
// says nothing about the cause, so the retry rewrote the same script and died
// the same way (two of six attempts in the captured run). {@link
// unterminatedStringFeedback} recognises that signature on a tool ERROR —
// Python's two spellings of a single-line string literal left open at a line
// break — plus a decoded argument whose code still shows the raw break inside
// a quoted (non-triple) string, and returns the exact fix to append to the
// next attempt's context, the way the truncation guidance above does.
//
// Deliberately narrow:
//   - Triple-quoted spans (`'''` / `"""`) are masked before scanning, so a
//     legitimate multi-line string never matches — a raw break inside one is
//     legal Python, and the triple-quoted spellings of the failure
//     ("unterminated triple-quoted string literal", "EOF in multi-line
//     string") do not match the error regex either.
//   - Heredoc bodies (`<<'EOF'` … terminator line) are masked too: their
//     lines are literal content, not code, and quotes in them (an apostrophe
//     in prose, most commonly) are text. The mask can HIDE the signature when
//     the script itself travels inside a heredoc — the classifier then stays
//     silent, which is the pre-#1018 behaviour, not a new failure.
//   - Everything else errs toward advice the model does not need — but only
//     on a round that ALREADY failed with the matching error, so a false
//     positive costs one redundant sentence, never a different route.
//
// Wired at the two loops' single-call tool-error paths (and simpleLoop's
// re-dispatch of a released held call, the same single-call shape). A
// multi-call batch reports its per-call errors inside one combined map, where
// per-call advice would have to address a call the map names only by index.

const UNTERMINATED_STRING_ERROR_RE = /unterminated string literal|EOL while scanning string literal/

/** The exact fix, in the same voice as the truncation guidance above. */
const NEWLINE_ESCAPE_GUIDANCE =
  'Your tool_args are JSON, so a \\n you wrote decoded to a REAL line break inside a ' +
  'quoted string in the code — that is the unterminated string literal above. To put the ' +
  'two characters \\n inside a quoted string, escape the backslash: write \\\\n in the ' +
  'JSON (it decodes to \\n). A string that should genuinely span several lines needs ' +
  'triple quotes (\'\'\' or """), which a line break inside them does not terminate.'

/** Every string in `args`, however nested — the code-bearing argument is
 *  whichever one the tool executes, and the loop cannot know its key. */
function* stringValuesOf(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringValuesOf(item)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) yield* stringValuesOf(item)
  }
}

/** Blank out heredoc BODY lines: from the line after a `<<[-]DELIM` start to
 *  the line that is DELIM alone (`<<-` allows leading whitespace before it).
 *  The start and terminator lines are kept — they are code. */
function maskHeredocBodies(text: string): string {
  const out: string[] = []
  let delim: string | undefined
  for (const line of text.split('\n')) {
    if (delim !== undefined) {
      if (line.trim() === delim) {
        delim = undefined
        out.push(line)
      }
      continue
    }
    const start = /<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    out.push(line)
    if (start) delim = start[2]
  }
  return out.join('\n')
}

/** Does a raw line break fall inside a quoted (non-triple) string literal?
 *  A scanner rather than a regex, because the falsifiable shapes cross: an
 *  apostrophe inside a double-quoted string (`print("it's here")`) closes that
 *  string on its own line, a `#` comment's apostrophe is not a string at all,
 *  and only a single- or double-quoted literal still OPEN at the break is the
 *  signature. */
function opensLiteralAcrossNewline(code: string): boolean {
  let quote: "'" | '"' | null = null
  let triple = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (triple) {
      if (ch === quote && code.startsWith(quote + quote + quote, i)) {
        triple = false
        quote = null
        i += 2
      }
      continue
    }
    if (quote !== null) {
      if (ch === '\\') {
        i++
      } else if (ch === quote) {
        quote = null
      } else if (ch === '\n') {
        return true
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      if (code.startsWith(ch + ch + ch, i)) {
        triple = true
        quote = ch
        i += 2
        continue
      }
      quote = ch
      continue
    }
    if (ch === '#') {
      while (i < code.length && code[i] !== '\n') i++
    }
  }
  return false
}

/**
 * The appended fix for a tool failure that is the JSON-decoded-newline
 * signature, or undefined when it is not. `error` is the tool's own error
 * text; `args` are the DECODED arguments the call ran with. The caller appends
 * the return value to what the next round reads — the projected turn-log
 * entry, the recovery's `feedback` — while the committed `tool_result` event
 * keeps the error verbatim.
 */
export function unterminatedStringFeedback(
  args: Record<string, unknown>,
  error: string | null | undefined,
): string | undefined {
  if (!error || !UNTERMINATED_STRING_ERROR_RE.test(error)) return undefined
  for (const value of stringValuesOf(args)) {
    if (opensLiteralAcrossNewline(maskHeredocBodies(value))) return NEWLINE_ESCAPE_GUIDANCE
  }
  return undefined
}
