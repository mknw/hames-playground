/**
 * Thinking-trace extraction (#625 S1): read a model's thinking out of a
 * response BAML has already parsed, for the thinking-on counterparts to put in
 * `reasoning`. The planner adapter uses it for #625 S3's dormant thinking
 * counterpart under the owner rulings recorded as G19; other roles remain
 * deferred.
 *
 * ## Why it reads the raw HTTP body
 *
 * BAML 0.224.0 never exposes a trace where an adapter would look first.
 * Measured offline against the committed client (#625 §2):
 *  - an OpenAI-compatible server WITH a reasoning parser returns the trace in
 *    `choices[0].message.reasoning_content` or `.reasoning`. The field name
 *    differs between servers and versions. BAML parses `content` only, and
 *    `rawLlmResponse` is `content` only.
 *  - Anthropic returns `thinking` blocks beside the text. BAML drops them from
 *    both. On the models this repo runs the block's text is an EMPTY STRING
 *    plus a signature (`clients.baml`, the thinking-disabled variants).
 * In both cases the trace survives only in the collector call's raw response
 * body, the same body `usageFromResponse` (`baml-adapters.server.ts`) reads for
 * the cache-write bucket. So {@link thinkingFrom} takes a collector call.
 *
 * ## The server with no reasoning parser
 *
 * There the trace is in `content`, ahead of the answer, closed by `</think>`.
 * The opening tag sits in the PROMPT (the chat template opens it), so `content`
 * usually has no `<think>`. BAML's parser takes the first JSON-shaped candidate
 * in `content`, so an action the model only DRAFTED inside its thinking parses
 * as the action (#625 §2, case B2). {@link splitAtLastThinkClose} is the
 * defence: cut at the LAST `</think>` and parse only the tail. The last one,
 * because the trace itself can mention the tag. A thinking client requires a
 * parser (G19, Q7), so on the routed path this split is defence in depth, and
 * the caller treats `</think>` in `content` as a loud failure.
 *
 * Both functions are pure, linear in their input and regex-free. The text is
 * model output, so it is untrusted: harness-patterns' `removeThinkBlocks`
 * exists because the think-block regex before it was polynomial on this input.
 * Extraction and splitting perform no sanitization or authorization; returned
 * text remains untrusted (SD-1, SD-3, SD-4).
 */

/** The part of a BAML collector call this module reads. Structural, so the
 *  adapters can pass their own `CollectorCall` and a test can pass a stub. The
 *  body is a native object whose `json()` can throw (a stream call, a network
 *  failure), which is why it is a method here and not a value. */
export interface ThinkingSourceCall {
  httpResponse?: { body?: { json?: () => unknown } } | null
}

/** Where a trace came from. Two OpenAI-compatible field names, because servers
 *  disagree on the name; one Anthropic block type. */
export type ThinkingSource = 'reasoning_content' | 'reasoning' | 'anthropic_thinking'

/**
 * Why there is no trace. Typed rather than an empty string, so a caller can
 * tell "the model did not think" from "this response could not be read" and
 * never has to guess:
 *  - `no-response`: the call has no response body (pre-flight failure).
 *  - `unreadable-body`: the body did not parse as JSON.
 *  - `unrecognised-shape`: neither an OpenAI-compatible nor an Anthropic body.
 *  - `no-trace`: a recognised body with no trace field or block. A thinking-off
 *    call, or a server with no parser, whose trace is in `content` instead.
 *  - `empty-trace`: the field or block is present, but its text is empty or
 *    whitespace. Anthropic's default display returns exactly this.
 */
export type ThinkingAbsence =
  'no-response' | 'unreadable-body' | 'unrecognised-shape' | 'no-trace' | 'empty-trace'

/** A trace, verbatim, or a typed absence. Never a fabricated or placeholder
 *  trace: every `trace` value is text the server returned. */
export type ThinkingTrace =
  | { kind: 'trace'; text: string; source: ThinkingSource }
  | { kind: 'absent'; reason: ThinkingAbsence }

const absent = (reason: ThinkingAbsence): ThinkingTrace => ({ kind: 'absent', reason })

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The OpenAI-compatible field names, in the order they are read. A server
 *  that sends both (one as a deprecated alias of the other) sends the same
 *  text, so the order only decides which name is reported. */
const OPENAI_TRACE_FIELDS = ['reasoning_content', 'reasoning'] as const

/**
 * The thinking trace of one collector call, read from its raw response body.
 *
 * OpenAI-compatible: `choices[0].message.reasoning_content`, else
 * `.reasoning`. Anthropic: every `thinking` block's text, joined by a blank
 * line. A `redacted_thinking` block has no readable text and counts as no
 * trace. Empty or whitespace-only text is `empty-trace`, never a trace.
 */
export function thinkingFrom(call: ThinkingSourceCall | undefined): ThinkingTrace {
  const raw = call?.httpResponse?.body
  if (typeof raw?.json !== 'function') return absent('no-response')
  let body: unknown
  try {
    body = raw.json()
  } catch {
    return absent('unreadable-body')
  }
  if (!isRecord(body)) return absent('unreadable-body')

  if (Array.isArray(body.choices)) {
    const message = isRecord(body.choices[0]) ? body.choices[0].message : undefined
    if (!isRecord(message)) return absent('no-trace')
    let sawField = false
    for (const field of OPENAI_TRACE_FIELDS) {
      const value = message[field]
      if (hasText(value)) return { kind: 'trace', text: value, source: field }
      if (typeof value === 'string') sawField = true
    }
    return absent(sawField ? 'empty-trace' : 'no-trace')
  }

  if (Array.isArray(body.content)) {
    const blocks = body.content.filter(
      (b): b is Record<string, unknown> => isRecord(b) && b.type === 'thinking',
    )
    if (blocks.length === 0) return absent('no-trace')
    const texts = blocks.map((b) => b.thinking).filter(hasText)
    if (texts.length === 0) return absent('empty-trace')
    return { kind: 'trace', text: texts.join('\n\n'), source: 'anthropic_thinking' }
  }

  return absent('unrecognised-shape')
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/**
 * `raw` cut at its LAST `</think>`.
 *
 * `head` is the trace: everything before the cut, with one leading `<think>`
 * removed when the server echoed the opening tag, trimmed. An empty `head` is
 * not a trace. `tail` is the answer: everything after the cut, with the
 * template's leading whitespace removed. It is what a caller re-parses with
 * `b.parse.<Fn>(tail)`.
 *
 * With no `</think>` at all, `closed` is false and `tail` is `raw` unchanged:
 * there is nothing to split, and nothing is guessed. An answer that itself
 * contains the literal `</think>` is cut inside the answer. The truncated tail
 * can still parse successfully, including for string-returning BAML functions.
 * `closed: true` certifies only a delimiter, not a validated trace/answer
 * boundary. The caller must independently enforce G19 Q7's loud-failure policy.
 * The first `</think>` would instead hand a drafted action to the parser.
 *
 * Both returned strings remain untrusted. This split performs no sanitization
 * or authorization (SD-1, SD-3, SD-4).
 */
export function splitAtLastThinkClose(
  raw: string,
): { closed: true; head: string; tail: string } | { closed: false; tail: string } {
  const cut = raw.lastIndexOf(THINK_CLOSE)
  if (cut < 0) return { closed: false, tail: raw }
  let head = raw.slice(0, cut).trim()
  if (head.startsWith(THINK_OPEN)) head = head.slice(THINK_OPEN.length).trim()
  return { closed: true, head, tail: raw.slice(cut + THINK_CLOSE.length).trimStart() }
}
