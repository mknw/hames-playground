/**
 * ControllerAction normalisation — the single place an LLM-produced action is
 * given its documented defaults before any pattern reads it.
 *
 * Pure (no server imports) so both loop patterns and the tests can use it.
 */

import type { ControllerAction, ToolCallRequest } from '../../../baml_client/types'
import { repairJson, scanLiteral } from './json-repair'

/**
 * Fill `is_final` when the model omitted it.
 *
 * `is_final` is `bool?` in `types.baml` (#159): required, its omission threw
 * away otherwise-perfect turns with `BamlValidationError: Missing required
 * field: is_final` — three times now for three different fields of this one
 * class. The full rationale lives on the field in `types.baml`; the short
 * version is that the field's only demonstration anywhere in the prompt is the
 * literal `false` the turn log renders, so a turn-0 call with no history has
 * nothing but `ctx.output_format` to go on.
 *
 * The default is FALSE and nothing else could be: absence must never be able to
 * end a loop or claim finality. simpleLoop keeps `tool_name === 'Return'` as an
 * independent terminal signal, so a model that means to finish still can; and
 * actorCritic's `is_final === true` only triggers the critic, which owns exit
 * either way.
 *
 * Normalising here rather than leaving `undefined` to fall through keeps the
 * runtime shape of an action complete for everything downstream of the loop —
 * the `controller_action` event and its UI readers, the compactExecution's iteration
 * log, and `ActorAttemptLog`, which renders the recorded action back into the
 * actor's own prompt history (where a `null` would demonstrate a third value
 * for a boolean field).
 *
 * Returns the same object when nothing needs filling, so the common path
 * allocates nothing.
 */
export function normalizeControllerAction(action: ControllerAction): ControllerAction {
  if (action.is_final === undefined || action.is_final === null) {
    return { ...action, is_final: false }
  }
  return action
}

// ============================================================================
// Brace-less envelope recovery (#see .harness-logs/baml-validation.json)
// ============================================================================

/**
 * The six `ControllerAction` field names, as the model writes them at the start
 * of a line in the brace-less shape this module recovers.
 *
 * Anchored with `^` (no leading whitespace) and `[ \t]` around the colon so a
 * match can never straddle a newline: an indented `tool_name:` is a member of
 * an `additional_calls` list item, not a second top-level field.
 */
const ACTION_FIELD_LINE =
  /^(reasoning|tool_name|tool_args|additional_calls|status|is_final)[ \t]*:[ \t]*/gm

/** A tool name is an identifier, not prose. `mcp-exec` and `Return` both fit. */
const TOOL_NAME = /^[A-Za-z_][\w.-]{0,63}$/

/** `tool_name: sandbox_bash` and `tool_name: "sandbox_bash"` mean the same thing:
 *  the few-shot section renders values with `tojson`, so the model has seen both
 *  a quoted and (in its own attempt log) an unquoted form of every field. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) return trimmed
  try {
    // Opens and closes with a quote AND parses, so it is a JSON string.
    return JSON.parse(trimmed) as string
  } catch {
    // Its own quotes were not escaped (`"he said "hi""`). Stripping the outer
    // pair beats passing the stray quotes downstream.
    return trimmed.slice(1, -1)
  }
}

/**
 * The fields whose SECOND top-level occurrence abandons the whole recovery.
 *
 * These three decide which tool runs with which arguments. A duplicate means
 * the text contains two candidate calls and nothing in the envelope says which
 * one the model meant — and the realistic way that happens is hostile: a tool
 * result echoed into `reasoning` carrying its own column-0 `tool_name:` /
 * `tool_args:` lines, i.e. the shape a prompt-injection payload takes. Taking
 * the first would let quoted content choose the call over the model's own
 * action, and this coercion runs UPSTREAM of `withInjectionGuard` (which
 * neutralises spans in tool results, not in the model's reasoning).
 *
 * `reasoning`, `status` and `is_final` are left first-wins: none of them can
 * redirect a call, and `normalizeControllerAction` owns `is_final`'s default.
 */
const SINGLE_OCCURRENCE_FIELDS = new Set(['tool_name', 'tool_args', 'additional_calls'])

/**
 * Top-level `key: value` fields of a brace-less envelope — first occurrence wins,
 * except where a duplicate makes the action ambiguous (see below).
 *
 * A field's value runs to the start of the next top-level field, EXCEPT when it
 * opens a `{`/`[` literal — then it runs to that literal's matching bracket
 * (`scanLiteral`), so a `tool_args` object containing a `status:` line inside a
 * string cannot be mistaken for the next field.
 *
 * Returns null when a value opens a literal that never closes — the payload is
 * incomplete, so recovering "most of" the action would hand the loop a
 * half-written script to execute. (This is a lexical signal only; the
 * authoritative cap-hit check lives in `recoverActionFromEnvelope`, which
 * declines on `collectorHitOutputCap` before this function is ever reached.)
 *
 * Also returns null when one of `SINGLE_OCCURRENCE_FIELDS` appears twice at top
 * level — see that constant for why an ambiguous envelope must not be resolved
 * by position.
 */
function scanEnvelopeFields(text: string): Map<string, string> | null {
  const marks: Array<{ key: string; start: number; valueStart: number }> = []
  const re = new RegExp(ACTION_FIELD_LINE.source, 'gm')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    marks.push({ key: m[1], start: m.index, valueStart: m.index + m[0].length })
  }

  const fields = new Map<string, string>()
  let consumedTo = 0
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    if (mark.start < consumedTo) continue // sits inside a value already taken
    const opensLiteral = text[mark.valueStart] === '{' || text[mark.valueStart] === '['
    const literalEnd = opensLiteral ? scanLiteral(text, mark.valueStart) : -1
    if (opensLiteral && literalEnd < 0) return null // unterminated → truncated
    const end = literalEnd > 0 ? literalEnd : (marks[i + 1]?.start ?? text.length)
    if (fields.has(mark.key)) {
      if (SINGLE_OCCURRENCE_FIELDS.has(mark.key)) return null // ambiguous → decline
    } else {
      fields.set(mark.key, text.slice(mark.valueStart, end).trim())
    }
    consumedTo = end
  }
  return fields
}

/** Normalise a `tool_args` payload: strict JSON when it parses as an object,
 *  otherwise the model's text verbatim. Verbatim is deliberate — a `Return`
 *  turn's args are prose by contract (`types.baml`), and simpleLoop checks for
 *  `Return` BEFORE it parses args, so re-shaping them here would corrupt the
 *  one turn that carries the finished answer. A non-`Return` tool with
 *  unparseable args reaches the loops' existing `Invalid tool_args JSON`
 *  branches, which are observable and carry `rawOutput`. */
function normalizeToolArgs(raw: string): string {
  const value = unquote(raw)
  try {
    const parsed = repairJson(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? JSON.stringify(parsed)
      : value
  } catch {
    return value
  }
}

/**
 * `additional_calls` as either a JSON array or the YAML-ish list the model
 * writes when it is copying the brace-less envelope:
 *
 *     additional_calls:
 *       - tool_name: sandbox_bash
 *         tool_args: {"command":"python3 /work/inspect_xlsx.py"}
 *
 * Returns `null` when the field is present but any entry is unreadable. The
 * caller then abandons the whole recovery: executing a PARTIAL batch would drop
 * a call the model asked for and report success — the loops run these in order
 * and later calls depend on earlier ones (`multiToolCalls: 'sequential'`), so a
 * silently short batch is worse than the parse failure it replaces.
 */
function parseAdditionalCalls(raw: string): ToolCallRequest[] | null {
  const value = raw.trim()
  if (value === '' || value === 'null' || value === '[]') return []

  if (value.startsWith('[')) {
    try {
      // `value` opens with `[`, so a successful parse is an array by construction.
      const parsed = JSON.parse(value) as unknown[]
      const calls = parsed.map((entry) => {
        const e = entry as { tool_name?: unknown; tool_args?: unknown }
        // BOTH fields must be there. An entry with a name and no args is as
        // unreadable as one with args and no name: defaulting it to `{}` would
        // INVENT an argument the model never wrote and run the tool bare — the
        // one thing "declines anything partly readable" exists to prevent.
        if (typeof e?.tool_name !== 'string' || !e.tool_name) return null
        if (e.tool_args === undefined || e.tool_args === null) return null
        return {
          tool_name: e.tool_name,
          tool_args: typeof e.tool_args === 'string' ? e.tool_args : JSON.stringify(e.tool_args),
        }
      })
      return calls.every((c): c is ToolCallRequest => c !== null) ? calls : null
    } catch {
      return null
    }
  }

  // YAML-ish list: split on the `-` bullets, then read each item's two fields.
  const items = value
    .split(/^[ \t]*-[ \t]*/m)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (items.length === 0) return null

  const calls: ToolCallRequest[] = []
  for (const item of items) {
    const name = item.match(/(?:^|\n)[ \t]*tool_name[ \t]*:[ \t]*(.*)/)
    if (!name) return null
    const toolName = unquote(name[1])
    if (!TOOL_NAME.test(toolName)) return null
    const argsAt = item.search(/(?:^|\n)[ \t]*tool_args[ \t]*:[ \t]*/m)
    if (argsAt < 0) return null
    const argsValue = item.slice(argsAt).replace(/^[\s\S]*?tool_args[ \t]*:[ \t]*/, '')
    calls.push({ tool_name: toolName, tool_args: normalizeToolArgs(argsValue) })
  }
  return calls
}

/**
 * Recover a `ControllerAction` from a response the model wrote as brace-less
 * `key: value` lines instead of the JSON object `ctx.output_format` asks for.
 *
 * Captured live (`.harness-logs/baml-validation.json`, `sandbox-session-loop`
 * attempt 3 of 6):
 *
 *     reasoning: Previous attempt failed likely due to quoting issues...
 *     tool_name: sandbox_write
 *     tool_args: {"path":"/work/inspect_xlsx.py","content":"import openpyxl\n..."}
 *     additional_calls:
 *       - tool_name: sandbox_bash
 *         tool_args: {"command":"python3 /work/inspect_xlsx.py"}
 *     status: Reading the spreadsheet's column headers using a Python script.
 *     is_final: false
 *
 * Every field the contract needs is THERE and correct — only the envelope is
 * wrong. BAML's jsonish parser cannot recover a brace-less block: it instead
 * finds the embedded `tool_args` objects and tries each as a ControllerAction,
 * which is the shape of the error ("Failed to find any ControllerAction ... in 3
 * items", each `missing=3`). The throw aborted the whole actorCritic loop with
 * three attempts still in budget and the user got an apology.
 *
 * The root cause is a prompt defect — the few-shot sections rendered examples
 * in exactly this brace-less shape, and the model copied them (fixed in
 * `actorCritic.baml` / `simpleLoop.baml`). This function is the belt to that
 * braces: a model can always drift, and discarding a complete, correct action
 * over its punctuation is never the right answer.
 *
 * Deliberately NOT a general "parse anything" pass. It returns null unless:
 *  - `tool_name` and `tool_args` both appear as top-level fields, and
 *  - neither they nor `additional_calls` appear TWICE at top level (an echoed
 *    tool result must never get to choose the call — `SINGLE_OCCURRENCE_FIELDS`), and
 *  - `tool_name` looks like a tool name rather than prose, and
 *  - a present `additional_calls` parses COMPLETELY.
 * An unterminated `{`/`[` value also declines, but that is a lexical signal, not
 * the truncation guard: a cut can land after a closing brace (mid-`additional_calls`)
 * or inside a QUOTED `tool_args`, and neither is unbalanced. Truncation is owned
 * by the caller — `recoverActionFromEnvelope` declines on `collectorHitOutputCap`
 * before this function runs, so a genuine cap-hit is never coerced and stays on
 * the truncation-retry path where it belongs.
 *
 * `reasoning` defaults to `''` — the same default `ActorAttemptLog` and the
 * adapters' own `Attempt` assembly already use for it. `is_final` is left absent
 * when unreadable so `normalizeControllerAction` applies the documented false.
 */
export function coerceControllerActionText(raw: string | undefined): ControllerAction | null {
  if (!raw?.trim()) return null
  const fields = scanEnvelopeFields(raw)
  if (!fields) return null

  const toolNameRaw = fields.get('tool_name')
  const toolArgsRaw = fields.get('tool_args')
  if (toolNameRaw === undefined || toolArgsRaw === undefined) return null

  const tool_name = unquote(toolNameRaw)
  if (!TOOL_NAME.test(tool_name)) return null

  const additionalRaw = fields.get('additional_calls')
  const additional_calls = additionalRaw === undefined ? [] : parseAdditionalCalls(additionalRaw)
  if (additional_calls === null) return null

  const status = fields.has('status') ? unquote(fields.get('status') as string) : undefined
  const isFinalRaw = fields.get('is_final')?.trim().toLowerCase()

  return {
    reasoning: fields.has('reasoning') ? unquote(fields.get('reasoning') as string) : '',
    tool_name,
    tool_args: normalizeToolArgs(toolArgsRaw),
    ...(additional_calls.length ? { additional_calls } : {}),
    ...(status ? { status } : {}),
    ...(isFinalRaw === 'true' || isFinalRaw === 'false' ? { is_final: isFinalRaw === 'true' } : {}),
  }
}
