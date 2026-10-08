/**
 * The DATA fence's escape (#419 M5a, review item 3 of the M5 preconditions).
 *
 * `memory.baml`'s two prompts, and the `memory_context` blocks of `router.baml`
 * and `compact-execution.baml`, and `decide.baml`'s state, put text they did not write between
 * `---BEGIN DATA---` and `---END DATA---` and tell the model that everything in
 * between is to be read, never obeyed. The fence is a convention the model
 * follows, and it ends where the text says it ends: a reply that contains
 * `---END DATA---` followed by instructions closes the fence early and the
 * instructions land OUTSIDE it, in the prompt's own voice.
 *
 * The text that can do that is not a stranger's. The assistant's reply is
 * composed from tool results, so a poisoned page reaches the extractor through
 * the reply, one step removed from the tool result `settleMemory`'s window
 * deliberately never reads (the evidence rule closes the other half: a memory
 * needs a verbatim span of the USER's message). So the marker is neutralised in
 * every string that goes inside a fence, deterministically, before the prompt
 * is rendered — it is not left to the model to notice.
 *
 * This is not the security control either, and says so: the acceptance rules
 * and the sanitizer in core are. It neutralises the known marker spellings
 * described below.
 *
 * ## What it does
 *
 * Every `BEGIN DATA` / `END DATA` that a model would read as the marker becomes
 * `BEGIN (data marker removed)` / `END (data marker removed)`. That covers:
 *  - any case;
 *  - the two words joined by whitespace, `_`, `.`, `-` or nothing;
 *  - with or without the dashes around it;
 *  - spelled with invisible format characters (the guard's `hidden-invisible`
 *    class), compatibility forms (fullwidth, mathematical alphanumerics),
 *    accents, or the Cyrillic, Greek and small-capital lookalikes in
 *    `LOOKALIKE_FROM`.
 * Detection runs on a folded copy, and only the marker's own span of the
 * original is rewritten. The dashes are left alone: a run of dashes is not a
 * marker. ASCII text takes the single-regex path. In both paths every
 * quantified class is followed by a literal it cannot match, so the scan is
 * linear in its input. A polynomial pattern here was the CodeQL finding on
 * #514's think-block regex, and this function runs on hostile text. The
 * lookalike table is a closed list, not Unicode TR39: a spelling outside it is
 * not caught, which is one reason this is not the security control.
 *
 * A string with no marker comes back unchanged, which is what keeps a verbatim
 * `evidence` span verbatim. A user message that itself contains a marker is
 * escaped too. An evidence span that overlaps the marker then fails to match
 * the original message, and the candidate is dropped (fail closed). A span
 * elsewhere in the same message still matches, so the stored `content` may
 * carry the replacement text.
 */

import { INJECTION_RULES } from '@hames-ai/harness-patterns/guard'

/** The text a neutralised marker becomes. Exported so a pin can say what it
 *  expects without restating the wording. */
export const FENCE_MARKER_REPLACEMENT = '(data marker removed)'

/** The guard's own invisible-character class (`hidden-invisible`), reused rather
 *  than restated: a marker split by a soft hyphen or a zero-width joiner is
 *  still a marker to the model that reads it. */
const HIDDEN = new RegExp(
  `^${INJECTION_RULES.find((r) => r.id === 'hidden-invisible')!.re.source}$`,
)

/** Cyrillic, Greek and small-capital letters that render as the Latin letters
 *  of the two marker words; NFKD folds none of them. Escaped on purpose: a
 *  lookalike written literally cannot be reviewed. `FROM[i]` reads as `TO[i]`. */
const LOOKALIKE_FROM =
  '\u0410\u0430\u0412\u0415\u0435\u0406\u0456\u0422\u0500\u0501' +
  '\u0391\u03B1\u0392\u0395\u0399\u039D\u03A4' +
  '\u1D00\u0299\u1D05\u1D07\u0262\u026A\u0274\u1D1B\u0261\u0131'
const LOOKALIKE_TO = 'AaBEeIiTDd' + 'AaBEINT' + 'ABDEGINT' + 'gi'

/** One non-ASCII code point as a model will likely read it: invisible →
 *  nothing; a lookalike → its Latin letter; a compatibility or accented form
 *  (fullwidth, mathematical alphanumerics, `É`) → its base letter; anything
 *  whose decomposition is not one character → itself. */
function fold(ch: string): string {
  if (HIDDEN.test(ch)) return ''
  const k = LOOKALIKE_FROM.indexOf(ch)
  if (k >= 0) return LOOKALIKE_TO[k]
  const base = ch.normalize('NFKD').replace(/\p{M}/gu, '')
  return base.length <= 1 ? base : ch
}

/** BEGIN|END, then any run of whitespace, `_`, `.`, `-` or nothing, then DATA,
 *  as whole words. Each quantified class is followed by a literal it cannot
 *  match, so the scan is linear. */
const MARKER = /(?<![\p{L}\p{N}])(BEGIN|END)[\s_.-]*DATA(?![\p{L}\p{N}])/giu

/** Neutralise every DATA-fence marker in `text`, however it is spelled. Text
 *  with none comes back unchanged. The folding is used to FIND a marker and is
 *  never written to the output: only the marker itself is rewritten. */
export function escapeDataFence(text: string): string {
  // ASCII needs no folding (the common case, and the cheap one).
  if (!/[^\x00-\x7F]/.test(text)) {
    return text.replace(MARKER, (_m, word: string) => `${word} ${FENCE_MARKER_REPLACEMENT}`)
  }
  // Fold into a shadow string, remembering which slice of `text` each shadow
  // unit came from, so a match found in the shadow rewrites the original span.
  let shadow = ''
  const from: number[] = []
  const to: number[] = []
  let i = 0
  for (const ch of text) {
    const f = ch.charCodeAt(0) < 0x80 ? ch : fold(ch)
    for (let k = 0; k < f.length; k++) {
      from.push(i)
      to.push(i + ch.length)
    }
    shadow += f
    i += ch.length
  }
  let out = ''
  let last = 0
  for (const m of shadow.matchAll(MARKER)) {
    const start = from[m.index]
    out += `${text.slice(last, start)}${m[1]} ${FENCE_MARKER_REPLACEMENT}`
    last = to[m.index + m[0].length - 1]
  }
  return last === 0 ? text : out + text.slice(last)
}
