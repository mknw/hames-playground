/**
 * What the browser is shown of a BLOCKING request — a pause a person must
 * answer before the run continues (decision-loop-agent slice 9). Client-safe:
 * types and one pure helper, no server import.
 *
 * Every string here came from content, a model or the graph, so it is
 * untrusted: the dialog renders it as text nodes, and {@link visibleFormatChars}
 * makes the characters that would change how it reads visible instead of
 * applying them.
 */

/** One option, as the request froze it. */
export interface BlockingOptionView {
  readonly id: string
  readonly label: string
  readonly tone?: 'danger' | 'caution'
  /** Why the option cannot be chosen, when it cannot. */
  readonly unavailable?: string
}

/** One waiting request of a paused conversation, as the dialog reads it. */
export interface BlockingRequestView {
  readonly requestId: string
  readonly kind: string
  readonly question: string
  readonly options: readonly BlockingOptionView[]
  /** The safe action: initial focus and the prominent style. */
  readonly defaultOption: string
  /** Display only. */
  readonly summary: Readonly<Record<string, string | number | boolean | null>>
  readonly expiresAt: number | null
  /** An answer already recorded for it, not yet consumed by a resume. */
  readonly recorded: string | null
  /** The held payload (`payloadRef`), read owner-gated; absent when the
   *  request names none, `null` when it names one that is gone. */
  readonly payload?: unknown
}

/** A conversation that waits on its owner, for the header inbox. */
export interface BlockingInboxEntry {
  readonly sessionId: string
  readonly title: string | null
}

/**
 * Show format and bidi characters instead of applying them: every `\p{Cf}`
 * (zero-width characters, the soft hyphen, the bidi controls) and the line and
 * paragraph separators become `⟨U+XXXX⟩`. Silently removing one would hide it,
 * which is why `displayText` is not used here. Newlines and tabs are kept.
 */
export function visibleFormatChars(text: string): string {
  return text.replace(
    /[\p{Cf}\u2028\u2029]/gu,
    (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`,
  )
}
