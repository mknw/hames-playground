/**
 * The DATA fence's escape (#419 M5a, review item 3 of the M5 preconditions).
 *
 * `memory.baml`'s two prompts, and the `memory_context` blocks of `router.baml`
 * and `compact-execution.baml`, put text they did not write between
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
 * and the sanitizer in core are. It removes the one way text could change the
 * fence's own meaning.
 *
 * ## What it does
 *
 * Every `BEGIN DATA` / `END DATA` — any case, any run of whitespace, with or
 * without the dashes around it — becomes `BEGIN (data marker removed)` /
 * `END (data marker removed)`. The dashes are left alone: a run of dashes is
 * not a marker, and the rewrite must not change text that is not one. The scan
 * is a single regular expression with one literal anchor and no nested
 * quantifier, so it is linear in its input (a polynomial pattern here was the
 * CodeQL finding on #514's think-block regex, and this runs on hostile text).
 *
 * A string with no marker comes back BYTE-FOR-BYTE identical, which is what
 * keeps a verbatim `evidence` span verbatim. A user message that itself
 * contains a marker is escaped too, so an evidence span copied from it will not
 * match the original and the candidate is dropped: that fails closed and costs
 * a memory nobody needed.
 */

const MARKER = /\b(BEGIN|END)\s+DATA\b/gi

/** The text a neutralised marker becomes. Exported so a pin can say what it
 *  expects without restating the wording. */
export const FENCE_MARKER_REPLACEMENT = '(data marker removed)'

/** Neutralise every DATA-fence marker in `text`. Identity on text without one. */
export function escapeDataFence(text: string): string {
  return text.replace(MARKER, (_m, word: string) => `${word} ${FENCE_MARKER_REPLACEMENT}`)
}
